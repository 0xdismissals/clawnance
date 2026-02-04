import { Router } from 'express';
import { agentAuthMiddleware } from '../auth/middleware.js';
import { supabase } from '../db/client.js';
import { MarketState } from '../market/state.js';
import { Decimal } from 'decimal.js';
import { TradingEngine } from '../engine/index.js';
import crypto from 'crypto';
import { generatePnLCard, generateOverviewCard, PnLCardData, OverviewCardData } from '../utils/share-cards/index.js';

import { getClientIp, generateDeviceId } from '../utils/ip.js';

const router = Router();
const marketState = MarketState.getInstance();

router.post('/agents/register', async (req, res) => {
    const { name, pubkey, model } = req.body;
    if (!name || !pubkey) {
        return res.status(400).json({ error: 'Name and pubkey (hex) are required' });
    }

    // Server-side Device ID generation (IP-anchored to prevent tampering)
    const ip = getClientIp(req);
    const deviceId = generateDeviceId(ip);

    const agentId = `agent_${name.toLowerCase().replace(/\s+/g, '_')}`;

    console.log(`[Registration] Registering agent ${name} (${agentId}) from IP ${ip} (Hashed: ${deviceId})`);

    const { data: agent, error } = await supabase
        .from('agents')
        .insert({
            id: agentId,
            name,
            pubkey,
            device_id: deviceId,
            model: model || 'unknown',
            status: 'active'
        })
        .select()
        .single();

    if (error) {
        if (error.code === '23505') {
            let field = 'Agent';
            if (error.message.includes('device_id')) field = 'Connection/Device';
            if (error.message.includes('name')) field = 'Agent name';
            if (error.message.includes('agents_pkey')) field = 'Agent ID (derived from name)';

            return res.status(400).json({ error: `${field} already registered` });
        }
        return res.status(500).json({ error: error.message });
    }

    // Initialize wallet
    await supabase.from('wallets').insert({
        agent_id: agentId,
        balance_usd: 10000,
        equity_usd: 10000,
        free_margin_usd: 10000
    });

    res.json({
        success: true,
        agent_id: agentId,
        message: 'Registration successful. Initialize your local credentials.json with your private key and this agent_id.'
    });
});

// Apply auth to all subsequent agent routes
router.use(agentAuthMiddleware);

router.get('/bootstrap', async (req, res) => {
    res.json({
        symbols: ['BTCUSD', 'ETHUSD', 'XRPUSD', 'DOGEUSD', 'PEPEUSD', 'SOLUSD', 'BNBUSD', 'TRONUSD'],
        leverage_cap: 20,
        fees: { maker: 0.0002, taker: 0.0005 },
        game_rules: 'Simulated trading with 10k starting balance. Margin model: notional/leverage.'
    });
});

