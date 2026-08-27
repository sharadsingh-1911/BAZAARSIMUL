const express = require('express');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const Order = require('../models/Order');
const Instrument = require('../models/Instrument');
const { requireAuth, signToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');
const { buildPortfolio } = require('../services/portfolioService');
const { computeReturns } = require('../utils/returns');

const router = express.Router();

// Credential endpoints get a tighter limit than the rest of the API.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  message: { error: 'Too many attempts. Try again in 15 minutes.', code: 'RATE_LIMIT' },
});

const START = () => Number(process.env.STARTING_CAPITAL || 100000);

/** POST /api/auth/register */
router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  const { username, password, email, displayName } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.', code: 'MISSING_FIELDS' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.', code: 'WEAK_PASSWORD' });
  }

  const capital = START();
  const user = await User.create({
    username: String(username).toLowerCase().trim(),
    displayName: displayName?.trim() || undefined,
    email: email?.trim() || undefined,
    passwordHash: password,          // hashed by the pre-save hook
    cash: capital,
    fundedCapital: capital,
    fundedAt: new Date(),
    cashflows: [{ amount: capital, kind: 'FUNDING', at: new Date() }],
  });

  return res.status(201).json({ token: signToken(user), user: user.toPublic() });
}));

/** POST /api/auth/login */
router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.', code: 'MISSING_FIELDS' });
  }

  const user = await User.findOne({ username: String(username).toLowerCase().trim() })
    .select('+passwordHash');

  // Same message either way, so the endpoint does not confirm which usernames exist.
  const ok = user && await user.verifyPassword(String(password));
  if (!ok) {
    return res.status(401).json({ error: 'Wrong username or password.', code: 'BAD_CREDENTIALS' });
  }

  user.lastLoginAt = new Date();
  await user.save();

  return res.json({ token: signToken(user), user: user.toPublic() });
}));

/** GET /api/auth/me — account plus valued portfolio, for app boot. */
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const portfolio = await buildPortfolio(req.user);
  res.json({ user: req.user.toPublic(), ...portfolio });
}));

/** POST /api/auth/reset — wipe the book, keep the login and watchlist. */
router.post('/reset', requireAuth, asyncHandler(async (req, res) => {
  const user = req.user;
  const capital = START();

  await Order.deleteMany({ user: user._id });

  user.cash = capital;
  user.fundedCapital = capital;
  user.fundedAt = new Date();
  user.cashflows = [{ amount: capital, kind: 'FUNDING', at: new Date() }];
  user.positions = [];
  user.realisedPnl = 0;
  user.totalCharges = 0;
  user.tradeCount = 0;
  await user.save();

  const portfolio = await buildPortfolio(user);
  res.json({ message: 'Account reset.', user: user.toPublic(), ...portfolio });
}));

/**
 * POST /api/auth/backdate — development helper.
 * Moves fundedAt into the past so the CAGR guard can be exercised without
 * waiting thirty real days. Disabled in production, deliberately.
 */
router.post('/backdate', requireAuth, asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production.', code: 'FORBIDDEN' });
  }
  const days = Math.max(0, Math.min(3650, Number(req.body?.days) || 0));
  req.user.fundedAt = new Date(Date.now() - days * 86400000);
  await req.user.save();

  const portfolio = await buildPortfolio(req.user);
  return res.json({ message: `Funding backdated ${days} days.`, user: req.user.toPublic(), ...portfolio });
}));

/**
 * GET /api/auth/leaderboard — public ranking by total return.
 *
 * Two queries total regardless of how many accounts exist: one for the users,
 * one for every instrument they collectively hold. The previous shape called
 * buildPortfolio() per user, which was one query per user plus one per holding
 * and fell over past a few dozen accounts.
 *
 * Ranking is by absolute return, not CAGR: annualising a three-day account
 * produces a meaningless leader. ?minDays= filters out accounts too new to
 * compare fairly. Accounts with no trades are excluded so an untouched book
 * cannot sit at 0% mid-table.
 */
router.get('/leaderboard', asyncHandler(async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const minDays = Math.max(0, Number(req.query.minDays) || 0);

  const users = await User.find({ tradeCount: { $gt: 0 } })
    .select('username displayName cash fundedCapital fundedAt realisedPnl totalCharges tradeCount positions')
    .lean();

  if (!users.length) {
    return res.json({ leaderboard: [], note: 'No accounts have traded yet.' });
  }

  const symbols = [...new Set(users.flatMap((u) => (u.positions || []).map((p) => p.symbol)))];
  const instruments = symbols.length
    ? await Instrument.find({ symbol: { $in: symbols } }).select('symbol lastPrice').lean()
    : [];
  const priceOf = new Map(instruments.map((i) => [i.symbol, i.lastPrice]));

  const rows = users.map((u) => {
    // No price on record (deactivated or never synced): value at cost, so a
    // stuck position does not read as a total loss.
    const marketValue = (u.positions || []).reduce(
      (t, p) => t + p.quantity * (priceOf.get(p.symbol) || p.avgCost), 0,
    );

    const r = computeReturns({
      funded: u.fundedCapital,
      fundedAt: u.fundedAt,
      netWorth: u.cash + marketValue,
      minCagrDays: Number(process.env.MIN_CAGR_DAYS || 30),
    });

    return {
      username: u.username,
      displayName: u.displayName || u.username,
      netWorth: r.netWorth,
      absoluteReturnPct: r.absoluteReturnPct,
      cagrPct: r.cagrReliable ? r.cagrPct : null,
      holdingPeriodDays: r.holdingPeriodDays,
      tradeCount: u.tradeCount,
      totalCharges: Math.round((u.totalCharges || 0) * 100) / 100,
    };
  }).filter((r) => r.holdingPeriodDays >= minDays);

  rows.sort((a, b) => b.absoluteReturnPct - a.absoluteReturnPct);

  res.json({
    leaderboard: rows.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r })),
    accountsRanked: rows.length,
    note: 'Ranked by absolute return. Accounts with no trades are excluded.',
  });
}));

module.exports = router;