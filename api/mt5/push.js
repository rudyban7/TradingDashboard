// Vercel serverless function — receives MT5 state from MQL5 EA via WebRequest
// Stores payload in Upstash Redis under key "mt5:state"
// Called as: POST /api/mt5/push?secret=YOUR_SECRET
// Body: JSON { account, positions[] }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  // ── Auth: shared secret passed as query param ──
  const PUSH_SECRET = process.env.MT5_PUSH_SECRET || '';
  if (PUSH_SECRET && req.query.secret !== PUSH_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Parse body ──
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Body required' });

  // ── Stamp server timestamp ──
  body.pushedAt = new Date().toISOString();

  // ── Write to Upstash Redis via REST API ──
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) return res.status(500).json({ error: 'Redis env vars not set' });

  try {
    // Split deals into their own key to keep the state payload lean
    const deals = Array.isArray(body.deals) ? body.deals : null;
    const state = { ...body };
    delete state.deals;

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // Write state (no deals)
    const rState = await fetch(`${url}/set/mt5:state`, {
      method: 'POST', headers, body: JSON.stringify(state),
    });
    if (!rState.ok) {
      const text = await rState.text();
      return res.status(500).json({ error: 'Redis write failed', detail: text });
    }

    // Write deals separately when present
    if (deals && deals.length > 0) {
      await fetch(`${url}/set/mt5:deals`, {
        method: 'POST', headers, body: JSON.stringify(deals),
      });
    }

    return res.status(200).json({ ok: true, pushedAt: body.pushedAt, deals: deals ? deals.length : 0 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
