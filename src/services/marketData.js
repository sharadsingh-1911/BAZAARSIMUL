const axios = require('axios');
const Instrument = require('../models/Instrument');
const { providerSymbol, canonical } = require('../utils/symbol');

/**
 * Market data.
 *
 * Two things worth understanding about why this is a server-side module:
 *
 * 1. CORS. Yahoo Finance does not send Access-Control-Allow-Origin, so a browser
 *    fetch is blocked before it ever reaches the network. Calling it from Node has
 *    no such restriction. If your deployed frontend "can't find" a symbol that
 *    exists, check the console for a CORS error before blaming the symbol.
 *
 * 2. Rate limiting. Yahoo throttles aggressively per IP. One server pulling a
 *    few hundred symbols once a day is invisible; a thousand browsers each
 *    pulling on page load gets the IP blocked. So: sync into Mongo on a
 *    schedule, serve from Mongo.
 */

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const UA = 'Mozilla/5.0 (compatible; BazaarSimul/2.0; +https://github.com/)';
const HISTORY_CAP = 260; // ~1 trading year

/**
 * Fetch daily candles for one instrument.
 * @returns {Promise<{candles: Array, meta: Object}>}
 */
async function fetchDailyCandles(symbol, exchange = 'NSE', range = '3mo') {
  const provider = providerSymbol(symbol, exchange, 'yahoo');
  const url = `${YAHOO_CHART}/${encodeURIComponent(provider)}`;

  const { data } = await axios.get(url, {
    params: { range, interval: '1d', includePrePost: false },
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    timeout: 12000,
  });

  const result = data?.chart?.result?.[0];
  if (!result) {
    const msg = data?.chart?.error?.description || 'empty response';
    throw new Error(`no chart data for ${provider}: ${msg}`);
  }

  const stamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const candles = [];

  for (let i = 0; i < stamps.length; i += 1) {
    const close = q.close?.[i];
    if (close == null) continue; // Yahoo pads holidays with nulls
    candles.push({
      date: new Date(stamps[i] * 1000),
      open: q.open?.[i] ?? close,
      high: q.high?.[i] ?? close,
      low: q.low?.[i] ?? close,
      close,
      volume: q.volume?.[i] ?? 0,
    });
  }

  if (!candles.length) throw new Error(`no usable candles for ${provider}`);
  return { candles, meta: result.meta || {} };
}

/** Write fetched candles onto the instrument document. */
async function applyCandles(instrument, candles, source = 'yahoo') {
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  instrument.lastPrice = round2(latest.close);
  instrument.prevClose = round2(previous ? previous.close : latest.open ?? latest.close);
  instrument.dayOpen = round2(latest.open);
  instrument.dayHigh = round2(latest.high);
  instrument.dayLow = round2(latest.low);
  instrument.volume = latest.volume;
  instrument.asOf = latest.date;
  instrument.priceSource = source;
  instrument.syncedAt = new Date();
  instrument.syncError = undefined;
  instrument.history = candles.slice(-HISTORY_CAP);

  await instrument.save();
  return instrument;
}

/**
 * Sync instruments. Chunked with a pause so we stay a polite client.
 * Failures are recorded per-instrument and do not abort the run — one delisted
 * symbol should never take down the whole sync.
 *
 * Pass { all: true } to force the entire master. Expect throttling past a few
 * hundred symbols; that is exactly what the tier system exists to avoid.
 */
async function syncAllInstruments({ chunkSize = 5, pauseMs = 400, range = '3mo', all = false } = {}) {
  const filter = all ? { active: true } : await inUseFilter();
  const instruments = await Instrument.find(filter);
  const report = { total: instruments.length, updated: 0, failed: 0, errors: [], scope: all ? 'all' : 'in-use' };

  for (let i = 0; i < instruments.length; i += chunkSize) {
    const chunk = instruments.slice(i, i + chunkSize);

    await Promise.all(chunk.map(async (inst) => {
      try {
        const { candles } = await fetchDailyCandles(inst.symbol, inst.exchange, range);
        await applyCandles(inst, candles, 'yahoo');
        report.updated += 1;
      } catch (err) {
        report.failed += 1;
        report.errors.push({ symbol: inst.symbol, error: err.message });
        inst.syncError = err.message;
        inst.syncedAt = new Date();
        await inst.save().catch(() => {});
      }
    }));

    if (i + chunkSize < instruments.length) await sleep(pauseMs);
  }

  console.log(`[market] sync complete (${report.scope}) — ${report.updated} updated, ${report.failed} failed`);
  if (report.failed) console.warn('[market] failures:', report.errors.slice(0, 10));
  return report;
}

