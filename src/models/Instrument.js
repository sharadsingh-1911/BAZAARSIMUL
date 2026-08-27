const mongoose = require('mongoose');

const candleSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  open: Number,
  high: Number,
  low: Number,
  close: { type: Number, required: true },
  volume: Number,
}, { _id: false });

/**
 * The instrument master. `symbol` is the canonical bare form ("RELIANCE") and is
 * the ONLY thing stored or looked up. Provider suffixes are built at call time by
 * utils/symbol.js — see the comment there for why this matters.
 */
const instrumentSchema = new mongoose.Schema({
  symbol: {
    type: String, required: true, unique: true, uppercase: true, trim: true,
    // Hyphens are allowed: BAJAJ-AUTO and BAJAJ-FINSV are real NSE symbols.
    match: [/^[A-Z0-9&][A-Z0-9&\-]*$/, 'Symbol must be the bare canonical form, e.g. RELIANCE or BAJAJ-AUTO'],
  },
  name: { type: String, required: true, trim: true },
  sector: { type: String, trim: true, index: true },
  exchange: { type: String, enum: ['NSE', 'BSE'], default: 'NSE' },
  isin: { type: String, trim: true },
  lotSize: { type: Number, default: 1 },
  active: { type: Boolean, default: true },

  // Sync tier. 1 = refreshed by the daily job. 2 = priced on demand only.
  // With ~2,000 NSE symbols a nightly pull for all of them would be throttled,
  // so only instruments people actually use get a scheduled refresh.
  tier: { type: Number, enum: [1, 2], default: 2, index: true },
  lookupCount: { type: Number, default: 0 },

  // --- price cache, written by the EOD sync job ---
  lastPrice: { type: Number, default: 0 },   // most recent close we hold
  prevClose: { type: Number, default: 0 },   // the close before that
  dayOpen: Number,
  dayHigh: Number,
  dayLow: Number,
  volume: Number,
  asOf: Date,                                 // trading date of lastPrice
  priceSource: { type: String, enum: ['yahoo', 'seed', 'manual'], default: 'seed' },
  syncedAt: Date,
  syncError: String,

  // Rolling window for sparklines. Capped in the sync job, not by Mongo.
  history: { type: [candleSchema], default: [] },
}, { timestamps: true });

// Text index powers name search; symbol has its own unique index already.
instrumentSchema.index({ name: 'text', symbol: 'text' });

instrumentSchema.virtual('change').get(function () {
  return this.prevClose ? this.lastPrice - this.prevClose : 0;
});
instrumentSchema.virtual('changePct').get(function () {
  return this.prevClose ? ((this.lastPrice - this.prevClose) / this.prevClose) * 100 : 0;
});

/** Shape sent to the client. Trimmed history keeps payloads small. */
instrumentSchema.methods.toQuote = function toQuote(historyPoints = 60) {
  return {
    symbol: this.symbol,
    name: this.name,
    sector: this.sector,
    exchange: this.exchange,
    lastPrice: r2(this.lastPrice),
    prevClose: r2(this.prevClose),
    change: r2(this.change),
    changePct: r4(this.changePct),
    dayOpen: r2(this.dayOpen),
    dayHigh: r2(this.dayHigh),
    dayLow: r2(this.dayLow),
    volume: this.volume,
    asOf: this.asOf,
    priceSource: this.priceSource,
    history: (this.history || []).slice(-historyPoints).map((c) => ({
      date: c.date, close: r2(c.close),
    })),
  };
};

const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const r4 = (n) => (n == null ? null : Math.round(n * 10000) / 10000);

module.exports = mongoose.model('Instrument', instrumentSchema);