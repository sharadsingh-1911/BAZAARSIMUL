const DAY_MS = 86400000;

/**
 * Return metrics for a paper-trading account.
 *
 * The important part is the CAGR guard. CAGR annualises a return, so over a short
 * window it explodes: a 1% gain held for one day compounds to roughly +3,700% a
 * year. Reporting that is arithmetically correct and financially useless, and it
 * teaches a beginner exactly the wrong lesson. So we compute it, expose the naive
 * value for transparency, and only mark it reliable past MIN_CAGR_DAYS.
 *
 * NOTE ON SCOPE: simple CAGR is only valid while there is a single funding event.
 * The moment you let users top up their balance, switch to XIRR over the cashflow
 * array — `cashflows` is already carried on the user document for that reason.
 */
function computeReturns({ funded, fundedAt, netWorth, minCagrDays = 30 }) {
  const base = Number(funded) || 0;
  const net = Number(netWorth) || 0;
  const start = new Date(fundedAt).getTime();
  const days = Math.max(0, (Date.now() - start) / DAY_MS);
  const years = days / 365;

  const absoluteReturn = base > 0 ? (net - base) / base : 0;
  const cagr = years > 0 && base > 0 && net > 0 ? Math.pow(net / base, 1 / years) - 1 : null;
  const reliable = days >= minCagrDays && cagr !== null;

  return {
    fundedCapital: round2(base),
    netWorth: round2(net),
    absoluteGain: round2(net - base),
    absoluteReturnPct: round4(absoluteReturn * 100),
    holdingPeriodDays: round2(days),
    holdingPeriodLabel: periodLabel(days),
    cagrPct: cagr === null ? null : round4(cagr * 100),
    cagrReliable: reliable,
    minCagrDays,
    // Surfaced so the UI can explain the suppression instead of just hiding it.
    cagrSuppressedReason: reliable
      ? null
      : `CAGR annualises returns, so it is not meaningful over ${periodLabel(days)}. It unlocks at ${minCagrDays} days.`,
  };
}

/**
 * XIRR — money-weighted return over irregular cashflows. Use this once deposits
 * and withdrawals exist. Newton-Raphson with a bisection fallback.
 * @param {Array<{amount:number, date:Date}>} flows negative = money in, positive = money out/value
 */
function xirr(flows, guess = 0.1) {
  if (!flows || flows.length < 2) return null;
  const t0 = new Date(flows[0].date).getTime();
  const yearsFrom = (d) => (new Date(d).getTime() - t0) / (365 * DAY_MS);

  const npv = (r) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, yearsFrom(f.date)), 0);
  const dNpv = (r) => flows.reduce((s, f) => {
    const y = yearsFrom(f.date);
    return s - (y * f.amount) / Math.pow(1 + r, y + 1);
  }, 0);

  let rate = guess;
  for (let i = 0; i < 80; i++) {
    const v = npv(rate);
    if (Math.abs(v) < 1e-7) return rate;
    const d = dNpv(rate);
    if (!isFinite(d) || Math.abs(d) < 1e-12) break;
    const next = rate - v / d;
    if (!isFinite(next) || next <= -0.999999) break;
    rate = next;
  }

  let lo = -0.9999, hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

function periodLabel(days) {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} hours`;
  if (days < 60) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
  if (days < 730) return `${(days / 30.44).toFixed(1)} months`;
  return `${(days / 365).toFixed(1)} years`;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

module.exports = { computeReturns, xirr, periodLabel, DAY_MS };