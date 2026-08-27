const mongoose = require('mongoose');

/**
 * Connects to MongoDB Atlas.
 *
 * Atlas gotchas worth knowing before you debug for an hour:
 *  - Network Access must allow your IP (or 0.0.0.0/0 for a hosted deploy).
 *  - The password in the URI must be percent-encoded if it contains @ : / ? # [ ] %
 *  - The database name belongs in the path, before the ? — otherwise Mongoose
 *    writes into a database literally called "test".
 */
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set. Copy .env.example to .env and fill it in.');

  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () =>
    console.log(`[db] connected to ${mongoose.connection.name}`));
  mongoose.connection.on('error', (err) =>
    console.error('[db] error:', err.message));
  mongoose.connection.on('disconnected', () =>
    console.warn('[db] disconnected'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 20,
    retryWrites: true,
  });

  return mongoose.connection;
}

module.exports = { connectDB };