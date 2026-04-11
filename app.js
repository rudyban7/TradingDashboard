/* ============================================================
   TRADING DASHBOARD — Shared Utilities
   ============================================================ */

const API_KEY = '8b9b5b24559e4f45a3cb8b3e7dd5dd1a';

const PAIRS = [
  { symbol: 'USD/JPY',    api: 'USD/JPY',    name: 'Dollar Yen',        decimals: 3, sessions: ['tokyo','london','newyork'] },
  { symbol: 'EUR/USD',    api: 'EUR/USD',    name: 'Euro Dollar',       decimals: 5, sessions: ['london','newyork'] },
  { symbol: 'GBP/USD',    api: 'GBP/USD',    name: 'Pound Dollar',      decimals: 5, sessions: ['london','newyork'] },
  { symbol: 'XAU/USD',    api: 'XAU/USD',    name: 'Gold',              decimals: 2, sessions: ['london','newyork'] },
  { symbol: 'EUR/JPY',    api: 'EUR/JPY',    name: 'Euro Yen',          decimals: 3, sessions: ['tokyo','london'] },
  { symbol: 'GER40',      api: 'GER40',      name: 'DAX 40',            decimals: 1, sessions: ['london'] },
  { symbol: 'JP225USD',   api: 'JP225USD',   name: 'Nikkei 225',        decimals: 1, sessions: ['tokyo'] },
  { symbol: 'FTSE100',    api: 'FTSE100',    name: 'FTSE 100',          decimals: 1, sessions: ['london'] },
  { symbol: 'SPX500',     api: 'SPX500',     name: 'S&P 500',           decimals: 1, sessions: ['newyork'] },
];

/* ── Session Detection ── */
function getActiveSessions() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const t = h + m / 60;

  const sessions = {
    tokyo:   (t >= 0 && t < 9),
    london:  (t >= 7 && t < 16),
    newyork: (t >= 12 && t < 21),
  };
  return sessions;
}

function getSessionLabel() {
  const s = getActiveSessions();
  const active = [];
  if (s.tokyo)   active.push('Tokyo');
  if (s.london)  active.push('London');
  if (s.newyork) active.push('New York');
  return active.length ? active.join(' + ') : 'Off Hours';
}

/* ── Price Formatting ── */
function formatPrice(price, symbol) {
  const pair = PAIRS.find(p => p.symbol === symbol);
  const dec = pair ? pair.decimals : 2;
  return parseFloat(price).toFixed(dec);
}

function formatChange(change, changePct) {
  const pct = parseFloat(changePct);
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

/* ── localStorage Helpers ── */
function saveToStorage(key, data) {
  try {
    localStorage.setItem('td_' + key, JSON.stringify(data));
  } catch(e) {}
}

function loadFromStorage(key) {
  try {
    const raw = localStorage.getItem('td_' + key);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

/* ── ID Generator ── */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ── Date Helpers ── */
function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'2-digit' });
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short' }) + ' ' +
         d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
}

function getMonthKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function getMonthLabel(key) {
  const [y, m] = key.split('-');
  const d = new Date(parseInt(y), parseInt(m)-1, 1);
  return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}

/* ── RR Calculator ── */
function calcRR(entry, sl, tp, direction) {
  entry = parseFloat(entry);
  sl = parseFloat(sl);
  tp = parseFloat(tp);
  if (!entry || !sl || !tp) return null;
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk === 0) return null;
  return (reward / risk).toFixed(2);
}

/* ── Nav Active State ── */
function setActiveNav() {
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === path || (path === '' && href === 'index.html')) {
      a.classList.add('active');
    }
  });
}

/* ── Shared Nav HTML ── */
function getNavHTML(activePage) {
  return `
<nav class="nav">
  <div class="nav-inner">
    <div class="nav-logo">RB<span>/TRADING</span></div>
    <ul class="nav-links">
      <li><a href="index.html" ${activePage==='watchlist'?'class="active"':''}>
        <span class="nav-icon">📊</span><span>Watchlist</span></a></li>
      <li><a href="journal.html" ${activePage==='journal'?'class="active"':''}>
        <span class="nav-icon">📒</span><span>Journal</span></a></li>
      <li><a href="alerts.html" ${activePage==='alerts'?'class="active"':''}>
        <span class="nav-icon">🔔</span><span>Alerts</span></a></li>
      <li><a href="stats.html" ${activePage==='stats'?'class="active"':''}>
        <span class="nav-icon">📈</span><span>Stats</span></a></li>
    </ul>
    <div class="nav-right">
      <div class="live-dot"></div>
      <span class="live-label" id="nav-time">--:--</span>
    </div>
  </div>
</nav>`;
}

/* ── Clock tick ── */
function startClock() {
  function tick() {
    const el = document.getElementById('nav-time');
    if (el) {
      const now = new Date();
      el.textContent = now.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    }
  }
  tick();
  setInterval(tick, 1000);
}
