require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Instrument = require('../models/Instrument');
const { canonical } = require('../utils/symbol');

/**
 * Imports the full NSE equity master from a locally saved EQUITY_L.csv.
 *
 *   1. Open https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv
 *      in a browser and save it to data/EQUITY_L.csv
 *   2. npm run import:nse
 *
 * Why not download it in code: NSE blocks non-browser requests unless you first
 * fetch a cookie from nseindia.com and replay it with a full browser User-Agent.
 * It works, it breaks often, and it is not worth the maintenance for a file you
 * refresh monthly.
 *
 * Imported instruments land unpriced at tier 2 — excluded from the daily sync
 * and priced on demand the first time someone opens them. See ensurePriced()
 * in services/marketData.js for why that matters at this scale.
 */

const FILE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', '..', 'data', 'EQUITY_L.csv');

// Settlement series we trade. EQ is normal rolling settlement; BE is
// trade-to-trade. Everything else — RE (rights entitlements), E1/E2 (partly
// paid), W (warrants), GB, IV — does not belong in a delivery simulator.
const TRADEABLE_SERIES = new Set(['EQ', 'BE']);

/** CSV split that respects quoted fields containing commas. */
function splitRow(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

async function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`\nNot found: ${FILE}\n`);
    console.error('Download the NSE equity master and save it there:');
    console.error('  https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv\n');
    console.error('Or pass a path:  npm run import:nse -- ~/Downloads/EQUITY_L.csv\n');
    process.exit(1);
  }

  await connectDB();

  const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    console.error('[import] file has no data rows');
    process.exit(1);
  }

  const header = splitRow(lines[0]).map((h) => h.toUpperCase());
  const iSymbol = header.indexOf('SYMBOL');
  const iName = header.indexOf('NAME OF COMPANY');
  const iSeries = header.indexOf('SERIES');
  const iIsin = header.indexOf('ISIN NUMBER');

  if (iSymbol === -1 || iName === -1) {
    console.error('[import] unexpected header — is this EQUITY_L.csv?');
    console.error('[import] found:', header.join(' | '));
    process.exit(1);
  }

  const ops = [];
  const seen = new Set();
  const skipped = { series: 0, unparseable: 0, duplicate: 0 };

  for (const line of lines.slice(1)) {
    const f = splitRow(line);

    const series = (f[iSeries] || '').toUpperCase();
    if (iSeries !== -1 && !TRADEABLE_SERIES.has(series)) { skipped.series += 1; continue; }

    const symbol = canonical(f[iSymbol]);
    if (!symbol) { skipped.unparseable += 1; continue; }
    if (seen.has(symbol)) { skipped.duplicate += 1; continue; }
    seen.add(symbol);

    ops.push({
      updateOne: {
        filter: { symbol },
        update: {
          $set: {
            name: f[iName] || symbol,
            exchange: 'NSE',
            active: true,
            ...(iIsin !== -1 && f[iIsin] ? { isin: f[iIsin] } : {}),
          },
          // Only on insert, so a re-import never clobbers a price or a tier
          // promotion earned through real usage.
          $setOnInsert: {
            lastPrice: 0,
            prevClose: 0,
            priceSource: 'seed',
            tier: 2,
            lookupCount: 0,
            history: [],
          },
        },
        upsert: true,
      },
    });
  }

  console.log(`[import] ${ops.length} tradeable rows parsed`);
  console.log(`[import] skipped — ${skipped.series} non-EQ/BE series, ` +
              `${skipped.unparseable} unparseable, ${skipped.duplicate} duplicates`);

  // Chunked: a single 2,000-op bulkWrite is enough to trip Atlas M0 limits.
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const res = await Instrument.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    inserted += res.upsertedCount || 0;
    updated += res.modifiedCount || 0;
    process.stdout.write(`\r[import] written ${Math.min(i + 500, ops.length)}/${ops.length}`);
  }
  process.stdout.write('\n');

  const [total, priced, tier1] = await Promise.all([
    Instrument.countDocuments({ active: true }),
    Instrument.countDocuments({ active: true, lastPrice: { $gt: 0 } }),
    Instrument.countDocuments({ active: true, tier: 1 }),
  ]);

  console.log(`[import] ${inserted} new, ${updated} refreshed`);
  console.log(`[import] master now holds ${total} instruments — ${priced} priced, ${tier1} on the daily sync`);
  console.log('[import] the rest are priced on demand when first opened');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\n[import] failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});