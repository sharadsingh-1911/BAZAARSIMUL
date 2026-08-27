/* eslint-disable no-unused-vars */

function notFound(req, res) {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
}

/**
 * One place that turns thrown errors into JSON. Mongoose and JWT errors get
 * translated into messages a user can act on, rather than leaking internals.
 */
function errorHandler(err, req, res, next) {
  // Duplicate key — username or email already taken.
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || { field: 1 })[0];
    return res.status(409).json({
      error: `That ${field} is already registered.`,
      code: 'DUPLICATE',
      field,
    });
  }

  // Mongoose schema validation.
  if (err.name === 'ValidationError') {
    const fields = Object.fromEntries(
      Object.entries(err.errors).map(([k, v]) => [k, v.message]),
    );
    return res.status(422).json({ error: 'Some fields need fixing.', code: 'VALIDATION', fields });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ error: `Malformed value for ${err.path}.`, code: 'CAST' });
  }

  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err);

  return res.status(status).json({
    error: status >= 500 ? 'Something broke on our side.' : err.message,
    code: err.code || 'ERROR',
    ...(process.env.NODE_ENV !== 'production' && status >= 500 ? { stack: err.stack } : {}),
  });
}

/** Wrap async handlers so a rejected promise reaches errorHandler. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { notFound, errorHandler, asyncHandler };