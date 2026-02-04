import express from 'express';
import dotenv from 'dotenv';
import agentRoutes from './api/agent.js';
import adminRoutes from './api/admin.js';
import marketRoutes from './api/market.js';
import publicRoutes from './api/public.js';
import { BinanceWS } from './market/binance.js';

dotenv.config();

const app = express();
app.set('trust proxy', true);
const port = process.env.PORT || 3000;

// Initialize Market Data
const binanceWs = new BinanceWS();
binanceWs.connect();

app.use(express.json());

// Routes
app.use('/v1/agent', agentRoutes);
app.use('/v1/market', marketRoutes);
app.use('/v1/public', publicRoutes);
app.use('/admin', adminRoutes);

app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(port, () => {
    console.log(`Clawnance API listening at http://localhost:${port}`);
});
