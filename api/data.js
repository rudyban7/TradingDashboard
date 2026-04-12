// Vercel serverless function — fetches all pair data from Yahoo Finance v8 chart endpoint
// Returns current price + 30 days of OHLC for ADR calculation
// Called as: /api/data (no params needed, symbols are hardcoded)
const SYMBOLS = [
  'USDJPY=X', 'EURUSD=X', 'GBPUSD=X', 'XAUUSD=X', 'EURJPY=X',
  '^GDAXI', '^N225', '^FTSE', '^GSPC', '^VIX'
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const results = await Promise.allSettled(
    SYMBOLS.map(sym =>
      fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1mo`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }
      ).then(r => r.json())
    )
  );

  const data = {};
  SYMBOLS.forEach((sym, i) => {
    if (results[i].status !== 'fulfilled') return;
    const chart = results[i].value;
    const result = chart?.chart?.result?.[0];
    if (!result) return;

    const meta   = result.meta;
    const quotes = result.indicators?.quote?.[0];
    const price  = meta.regularMarketPrice;
    const prev   = meta.chartPreviousClose || meta.previousClose || price;

    data[sym] = {
      price,
      change:    price - prev,
      changePct: prev ? ((price - prev) / prev) * 100 : 0,
      high:      meta.regularMarketDayHigh  || null,
      low:       meta.regularMarketDayLow   || null,
      prevClose: prev,
      highs:     quotes?.high   || [],
      lows:      quotes?.low    || [],
      closes:    quotes?.close  || [],
    };
  });

  res.json(data);
};