router.get('/wallet', async (req: any, res) => {
    const { data, error } = await supabase
        .from('wallets')
        .select('*')
        .eq('agent_id', req.agentId)
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

router.get('/overview', async (req: any, res) => {
    // 1. Fetch structural data
    const [walletRes, positionsRes, ordersRes, closedRes] = await Promise.all([
        supabase.from('wallets').select('*').eq('agent_id', req.agentId).single(),
        supabase.from('positions').select('*').eq('agent_id', req.agentId).eq('status', 'active'),
        supabase.from('orders').select('*').eq('agent_id', req.agentId),
        supabase.from('positions')
            .select('*')
            .eq('agent_id', req.agentId)
            .eq('status', 'closed')
            .order('closed_at', { ascending: false })
            .limit(50)
    ]);

    if (walletRes.error) return res.status(500).json({ error: walletRes.error.message });

    const wallet = walletRes.data;
    const positions = positionsRes.data || [];
    const orders = ordersRes.data || [];
    const closedPositions = closedRes.data || [];

    // 2. Enrich with live market data
    let totalUnrealizedPnL = new Decimal(0);
    const enrichedPositions = positions.map(pos => {
        const quote = marketState.getQuote(pos.symbol);
        const currentPrice = quote ? quote.last : new Decimal(pos.mark_price || 0);

        // Live PnL calculation
        const entry = new Decimal(pos.entry_price);
        const qty = new Decimal(pos.qty);
        const upnl = pos.side === 'long'
            ? currentPrice.minus(entry).times(qty)
            : entry.minus(currentPrice).times(qty);

        const margin = entry.times(qty).div(pos.leverage);
        const roi = margin.isZero() ? new Decimal(0) : upnl.div(margin).times(100);

        totalUnrealizedPnL = totalUnrealizedPnL.plus(upnl);

        return {
            ...pos,
            current_price: currentPrice.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber(),
            margin_invested: margin.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber(),
            unrealized_pnl_usd: upnl.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber(),
            roi_percent: roi.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber()
        };
    });

    const enrichedOrders = orders.map(ord => {
        const quote = marketState.getQuote(ord.symbol);
        const currentPrice = quote ? quote.last : null;
        return {
            ...ord,
            current_price: currentPrice ? currentPrice.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber() : null
        };
    });

    // 3. Fetch Trades History (Permanent)
    const { data: trades } = await supabase
        .from('trades')
        .select('*')
        .eq('agent_id', req.agentId)
        .order('closed_at', { ascending: false })
        .limit(50);

    // 4. Final live wallet state
    const liveEquity = new Decimal(wallet.balance_usd).plus(totalUnrealizedPnL);

    res.json({
        wallet: {
            ...wallet,
            equity_usd: liveEquity.toNumber(),
            unrealized_pnl_usd: totalUnrealizedPnL.toNumber()
        },
        positions: enrichedPositions,
        orders: enrichedOrders,
        history: trades || [],
        closed_positions: trades || []
    });
});

router.post('/orders', async (req: any, res) => {
    const { symbol, side, type, qty, price, leverage, reduceOnly, timeInForce, clientOrderId } = req.body;

    // 1. Validate Input
    if (!symbol || !side || !type || !qty || !leverage) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // 2. Fetch Market Quote
    const quote = marketState.getQuote(symbol);
    if (!quote) return res.status(400).json({ error: 'Symbol not available' });

    // 3. Margin Check (if not reduce-only)
    if (!reduceOnly) {
        const fillPrice = type === 'market' ? quote.last : new Decimal(price);
        const notional = new Decimal(qty).times(fillPrice);
        const requiredMargin = notional.div(leverage);

        const { data: wallet } = await supabase.from('wallets').select('free_margin_usd').eq('agent_id', req.agentId).single();
        if (!wallet || requiredMargin.gt(wallet.free_margin_usd)) {
            return res.status(400).json({ error: 'Insufficient margin' });
        }
    }

    // 4. Create Order in DB
    const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
            agent_id: req.agentId,
            symbol,
            side,
            type,
            qty,
            price: type === 'limit' ? price : null,
            status: 'open',
            leverage,
            reduce_only: reduceOnly || false,
            time_in_force: timeInForce || 'GTC',
            client_order_id: clientOrderId
        })
        .select()
        .single();

    if (orderError) return res.status(500).json({ error: orderError.message });

    // 5. If Market Order, trigger immediate fill
    if (type === 'market') {
        const fillPrice = quote.last;
        if (fillPrice.isZero()) {
            return res.status(400).json({ error: 'Market price data unavailable. Try again in a moment.' });
        }
        await TradingEngine.getInstance().executeFill(order, fillPrice);
    }

    res.json(order);
});

router.get('/orders/:id', async (req: any, res) => {
    const { id } = req.params;
    const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('agent_id', req.agentId)
        .eq('id', id)
        .single();

    if (error || !data) return res.status(404).json({ error: 'Order not found' });
    res.json(data);
});

router.get('/positions', async (req: any, res) => {
    const { data, error } = await supabase
        .from('positions')
        .select('*')
        .eq('agent_id', req.agentId)
        .eq('status', 'active');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});


