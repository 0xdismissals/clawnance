import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import React from 'react';

// Load assets with robust pathing and error handling
const rootDir = process.cwd();

function loadFont(fontName: string): Buffer {
    const extensions = ['.ttf', '.otf'];
    const possiblePaths = [
        join(rootDir, 'src/assets/fonts'),
        join(rootDir, 'assets/fonts'), // Backup for some deployments
        join(rootDir, 'dist/assets/fonts'), // Backup for built versions
    ];

    for (const basePath of possiblePaths) {
        for (const ext of extensions) {
            try {
                const fullPath = join(basePath, fontName + ext);
                const data = readFileSync(fullPath);
                if (data.length > 5000) { // Real fonts are usually > 5k
                    console.log(`[Assets] Loaded font: ${fontName}${ext} from ${fullPath} (${data.length} bytes)`);
                    return data;
                }
            } catch (err) {
                // Ignore and try next
            }
        }
    }
    console.warn(`[Assets] Could not find or load font: ${fontName}`);
    return Buffer.alloc(0);
}

const interBold = loadFont('Inter-Bold');
const interRegular = loadFont('Inter-Regular');

let pnlBg: string = '';
let overviewBg: string = '';

try {
    pnlBg = readFileSync(join(rootDir, 'src/assets/pnl_bg.JPG')).toString('base64');
    overviewBg = readFileSync(join(rootDir, 'src/assets/overview_bg.JPG')).toString('base64');
} catch (err) {
    console.error('[Assets] Failed to load share card background images:', err);
}

export interface PnLCardData {
    symbol: string;
    side: 'long' | 'short';
    leverage: number;
    pnlUsd: number;
    pnlPercent: number;
    entryPrice: number;
    markPrice: number;
    agentName: string;
}

export interface OverviewCardData {
    agentName: string;
    equityUsd: number;
    realizedPnL: number;
    unrealizedPnL: number;
    winRate: number;
    totalTrades: number;
    totalVolume: number;
    activePositions: number;
}

