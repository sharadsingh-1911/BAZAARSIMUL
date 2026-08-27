/* ==========================================================================
   SimulBazaar frontend
   Talks only to our own API. No market-data provider is called from the
   browser: those endpoints do not send CORS headers, and even if they did,
   fifty browsers hammering them would get the IP throttled.
   ========================================================================== */

const API = '/api';
const TOKEN_KEY = 'bazaarsimul.token';

const state = {
  token: null,
  isProduction: false,   // set from /api/health at boot
  user: null,
  portfolio: null,
  watchlist: [],
  orders: [],
  selected: null,   // full quote object
  side: 'BUY',
  preview: null,
  instruments: [],  // tier-1 symbols, for the tape
  authMode: 'login',
};

/* ------------------------------ helpers ------------------------------ */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

const inr = (n) => '\u20B9' + Math.abs(Number(n) || 0).toLocaleString('en-IN',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = (n) => '\u20B9' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-IN');
const num = (n) => Math.abs(Number(n) || 0).toLocaleString('en-IN',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sgn = (n) => (n > 0.005 ? '+' : n < -0.005 ? '\u2212' : '');
const cls = (n) => (n > 0.005 ? 'up' : n < -0.005 ? 'dn' : 'flat');
const pct = (n) => `${sgn(n)}${Math.abs(Number(n) || 0).toFixed(2)}%`;

let toastTimer;
function toast(message, bad = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast' + (bad ? ' bad' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

/**
 * Single fetch wrapper. Attaches the bearer token, unwraps errors into thrown
 * Error objects carrying the server's own message, and bounces to the login
 * screen on a 401 so an expired token cannot leave the UI in a half-state.
 */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }

  if (res.status === 401 && state.token) {
    signOut(true);
    throw new Error(data.error || 'Session expired. Sign in again.');
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.code = data.code;
    err.fields = data.fields;
    throw err;
  }
  return data;
}

/* ------------------------------ auth ------------------------------ */
function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === 'register';

  $('tab-login').setAttribute('aria-pressed', String(!isRegister));
  $('tab-register').setAttribute('aria-pressed', String(isRegister));
  $('gate-title').textContent = isRegister ? 'Create account' : 'Sign in';
  $('gate-submit').textContent = isRegister ? 'Create account & fund \u20B91,00,000' : 'Sign in';
  $('password').setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
  $('gate-switch-text').textContent = isRegister ? 'Already registered?' : 'No account yet?';
  $('gate-switch').textContent = isRegister ? 'Sign in' : 'Create one';
  document.querySelectorAll('.reg-only').forEach((el) => { el.hidden = !isRegister; });
  $('gate-error').textContent = '';
}

async function submitAuth() {
  const username = $('username').value.trim().toLowerCase();
  const password = $('password').value;
  const setError = (m) => { $('gate-error').textContent = m; };

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return setError('Username must be 3\u201320 characters: lowercase letters, digits or underscore.');
  }
  if (password.length < 8) return setError('Password must be at least 8 characters.');

  $('gate-submit').disabled = true;
  try {
    const payload = state.authMode === 'register'
      ? { username, password, displayName: $('displayName').value.trim() || undefined,
          email: $('email').value.trim() || undefined }
      : { username, password };

    const path = state.authMode === 'register' ? '/auth/register' : '/auth/login';
    const data = await api(path, { method: 'POST', body: payload });

    state.token = data.token;
    sessionStorage.setItem(TOKEN_KEY, data.token);
    await enterApp();
  } catch (err) {
    setError(err.fields ? Object.values(err.fields).join(' ') : err.message);
  } finally {
    $('gate-submit').disabled = false;
  }
}

function signOut(silent = false) {
  state.token = null;
  state.user = null;
  state.selected = null;
  sessionStorage.removeItem(TOKEN_KEY);
  clearInterval(pollTimer);
  $('app').hidden = true;
  $('gate').hidden = false;
  $('password').value = '';
  setAuthMode('login');
  if (!silent) toast('Signed out.');
}

