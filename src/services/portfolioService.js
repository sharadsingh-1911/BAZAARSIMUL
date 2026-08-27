const Instrument = require('../models/Instrument');
const { computeReturns } = require('../utils/returns');

/**
 * Values a user's book against the latest prices we hold.
 * One query for all held instruments — not one per position.
 */
async function buildPortfolio(user) {
  const symbols = user.positions.map((p) => p.symbol);
  const instruments = symbols.length
    ? await Instrument.find({ symbol: { $in: symbols } }).lean()
    : [];
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));

  const holdings = user.positions.map((p) => {
    const inst = bySymbol.get(p.symbol);
    const lastPrice = inst?.lastPrice ?? p.avgCost; // no price yet: value at cost
    const marketValue = lastPrice * p.quantity;
    const investedValue = p.avgCost * p.quantity;
    const unrealisedPnl = marketValue - investedValue;

    return {
      symbol: p.symbol,
      name: inst?.name ?? p.symbol,
      sector: inst?.sector ?? null,
      quantity: p.quantity,
      avgCost: r2(p.avgCost),
      lastPrice: r2(lastPrice),
      prevClose: r2(inst?.prevClose ?? lastPrice),
      dayChangePct: inst?.prevClose ? r4(((lastPrice - inst.prevClose) / inst.prevClose) * 100) : 0,
      investedValue: r2(investedValue),
      marketValue: r2(marketValue),
      unrealisedPnl: r2(unrealisedPnl),
      unrealisedPnlPct: investedValue ? r4((unrealisedPnl / investedValue) * 100) : 0,
      asOf: inst?.asOf ?? null,
      priceStale: !inst?.lastPrice,
      firstBoughtAt: p.firstBoughtAt,
    };
  });

  const marketValue = holdings.reduce((t, h) => t + h.marketValue, 0);
  const investedValue = holdings.reduce((t, h) => t + h.investedValue, 0);
  const unrealisedPnl = holdings.reduce((t, h) => t + h.unrealisedPnl, 0);
  const netWorth = user.cash + marketValue;

  // Portfolio weights, computed after the total is known.
  holdings.forEach((h) => { h.weightPct = marketValue ? r4((h.marketValue / marketValue) * 100) : 0; });
  holdings.sort((a, b) => b.marketValue - a.marketValue);

  const returns = computeReturns({
    funded: user.fundedCapital,
    fundedAt: user.fundedAt,
    netWorth,
    minCagrDays: Number(process.env.MIN_CAGR_DAYS || 30),
  });

  return {
    summary: {
      cash: r2(user.cash),
      marketValue: r2(marketValue),
      investedValue: r2(investedValue),
      netWorth: r2(netWorth),
      unrealisedPnl: r2(unrealisedPnl),
      unrealisedPnlPct: investedValue ? r4((unrealisedPnl / investedValue) * 100) : 0,
      realisedPnl: r2(user.realisedPnl),
      totalCharges: r2(user.totalCharges),
      tradeCount: user.tradeCount,
      positionCount: holdings.length,
    },
    returns,
    holdings,
  };
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

module.exports = { buildPortfolio };