export async function generatePnLCard(data: PnLCardData): Promise<Buffer> {
    const isProfit = data.pnlUsd >= 0;
    const color = isProfit ? '#22c55e' : '#ef4444';

    const svg = await satori(
        <div style={{
            height: '100%',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#000',
            backgroundImage: `url(data:image/jpeg;base64,${pnlBg})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            color: '#fff',
            fontFamily: 'Inter',
            padding: '40px',
            position: 'relative',
        }}>
            <div style={{
                display: 'flex',
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0,0,0,0.6)',
            }} />

            {/* Content Container */}
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
                width: '100%',
                height: '100%',
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontSize: '24px', fontWeight: 'bold', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '2px' }}>
                            Clawnance
                        </span>
                        <span style={{ fontSize: '48px', fontWeight: 'bold', letterSpacing: '-2px' }}>
                            {data.symbol.replace('USD', '/USD')}
                        </span>
                    </div>
                    <div style={{
                        display: 'flex',
                        backgroundColor: color,
                        color: '#000',
                        padding: '8px 16px',
                        borderRadius: '4px',
                        fontSize: '20px',
                        fontWeight: 'bold',
                        textTransform: 'uppercase'
                    }}>
                        {data.side} {data.leverage}X
                    </div>
                </div>

                {/* Big PnL Display */}
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    backgroundColor: 'rgba(255,255,255,0.05)',
                    borderLeft: `8px solid ${color}`,
                    padding: '32px',
                    marginBottom: '40px',
                    backdropFilter: 'blur(10px)',
                }}>
                    <span style={{ fontSize: '24px', color: '#9ca3af', fontWeight: 'bold', marginBottom: '8px' }}>PNL</span>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '16px' }}>
                        <span style={{ fontSize: '84px', fontWeight: 'bold', color: color }}>
                            {isProfit ? '+' : ''}{data.pnlPercent.toFixed(2)}%
                        </span>
                        <span style={{ fontSize: '32px', fontWeight: 'bold', color: color, opacity: 0.8 }}>
                            ({isProfit ? '+' : ''}${Math.abs(data.pnlUsd).toFixed(4)})
                        </span>
                    </div>
                </div>

                {/* Stats Grid */}
                <div style={{ display: 'flex', gap: '40px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontSize: '18px', color: '#6b7280', fontWeight: 'bold', textTransform: 'uppercase' }}>Entry Price</span>
                        <span style={{ fontSize: '28px', fontWeight: 'bold' }}>${data.entryPrice.toFixed(4)}</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontSize: '18px', color: '#6b7280', fontWeight: 'bold', textTransform: 'uppercase' }}>Mark Price</span>
                        <span style={{ fontSize: '28px', fontWeight: 'bold' }}>${data.markPrice.toFixed(4)}</span>
                    </div>
                </div>

                {/* Footer */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto', paddingTop: '40px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontSize: '16px', color: '#4b5563', fontWeight: 'bold' }}>@{data.agentName}</span>
                        <span style={{ fontSize: '14px', color: '#374151' }}>clawnance.com</span>
                    </div>
                    <span style={{ fontSize: '24px', fontWeight: 'bold', color: 'rgba(255,255,255,0.2)' }}>BETA</span>
                </div>
            </div>
        </div>,
        {
            width: 800,
            height: 800,
            fonts: interBold.length > 0 && interRegular.length > 0 ? [
                { name: 'Inter', data: interBold, weight: 700 },
                { name: 'Inter', data: interRegular, weight: 400 },
            ] : [],
        }
    );

    const resvg = new Resvg(svg, {
        background: 'black',
        fitTo: { mode: 'width', value: 800 }
    });
    return resvg.render().asPng();
}

export async function generateOverviewCard(data: OverviewCardData): Promise<Buffer> {
    const isProfit = data.unrealizedPnL + data.realizedPnL >= 0;
    const color = isProfit ? '#22c55e' : '#ef4444';

    const svg = await satori(
        <div style={{
            height: '100%',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#000',
            backgroundImage: `url(data:image/jpeg;base64,${overviewBg})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            color: '#fff',
            fontFamily: 'Inter',
            padding: '40px',
            position: 'relative',
        }}>
            <div style={{
                display: 'flex',
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0,0,0,0.7)',
            }} />

            <div style={{
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
                height: '100%',
                width: '100%',
            }}>
                <div style={{ display: 'flex', flexDirection: 'column', marginBottom: '40px' }}>
                    <span style={{ fontSize: '24px', fontWeight: 'bold', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '2px' }}>
                        Clawnance
                    </span>
                    <span style={{ fontSize: '56px', fontWeight: 'bold', letterSpacing: '-2px' }}>
                        {data.agentName}
                    </span>
                </div>

                {/* Main Equity Display */}
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    backgroundColor: 'rgba(255,255,255,0.05)',
                    borderLeft: '8px solid #fff',
                    padding: '32px',
                    marginBottom: '40px',
                    backdropFilter: 'blur(10px)',
                }}>
                    <span style={{ fontSize: '20px', color: '#9ca3af', fontWeight: 'bold', marginBottom: '8px' }}>NET EQUITY</span>
                    <span style={{ fontSize: '72px', fontWeight: 'bold' }}>
                        ${data.equityUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                </div>

                {/* Stats Grid Rows */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
                    <div style={{ display: 'flex', gap: '32px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                            <span style={{ fontSize: '16px', color: '#6b7280', fontWeight: 'bold', textTransform: 'uppercase' }}>Win Rate</span>
                            <span style={{ fontSize: '36px', fontWeight: 'bold', color: data.winRate >= 50 ? '#22c55e' : '#6b7280' }}>
                                {data.winRate}%
                            </span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                            <span style={{ fontSize: '16px', color: '#6b7280', fontWeight: 'bold', textTransform: 'uppercase' }}>Active Trades</span>
                            <span style={{ fontSize: '36px', fontWeight: 'bold' }}>{data.activePositions}</span>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: '32px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                            <span style={{ fontSize: '16px', color: '#6b7280', fontWeight: 'bold', textTransform: 'uppercase' }}>Total PnL</span>
                            <span style={{ fontSize: '36px', fontWeight: 'bold', color: color }}>
                                {isProfit ? '+' : '-'}${Math.abs(data.realizedPnL + data.unrealizedPnL).toFixed(2)}
                            </span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                            <span style={{ fontSize: '16px', color: '#6b7280', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Volume</span>
                            <span style={{ fontSize: '36px', fontWeight: 'bold' }}>
                                ${data.totalVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto' }}>
                    <span style={{ fontSize: '24px', fontWeight: 'bold', color: 'rgba(255,255,255,0.1)' }}>CLAWNANCE</span>
                    <span style={{ fontSize: '14px', color: '#374151' }}>clawnance.com</span>
                </div>
            </div>
        </div>,
        {
            width: 800,
            height: 800,
            fonts: interBold.length > 0 && interRegular.length > 0 ? [
                { name: 'Inter', data: interBold, weight: 700 },
                { name: 'Inter', data: interRegular, weight: 400 },
            ] : [],
        }
    );

    const resvg = new Resvg(svg, {
        background: 'black',
        fitTo: { mode: 'width', value: 800 }
    });
    return resvg.render().asPng();
}
