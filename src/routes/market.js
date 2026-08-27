const express = require('express');
const Instrument = require('../models/Instrument');
const { asyncHandler } = require('../middleware/error');
const { canonical, escapeRegex } = require('../utils/symbol');
const { syncAllInstruments, syncOne, quoteWithSpread, ensurePriced } = require('../services/marketData');

const router = express.Router();

/**
 * GET /api/market/search?q=reliance.ns
 *
 * The endpoint that fixes the original bug. Every inbound string is canonicalised
 * before it touches the database, so "RELIANCE", "RELIANCE.NS" and "NSE:RELIANCE"
 * are the same query. An exact symbol match is always promoted to the top.
 */
router.get('/search', asyncHandler(async (req, res) => {
  const raw = String(req.query.q || '').trim();
  if (!raw) return res.json({ query: raw, canonical: '', results: [] });

  const canon = canonical(raw);
  const rx = new RegExp(escapeRegex(canon || raw), 'i');
  const limit = Math.min(20, Number(req.query.limit) || 8);

  const matches = await Instrument.find({
    active: true,
    $or: [{ symbol: rx }, { name: rx }, { sector: rx }],
  }).limit(limit);

  // Rank: exact symbol, then symbol prefix, then name prefix, then the rest.
  const rank = (i) => {
    if (i.symbol === canon) return 0;
    if (i.symbol.startsWith(canon)) return 1;
    if (i.name.toUpperCase().startsWith(canon)) return 2;
    return 3;
  };
  matches.sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));

  return res.json({
    query: raw,
    canonical: canon,
    count: matches.length,
    results: matches.map((i) => ({
      symbol: i.symbol,
      name: i.name,
      sector: i.sector,
      lastPrice: i.lastPrice,
      prevClose: i.prevClose,
      changePct: Math.round(i.changePct * 10000) / 10000,
      asOf: i.asOf,
    })),
    // When nothing matches, say what WAS looked up. Silent normalisation is how
    // symbol bugs stay hidden for weeks.
    hint: matches.length ? undefined
      : `Nothing matched "${raw}" (normalised to "${canon}"). The master holds NSE large- and mid-caps — try RELIANCE or a sector like Banking.`,
  });
}));

/** GET /api/market/quote/:symbol */
router.get('/quote/:symbol', asyncHandler(async (req, res) => {
  const symbol = canonical(req.params.symbol);
  // Fetches a close if we do not hold a fresh one, and promotes the instrument
  // to the daily sync. This is how a 2,000-symbol master stays usable.
  const instrument = await ensurePriced(symbol);

  if (!instrument) {
    return res.status(404).json({
      error: `No price available for "${symbol}". It may be unlisted, suspended, or missing from the provider.`,
      code: 'UNKNOWN_INSTRUMENT',
      requested: req.params.symbol,
      normalised: symbol,
    });
  }

  const points = Math.min(260, Number(req.query.history) || 60);
  return res.json({ quote: { ...instrument.toQuote(points), ...quoteWithSpread(instrument) } });
}));

/** GET /api/market/quotes?symbols=RELIANCE,TCS — one round trip for a watchlist. */
router.get('/quotes', asyncHandler(async (req, res) => {
  const symbols = String(req.query.symbols || '')
    .split(',').map(canonical).filter(Boolean).slice(0, 60);

  if (!symbols.length) return res.json({ quotes: [] });

  const instruments = await Instrument.find({ symbol: { $in: symbols }, active: true });
  const points = Math.min(120, Number(req.query.history) || 0);

  return res.json({
    quotes: instruments.map((i) => ({ ...i.toQuote(points), ...quoteWithSpread(i) })),
    missing: symbols.filter((s) => !instruments.some((i) => i.symbol === s)),
  });
}));

/**
 * GET /api/market/instruments — the symbols the client caches locally.
 *
 * Defaults to tier 1 and a hard cap, because the full NSE master is ~2,500 rows
 * and about 470 KB of JSON. The frontend uses this only to draw a 40-item ticker
 * tape, so shipping the whole master on every login was 40x more data than the
 * page needs. Search and quotes hit the API live, so nothing is lost.
 *
 * Pass ?all=true for the full master (useful for an offline symbol picker).
 */
router.get('/instruments', asyncHandler(async (req, res) => {
  const all = req.query.all === 'true';
  const limit = Math.min(all ? 3000 : 200, Number(req.query.limit) || (all ? 3000 : 60));

  const filter = { active: true };
  if (!all) {
    filter.tier = 1;
    filter.lastPrice = { $gt: 0 };   // unpriced rows would render as 0.00 in the tape
  }

  const instruments = await Instrument.find(filter)
    .select('symbol name sector exchange lastPrice prevClose asOf')
    .sort({ lookupCount: -1, symbol: 1 })   // most-viewed first
    .limit(limit)
    .lean();

  const total = await Instrument.countDocuments({ active: true });
  res.json({ count: instruments.length, totalAvailable: total, instruments });
}));

/** GET /api/market/status — is our price data fresh? */
router.get('/status', asyncHandler(async (req, res) => {
  const [total, priced, newest, failed] = await Promise.all([
    Instrument.countDocuments({ active: true }),
    Instrument.countDocuments({ active: true, lastPrice: { $gt: 0 } }),
    Instrument.findOne({ active: true }).sort({ asOf: -1 }).select('asOf syncedAt priceSource').lean(),
    Instrument.countDocuments({ active: true, syncError: { $exists: true, $ne: null } }),
  ]);

  const asOf = newest?.asOf ? new Date(newest.asOf) : null;
  const ageHours = asOf ? (Date.now() - asOf.getTime()) / 3600000 : null;

  res.json({
    instruments: total,
    priced,
    unpriced: total - priced,
    syncFailures: failed,
    latestTradingDate: asOf,
    lastSyncedAt: newest?.syncedAt ?? null,
    priceSource: newest?.priceSource ?? null,
    dataAgeHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    // EOD data is a day behind by design; flag only genuinely stale data.
    stale: ageHours !== null && ageHours > 96,
  });
}));

/** POST /api/market/sync — manual pull. Protect this before going public. */
router.post('/sync', asyncHandler(async (req, res) => {
  if (process.env.SYNC_TOKEN && req.headers['x-sync-token'] !== process.env.SYNC_TOKEN) {
    return res.status(403).json({ error: 'Bad sync token.', code: 'FORBIDDEN' });
  }
  const symbol = req.body?.symbol;
  if (symbol) {
    const inst = await syncOne(symbol);
    return res.json({ message: `Synced ${inst.symbol}.`, quote: inst.toQuote(5) });
  }
  // { all: true } forces the entire master. Expect throttling past a few hundred.
  const report = await syncAllInstruments({ range: req.body?.range || '3mo', all: req.body?.all === true });
  return res.json({ message: 'Sync complete.', report });
}));

module.exports = router;