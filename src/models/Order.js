const mongoose = require('mongoose');

const chargesSchema = new mongoose.Schema({
  brokerage: Number,
  stt: Number,
  exchangeTxn: Number,
  sebi: Number,
  stampDuty: Number,
  dpCharge: Number,
  gst: Number,
  total: Number,
}, { _id: false });

/**
 * One document per fill. Append-only: never updated after creation, so it doubles
 * as an audit trail. Every number here was computed on the server.
 */
const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  reference: { type: String, required: true, unique: true }, // SB-000001

  symbol: { type: String, required: true, uppercase: true, index: true },
  name: String,
  side: { type: String, enum: ['BUY', 'SELL'], required: true },
  orderType: { type: String, enum: ['MARKET', 'LIMIT'], default: 'MARKET' },
  status: { type: String, enum: ['FILLED', 'REJECTED'], default: 'FILLED' },

  quantity: { type: Number, required: true, min: 1 },
  limitPrice: Number,
  fillPrice: { type: Number, required: true },
  turnover: { type: Number, required: true },
  charges: chargesSchema,
  netAmount: { type: Number, required: true },   // debit on BUY, credit on SELL

  // Only set on SELL. Net of charges, so it is the number that actually landed.
  realisedPnl: { type: Number, default: null },
  // Snapshot of the position after this fill, for reconstructing account history.
  positionAfter: { quantity: Number, avgCost: Number },

  rejectionReason: String,
  placedAt: { type: Date, default: Date.now },
}, { timestamps: true });

orderSchema.index({ user: 1, placedAt: -1 });

/** Monotonic per-user reference. Cheap because of the compound index above. */
orderSchema.statics.nextReference = async function nextReference(userId) {
  const count = await this.countDocuments({ user: userId });
  return `BS-${String(count + 1).padStart(6, '0')}`;
};

module.exports = mongoose.model('Order', orderSchema);