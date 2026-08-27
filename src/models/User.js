const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * Positions are EMBEDDED in the user document, deliberately.
 * A trade must mutate cash and a position together or not at all. Keeping both in
 * one document makes every fill a single-document write, which MongoDB guarantees
 * atomically without needing a multi-document transaction. Orders go to their own
 * collection because they are append-only and unbounded.
 */
const positionSchema = new mongoose.Schema({
  symbol: { type: String, required: true, uppercase: true, trim: true },
  quantity: { type: Number, required: true, min: 0 },
  // Average cost INCLUDING charges paid on entry — so displayed P&L is the truth.
  avgCost: { type: Number, required: true, min: 0 },
  firstBoughtAt: { type: Date, default: Date.now },
}, { _id: false });

const cashflowSchema = new mongoose.Schema({
  amount: { type: Number, required: true }, // + = deposit into account
  kind: { type: String, enum: ['FUNDING', 'DEPOSIT', 'WITHDRAWAL'], default: 'DEPOSIT' },
  at: { type: Date, default: Date.now },
}, { _id: false });

const userSchema = new mongoose.Schema({
  username: {
    type: String, required: [true, 'Username is required'], unique: true,
    trim: true, lowercase: true, minlength: 3, maxlength: 20,
    match: [/^[a-z0-9_]+$/, 'Username may contain only lowercase letters, digits and underscores'],
  },
  displayName: { type: String, trim: true, maxlength: 40 },
  email: {
    type: String, trim: true, lowercase: true, sparse: true, unique: true,
    match: [/^\S+@\S+\.\S+$/, 'Enter a valid email address'],
  },
  passwordHash: { type: String, required: true, select: false },

  // --- trading account ---
  cash: { type: Number, required: true, default: 100000, min: 0 },
  fundedCapital: { type: Number, required: true, default: 100000 },
  fundedAt: { type: Date, default: Date.now },
  cashflows: { type: [cashflowSchema], default: [] },
  positions: { type: [positionSchema], default: [] },
  watchlist: { type: [String], default: ['RELIANCE', 'HDFCBANK', 'TCS', 'ZOMATO'] },

  realisedPnl: { type: Number, default: 0 },
  totalCharges: { type: Number, default: 0 },
  tradeCount: { type: Number, default: 0 },

  lastLoginAt: Date,
}, { timestamps: true });

userSchema.index({ realisedPnl: -1 }); // leaderboard

/** Hash on the way in, so no route ever handles a raw password twice. */
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('passwordHash')) return next();
  if (this.passwordHash.startsWith('$2')) return next(); // already hashed
  this.passwordHash = await bcrypt.hash(this.passwordHash, 12);
  next();
});

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.methods.findPosition = function findPosition(symbol) {
  return this.positions.find((p) => p.symbol === symbol);
};

/** Safe projection for API responses — never leaks the hash. */
userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id,
    username: this.username,
    displayName: this.displayName || this.username,
    cash: round2(this.cash),
    fundedCapital: round2(this.fundedCapital),
    fundedAt: this.fundedAt,
    realisedPnl: round2(this.realisedPnl),
    totalCharges: round2(this.totalCharges),
    tradeCount: this.tradeCount,
    watchlist: this.watchlist,
    createdAt: this.createdAt,
  };
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

module.exports = mongoose.model('User', userSchema);