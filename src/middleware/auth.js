const jwt = require('jsonwebtoken');
const User = require('../models/User');

function signToken(user) {
  return jwt.sign(
    { sub: String(user._id), username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
  );
}

/**
 * Loads the full user document (not lean) because the trade engine mutates it.
 * Reading the token from either the Authorization header or an httpOnly cookie
 * lets you move to cookie auth later without touching route code.
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    const token = bearer || req.cookies?.token;

    if (!token) {
      return res.status(401).json({ error: 'Sign in to continue.', code: 'NO_TOKEN' });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(401).json({ error: 'Account no longer exists.', code: 'NO_USER' });
    }

    req.user = user;
    return next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Session expired. Sign in again.' : 'Invalid session.',
      code: expired ? 'TOKEN_EXPIRED' : 'BAD_TOKEN',
    });
  }
}

module.exports = { requireAuth, signToken };