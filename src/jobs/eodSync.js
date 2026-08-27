const cron = require('node-cron');
const { syncAllInstruments } = require('../services/marketData');

/**
 * Schedules the daily EOD pull.
 *
 * Default: 18:30 IST, Monday to Friday. That is three hours after the 15:30
 * close, which gives the provider time to settle the official close. Pulling at
 * 15:35 often returns a provisional figure that gets revised.
 *
 * On a platform that sleeps idle dynos (Render free, Railway), in-process cron
 * will silently stop firing. Use the platform's own scheduler to POST
 * /api/market/sync with the X-Sync-Token header instead, and set ENABLE_CRON=false.
 */
function startScheduler() {
  if (String(process.env.ENABLE_CRON).toLowerCase() === 'false') {
    console.log('[cron] disabled by ENABLE_CRON=false');
    return null;
  }

  const expression = process.env.EOD_CRON || '30 18 * * 1-5';
  const timezone = process.env.EOD_CRON_TZ || 'Asia/Kolkata';

  if (!cron.validate(expression)) {
    console.error(`[cron] invalid EOD_CRON "${expression}" — scheduler not started`);
    return null;
  }

  let running = false;
  const task = cron.schedule(expression, async () => {
    if (running) {
      console.warn('[cron] previous sync still running, skipping this tick');
      return;
    }
    running = true;
    console.log('[cron] starting EOD sync');
    try {
      const report = await syncAllInstruments({ range: '3mo' });
      console.log(`[cron] EOD sync finished — ${report.updated}/${report.total} updated`);
    } catch (err) {
      console.error('[cron] EOD sync failed:', err.message);
    } finally {
      running = false;
    }
  }, { timezone, scheduled: true });

  console.log(`[cron] EOD sync scheduled "${expression}" (${timezone})`);
  return task;
}

module.exports = { startScheduler };