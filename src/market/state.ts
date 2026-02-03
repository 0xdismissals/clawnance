import { Decimal } from 'decimal.js';

export interface Trade {
    p: Decimal; // price
    q: Decimal; // qty
    T: number;  // time
    m: boolean; // is buyer maker
}

export interface MarketQuote {
    symbol: string;
    bid: Decimal;
    ask: Decimal;
    bidQty: Decimal;
    askQty: Decimal;
    last: Decimal;
    markPrice: Decimal;
    indexPrice: Decimal;
    high24h: Decimal;
    low24h: Decimal;
    volume24h: Decimal;
    priceChange24h: Decimal;
    priceChangePercent24h: Decimal;
    fundingRate: Decimal;
    openInterest: Decimal;
    // OHLCV for 1h
    open1h: Decimal;
    high1h: Decimal;
    low1h: Decimal;
    close1h: Decimal;
    volume1h: Decimal;
    recentTrades: Trade[];
    ts: number;
}

export class MarketState {
    private static instance: MarketState;
    private quotes: Map<string, MarketQuote> = new Map();

    private constructor() { }

    public static getInstance(): MarketState {
        if (!MarketState.instance) {
            MarketState.instance = new MarketState();
        }
        return MarketState.instance;
    }

    public updateQuote(symbol: string, quote: Partial<MarketQuote>) {
        const existing = this.quotes.get(symbol) || {
            symbol,
            bid: new Decimal(0),
            ask: new Decimal(0),
            last: new Decimal(0),
            markPrice: new Decimal(0),
            indexPrice: new Decimal(0),
            high24h: new Decimal(0),
            low24h: new Decimal(0),
            volume24h: new Decimal(0),
            priceChange24h: new Decimal(0),
            priceChangePercent24h: new Decimal(0),
            fundingRate: new Decimal(0),
            openInterest: new Decimal(0),
            open1h: new Decimal(0),
            high1h: new Decimal(0),
            low1h: new Decimal(0),
            close1h: new Decimal(0),
            volume1h: new Decimal(0),
            recentTrades: [],
            ts: Date.now()
        };

        const updated = {
            ...existing,
            ...quote,
            ts: quote.ts || Date.now()
        } as MarketQuote;

        // Ensure recentTrades doesn't grow indefinitely
        if (quote.recentTrades) {
            updated.recentTrades = [...quote.recentTrades, ...existing.recentTrades].slice(0, 50);
        }

        this.quotes.set(symbol, updated);
    }

    public getQuote(symbol: string): MarketQuote | undefined {
        return this.quotes.get(symbol);
    }

    public getAllQuotes(): MarketQuote[] {
        return Array.from(this.quotes.values());
    }
}
