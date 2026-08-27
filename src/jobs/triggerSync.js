/**
 * Calls the deployed app's own sync endpoint, waking it first.
 *
 * Free-tier hosts spin down idle instances, so firing a sync straight at a
 * sleeping container times out. Poll /api/health until it answers, then sync.
 *
 * Usage: APP_URL=https://x.onrender.com SYNC_TOKEN=... node src/jobs/triggerSync.js
 */
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';

if (!APP_URL) {
  console.error('APP_URL is required, e.g. https://bazaarsimul.onrender.com');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wake() {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const res = await fetch(`${APP_URL}/api/health`, { signal: AbortSignal.timeout(20000) });
      if (res.ok) {
        const body = await res.json();
        console.log(`[trigger] awake — database ${body.database}`);
        return body.database === 'connected';
      }
      console.log(`[trigger] health returned ${res.status} (attempt ${attempt}/12)`);
    } catch {
      console.log(`[trigger] still booting (attempt ${attempt}/12)`);
    }
    await sleep(10000);
  }
  return false;
}

(async () => {
  if (!await wake()) {
    console.error('[trigger] app did not come up, or the database is unreachable');
    process.exit(1);
  }

  // No { all: true }: the tier system exists so the daily job stays small.
  const res = await fetch(`${APP_URL}/api/market/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sync-Token': SYNC_TOKEN },
    body: JSON.stringify({ range: '3mo' }),
    signal: AbortSignal.timeout(900000),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[trigger] sync failed (${res.status}):`, body.error || 'unknown');
    process.exit(1);
  }

  console.log('[trigger]', JSON.stringify(body.report || body, null, 2));

  // Total failure means the provider is throttling — worth a red build.
  if (body.report && body.report.total > 0 && body.report.failed === body.report.total) {
    console.error('[trigger] every symbol failed');
    process.exit(1);
  }
})();