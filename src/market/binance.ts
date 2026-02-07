import WebSocket from 'ws';
import { Decimal } from 'decimal.js';
import { MarketState } from './state.js';
import { TradingEngine } from '../engine/index.js';
import { supabase } from '../db/client.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'DOGEUSDT', 'PEPEUSDT', 'SOLUSDT', 'BNBUSDT', 'TRONUSDT'];
const BINANCE_WS_URL = 'wss://fstream.binance.com/ws';

export class BinanceWS {
    private ws: WebSocket | null = null;
    private marketState = MarketState.getInstance();

    constructor() { }

    public connect() {
        const streamList: string[] = [];
        SYMBOLS.forEach(s => {
            const sym = s.toLowerCase();
            streamList.push(`${sym}@ticker`);
            streamList.push(`${sym}@kline_1h`);
            streamList.push(`${sym}@markPrice`);
            streamList.push(`${sym}@aggTrade`);
            streamList.push(`${sym}@bookTicker`);
        });

        const url = `${BINANCE_WS_URL}/${streamList.join('/')}`;

        console.log(`Connecting to Binance WS: ${url}`);
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            console.log('Connected to Binance WebSocket');
        });

        this.ws.on('message', (data: string) => {
            try {
                const msg = JSON.parse(data);
                const stream = msg.stream;
                const dataObj = msg.data;

                // If it's a combined stream, the payload is wrapped in {stream, data}
                // But Binance also allows connecting directly to streams.
                // If we use the stream junction format, it wraps them.

                const eventData = dataObj || msg;
                const symbol = eventData.s ? eventData.s.replace('USDT', 'USD') : '';
                if (!symbol) return;

                // Sync to DB (Throttled)
                this.syncToDb(symbol, eventData).catch(err => console.error(`DB Sync failed for ${symbol}:`, err));

                if (eventData.e === '24hrTicker') {
                    this.marketState.updateQuote(symbol, {
                        last: new Decimal(eventData.c).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
                        high24h: new Decimal(eventData.h).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
                        low24h: new Decimal(eventData.l).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
                        volume24h: new Decimal(eventData.v).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
                        priceChange24h: new Decimal(eventData.p).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
                        priceChangePercent24h: new Decimal(eventData.P).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
                        ts: eventData.E
                    });
                    TradingEngine.getInstance().onTick(symbol).catch(err => console.error(`Engine tick failed for ${symbol}:`, err));
                } else if (eventData.e === 'kline') {
                    const k = eventData.k;
                    this.marketState.updateQuote(symbol, {
                        open1h: new Decimal(k.o),
                        high1h: new Decimal(k.h),
                        low1h: new Decimal(k.l),
                        close1h: new Decimal(k.c),
                        volume1h: new Decimal(k.v),
                        ts: eventData.E
                    });
                } else if (eventData.e === 'markPriceUpdate') {
                    this.marketState.updateQuote(symbol, {
                        markPrice: new Decimal(eventData.p).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
                        indexPrice: new Decimal(eventData.i).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
                        fundingRate: new Decimal(eventData.r).toDecimalPlaces(8, Decimal.ROUND_HALF_UP),
                        ts: eventData.E
                    });
                    // Mark price updates are critical for Risk (Liq/PnL)
                    TradingEngine.getInstance().onTick(symbol).catch(err => console.error(`Engine tick failed for ${symbol}:`, err));
                } else if (eventData.e === 'aggTrade') {
                    this.marketState.updateQuote(symbol, {
                        recentTrades: [{
                            p: new Decimal(eventData.p).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
                            q: new Decimal(eventData.q).toDecimalPlaces(8, Decimal.ROUND_HALF_UP),
                            T: eventData.T,
                            m: eventData.m
                        }]
                    });
                    // Throttled onTick for trades to ensure Limit Orders/TP hit fast but don't overwhelm
                    this.triggerTradeTick(symbol);
                } else if (!eventData.e && eventData.u) {
                    // bookTicker doesn't have an "e" field but has "u" (updateId)
                    this.marketState.updateQuote(symbol, {
                        bid: new Decimal(eventData.b).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
                        ask: new Decimal(eventData.a).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
                        bidQty: new Decimal(eventData.B).toDecimalPlaces(8, Decimal.ROUND_HALF_UP),
                        askQty: new Decimal(eventData.A).toDecimalPlaces(8, Decimal.ROUND_HALF_UP),
                        ts: eventData.E || Date.now()
                    });
                }
            } catch (err) {
                console.error('Error parsing Binance message:', err);
            }
        });

        this.ws.on('close', () => {
            console.log('Binance WS closed, reconnecting in 5s...');
            setTimeout(() => this.connect(), 5000);
        });

        this.ws.on('error', (err) => {
            console.error('Binance WS error:', err);
        });
    }

    private lastTradeTick: Map<string, number> = new Map();
    private triggerTradeTick(symbol: string) {
        const now = Date.now();
        const last = this.lastTradeTick.get(symbol) || 0;
        if (now - last < 500) return; // Max 2 ticks per second from trades
        this.lastTradeTick.set(symbol, now);
        TradingEngine.getInstance().onTick(symbol).catch(err => console.error(`Engine tick failed for ${symbol}:`, err));
    }

    private lastSync: Map<string, number> = new Map();
    private async syncToDb(symbol: string, eventData: any) {
        const now = Date.now();
        const last = this.lastSync.get(symbol) || 0;

        // Sync every 2 seconds per symbol to prevent DB overload
        if (now - last < 2000) return;
        this.lastSync.set(symbol, now);

        const quote = this.marketState.getQuote(symbol);
        if (!quote) return;

        try {
            await supabase.from('prices').upsert({
                symbol,
                bid: quote.bid.toNumber(),
                ask: quote.ask.toNumber(),
                last: quote.last.toNumber(),
                mark_price: quote.markPrice.toNumber(),
                updated_at: new Date().toISOString()
            });
        } catch (err) {
            // Silently fail to avoid console Spam on network blips
        }
    }
}
