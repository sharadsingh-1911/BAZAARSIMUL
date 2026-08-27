/**
 * Charges for equity delivery on NSE, as of the 2025-26 schedule.
 * Rates live in one place so you can version them when SEBI revises anything.
 *
 * Discount brokers charge zero brokerage on delivery, so the entire cost is
 * statutory. Modelling it matters: a beginner who round-trips a position forty
 * times learns from the ledger why the account bled, which a zero-friction
 * simulator can never teach.
 */
const RATES = {
  brokerage: 0,          // delivery, discount broker
  stt: 0.001,            // 0.1% of turnover, both sides
  exchangeTxn: 0.0000297, // NSE 0.00297%
  sebi: 0.000001,        // 0.0001%
  stampDuty: 0.00015,    // 0.015%, BUY side only
  gst: 0.18,             // on brokerage + exchange + SEBI
  dpCharge: 15.93,       // flat per scrip on SELL (CDSL + broker, incl. GST)
};

/**
 * @param {'BUY'|'SELL'} side
 * @param {number} turnover  price * quantity
 * @returns {{brokerage,stt,exchangeTxn,sebi,stampDuty,gst,dpCharge,total}}
 */
function computeCharges(side, turnover) {
  const t = Math.max(0, Number(turnover) || 0);
  const isBuy = side === 'BUY';

  const brokerage = RATES.brokerage * t;
  const stt = RATES.stt * t;
  const exchangeTxn = RATES.exchangeTxn * t;
  const sebi = RATES.sebi * t;
  const stampDuty = isBuy ? RATES.stampDuty * t : 0;
  const dpCharge = isBuy ? 0 : RATES.dpCharge;
  const gst = (brokerage + exchangeTxn + sebi) * RATES.gst;

  const total = brokerage + stt + exchangeTxn + sebi + stampDuty + dpCharge + gst;

  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    brokerage: r2(brokerage),
    stt: r2(stt),
    exchangeTxn: r2(exchangeTxn),
    sebi: r2(sebi),
    stampDuty: r2(stampDuty),
    dpCharge: r2(dpCharge),
    gst: r2(gst),
    total: r2(total),
  };
}

module.exports = { computeCharges, RATES };