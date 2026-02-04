import { Router } from 'express';
import { supabase } from '../db/client.js';
import { MarketState } from '../market/state.js';
import { Decimal } from 'decimal.js';

const router = Router();
const marketState = MarketState.getInstance();

// GET /v1/public/agent/:identifier
// Lookup by ID, Name, or Pubkey
router.get('/agent/:identifier', async (req, res) => {
    const { identifier } = req.params;

    // Try ID first, then Pubkey, then Name
    const { data: agent, error: agentError } = await supabase
        .from('agents')
        .select('*')
        .or(`id.eq.${identifier},pubkey.eq.${identifier},name.eq.${identifier}`)
        .maybeSingle();

    if (agentError) return res.status(500).json({ error: agentError.message });
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // Fetch associated data
    const [walletRes, positionsRes, tradesRes] = await Promise.all([
        supabase.from('wallets').select('*').eq('agent_id', agent.id).maybeSingle(),
        supabase.from('positions').select('*').eq('agent_id', agent.id).eq('status', 'active'),
        supabase.from('trades').select('realized_pnl, qty, entry_price').eq('agent_id', agent.id)
    ]);

    const wallet = walletRes.data;
    const positions = positionsRes.data || [];
    const trades = tradesRes.data || [];

    // Calculate live unrealized PnL and equity
    let totalUnrealizedPnL = new Decimal(0);
    const enrichedPositions = positions.map(pos => {
        const quote = marketState.getQuote(pos.symbol);
        const currentPrice = quote ? quote.last : new Decimal(pos.mark_price || 0);

        const entry = new Decimal(pos.entry_price);
        const qty = new Decimal(pos.qty);
        const upnl = pos.side === 'long'
            ? currentPrice.minus(entry).times(qty)
            : entry.minus(currentPrice).times(qty);

        totalUnrealizedPnL = totalUnrealizedPnL.plus(upnl);

        return {
            ...pos,
            mark_price: currentPrice.toNumber(),
            unrealized_pnl_usd: upnl.toNumber()
        };
    });

    const liveEquity = wallet ? new Decimal(wallet.balance_usd).plus(totalUnrealizedPnL) : new Decimal(0);

    // Calculate trade statistics
    const realizedTotal = trades.reduce((acc: number, t: any) => acc + (t.realized_pnl || 0), 0);
    const totalVolume = trades.reduce((acc: number, t: any) => acc + (Number(t.qty) * Number(t.entry_price)), 0);
    const winningTrades = trades.filter((t: any) => t.realized_pnl > 0).length;
    const totalTrades = trades.length;
    const winRate = totalTrades > 0 ? Math.round((winningTrades / totalTrades) * 100) : 0;

    res.json({
        agent: {
            id: agent.id,
            name: agent.name,
            pubkey: agent.pubkey,
            created_at: agent.created_at
        },
        stats: {
            equity: liveEquity.toNumber(),
            balance: wallet?.balance_usd || 0,
            realized_pnl: realizedTotal,
            unrealized_pnl: totalUnrealizedPnL.toNumber(),
            win_rate: winRate,
            volume: totalVolume,
            total_moves: totalTrades
        },
        positions: enrichedPositions
    });
});

export default router;
