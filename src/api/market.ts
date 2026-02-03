import { Router } from 'express';
import { agentAuthMiddleware } from '../auth/middleware.js';
import { MarketState } from '../market/state.js';

const router = Router();
const marketState = MarketState.getInstance();

// All market routes for agents are authenticated
router.use(agentAuthMiddleware);

router.get('/markets', (req, res) => {
    const symbols = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'DOGEUSD', 'PEPEUSD', 'SOLUSD', 'BNBUSD', 'TRONUSD'];
    res.json({ symbols });
});

router.get('/quotes', (req, res) => {
    const quotes = marketState.getAllQuotes();
    res.json(quotes);
});

router.get('/:symbol/quote', (req, res) => {
    const { symbol } = req.params;
    const quote = marketState.getQuote(symbol);
    if (!quote) return res.status(404).json({ error: 'Symbol not found' });
    res.json(quote);
});

router.get('/:symbol/candles', (req, res) => {
    const { symbol } = req.params;
    const quote = marketState.getQuote(symbol);
    if (!quote) return res.status(404).json({ error: 'Symbol not found' });

    // Return the 1h kline data we are currently tracking
    res.json([{
        open: quote.open1h,
        high: quote.high1h,
        low: quote.low1h,
        close: quote.close1h,
        volume: quote.volume1h,
        ts: quote.ts
    }]);
});

export default router;