/* ------------------------------ data loading ------------------------------ */
let pollTimer;

async function enterApp() {
  $('gate').hidden = true;
  $('app').hidden = false;

  await Promise.all([loadAccount(), loadInstruments(), loadStatus()]);
  await Promise.all([loadWatchlist(), loadOrders()]);
  renderAll();

  // EOD data changes once a day, so polling every 60s is generous. It exists to
  // pick up a sync landing while the tab is open, not to chase ticks.
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      await Promise.all([loadAccount(), loadWatchlist()]);
      renderFigures(); renderReturns(); renderWatchlist(); renderHoldings();
    } catch { /* transient */ }
  }, 60000);
}

async function loadAccount() {
  const data = await api('/portfolio');
  state.user = data.user;
  state.portfolio = { summary: data.summary, returns: data.returns, holdings: data.holdings };
  $('btn-logout').textContent = `${data.user.displayName} \u00B7 log out`;
}

async function loadInstruments() {
  const data = await api('/market/instruments');
  state.instruments = data.instruments;
}

async function loadWatchlist() {
  const data = await api('/portfolio/watchlist');
  state.watchlist = data.watchlist;
}

async function loadOrders() {
  const data = await api('/orders?limit=50');
  state.orders = data.orders;
}

async function loadStatus() {
  try {
    const s = await api('/market/status');
    const when = s.latestTradingDate
      ? new Date(s.latestTradingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : 'no data';
    $('data-note').textContent = `End-of-day prices \u00B7 close of ${when} \u00B7 ${s.priced}/${s.instruments} priced`;

    $('session-dot').className = 'dot' + (s.stale ? ' shut' : '');
    $('session-text').textContent = s.stale ? 'Data stale' : 'Data current';
    $('session-pill').title = s.stale
      ? `Latest close is ${s.dataAgeHours}h old. Run npm run sync.`
      : `Synced ${s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString('en-IN') : 'never'}`;
  } catch { /* status is decorative */ }
}

/* ------------------------------ tape ------------------------------ */
function renderTape() {
  if (!state.instruments.length) return;
  const items = state.instruments.slice(0, 40).map((i) => {
    const c = i.prevClose ? ((i.lastPrice - i.prevClose) / i.prevClose) * 100 : 0;
    return `<span class="tape-item"><b>${esc(i.symbol)}</b>${num(i.lastPrice)} ` +
      `<span class="${c >= 0 ? 't-up' : 't-dn'}">${c >= 0 ? '\u25B2' : '\u25BC'}${Math.abs(c).toFixed(2)}%</span></span>`;
  }).join('');
  $('tape').innerHTML = items + items; // duplicated for a seamless loop
}

/* ------------------------------ figures ------------------------------ */
function renderFigures() {
  const { summary, returns } = state.portfolio;

  $('f-net').textContent = inr0(summary.netWorth);
  $('f-net').className = 'fig-v ' + cls(returns.absoluteGain);
  $('f-net-n').innerHTML = `<span class="${cls(returns.absoluteReturnPct)}">${pct(returns.absoluteReturnPct)}</span> since funding`;

  $('f-cash').textContent = inr0(summary.cash);
  $('f-cash-n').textContent = summary.marketValue > 0
    ? `${inr0(summary.marketValue)} in positions` : 'fully in cash';

  $('f-open').textContent = sgn(summary.unrealisedPnl) + inr0(summary.unrealisedPnl);
  $('f-open').className = 'fig-v ' + cls(summary.unrealisedPnl);
  $('f-open-n').textContent = summary.investedValue > 0
    ? `on ${inr0(summary.investedValue)} invested` : 'no open positions';

  $('f-real').textContent = sgn(summary.realisedPnl) + inr0(summary.realisedPnl);
  $('f-real').className = 'fig-v ' + cls(summary.realisedPnl);
  $('f-real-n').textContent = summary.totalCharges > 0
    ? `${inr0(summary.totalCharges)} paid in charges` : 'no charges yet';
}

function renderReturns() {
  const r = state.portfolio.returns;

  const cagrCell = r.cagrReliable
    ? `<span class="${cls(r.cagrPct)}">${pct(r.cagrPct)}</span>`
    : '<span class="flat">not yet meaningful</span>';

  $('perf').innerHTML = `
    <div class="perf-top">
      <div class="perf-lab">Absolute return</div>
      <div class="perf-big ${cls(r.absoluteReturnPct)}">${pct(r.absoluteReturnPct)}</div>
      <div class="perf-cap">${sgn(r.absoluteGain)}${inr(r.absoluteGain)} on ${inr0(r.fundedCapital)} over ${esc(r.holdingPeriodLabel)}</div>
    </div>
    <div class="pline"><span>Capital funded</span><span>${inr0(r.fundedCapital)}</span></div>
    <div class="pline"><span>Current net worth</span><span>${inr(r.netWorth)}</span></div>
    <div class="pline"><span>Holding period</span><span>${esc(r.holdingPeriodLabel)}</span></div>
    <div class="pline"><span>CAGR (annualised)</span><span>${cagrCell}</span></div>
    <div class="pline"><span>Booked P&amp;L</span><span class="${cls(state.portfolio.summary.realisedPnl)}">${sgn(state.portfolio.summary.realisedPnl)}${inr(state.portfolio.summary.realisedPnl)}</span></div>
    <div class="pline"><span>Charges paid</span><span>${inr(state.portfolio.summary.totalCharges)}</span></div>
    ${r.cagrReliable ? '' : `
      <div class="callout"><b>Why CAGR is blank.</b>
      It compounds a return out to a full year, so short windows explode.
      Annualising ${esc(r.holdingPeriodLabel)} here would report
      ${r.cagrPct === null ? '\u2014' : pct(r.cagrPct)} &mdash; arithmetically correct,
      financially meaningless. It unlocks at ${r.minCagrDays} days; absolute return
      is the honest number until then.</div>`}
    ${state.isProduction ? '' : `
      <div class="devbar">
        <label for="backdate">Demo &middot; backdate funding</label>
        <select id="backdate">
          <option value="0">Today</option><option value="30">30 days ago</option>
          <option value="90">3 months ago</option><option value="365">1 year ago</option>
          <option value="1095">3 years ago</option>
        </select>
      </div>`}`;

  // The backdate control is a development affordance. The server refuses it in
  // production, so there is nothing to wire up there.
  if (state.isProduction) return;

  const days = r.holdingPeriodDays;
  $('backdate').value = String(days >= 1095 ? 1095 : days >= 365 ? 365 : days >= 90 ? 90 : days >= 30 ? 30 : 0);
  $('backdate').onchange = async (e) => {
    try {
      const data = await api('/auth/backdate', { method: 'POST', body: { days: Number(e.target.value) } });
      state.portfolio = { summary: data.summary, returns: data.returns, holdings: data.holdings };
      renderFigures(); renderReturns();
    } catch (err) { toast(err.message, true); }
  };
}

/* ------------------------------ quote ------------------------------ */
function sparkline(history, prevClose) {
  const pts = (history || []).map((h) => h.close).filter((n) => n != null);
  if (pts.length < 2) return '<div class="perf-cap" style="margin:14px 0">Not enough history for a chart yet.</div>';

  const lo = Math.min(...pts), hi = Math.max(...pts), range = hi - lo || 1;
  const W = 300, H = 66;
  const coords = pts.map((v, i) => [(i / (pts.length - 1)) * W, H - 4 - ((v - lo) / range) * (H - 10)]);
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const colour = pts[pts.length - 1] >= pts[0] ? 'var(--gain)' : 'var(--loss)';
  const baseY = H - 4 - ((prevClose - lo) / range) * (H - 10);

  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="0,${H} ${line} ${W},${H}" fill="${colour}" opacity=".10"></polygon>
    ${prevClose >= lo && prevClose <= hi ? `<line x1="0" y1="${baseY.toFixed(1)}" x2="${W}" y2="${baseY.toFixed(1)}" stroke="var(--rule)" stroke-dasharray="3 3"></line>` : ''}
    <polyline points="${line}" fill="none" stroke="${colour}" stroke-width="1.6"></polyline>
  </svg>`;
}

function renderQuote() {
  const box = $('quote-block');
  const q = state.selected;

  if (!q) {
    box.innerHTML = `<h2 class="hd">Quote</h2>
      <div class="empty"><b>No instrument selected</b>
      Search above or press <kbd>/</kbd> to pull a quote and open the order pad.</div>`;
    return;
  }

  const held = state.portfolio.holdings.find((h) => h.symbol === q.symbol);
  const watched = state.user.watchlist.includes(q.symbol);
  const asOf = q.asOf ? new Date(q.asOf).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'unknown';

  box.innerHTML = `<h2 class="hd">Quote <em>${esc(q.sector || '')} \u00B7 close of ${asOf}</em></h2>
    <div class="quote">
      <div class="quote-top">
        <div>
          <div class="quote-sym">${esc(q.symbol)}</div>
          <div class="quote-name">${esc(q.name)}</div>
          <div class="tag">${held ? `${held.quantity} held \u00B7 avg ${num(held.avgCost)}` : 'not held'}</div>
        </div>
        <div class="quote-px">
          <div class="quote-ltp">${num(q.lastPrice)}</div>
          <div class="quote-chg ${cls(q.change)}">${sgn(q.change)}${num(q.change)} (${pct(q.changePct)})</div>
          <button class="star star-wide ${watched ? 'on' : ''}" id="quote-star" aria-pressed="${watched}">
            ${watched ? '\u2605 On watchlist' : '\u2606 Watch'}</button>
        </div>
      </div>
      ${sparkline(q.history, q.prevClose)}
      <dl class="quote-grid">
        <div class="quote-cell"><dt>Prev close</dt><dd>${num(q.prevClose)}</dd></div>
        <div class="quote-cell"><dt>Day range</dt><dd>${num(q.dayLow)} \u2013 ${num(q.dayHigh)}</dd></div>
        <div class="quote-cell"><dt>Bid</dt><dd>${num(q.bid)}</dd></div>
        <div class="quote-cell"><dt>Ask</dt><dd>${num(q.ask)}</dd></div>
      </dl>
    </div>`;

  $('quote-star').onclick = () => toggleWatch(q.symbol);
}

/* ------------------------------ watchlist ------------------------------ */
function renderWatchlist() {
  $('hd-watch').textContent = state.watchlist.length ? `${state.watchlist.length} tracked` : '';

  if (!state.watchlist.length) {
    $('watchlist').innerHTML = `<div class="empty"><b>Nothing on the watchlist</b>
      Star an instrument from search or the quote panel to track it here.</div>`;
    return;
  }

  const rows = state.watchlist.map((w) => `<tr>
    <td class="sym">${esc(w.symbol)}<div class="sub-name">${esc(w.name)}</div></td>
    <td>${num(w.lastPrice)}</td>
    <td class="${cls(w.change)}">${sgn(w.change)}${num(w.change)}</td>
    <td class="${cls(w.changePct)}">${pct(w.changePct)}</td>
    <td>${num(w.dayLow)} \u2013 ${num(w.dayHigh)}</td>
    <td>${w.heldQuantity || '\u2014'}</td>
    <td><button class="act" data-pick="${esc(w.symbol)}">Trade</button>
        <button class="drop" data-drop="${esc(w.symbol)}" aria-label="Remove ${esc(w.symbol)}">\u00D7</button></td>
  </tr>`).join('');

  $('watchlist').innerHTML = `<table class="ledger">
    <thead><tr><th>Instrument</th><th>Close</th><th>Change</th><th>%</th><th>Day range</th><th>Held</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;

  bindPickers($('watchlist'));
  $('watchlist').querySelectorAll('[data-drop]').forEach((b) => {
    b.onclick = () => toggleWatch(b.dataset.drop);
  });
}

/* ------------------------------ holdings ------------------------------ */
function renderHoldings() {
  const { holdings, summary } = state.portfolio;
  $('hd-holdings').textContent = holdings.length
    ? `${holdings.length} scrips \u00B7 ${inr0(summary.marketValue)}` : '';

  if (!holdings.length) {
    $('holdings').innerHTML = `<div class="empty"><b>Ledger is empty</b>
      Buy your first scrip and it lands here with cost basis and live P&amp;L.</div>`;
    return;
  }

  const rows = holdings.map((h) => `<tr>
    <td class="sym">${esc(h.symbol)}<div class="sub-name">${esc(h.name)}</div></td>
    <td>${h.quantity}</td>
    <td>${num(h.avgCost)}</td>
    <td>${num(h.lastPrice)}</td>
    <td class="${cls(h.dayChangePct)}">${pct(h.dayChangePct)}</td>
    <td>${inr(h.marketValue)}</td>
    <td class="${cls(h.unrealisedPnl)}">${sgn(h.unrealisedPnl)}${inr(h.unrealisedPnl)}
      <div style="font-size:10.5px">${pct(h.unrealisedPnlPct)}</div></td>
    <td>${h.weightPct.toFixed(1)}%<div class="wbar"><i style="width:${Math.min(100, h.weightPct).toFixed(1)}%"></i></div></td>
    <td><button class="act" data-pick="${esc(h.symbol)}">Trade</button></td>
  </tr>`).join('');

  $('holdings').innerHTML = `<table class="ledger">
    <thead><tr><th>Instrument</th><th>Qty</th><th>Avg cost</th><th>Close</th><th>Day</th>
      <th>Value</th><th>Open P&amp;L</th><th>Weight</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><th>Total</th><th></th><th></th><th></th><th></th>
      <th style="text-align:right">${inr(summary.marketValue)}</th>
      <th style="text-align:right" class="${cls(summary.unrealisedPnl)}">
        ${sgn(summary.unrealisedPnl)}${inr(summary.unrealisedPnl)} (${pct(summary.unrealisedPnlPct)})</th>
      <th></th><th></th></tr></tfoot></table>`;

  bindPickers($('holdings'));
}

/* ------------------------------ orders ------------------------------ */
function renderOrders() {
  $('hd-orders').textContent = state.orders.length ? `${state.orders.length} filled` : '';

  if (!state.orders.length) {
    $('orders').innerHTML = `<div class="empty"><b>No orders yet</b>
      Every fill is logged as a contract note with charges broken out.</div>`;
    return;
  }

  const rows = state.orders.map((o) => {
    const when = new Date(o.placedAt);
    return `<tr>
      <td style="font-size:10.5px;color:var(--ink-soft)">${esc(o.reference)}
        <div>${when.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
        ${when.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}</div></td>
      <td class="sym">${esc(o.symbol)}</td>
      <td class="${o.side === 'BUY' ? 'side-b' : 'side-s'}">${o.side}</td>
      <td>${o.orderType === 'LIMIT' ? 'LMT' : 'MKT'}</td>
      <td>${o.quantity}</td>
      <td>${num(o.fillPrice)}</td>
      <td>${inr(o.turnover)}</td>
      <td>${inr(o.charges?.total)}</td>
      <td>${o.realisedPnl == null ? '\u2014'
        : `<span class="${cls(o.realisedPnl)}">${sgn(o.realisedPnl)}${inr(o.realisedPnl)}</span>`}</td>
    </tr>`;
  }).join('');

  $('orders').innerHTML = `<table class="ledger">
    <thead><tr><th>Order</th><th>Instrument</th><th>Side</th><th>Type</th><th>Qty</th>
      <th>Fill</th><th>Turnover</th><th>Charges</th><th>Booked</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/* ------------------------------ order pad ------------------------------ */
/**
 * The pad never computes money. It asks the server to price the order and
 * renders the answer, so the preview and the fill cannot drift apart.
 */
let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 220);
}

async function refreshPreview() {
  const q = state.selected;
  $('pad-symbol').textContent = q ? `${q.symbol} \u00B7 delivery` : 'no instrument';
  $('limit-price').disabled = $('order-type').value !== 'LIMIT';

  if (!q) {
    $('contract').innerHTML = '<div class="cline">No instrument selected.</div>';
    $('quick-qty').innerHTML = '';
    $('pad-error').textContent = '';
    $('btn-execute').disabled = true;
    $('btn-execute').textContent = 'Pick an instrument';
    return;
  }

  renderQuickQty();

  const body = {
    symbol: q.symbol,
    side: state.side,
    quantity: Math.floor(Number($('qty').value)) || 0,
    orderType: $('order-type').value,
    limitPrice: $('order-type').value === 'LIMIT' ? Number($('limit-price').value) : undefined,
  };

  if (body.quantity < 1) {
    $('pad-error').textContent = 'Quantity must be at least 1.';
    $('btn-execute').disabled = true;
    $('btn-execute').textContent = 'Cannot place order';
    return;
  }

  try {
    const { preview } = await api('/orders/preview', { method: 'POST', body });
    state.preview = preview;
    renderContract(preview);
    $('pad-error').textContent = preview.errors.join(' ');
    $('btn-execute').disabled = !preview.executable;
    $('btn-execute').textContent = preview.executable
      ? `${preview.side} ${preview.quantity} ${preview.symbol}`
      : 'Cannot place order';
  } catch (err) {
    // A rejected preview is information, not a failure — show the reason.
    state.preview = null;
    $('contract').innerHTML = `<div class="cline">Pricing unavailable.</div>`;
    $('pad-error').textContent = err.message;
    $('btn-execute').disabled = true;
    $('btn-execute').textContent = 'Cannot place order';
  }
}

function renderContract(p) {
  const c = p.charges;
  const isBuy = p.side === 'BUY';
  $('contract').innerHTML = `
    <div class="cline"><span>Fill price ${p.orderType === 'LIMIT' ? '(limit)' : '(market)'}</span><span>${num(p.fillPrice)}</span></div>
    <div class="cline"><span>Turnover &nbsp;${p.quantity} \u00D7 ${num(p.fillPrice)}</span><span>${inr(p.turnover)}</span></div>
    <div class="cline"><span>STT 0.1%</span><span>${inr(c.stt)}</span></div>
    <div class="cline"><span>Exchange + SEBI</span><span>${inr(c.exchangeTxn + c.sebi)}</span></div>
    ${isBuy ? `<div class="cline"><span>Stamp duty 0.015%</span><span>${inr(c.stampDuty)}</span></div>`
            : `<div class="cline"><span>DP charge</span><span>${inr(c.dpCharge)}</span></div>`}
    <div class="cline"><span>GST 18%</span><span>${inr(c.gst)}</span></div>
    <div class="cline total"><span>${isBuy ? 'Total debit' : 'Net credit'}</span><span>${inr(p.netAmount)}</span></div>`;
}

function renderQuickQty() {
  const q = state.selected;
  const held = state.portfolio.holdings.find((h) => h.symbol === q.symbol)?.quantity || 0;

  $('quick-qty').innerHTML = state.side === 'BUY'
    ? [25, 50, 100].map((p) => `<button data-buypc="${p}">${p}% of cash</button>`).join('')
    : (held ? [25, 50, 100].map((p) => `<button data-sellpc="${p}">${p}% of ${held}</button>`).join('') : '');

  $('quick-qty').querySelectorAll('[data-buypc]').forEach((b) => {
    b.onclick = () => {
      const cash = state.portfolio.summary.cash * (Number(b.dataset.buypc) / 100);
      $('qty').value = Math.max(1, Math.floor(cash / (q.ask || q.lastPrice)));
      schedulePreview();
    };
  });
  $('quick-qty').querySelectorAll('[data-sellpc]').forEach((b) => {
    b.onclick = () => {
      $('qty').value = Math.max(1, Math.floor(held * (Number(b.dataset.sellpc) / 100)));
      schedulePreview();
    };
  });
}

function showStamp(text, ok) {
  const el = $('stamp');
  $('stamp-mark').textContent = text;
  $('stamp-mark').className = 'stamp-mark' + (ok ? '' : ' bad');
  el.classList.remove('go');
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add('go');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setTimeout(() => el.classList.remove('go'), 1200);
  }
}

async function executeOrder() {
  const p = state.preview;
  if (!p || !p.executable) return;

  $('btn-execute').disabled = true;
  try {
    const data = await api('/orders', {
      method: 'POST',
      body: {
        symbol: p.symbol, side: p.side, quantity: p.quantity,
        orderType: p.orderType,
        limitPrice: p.orderType === 'LIMIT' ? Number($('limit-price').value) : undefined,
      },
    });

    state.portfolio = { summary: data.summary, returns: data.returns, holdings: data.holdings };
    state.user.cash = data.cash;

    showStamp('Filled', true);
    toast(data.message);

    await Promise.all([loadOrders(), loadWatchlist()]);
    renderFigures(); renderReturns(); renderHoldings(); renderOrders();
    renderWatchlist(); renderQuote();
    await refreshPreview();
  } catch (err) {
    showStamp('Rejected', false);
    toast(err.message, true);
    $('pad-error').textContent = err.message;
    await refreshPreview();
  }
}

/* ------------------------------ search ------------------------------ */
let searchTimer;
$('search').addEventListener('input', (e) => {
  const raw = e.target.value;
  clearTimeout(searchTimer);
  if (!raw.trim()) { $('search-results').innerHTML = ''; return; }
  searchTimer = setTimeout(() => runSearch(raw), 180);
});

$('search').addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { e.target.value = ''; $('search-results').innerHTML = ''; }
  if (e.key === 'Enter') {
    const first = $('search-results').querySelector('[data-pick]');
    if (first) selectSymbol(first.dataset.pick);
  }
});

async function runSearch(raw) {
  try {
    const data = await api(`/market/search?q=${encodeURIComponent(raw)}`);

    if (!data.results.length) {
      $('search-results').innerHTML = `<div class="hint">${esc(data.hint || 'No matches.')}</div>`;
      return;
    }

    $('search-results').innerHTML = '<div class="results">' + data.results.map((r) => {
      const watched = state.user.watchlist.includes(r.symbol);
      return `<div class="result">
        <button class="result-main" data-pick="${esc(r.symbol)}">
          <span class="result-sym">${esc(r.symbol)}</span>
          <span class="result-name">${esc(r.name)}</span>
          <span class="result-px">${num(r.lastPrice)}
            <span class="${cls(r.changePct)}">${pct(r.changePct)}</span></span>
        </button>
        <button class="star ${watched ? 'on' : ''}" data-star="${esc(r.symbol)}"
          aria-label="Watch ${esc(r.symbol)}">${watched ? '\u2605' : '\u2606'}</button>
      </div>`;
    }).join('') + '</div>';

    bindPickers($('search-results'));
    $('search-results').querySelectorAll('[data-star]').forEach((b) => {
      b.onclick = () => toggleWatch(b.dataset.star);
    });
  } catch (err) {
    $('search-results').innerHTML = `<div class="hint">${esc(err.message)}</div>`;
  }
}

function bindPickers(root) {
  root.querySelectorAll('[data-pick]').forEach((b) => {
    b.onclick = () => selectSymbol(b.dataset.pick);
  });
}

async function selectSymbol(symbol) {
  try {
    const { quote } = await api(`/market/quote/${encodeURIComponent(symbol)}?history=60`);
    state.selected = quote;
    $('search').value = '';
    $('search-results').innerHTML = '';
    $('limit-price').value = (state.side === 'BUY' ? quote.ask : quote.bid).toFixed(2);
    renderQuote();
    await refreshPreview();
    $('qty').focus();
    $('qty').select();
  } catch (err) {
    toast(err.message, true);
  }
}

async function toggleWatch(symbol) {
  const on = state.user.watchlist.includes(symbol);
  try {
    const data = on
      ? await api(`/portfolio/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' })
      : await api('/portfolio/watchlist', { method: 'POST', body: { symbol } });

    state.user.watchlist = data.watchlist;
    await loadWatchlist();
    renderWatchlist();
    renderQuote();
    if ($('search').value.trim()) runSearch($('search').value);
    toast(on ? `${symbol} removed from watchlist.` : `${symbol} added to watchlist.`);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ------------------------------ wiring ------------------------------ */
$('tab-login').onclick = () => setAuthMode('login');
$('tab-register').onclick = () => setAuthMode('register');
$('gate-switch').onclick = () => setAuthMode(state.authMode === 'login' ? 'register' : 'login');
$('gate-submit').onclick = submitAuth;
['username', 'password', 'displayName', 'email'].forEach((id) => {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
});

$('side-buy').onclick = () => {
  state.side = 'BUY';
  $('side-buy').setAttribute('aria-pressed', 'true');
  $('side-sell').setAttribute('aria-pressed', 'false');
  if (state.selected) $('limit-price').value = state.selected.ask.toFixed(2);
  refreshPreview();
};
$('side-sell').onclick = () => {
  state.side = 'SELL';
  $('side-buy').setAttribute('aria-pressed', 'false');
  $('side-sell').setAttribute('aria-pressed', 'true');
  if (state.selected) $('limit-price').value = state.selected.bid.toFixed(2);
  refreshPreview();
};

$('qty').oninput = schedulePreview;
$('order-type').onchange = refreshPreview;
$('limit-price').oninput = schedulePreview;
$('btn-execute').onclick = executeOrder;
$('btn-logout').onclick = () => signOut();

$('btn-refresh').onclick = async () => {
  $('btn-refresh').disabled = true;
  try {
    await Promise.all([loadAccount(), loadInstruments(), loadWatchlist(), loadOrders(), loadStatus()]);
    if (state.selected) {
      const { quote } = await api(`/market/quote/${state.selected.symbol}?history=60`);
      state.selected = quote;
    }
    renderAll();
    toast('Refreshed.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('btn-refresh').disabled = false;
  }
};

$('btn-reset').onclick = async () => {
  if (!confirm('Reset the account? Every position and order is deleted and cash returns to the starting capital. This cannot be undone.')) return;
  try {
    const data = await api('/auth/reset', { method: 'POST' });
    state.user = data.user;
    state.portfolio = { summary: data.summary, returns: data.returns, holdings: data.holdings };
    state.selected = null;
    await loadOrders();
    renderAll();
    showStamp('Reset', false);
    toast('Account reset.');
  } catch (err) {
    toast(err.message, true);
  }
};

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !$('app').hidden && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
    e.preventDefault();
    $('search').focus();
  }
});

function renderAll() {
  renderTape(); renderFigures(); renderReturns();
  renderWatchlist(); renderHoldings(); renderOrders();
  renderQuote(); refreshPreview();
}

/* ------------------------------ boot ------------------------------ */
(async function boot() {
  const health = await fetch(`${API}/health`).then((r) => r.json()).catch(() => null);
  if (!health || health.database !== 'connected') {
    $('gate').hidden = false;
    setAuthMode('login');
    $('gate-status').textContent = health
      ? `API is up but the database is ${health.database}. Check MONGODB_URI and Atlas network access.`
      : 'Cannot reach the API. Is the server running on this port?';
    return;
  }

  // sessionStorage, not localStorage: the token dies with the tab, which is the
  // right default for anything that looks like a brokerage login.
  const saved = sessionStorage.getItem(TOKEN_KEY);
  if (saved) {
    state.token = saved;
    try {
      await enterApp();
      return;
    } catch {
      sessionStorage.removeItem(TOKEN_KEY);
      state.token = null;
    }
  }

  $('gate').hidden = false;
  setAuthMode('login');
  $('username').focus();
}());