require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');

const { connectDB } = require('./src/config/db');
const { notFound, errorHandler } = require('./src/middleware/error');
const { startScheduler } = require('./src/jobs/eodSync');

const authRoutes = require('./src/routes/auth');
const marketRoutes = require('./src/routes/market');
const orderRoutes = require('./src/routes/orders');
const portfolioRoutes = require('./src/routes/portfolio');

const app = express();
const PORT = process.env.PORT || 4000;

/* ------------------------------ hard requirements ----------------------- */
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 24) {
  console.error('JWT_SECRET is missing or too short. Generate one:');
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}

/* ------------------------------ middleware ------------------------------ */
app.set('trust proxy', 1); // correct client IPs behind Render/Railway/Nginx

app.use(helmet({
  // The frontend is a single static page with an inline stylesheet; relax CSP
  // just enough for it while keeping everything else on.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));

const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true, credentials: true }));

app.use(compression());
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 240,               // the order pad previews on keystroke, so keep this generous
  standardHeaders: true,
  message: { error: 'Slow down a moment.', code: 'RATE_LIMIT' },
}));

if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.originalUrl}`);
    next();
  });
}

/* -------------------------------- routes -------------------------------- */
app.get('/api/health', (req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    database: states[mongoose.connection.readyState] || 'unknown',
    environment: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/portfolio', portfolioRoutes);

/* ------------------------------- frontend ------------------------------- */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Any non-API path falls through to the SPA shell.
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/api', notFound);
app.use(errorHandler);

/* -------------------------------- boot ---------------------------------- */
let server;

async function start() {
  await connectDB();
  server = app.listen(PORT, () => {
    console.log(`\n  SimulBazaar running on http://localhost:${PORT}`);
    console.log(`  API      http://localhost:${PORT}/api/health`);
    console.log(`  Env      ${process.env.NODE_ENV || 'development'}\n`);
  });
  startScheduler();
}

// Close cleanly so Mongo connections are not left dangling on redeploy.
['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, async () => {
    console.log(`\n[${signal}] shutting down`);
    server?.close();
    await mongoose.connection.close().catch(() => {});
    process.exit(0);
  });
});

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

start().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});

module.exports = app;