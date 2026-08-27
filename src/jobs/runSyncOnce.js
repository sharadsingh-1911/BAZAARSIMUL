require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const { syncAllInstruments } = require('../services/marketData');

/**
 * One-shot EOD sync, then exit. Use this from an external scheduler:
 *   GitHub Actions:  npm run sync
 *   Render cron job: node src/jobs/runSyncOnce.js
 *   Local:           npm run sync
 */
(async () => {
  try {
    await connectDB();
    const report = await syncAllInstruments({ range: process.argv[2] || '3mo' });
    console.log(JSON.stringify(report, null, 2));
    await mongoose.disconnect();
    process.exit(report.failed === report.total && report.total > 0 ? 1 : 0);
  } catch (err) {
    console.error('[sync] failed:', err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
})();