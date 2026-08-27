const express = require('express');
const Instrument = require('../models/Instrument');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');
const { buildPortfolio } = require('../services/portfolioService');
const { canonical } = require('../utils/symbol');
const { quoteWithSpread } = require('../services/marketData');

const router = express.Router();
router.use(requireAuth);

/** GET /api/portfolio — holdings, summary and return metrics. */
router.get('/', asyncHandler(async (req, res) => {
  const portfolio = await buildPortfolio(req.user);
  res.json({ user: req.user.toPublic(), ...portfolio });
}));

/** GET /api/portfolio/returns — just the metrics, for polling. */
router.get('/returns', asyncHandler(async (req, res) => {
  const { returns, summary } = await buildPortfolio(req.user);
  res.json({ returns, summary });
}));

/* ------------------------------------------------------------------ *
 *  Watchlist                                                          *
 * ------------------------------------------------------------------ */

/** GET /api/portfolio/watchlist — symbols hydrated with live quotes. */
router.get('/watchlist', asyncHandler(async (req, res) => {
  const symbols = req.user.watchlist || [];
  if (!symbols.length) return res.json({ watchlist: [] });

  const instruments = await Instrument.find({ symbol: { $in: symbols }, active: true });
  const heldBySymbol = new Map(req.user.positions.map((p) => [p.symbol, p.quantity]));

  // Preserve the user's ordering rather than Mongo's.
  const ordered = symbols
    .map((s) => instruments.find((i) => i.symbol === s))
    .filter(Boolean)
    .map((i) => ({
      ...i.toQuote(30),
      ...quoteWithSpread(i),
      heldQuantity: heldBySymbol.get(i.symbol) || 0,
    }));

  res.json({ watchlist: ordered });
}));

/** POST /api/portfolio/watchlist  { symbol } */
router.post('/watchlist', asyncHandler(async (req, res) => {
  const symbol = canonical(req.body?.symbol);
  if (!symbol) return res.status(400).json({ error: 'Symbol is required.', code: 'MISSING_SYMBOL' });

  const exists = await Instrument.exists({ symbol, active: true });
  if (!exists) {
    return res.status(404).json({
      error: `Instrument "${symbol}" is not in the master.`,
      code: 'UNKNOWN_INSTRUMENT', normalised: symbol,
    });
  }

  if (req.user.watchlist.includes(symbol)) {
    return res.json({ message: `${symbol} is already on your watchlist.`, watchlist: req.user.watchlist });
  }
  if (req.user.watchlist.length >= 50) {
    return res.status(400).json({ error: 'Watchlist is capped at 50 instruments.', code: 'WATCHLIST_FULL' });
  }

  req.user.watchlist.push(symbol);
  await req.user.save();
  return res.status(201).json({ message: `${symbol} added.`, watchlist: req.user.watchlist });
}));

/** DELETE /api/portfolio/watchlist/:symbol */
router.delete('/watchlist/:symbol', asyncHandler(async (req, res) => {
  const symbol = canonical(req.params.symbol);
  const before = req.user.watchlist.length;

  req.user.watchlist = req.user.watchlist.filter((s) => s !== symbol);
  if (req.user.watchlist.length === before) {
    return res.status(404).json({ error: `${symbol} is not on your watchlist.`, code: 'NOT_ON_WATCHLIST' });
  }

  await req.user.save();
  return res.json({ message: `${symbol} removed.`, watchlist: req.user.watchlist });
}));

/** PUT /api/portfolio/watchlist  { symbols: [...] } — reorder or bulk replace. */
router.put('/watchlist', asyncHandler(async (req, res) => {
  const requested = Array.isArray(req.body?.symbols) ? req.body.symbols : null;
  if (!requested) return res.status(400).json({ error: 'Send { symbols: [...] }.', code: 'MISSING_SYMBOLS' });

  const symbols = [...new Set(requested.map(canonical).filter(Boolean))].slice(0, 50);
  const known = await Instrument.find({ symbol: { $in: symbols }, active: true }).select('symbol').lean();
  const knownSet = new Set(known.map((i) => i.symbol));

  req.user.watchlist = symbols.filter((s) => knownSet.has(s));
  await req.user.save();

  res.json({
    watchlist: req.user.watchlist,
    rejected: symbols.filter((s) => !knownSet.has(s)),
  });
}));

module.exports = router;