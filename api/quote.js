// Vercel serverless function — proxies Yahoo Finance batch quotes
// Called as: /api/quote?symbols=EURUSD=X,GBPUSD=X,...
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols param required' });

  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`;

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