/**
 * Which instruments deserve a scheduled refresh.
 *
 * With the full NSE master loaded that is ~2,000 symbols, and a nightly pull for
 * all of them means ~2,000 provider requests in one window — which gets 429d
 * partway through, leaving a half-synced master with no clean way to tell which
 * half. So the daily job covers only tier 1 (promoted through real use) plus
 * anything currently held or watched by a user. Everything else is priced on
 * demand by ensurePriced().
 */
async function inUseFilter() {
  const User = require('../models/User');
  const users = await User.find().select('watchlist positions.symbol').lean();

  const inUse = new Set();
  users.forEach((u) => {
    (u.watchlist || []).forEach((s) => inUse.add(s));
    (u.positions || []).forEach((p) => inUse.add(p.symbol));
  });

  return { active: true, $or: [{ tier: 1 }, { symbol: { $in: [...inUse] } }] };
}

/**
 * Ensure an instrument has a usable price, fetching one on demand.
 *
 * This is what makes a 2,000-symbol master practical. An instrument imported
 * from the NSE master starts unpriced at tier 2; the first time anyone opens it
 * we fetch a close and promote it to tier 1, so it joins the daily sync from
 * then on. Cost is one provider call on first view.
 *
 * On failure — delisted, suspended, provider throttling — we return a stale
 * price if we have one. A day-old close beats a hard error.
 */
async function ensurePriced(rawSymbol, { maxAgeHours = 20 } = {}) {
  const canon = canonical(rawSymbol);
  const inst = await Instrument.findOne({ symbol: canon, active: true });
  if (!inst) return null;

  // Fire and forget: popularity data for a future promotion pass.
  Instrument.updateOne({ _id: inst._id }, { $inc: { lookupCount: 1 } }).catch(() => {});

  const ageMs = inst.asOf ? Date.now() - new Date(inst.asOf).getTime() : Infinity;
  if (inst.lastPrice > 0 && ageMs < maxAgeHours * 3600 * 1000) return inst;

  try {
    const { candles } = await fetchDailyCandles(inst.symbol, inst.exchange, '3mo');
    await applyCandles(inst, candles, 'yahoo');
    if (inst.tier !== 1) {
      inst.tier = 1;
      await inst.save();
      console.log(`[market] promoted ${inst.symbol} to the daily sync`);
    }
    return inst;
  } catch (err) {
    inst.syncError = err.message;
    inst.syncedAt = new Date();
    await inst.save().catch(() => {});
    console.warn(`[market] on-demand price failed for ${inst.symbol}: ${err.message}`);
    return inst.lastPrice > 0 ? inst : null;
  }
}

/** Sync a single symbol on demand (used by the admin route). */
async function syncOne(rawSymbol) {
  const symbol = canonical(rawSymbol);
  const inst = await Instrument.findOne({ symbol });
  if (!inst) throw Object.assign(new Error(`Unknown instrument ${symbol}`), { status: 404 });
  const { candles } = await fetchDailyCandles(inst.symbol, inst.exchange);
  return applyCandles(inst, candles, 'yahoo');
}

/**
 * The price the trade engine fills at. Authoritative — the client's opinion about
 * price is never trusted. Half-spread is applied so a round trip costs something
 * even before charges, which is honest about how real fills work.
 */
const SPREAD_BPS = 4; // 0.04%

function fillPriceFor(instrument, side) {
  const mid = instrument.lastPrice;
  const half = Math.max(0.05, (mid * SPREAD_BPS) / 10000 / 2);
  return round2(side === 'BUY' ? mid + half : mid - half);
}

function quoteWithSpread(instrument) {
  const half = Math.max(0.05, (instrument.lastPrice * SPREAD_BPS) / 10000 / 2);
  return { bid: round2(instrument.lastPrice - half), ask: round2(instrument.lastPrice + half) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

module.exports = {
  fetchDailyCandles, syncAllInstruments, syncOne, applyCandles, ensurePriced, inUseFilter,
  fillPriceFor, quoteWithSpread, SPREAD_BPS, HISTORY_CAP,
};