import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import nacl from 'tweetnacl';
import { supabase } from '../db/client.js';

const TIMESTAMP_WINDOW_MS = 30000; // ±30s

export const agentAuthMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const agentId = req.header('X-Agent-Id');
    const timestamp = req.header('X-Timestamp');
    const nonce = req.header('X-Nonce');
    const bodySha256 = req.header('X-Body-SHA256');
    const signature = req.header('X-Signature');

    if (!agentId || !timestamp || !nonce || !bodySha256 || !signature) {
        return res.status(401).json({ error: 'Missing auth headers' });
    }

    const ts = parseInt(timestamp);
    const now = Date.now();
    if (Math.abs(now - ts) > TIMESTAMP_WINDOW_MS) {
        return res.status(401).json({ error: 'Timestamp out of window' });
    }

    try {
        // 1. Fetch agent pubkey and device_id
        const { data: agent, error: agentError } = await supabase
            .from('agents')
            .select('pubkey, device_id')
            .eq('id', agentId)
            .single();

        if (agentError || !agent) {
            return res.status(401).json({ error: 'Agent not found' });
        }

        // 2. Connection-Anchored Security Check (IP Lock)
        const salt = process.env.DEVICE_SALT || 'clawnance-secure-salt-v1';
        const ip = req.ip || '127.0.0.1';
        const currentDeviceId = crypto.createHash('sha256').update(ip + salt).digest('hex');

        if (agent.device_id !== currentDeviceId) {
            console.warn(`[Auth] IP Mismatch! Agent ${agentId} attempted request from unauthorized IP: ${ip}`);
            return res.status(401).json({ error: 'Connection-Anchored Identity mismatch. Requests must originate from the registered device.' });
        }

        // 3. Replay protection
        const { data: existingNonce, error: nonceError } = await supabase
            .from('nonces')
            .select('nonce')
            .eq('agent_id', agentId)
            .eq('nonce', nonce)
            .single();

        if (existingNonce) {
            return res.status(401).json({ error: 'Nonce already used' });
        }

        // 3. Verify Body SHA256 (if body exists)
        // Standardize on hashing the RAW request body or empty string
        const bodyStr = req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : '';
        const actualSha256 = crypto.createHash('sha256').update(bodyStr).digest('hex');

        if (actualSha256 !== bodySha256) {
            console.error(`[Auth] Body hash mismatch: agent=${agentId}, expected=${bodySha256}, actual=${actualSha256}`);
            return res.status(401).json({ error: 'Body hash mismatch' });
        }

        // 4. Construct canonical string
        // We use req.originalUrl to ensure the agent signs the full path starting from /v1
        const fullPath = req.originalUrl.split('?')[0];
        const canonicalString = `${req.method.toUpperCase()}\n${fullPath}\n${timestamp}\n${nonce}\n${bodySha256}`;

        // 5. Verify Signature
        const pubkeyBytes = Buffer.from(agent.pubkey, 'hex');
        const signatureBytes = Buffer.from(signature, 'base64');
        const messageBytes = Buffer.from(canonicalString, 'utf8');

        const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, pubkeyBytes);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid signature' });
        }

        // 6. Store Nonce
        await supabase.from('nonces').insert({
            agent_id: agentId,
            nonce: nonce,
            expires_at: new Date(now + 120000).toISOString() // 2 minutes
        });

        // Attach agent to request
        (req as any).agentId = agentId;
        next();
    } catch (err) {
        console.error('Auth error:', err);
        res.status(500).json({ error: 'Internal auth error' });
    }
};
