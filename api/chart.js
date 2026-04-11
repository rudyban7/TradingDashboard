// Vercel serverless function — proxies Yahoo Finance chart data (for ADR)
// Called as: /api/chart?symbol=EURUSD=X&range=1mo
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { symbol, range } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol param required' });

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range || '1mo'}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
