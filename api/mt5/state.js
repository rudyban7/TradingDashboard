// Vercel serverless function — returns latest MT5 state from Upstash Redis
// Called as: GET /api/mt5/state
// Returns the JSON payload last pushed by the MQL5 EA

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) return res.status(500).json({ error: 'Redis env vars not set' });

  try {
    const r = await fetch(`${url}/get/mt5:state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await r.json();

    // Upstash returns { result: "stringified-json" }
    if (json.result === null || json.result === undefined) {
      return res.status(200).json({ ok: true, data: null });
    }

    let data = json.result;
    // Parse up to two levels of string encoding
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
        if (typeof data === 'string') data = JSON.parse(data);
      } catch { /* leave as-is */ }
    }

    return res.status(200).json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
