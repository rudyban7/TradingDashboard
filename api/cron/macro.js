// Vercel Cron Job — runs hourly, collects macro data, scores via Claude API
// Schedule: 0 * * * *  (every hour, on Vercel Pro; once daily on Hobby)
// Manual trigger: GET /api/cron/macro?secret=CRON_SECRET
//
// Required env vars:
//   ANTHROPIC_API_KEY   — your Claude API key
//   KV_REST_API_URL     — Upstash Redis URL
//   KV_REST_API_TOKEN   — Upstash Redis token
//   CRON_SECRET         — optional, secures manual triggers

const Anthropic = require('@anthropic-ai/sdk');

const PAIRS = ['EUR/USD','GBP/USD','USD/JPY','XAU/USD','EUR/JPY','GER40','JP225USD','FTSE100','SPX500'];
const YAHOO_SYMS = {
  'DXY':  'DX-Y.NYB',
  'VIX':  '^VIX',
  'GOLD': 'XAUUSD=X',
  'SPX':  '^GSPC',
};

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
      value:      parseInt(items[0]?.value ?? 50),
      label:      items[0]?.value_classification ?? 'Neutral',
      yesterday:  parseInt(items[1]?.value ?? 50),
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

    // Parse events with regex — only HIGH impact
    const events = [];
    const eventRx = /<event>([\s\S]*?)<\/event>/g;
    let m;
    while ((m = eventRx.exec(xml)) !== null) {
      const block = m[1];
      const get  = tag => { const t = new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`).exec(block); return t ? t[1].trim() : ''; };
      const impact = get('impact');
      if (impact !== 'High') continue;

      const dateStr  = get('date');
      const timeStr  = get('time');
      const country  = get('country');
      const title    = get('title');
      const forecast = get('forecast');
      const previous = get('previous');

      // Only events in the next 48 hours
      if (dateStr) {
        const evTime = new Date(`${dateStr} ${timeStr || '00:00'} UTC`);
        const now    = new Date();
        const diffH  = (evTime - now) / 3_600_000;
        if (diffH > -2 && diffH < 48) {
          events.push({ date: dateStr, time: timeStr, country, title, forecast, previous, diffH: Math.round(diffH) });
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
  const syms   = Object.values(YAHOO_SYMS);
  const keys   = Object.keys(YAHOO_SYMS);
  const results = await Promise.allSettled(
    syms.map(s =>
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=5d`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(7000),
      }).then(r => r.json())
    )
  );

  const out = {};
  keys.forEach((key, i) => {
    if (results[i].status !== 'fulfilled') return;
    const meta = results[i].value?.chart?.result?.[0]?.meta;
    if (!meta) return;
    const price = meta.regularMarketPrice;
    const prev  = meta.chartPreviousClose || meta.previousClose || price;
    out[key] = {
      price,
      changePct: prev ? (((price - prev) / prev) * 100).toFixed(2) : '0.00',
    };
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Telegram — public channel kolebessi preview page
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTelegram() {
  try {
    const r = await fetch('https://t.me/s/kolebessi', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(8000),
    });
    const html = await r.text();

    // Extract message texts — strip inner HTML tags, decode entities
    const msgRx = /<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    const posts  = [];
    let m;
    while ((m = msgRx.exec(html)) !== null && posts.length < 5) {
      let text = m[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .trim();
      if (text.length > 20) posts.push(text.slice(0, 500));
    }

    // Also grab post timestamps
    const timeRx = /datetime="([^"]+)"/g;
    const times  = [];
    let t;
    while ((t = timeRx.exec(html)) !== null && times.length < 5) {
      times.push(t[1]);
    }

    return posts.map((p, i) => ({ text: p, time: times[i] || '' }));
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Call Claude API with all data
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude({ fng, ffEvents, marketData, telegramPosts }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const now = new Date().toUTCString();

  const eventsText = ffEvents.length
    ? ffEvents.map(e => `  • [${e.country}] ${e.title} — ${e.diffH >= 0 ? `in ${e.diffH}h` : `${Math.abs(e.diffH)}h ago`} (forecast: ${e.forecast || 'N/A'}, prev: ${e.previous || 'N/A'})`).join('\n')
    : '  No high-impact events in the next 48h.';

  const telegramText = telegramPosts.length
    ? telegramPosts.map((p, i) => `  [${i+1}] ${p.text.replace(/\n/g, ' ').slice(0,300)}`).join('\n')
    : '  No recent posts.';

  const mktText = Object.entries(marketData)
    .map(([k,v]) => `  ${k}: ${v.price?.toFixed(2) ?? 'N/A'} (${v.changePct > 0 ? '+' : ''}${v.changePct}%)`)
    .join('\n');

  const prompt = `You are a professional forex/macro market analyst. Analyse the following real-time data and return a JSON object with your assessment. Be concise but actionable.

=== Current Time: ${now} ===

FEAR & GREED INDEX (Crypto/Risk-Appetite proxy)
  Value: ${fng.value}/100 — ${fng.label}
  Yesterday: ${fng.yesterday}/100

KEY MARKET LEVELS
${mktText}

HIGH-IMPACT FOREX FACTORY EVENTS (next 48h)
${eventsText}

RECENT TELEGRAM POSTS (kolebessi channel)
${telegramText}

=== TASK ===
Return ONLY valid JSON (no markdown, no prose before/after) in this exact structure:
{
  "overall": {
    "score": <integer -5 to +5, positive = risk-on/bullish USD weakness, negative = risk-off/USD strength>,
    "volatility": <integer 0-10, where 10 = extreme volatility expected>,
    "regime": <"trending" | "ranging" | "volatile" | "risk-off" | "risk-on">,
    "bias": <"bullish" | "bearish" | "neutral">,
    "summary": "<2-3 sentence macro summary for a trader>"
  },
  "pairs": {
    "EUR/USD": { "score": <-5 to +5>, "bias": <"bullish"|"bearish"|"neutral">, "note": "<1 sentence>" },
    "GBP/USD": { "score": <-5 to +5>, "bias": <"bullish"|"bearish"|"neutral">, "note": "<1 sentence>" },
    "USD/JPY": { "score": <-5 to +5>, "bias": <"bullish"|"bearish"|"neutral">, "note": "<1 sentence>" },
    "XAU/USD": { "score": <-5 to +5>, "bias": <"bullish"|"bearish"|"neutral">, "note": "<1 sentence>" },
    "EUR/JPY": { "score": <-5 to +5>, "bias": <"bullish"|"bearish"|"neutral">, "note": "<1 sentence>" },
    "GER40":   { "score": <-5 to +5>, "bias": <"bullish"|"bearish"|"neutral">, "note": "<1 sentence>" },
    "JP225USD":{ "score": <-5 to +5>, "bias": <"bullish"|"bearish"|"neutral">, "note": "<1 sentence>" },
    "FTSE100": { "score": <-5 to +5>, "bias": <"bullish"|"bearish"|"neutral">, "note": "<1 sentence>" },
    "SPX500":  { "score": <-5 to +5>, "bias": <"bullish"|"bearish"|"neutral">, "note": "<1 sentence>" }
  },
  "keyEvents": [<up to 4 strings, most important upcoming events e.g. "NFP Friday 13:30 UTC">],
  "fearGreed": { "value": ${fng.value}, "label": "${fng.label}" }
}`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0]?.text || '{}';
  let parsed;
  try {
    // Strip any markdown fences if model adds them
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    console.error('Claude JSON parse error, raw:', raw.slice(0, 500));
    parsed = { overall: { score: 0, volatility: 5, regime: 'ranging', bias: 'neutral', summary: 'Analysis unavailable.' }, pairs: {}, keyEvents: [], fearGreed: fng };
  }

  parsed.generatedAt = new Date().toISOString();
  parsed.fearGreed   = { value: fng.value, label: fng.label };
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Store in Redis
// ─────────────────────────────────────────────────────────────────────────────
async function storeInRedis(data) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Redis env vars not set');

  // Upstash REST API: POST /set with body ["macro:score", <value>, "EX", "10800"]
  // This stores the key with a 3-hour TTL
  const r = await fetch(`${url}/set`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(['macro:score', JSON.stringify(data), 'EX', 10800]),
  });
  if (!r.ok) throw new Error(`Redis write failed: ${await r.text()}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  // Vercel cron sends Authorization: Bearer <CRON_SECRET>
  const CRON_SECRET = process.env.CRON_SECRET || '';
  if (CRON_SECRET) {
    const auth    = req.headers['authorization'] || '';
    const qSecret = req.query?.secret || '';
    const valid   = auth === `Bearer ${CRON_SECRET}` || qSecret === CRON_SECRET;
    if (!valid) return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('macro cron: starting fetch...');

    const [fng, ffEvents, marketData, telegramPosts] = await Promise.all([
      fetchFearGreed(),
      fetchForexFactory(),
      fetchMarketData(),
      fetchTelegram(),
    ]);

    console.log(`macro cron: F&G=${fng.value}, FF events=${ffEvents.length}, Telegram posts=${telegramPosts.length}`);

    const analysis = await callClaude({ fng, ffEvents, marketData, telegramPosts });
    await storeInRedis(analysis);

    console.log(`macro cron: done — regime=${analysis.overall?.regime}, score=${analysis.overall?.score}`);
    return res.status(200).json({ ok: true, generatedAt: analysis.generatedAt, regime: analysis.overall?.regime });
  } catch (e) {
    console.error('macro cron error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
