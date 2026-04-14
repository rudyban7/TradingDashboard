// Vercel Cron Job — runs daily at 6am UTC
// Collects macro data and scores using a rule-based engine (no AI API needed)
// Manual trigger: GET /api/cron/macro?secret=CRON_SECRET

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fear & Greed Index — alternative.me (free, no auth)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchFearGreed() {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=2', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    const items = j?.data || [];
    return {
      value:     parseInt(items[0]?.value ?? 50),
      label:     items[0]?.value_classification ?? 'Neutral',
      yesterday: parseInt(items[1]?.value ?? 50),
    };
  } catch { return { value: 50, label: 'Neutral', yesterday: 50 }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Forex Factory calendar — free XML feed (this week)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchForexFactory() {
  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.xml', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    const xml = await r.text();

    const events = [];
    const eventRx = /<event>([\s\S]*?)<\/event>/g;
    let m;
    while ((m = eventRx.exec(xml)) !== null) {
      const block = m[1];
      const get = tag => { const t = new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`).exec(block); return t ? t[1].trim() : ''; };
      if (get('impact') !== 'High') continue;

      const dateStr  = get('date');
      const timeStr  = get('time');
      const country  = get('country').toUpperCase();
      const title    = get('title');
      const forecast = get('forecast');
      const previous = get('previous');

      if (dateStr) {
        const evTime = new Date(`${dateStr} ${timeStr || '00:00'} UTC`);
        const diffH  = (evTime - new Date()) / 3_600_000;
        if (diffH > -2 && diffH < 48) {
          events.push({ country, title, forecast, previous, diffH: Math.round(diffH) });
        }
      }
    }
    return events.slice(0, 10);
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. DXY / VIX / GOLD / SPX from Yahoo Finance
// ─────────────────────────────────────────────────────────────────────────────
async function fetchMarketData() {
  const MAP = { DXY: 'DX-Y.NYB', VIX: '^VIX', GOLD: 'XAUUSD=X', SPX: '^GSPC' };
  const entries = Object.entries(MAP);
  const results = await Promise.allSettled(
    entries.map(([, sym]) =>
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(7000),
      }).then(r => r.json())
    )
  );

  const out = {};
  entries.forEach(([key], i) => {
    if (results[i].status !== 'fulfilled') return;
    const meta = results[i].value?.chart?.result?.[0]?.meta;
    if (!meta) return;
    const price = meta.regularMarketPrice;
    const prev  = meta.chartPreviousClose || meta.previousClose || price;
    out[key] = {
      price,
      change:    price - prev,
      changePct: prev ? parseFloat((((price - prev) / prev) * 100).toFixed(2)) : 0,
    };
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Rule-based macro scoring engine (no AI API needed)
// ─────────────────────────────────────────────────────────────────────────────
function scoreMacro({ fng, ffEvents, marketData }) {
  const dxy  = marketData.DXY  || {};
  const vix  = marketData.VIX  || {};
  const gold = marketData.GOLD || {};
  const spx  = marketData.SPX  || {};

  const dxyChg  = dxy.changePct  || 0;   // % change today
  const vixVal  = vix.price      || 20;
  const fngVal  = fng.value;              // 0–100
  const spxChg  = spx.changePct  || 0;
  const goldChg = gold.changePct || 0;

  // ── Overall regime ──────────────────────────────────────────────────────
  let volatility = 5;
  if (vixVal >= 35)      volatility = 10;
  else if (vixVal >= 25) volatility = 8;
  else if (vixVal >= 20) volatility = 6;
  else if (vixVal >= 15) volatility = 4;
  else                   volatility = 2;

  // Add 1 point of vol per 3 high-impact events in next 24h
  const nearEvents = ffEvents.filter(e => e.diffH >= 0 && e.diffH < 24);
  volatility = Math.min(10, volatility + Math.floor(nearEvents.length / 3));

  let regime;
  if (vixVal >= 30)         regime = 'volatile';
  else if (Math.abs(dxyChg) > 0.5 || Math.abs(spxChg) > 1) regime = 'trending';
  else if (vixVal < 15)     regime = 'ranging';
  else if (fngVal < 30)     regime = 'risk-off';
  else if (fngVal > 70)     regime = 'risk-on';
  else                      regime = 'ranging';

  // ── Overall score (−5 to +5): positive = risk-on / USD weakness ──────────
  let score = 0;
  // DXY direction (strongest signal for FX)
  if (dxyChg >  0.5) score -= 2;
  else if (dxyChg >  0.2) score -= 1;
  else if (dxyChg < -0.5) score += 2;
  else if (dxyChg < -0.2) score += 1;
  // Risk sentiment
  if (fngVal < 25)       score -= 1;
  else if (fngVal > 75)  score += 1;
  // Equity direction
  if (spxChg >  1)       score += 1;
  else if (spxChg < -1)  score -= 1;
  // Gold surge = risk-off
  if (goldChg > 1.5)     score -= 1;

  score = Math.max(-5, Math.min(5, score));

  const bias = score > 1 ? 'bullish' : score < -1 ? 'bearish' : 'neutral';

  // ── Overall summary ───────────────────────────────────────────────────────
  const dxyStr  = dxy.price   ? `DXY ${dxy.price.toFixed(2)} (${dxyChg >= 0 ? '+' : ''}${dxyChg}%)` : '';
  const vixStr  = `VIX ${vixVal.toFixed(1)}`;
  const fngStr  = `Fear & Greed ${fngVal} (${fng.label})`;
  const evtStr  = nearEvents.length ? `${nearEvents.length} high-impact event${nearEvents.length > 1 ? 's' : ''} today` : 'no major events today';
  const summary = `${regime.charAt(0).toUpperCase()+regime.slice(1)} market. ${dxyStr ? dxyStr + ', ' : ''}${vixStr}, ${fngStr}. ${evtStr}.`;

  // ── Per-pair scoring ──────────────────────────────────────────────────────
  // Correlation map: how each pair responds to DXY move and risk sentiment
  // [dxyCorr, riskCorr]  +1 = positive correlation, -1 = inverse
  const CORR = {
    'EUR/USD':  { dxy: -1,    risk:  0.5 },
    'GBP/USD':  { dxy: -1,    risk:  0.5 },
    'USD/JPY':  { dxy:  1,    risk:  0.5 },   // risk-on = USDJPY up (carry)
    'XAU/USD':  { dxy: -0.8,  risk: -1   },   // gold = safe haven, risk-off positive
    'EUR/JPY':  { dxy:  0,    risk:  1   },   // pure risk proxy
    'GER40':    { dxy: -0.3,  risk:  1   },
    'JP225USD': { dxy:  0,    risk:  1   },
    'FTSE100':  { dxy: -0.2,  risk:  0.8 },
    'SPX500':   { dxy: -0.2,  risk:  1   },
  };

  // Risk score component (−5 to +5)
  const riskScore = score;

  // DXY component (normalise change to −3..+3 range)
  const dxyComponent = Math.max(-3, Math.min(3, -dxyChg * 4));

  const eventsByCountry = {};
  ffEvents.filter(e => e.diffH >= 0 && e.diffH < 48).forEach(e => {
    eventsByCountry[e.country] = (eventsByCountry[e.country] || 0) + 1;
  });

  // Country → pair mapping for event impact
  const COUNTRY_PAIRS = {
    USD: ['EUR/USD','GBP/USD','USD/JPY','XAU/USD','EUR/JPY','GER40','JP225USD','FTSE100','SPX500'],
    EUR: ['EUR/USD','EUR/JPY','GER40'],
    GBP: ['GBP/USD','FTSE100'],
    JPY: ['USD/JPY','EUR/JPY','JP225USD'],
    XAU: ['XAU/USD'],
  };

  const pairs = {};
  Object.entries(CORR).forEach(([sym, corr]) => {
    let ps = 0;
    ps += corr.dxy  * dxyComponent;
    ps += corr.risk * riskScore * 0.6;
    ps = Math.max(-5, Math.min(5, Math.round(ps)));

    const b = ps > 1 ? 'bullish' : ps < -1 ? 'bearish' : 'neutral';

    // Build note
    const parts = [];
    if (Math.abs(dxyChg) > 0.15 && corr.dxy !== 0)
      parts.push(`DXY ${dxyChg > 0 ? 'strength' : 'weakness'} ${corr.dxy < 0 ? 'pressures' : 'supports'} ${sym}`);
    if (Math.abs(riskScore) > 1 && Math.abs(corr.risk) > 0.4)
      parts.push(riskScore > 0 ? 'risk-on flow' : 'risk-off tone');

    // Event flag
    const affCountries = Object.entries(COUNTRY_PAIRS)
      .filter(([, syms]) => syms.includes(sym))
      .map(([c]) => c);
    const hasEvent = affCountries.some(c => eventsByCountry[c]);
    if (hasEvent) parts.push('high-impact news due');

    const note = parts.length ? parts.join(', ') + '.' : `${b} bias from combined signals.`;

    pairs[sym] = { score: ps, bias: b, note };
  });

  // ── Key events list ───────────────────────────────────────────────────────
  const keyEvents = nearEvents.slice(0, 4).map(e => {
    const when = e.diffH === 0 ? 'now' : e.diffH > 0 ? `in ${e.diffH}h` : `${Math.abs(e.diffH)}h ago`;
    return `${e.title} [${e.country}] — ${when}`;
  });
  if (!keyEvents.length && ffEvents.length) {
    const next = ffEvents.filter(e => e.diffH >= 0)[0];
    if (next) keyEvents.push(`Next: ${next.title} [${next.country}] in ${next.diffH}h`);
  }

  return {
    generatedAt: new Date().toISOString(),
    overall: { score, volatility, regime, bias, summary },
    pairs,
    keyEvents,
    fearGreed: { value: fngVal, label: fng.label },
    marketData: {
      dxy:  dxy.price  ? { price: parseFloat(dxy.price.toFixed(2)),  changePct: dxyChg  } : null,
      vix:  vix.price  ? { price: parseFloat(vixVal.toFixed(2)),      changePct: vix.changePct || 0 } : null,
      gold: gold.price ? { price: parseFloat(gold.price.toFixed(2)), changePct: goldChg } : null,
      spx:  spx.price  ? { price: parseFloat(spx.price.toFixed(2)),  changePct: spxChg  } : null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Store in Redis (3h TTL)
// ─────────────────────────────────────────────────────────────────────────────
async function storeInRedis(data) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Redis env vars not set');

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // SET the value
  const r = await fetch(`${url}/set/macro:score`, {
    method: 'POST', headers, body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`Redis write failed: ${await r.text()}`);

  // EXPIRE in 3 hours (10800s)
  await fetch(`${url}/expire/macro:score/10800`, { method: 'POST', headers });
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const CRON_SECRET = process.env.CRON_SECRET || '';
  if (CRON_SECRET) {
    const auth    = req.headers['authorization'] || '';
    const qSecret = req.query?.secret || '';
    if (auth !== `Bearer ${CRON_SECRET}` && qSecret !== CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    console.log('macro cron: fetching data...');

    const [fng, ffEvents, marketData] = await Promise.all([
      fetchFearGreed(),
      fetchForexFactory(),
      fetchMarketData(),
    ]);

    console.log(`macro cron: F&G=${fng.value}, FF high-impact=${ffEvents.length}, DXY=${marketData.DXY?.changePct}%`);

    const analysis = scoreMacro({ fng, ffEvents, marketData });
    await storeInRedis(analysis);

    console.log(`macro cron: done — regime=${analysis.overall.regime}, score=${analysis.overall.score}`);
    return res.status(200).json({ ok: true, generatedAt: analysis.generatedAt, regime: analysis.overall.regime, score: analysis.overall.score });
  } catch (e) {
    console.error('macro cron error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
