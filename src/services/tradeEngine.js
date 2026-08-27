const Instrument = require('../models/Instrument');
const Order = require('../models/Order');
const { computeCharges } = require('../utils/charges');
const { fillPriceFor, quoteWithSpread, ensurePriced } = require('./marketData');
const { canonical } = require('../utils/symbol');

/**
 * The trade engine.
 *
 * Rule: the client sends intent only — symbol, side, quantity, order type, limit.
 * Price, charges, cash checks and cost basis are all derived here. A client that
 * posts {"fillPrice": 1} gets ignored, because we never read a price off the wire.
 */

class TradeError extends Error {
  constructor(message, status = 400, code = 'TRADE_REJECTED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Price the order without touching the account. Powers the order pad preview, so
 * what the user sees before confirming is computed by the same code that fills.
 */
async function previewOrder({ user, symbol, side, quantity, orderType = 'MARKET', limitPrice }) {
  const { instrument, qty, fillPrice } = await resolve({ symbol, side, quantity, orderType, limitPrice });

  const turnover = round2(fillPrice * qty);
  const charges = computeCharges(side, turnover);
  const netAmount = round2(side === 'BUY' ? turnover + charges.total : turnover - charges.total);

  const position = user.findPosition(instrument.symbol);
  const held = position ? position.quantity : 0;
  const { bid, ask } = quoteWithSpread(instrument);

  const errors = [];
  if (side === 'BUY' && netAmount > user.cash) {
    errors.push(`Short by ₹${(netAmount - user.cash).toFixed(2)}. Reduce quantity or free up cash.`);
  }
  if (side === 'SELL' && qty > held) {
    errors.push(held ? `You hold ${held}. Cannot sell ${qty}.` : 'No position to sell.');
  }

  return {
    symbol: instrument.symbol,
    name: instrument.name,
    side,
    orderType,
    quantity: qty,
    fillPrice,
    bid,
    ask,
    turnover,
    charges,
    netAmount,
    heldQuantity: held,
    availableCash: round2(user.cash),
    executable: errors.length === 0,
    errors,
  };
}

/**
 * Execute. Mutates the user document and appends an Order.
 * Cash and position live in the same document, so the write is atomic.
 */
async function executeOrder({ user, symbol, side, quantity, orderType = 'MARKET', limitPrice }) {
  const { instrument, qty, fillPrice } = await resolve({ symbol, side, quantity, orderType, limitPrice });

  const turnover = round2(fillPrice * qty);
  const charges = computeCharges(side, turnover);
  let netAmount;
  let realisedPnl = null;

  if (side === 'BUY') {
    netAmount = round2(turnover + charges.total);
    if (netAmount > user.cash) {
      throw new TradeError(
        `Insufficient funds. Need ₹${netAmount.toFixed(2)}, available ₹${user.cash.toFixed(2)}.`,
        400, 'INSUFFICIENT_FUNDS',
      );
    }

    const existing = user.findPosition(instrument.symbol);
    if (existing) {
      // Weighted average, with entry charges folded into the cost basis so that
      // displayed P&L is net of what the user actually paid.
      const totalCost = existing.avgCost * existing.quantity + netAmount;
      existing.quantity += qty;
      existing.avgCost = round4(totalCost / existing.quantity);
    } else {
      user.positions.push({
        symbol: instrument.symbol,
        quantity: qty,
        avgCost: round4(netAmount / qty),
        firstBoughtAt: new Date(),
      });
    }
    user.cash = round2(user.cash - netAmount);
  } else {
    const existing = user.findPosition(instrument.symbol);
    if (!existing || existing.quantity < qty) {
      throw new TradeError(
        existing ? `You hold ${existing.quantity} ${instrument.symbol}. Cannot sell ${qty}.`
                 : `No position in ${instrument.symbol}.`,
        400, 'INSUFFICIENT_HOLDINGS',
      );
    }
    netAmount = round2(turnover - charges.total);
    realisedPnl = round2((fillPrice - existing.avgCost) * qty - charges.total);

    existing.quantity -= qty;
    if (existing.quantity === 0) {
      user.positions = user.positions.filter((p) => p.symbol !== instrument.symbol);
    }
    user.cash = round2(user.cash + netAmount);
    user.realisedPnl = round2(user.realisedPnl + realisedPnl);
  }

  user.totalCharges = round2(user.totalCharges + charges.total);
  user.tradeCount += 1;

  // Order numbering comes off the user document, incremented in the same save as
  // the cash and position change. Unique within the account, which is what the
  // {user, reference} index enforces.
  user.orderSeq = (user.orderSeq || 0) + 1;
  const reference = `BS-${String(user.orderSeq).padStart(6, '0')}`;

  await user.save();

  const after = user.findPosition(instrument.symbol);
  const order = await Order.create({
    user: user._id,
    reference,
    symbol: instrument.symbol,
    name: instrument.name,
    side,
    orderType,
    status: 'FILLED',
    quantity: qty,
    limitPrice: orderType === 'LIMIT' ? round2(limitPrice) : undefined,
    fillPrice,
    turnover,
    charges,
    netAmount,
    realisedPnl,
    positionAfter: after ? { quantity: after.quantity, avgCost: after.avgCost } : { quantity: 0, avgCost: 0 },
    placedAt: new Date(),
  });

  return { order, cash: user.cash };
}

/** Shared validation + pricing for preview and execute. */
/** Shared validation + pricing for preview and execute. */
async function resolve({ symbol, side, quantity, orderType, limitPrice }) {
  const canon = canonical(symbol);
  if (!canon) throw new TradeError('Symbol is required.', 400, 'BAD_SYMBOL');
  if (!['BUY', 'SELL'].includes(side)) throw new TradeError('Side must be BUY or SELL.', 400, 'BAD_SIDE');

  // Equities trade in whole shares. Reject a fractional quantity rather than
  // silently flooring it — a user who typed 1.7 should be told, not surprised.
  const raw = Number(quantity);
  if (!Number.isFinite(raw)) throw new TradeError('Quantity must be a number.', 400, 'BAD_QUANTITY');
  if (!Number.isInteger(raw)) throw new TradeError(`Quantity must be a whole number of shares. Got ${raw}.`, 400, 'BAD_QUANTITY');
  const qty = raw;
  if (qty < 1) throw new TradeError('Quantity must be at least 1.', 400, 'BAD_QUANTITY');
  if (qty > 1000000) throw new TradeError('Quantity exceeds the per-order cap of 1,000,000.', 400, 'BAD_QUANTITY');

  // ensurePriced fetches a close on demand for instruments imported from the
  // NSE master that nobody has opened yet.
  const instrument = await ensurePriced(canon);
  if (!instrument) {
    throw new TradeError(
      `Instrument "${canon}" is not tradeable here. Search for it first.`,
      404, 'UNKNOWN_INSTRUMENT',
    );
  }
  if (!instrument.lastPrice) {
    throw new TradeError(
      `No price available for ${canon}. It may be suspended or newly listed.`,
      503, 'NO_PRICE',
    );
  }

  const marketPrice = fillPriceFor(instrument, side);

  if (orderType === 'LIMIT') {
    const lp = Number(limitPrice);
    if (!Number.isFinite(lp) || lp <= 0) throw new TradeError('A limit order needs a positive limit price.', 400, 'BAD_LIMIT');
    // A limit that would not cross the book rests unfilled rather than silently
    // filling at a better price than the market offers.
    if (side === 'BUY' && lp < marketPrice) {
      throw new TradeError(`Limit ₹${lp.toFixed(2)} is below the ask ₹${marketPrice.toFixed(2)}. Order would rest unfilled.`, 400, 'NO_FILL');
    }
    if (side === 'SELL' && lp > marketPrice) {
      throw new TradeError(`Limit ₹${lp.toFixed(2)} is above the bid ₹${marketPrice.toFixed(2)}. Order would rest unfilled.`, 400, 'NO_FILL');
    }
  }

  return { instrument, qty, fillPrice: marketPrice };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

module.exports = { previewOrder, executeOrder, TradeError };