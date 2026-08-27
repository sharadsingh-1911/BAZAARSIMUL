/**
 * Symbol handling.
 *
 * This module exists because of one specific class of bug: a frontend appends an
 * exchange suffix for the data provider ("RELIANCE" -> "RELIANCE.NS"), then looks
 * that suffixed string up in its own instrument table, which stores symbols bare.
 * The lookup misses and the user sees `Stock "RELIANCE.NS" not found`.
 *
 * The rule enforced here: ONE canonical form in our database (bare, uppercase),
 * and provider suffixes are attached only at the moment of the outbound API call.
 * Anything a user types is normalised on the way in.
 *
 * HYPHENS ARE SIGNIFICANT. Several real NSE symbols contain one — BAJAJ-AUTO,
 * BAJAJ-FINSV, MAZDOCK-RE — and Yahoo expects it too ("BAJAJ-AUTO.NS"). So we
 * keep hyphens in the canonical form and strip only trailing SERIES codes
 * (-EQ, -BE), which are settlement segments rather than part of the symbol.
 */

// Exchange prefixes users paste from TradingView, screeners, etc.
const PREFIX = /^(NSE|BSE|NASDAQ|NYSE|IN)\s*[:\-]\s*/i;
// Provider suffixes: Yahoo uses .NS for NSE, .BO for BSE.
const SUFFIX = /(\.NS|\.BO|\.NSE|\.BSE)$/i;
// NSE settlement series appended by some screeners. Not part of the symbol.
const SERIES = /-(EQ|BE|BZ|SM|ST)$/i;

/**
 * Reduce any user input to our canonical stored form.
 *   "reliance"        -> "RELIANCE"
 *   "RELIANCE.NS"     -> "RELIANCE"
 *   "NSE:RELIANCE"    -> "RELIANCE"
 *   " nse - infy.ns " -> "INFY"
 *   "BAJAJ-AUTO.NS"   -> "BAJAJ-AUTO"   (hyphen preserved)
 *   "RELIANCE-EQ"     -> "RELIANCE"     (series code stripped)
 */
function canonical(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .trim()
    .replace(PREFIX, '')
    .replace(SUFFIX, '')
    .replace(SERIES, '')
    .toUpperCase()
    .replace(/[^A-Z0-9&\-]/g, '')
    .replace(/-{2,}/g, '-')        // collapse runs
    .replace(/^-+|-+$/g, '')       // no leading or trailing hyphen
    .slice(0, 24);
}

/** Build the symbol the market-data provider expects. Never stored. */
function providerSymbol(symbol, exchange = 'NSE', provider = 'yahoo') {
  const base = canonical(symbol);
  if (provider !== 'yahoo') return base;
  return exchange === 'BSE' ? `${base}.BO` : `${base}.NS`;
}

/** Escape a string for safe use inside a RegExp (search endpoints). */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { canonical, providerSymbol, escapeRegex };