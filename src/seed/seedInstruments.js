require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Instrument = require('../models/Instrument');
const list = require('./instruments');
const { syncAllInstruments } = require('../services/marketData');

/**
 * Upserts the instrument master, then attempts a real EOD pull.
 *
 * Run with:  npm run seed
 * Skip the price pull with:  npm run seed -- --no-prices
 *
 * Safe to re-run. Existing documents keep their price history; only the
 * descriptive fields are refreshed.
 */
async function main() {
  const skipPrices = process.argv.includes('--no-prices');
  await connectDB();

  let created = 0;
  let updated = 0;

  for (const row of list) {
    const existing = await Instrument.findOne({ symbol: row.symbol });

    if (existing) {
      existing.name = row.name;
      existing.sector = row.sector;
      existing.active = true;
      // Only touch price if we have never had one, so a seed never clobbers real data.
      if (!existing.lastPrice) {
        existing.lastPrice = row.seedPrice;
        existing.prevClose = row.seedPrice;
        existing.priceSource = 'seed';
      }
      await existing.save();
      updated += 1;
    } else {
      await Instrument.create({
        symbol: row.symbol,
        name: row.name,
        sector: row.sector,
        exchange: 'NSE',
        lastPrice: row.seedPrice,
        prevClose: row.seedPrice,
        dayOpen: row.seedPrice,
        dayHigh: row.seedPrice,
        dayLow: row.seedPrice,
        priceSource: 'seed',
        asOf: new Date(),
        history: [{ date: new Date(), close: row.seedPrice }],
      });
      created += 1;
    }
  }

  console.log(`[seed] ${created} created, ${updated} refreshed, ${list.length} total`);

  if (!skipPrices) {
    console.log('[seed] pulling EOD prices from the provider — this takes a minute...');
    const report = await syncAllInstruments({ range: '6mo' });
    console.log(`[seed] prices: ${report.updated} live, ${report.failed} still on seed values`);
    if (report.failed) {
      console.log('[seed] the app works fine on seed prices — retry later with: npm run sync');
    }
  }

  await mongoose.disconnect();
  console.log('[seed] done');
}

main().catch(async (err) => {
  console.error('[seed] failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});