import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../db/client.js';

const router = Router();

const adminAuth = (req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.header('X-Admin-Key');
    if (apiKey !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized admin access' });
    }
    next();
};

router.use(adminAuth);

router.get('/agents', async (req, res) => {
    const { data, error } = await supabase
        .from('agents')
        .select(`
      *,
      wallets (*)
    `);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

router.get('/leaderboard', async (req, res) => {
    const { data, error } = await supabase
        .from('wallets')
        .select('agent_id, equity_usd, realized_pnl_usd, agents(name)')
        .order('equity_usd', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

router.get('/agent/:id', async (req, res) => {
    const { id } = req.params;
    const { data: wallet } = await supabase.from('wallets').select('*').eq('agent_id', id).single();
    const { data: positions } = await supabase.from('positions').select('*').eq('agent_id', id);
    const { data: orders } = await supabase.from('orders').select('*').eq('agent_id', id).limit(50);

    res.json({ wallet, positions, orders });
});

export default router;
