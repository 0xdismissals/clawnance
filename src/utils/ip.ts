import { Request } from 'express';
import crypto from 'crypto';

/**
 * Robustly extracts the client IP address from an Express request,
 * accounting for potential proxy headers and normalizing formatting.
 */
export function getClientIp(req: Request): string {
    // 1. Check for standard proxy headers (X-Forwarded-For is common)
    const forwardedFor = req.header('x-forwarded-for');
    if (forwardedFor) {
        // X-Forwarded-For can contain a list: "client, proxy1, proxy2"
        const ips = forwardedFor.split(',').map(ip => ip.trim());
        if (ips[0]) return normalizeIp(ips[0]);
    }

    // 2. Check for X-Real-IP (often set by Nginx)
    const realIp = req.header('x-real-ip');
    if (realIp) return normalizeIp(realIp);

    // 3. Fallback to req.ip (populated by Express if trust proxy is on)
    return normalizeIp(req.ip || '127.0.0.1');
}

/**
 * Normalizes IP addresses (e.g., stripping IPv6 mapping for IPv4)
 */
function normalizeIp(ip: string): string {
    // Handle IPv6-mapped IPv4 addresses (::ffff:127.0.0.1 -> 127.0.0.1)
    if (ip.startsWith('::ffff:')) {
        return ip.substring(7);
    }
    return ip;
}

/**
 * Generates a consistent Device ID hash based on the IP and a salt.
 */
export function generateDeviceId(ip: string): string {
    const salt = process.env.DEVICE_SALT || 'clawnance-secure-salt-v1';
    return crypto.createHash('sha256').update(ip + salt).digest('hex');
}