router.post('/orders/:id/cancel', async (req: any, res) => {
    const { id } = req.params;
    const { data, error } = await supabase
        .from('orders')
        .update({ status: 'canceled', updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('agent_id', req.agentId)
        .eq('status', 'open')
        .select();

    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.status(404).json({ error: 'Order not found or already filled/canceled' });
    res.json({ success: true, order: data[0] });
});

router.get('/positions/:id/share', async (req: any, res) => {
    const { id } = req.params;

    try {
        // Check active positions first
        let { data: pos, error } = await supabase
            .from('positions')
            .select('*, agents(name)')
            .eq('id', id)
            .eq('agent_id', req.agentId)
            .single();

        // If not found, check closed trades
        if (error || !pos) {
            const { data: trade, error: tradeErr } = await supabase
                .from('trades')
                .select('*, agents(name)')
                .eq('id', id)
                .eq('agent_id', req.agentId)
                .single();

            if (tradeErr || !trade) return res.status(404).json({ error: 'Position not found' });

            // Map trade to share data
            const margin = (Number(trade.qty) * Number(trade.entry_price)) / trade.leverage;
            const pnlPercent = margin > 0 ? (trade.realized_pnl / margin) * 100 : 0;

            const cardData: PnLCardData = {
                symbol: trade.symbol,
                side: trade.side,
                leverage: trade.leverage,
                pnlUsd: trade.realized_pnl,
                pnlPercent: pnlPercent,
                entryPrice: trade.entry_price,
                markPrice: trade.close_price,
                agentName: (trade as any).agents?.name || 'Clawnance Agent'
            };
            const png = await generatePnLCard(cardData);
            res.header('Content-Type', 'image/png').send(png);
            return;
        }

        // Map active position to share data
        const margin = (Number(pos.qty) * Number(pos.entry_price)) / pos.leverage;
        const pnlPercent = margin > 0 ? (Number(pos.unrealized_pnl_usd || 0) / margin) * 100 : 0;

        const cardData: PnLCardData = {
            symbol: pos.symbol,
            side: pos.side,
            leverage: pos.leverage,
            pnlUsd: Number(pos.unrealized_pnl_usd || 0),
            pnlPercent: pnlPercent,
            entryPrice: pos.entry_price,
            markPrice: pos.mark_price,
            agentName: (pos as any).agents?.name || 'Clawnance Agent'
        };
        const png = await generatePnLCard(cardData);
        res.header('Content-Type', 'image/png').send(png);
    } catch (err) {
        console.error('[Share] Error generating PnL card:', err);
        res.status(500).json({ error: 'Failed to generate share card', detail: err instanceof Error ? err.message : String(err) });
    }
});

router.get('/overview/share', async (req: any, res) => {
    try {
        // 1. Fetch agent, wallet, and active positions
        const [agentRes, walletRes, positionsRes, tradesRes] = await Promise.all([
            supabase.from('agents').select('name').eq('id', req.agentId).single(),
            supabase.from('wallets').select('*').eq('agent_id', req.agentId).single(),
            supabase.from('positions').select('*').eq('agent_id', req.agentId).eq('status', 'active'),
            supabase.from('trades').select('realized_pnl, qty, entry_price').eq('agent_id', req.agentId)
        ]);

        if (agentRes.error || !agentRes.data) return res.status(404).json({ error: 'Agent not found' });
        if (walletRes.error) return res.status(500).json({ error: walletRes.error.message });

        const agent = agentRes.data;
        const wallet = walletRes.data;
        const positions = positionsRes.data || [];
        const trades = tradesRes.data || [];

        // 2. Calculate live unrealized PnL and equity
        let totalUnrealizedPnL = new Decimal(0);
        positions.forEach(pos => {
            const quote = marketState.getQuote(pos.symbol);
            const currentPrice = quote ? quote.last : new Decimal(pos.mark_price || 0);

            const entry = new Decimal(pos.entry_price);
            const qty = new Decimal(pos.qty);
            const upnl = pos.side === 'long'
                ? currentPrice.minus(entry).times(qty)
                : entry.minus(currentPrice).times(qty);
            totalUnrealizedPnL = totalUnrealizedPnL.plus(upnl);
        });
        const liveEquity = new Decimal(wallet.balance_usd).plus(totalUnrealizedPnL);

        // 3. Calculate trade statistics
        const realizedTotal = trades.reduce((acc: number, t: any) => acc + (t.realized_pnl || 0), 0);
        const totalVolume = trades.reduce((acc: number, t: any) => acc + (Number(t.qty) * Number(t.entry_price)), 0);
        const winningTrades = trades.filter((t: any) => t.realized_pnl > 0).length;
        const totalTrades = trades.length;
        const winRate = totalTrades > 0 ? Math.round((winningTrades / totalTrades) * 100) : 0;

        const cardData: OverviewCardData = {
            agentName: agent.name,
            equityUsd: liveEquity.toNumber(),
            realizedPnL: realizedTotal,
            unrealizedPnL: totalUnrealizedPnL.toNumber(),
            winRate: winRate,
            totalTrades: totalTrades,
            totalVolume: totalVolume,
            activePositions: positions.length
        };

        const png = await generateOverviewCard(cardData);
        res.header('Content-Type', 'image/png').send(png);
    } catch (err) {
        console.error('[Share] Error generating overview card:', err);
        res.status(500).json({ error: 'Failed to generate overview card', detail: err instanceof Error ? err.message : String(err) });
    }
});

router.post('/positions/:symbol/close', async (req: any, res) => {
    const { symbol } = req.params;
    const quote = marketState.getQuote(symbol);
    if (!quote) return res.status(400).json({ error: 'Market price not available' });

    const { data: pos, error } = await supabase
        .from('positions')
        .select('*')
        .eq('agent_id', req.agentId)
        .eq('symbol', symbol)
        .eq('status', 'active')
        .single();

    if (error || !pos) return res.status(404).json({ error: 'Position not found' });

    const closePrice = quote.last;
    await TradingEngine.getInstance().executeClose(pos, closePrice);

    res.json({ success: true, symbol, closePrice });
});

router.post('/positions/:symbol/risk', async (req: any, res) => {
    const { symbol } = req.params;
    const { takeProfitPrice, stopLossPrice } = req.body;

    const { data, error } = await supabase
        .from('positions')
        .update({
            take_profit_price: takeProfitPrice || null,
            stop_loss_price: stopLossPrice || null,
            updated_at: new Date().toISOString()
        })
        .eq('agent_id', req.agentId)
        .eq('symbol', symbol)
        .eq('status', 'active')
        .select();

    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.status(404).json({ error: 'Position not found' });
    res.json(data[0]);
});

export default router;
