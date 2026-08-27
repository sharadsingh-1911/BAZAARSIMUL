const express = require('express');
const Order = require('../models/Order');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');
const { previewOrder, executeOrder } = require('../services/tradeEngine');
const { buildPortfolio } = require('../services/portfolioService');

const router = express.Router();
router.use(requireAuth);

/**
 * POST /api/orders/preview
 * Body: { symbol, side, quantity, orderType?, limitPrice? }
 *
 * Returns exactly what the fill would cost. The order pad calls this on every
 * keystroke so the preview and the fill can never disagree — same code path.
 */
router.post('/preview', asyncHandler(async (req, res) => {
  const preview = await previewOrder({ user: req.user, ...req.body });
  res.json({ preview });
}));

/** POST /api/orders — place and fill. */
router.post('/', asyncHandler(async (req, res) => {
  const { order, cash } = await executeOrder({ user: req.user, ...req.body });
  const portfolio = await buildPortfolio(req.user);

  res.status(201).json({
    message: `${order.side} ${order.quantity} ${order.symbol} filled at ₹${order.fillPrice.toFixed(2)}.`,
    order,
    cash,
    ...portfolio,
  });
}));

/** GET /api/orders?limit=50&symbol=RELIANCE&side=BUY */
router.get('/', asyncHandler(async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const page = Math.max(1, Number(req.query.page) || 1);

  const filter = { user: req.user._id };
  if (req.query.symbol) filter.symbol = String(req.query.symbol).toUpperCase();
  if (['BUY', 'SELL'].includes(req.query.side)) filter.side = req.query.side;

  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ placedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);

  res.json({ page, limit, total, pages: Math.ceil(total / limit), orders });
}));

/** GET /api/orders/stats — realised P&L broken down by symbol. */
router.get('/stats', asyncHandler(async (req, res) => {
  const rows = await Order.aggregate([
    { $match: { user: req.user._id } },
    { $group: {
      _id: '$symbol',
      trades: { $sum: 1 },
      buys: { $sum: { $cond: [{ $eq: ['$side', 'BUY'] }, 1, 0] } },
      sells: { $sum: { $cond: [{ $eq: ['$side', 'SELL'] }, 1, 0] } },
      turnover: { $sum: '$turnover' },
      charges: { $sum: '$charges.total' },
      realised: { $sum: { $ifNull: ['$realisedPnl', 0] } },
    } },
    { $sort: { realised: -1 } },
  ]);

  const wins = rows.filter((r) => r.realised > 0).length;
  const closed = rows.filter((r) => r.sells > 0).length;

  res.json({
    bySymbol: rows.map((r) => ({ symbol: r._id, ...r, _id: undefined })),
    totals: {
      turnover: round2(rows.reduce((t, r) => t + r.turnover, 0)),
      charges: round2(rows.reduce((t, r) => t + r.charges, 0)),
      realised: round2(rows.reduce((t, r) => t + r.realised, 0)),
      winRatePct: closed ? Math.round((wins / closed) * 1000) / 10 : null,
    },
  });
}));

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

module.exports = router;