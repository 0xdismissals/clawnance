import { Decimal } from 'decimal.js';
import { supabase } from '../db/client.js';
import { MarketState } from '../market/state.js';
import { EngineCalculator } from './calculator.js';

export class TradingEngine {
    private static instance: TradingEngine;
    private marketState = MarketState.getInstance();
    private activePositions: Map<string, any[]> = new Map();
    private initialized = false;

    private constructor() { }

    public static getInstance(): TradingEngine {
        if (!TradingEngine.instance) {
            TradingEngine.instance = new TradingEngine();
        }
        return TradingEngine.instance;
    }

    public async syncPosition(pos: any) {
        await this.ensureInitialized();
        const list = this.activePositions.get(pos.symbol) || [];
        const idx = list.findIndex(p => p.id === pos.id);
        if (pos.status === 'active') {
            if (idx !== -1) {
                list[idx] = pos;
            } else {
                list.push(pos);
            }
        } else {
            if (idx !== -1) {
                list.splice(idx, 1);
            }
        }
        this.activePositions.set(pos.symbol, list);
    }

    private async ensureInitialized() {
        if (this.initialized) return;

        console.log('[Engine] Initializing active positions cache...');
        const { data: positions, error } = await supabase
            .from('positions')
            .select('*')
            .eq('status', 'active');

        if (error) {
            console.error('[Engine] Failed to load active positions:', error);
            return;
        }

        // Reset and fill cache
        this.activePositions.clear();
        (positions || []).forEach(pos => {
            const list = this.activePositions.get(pos.symbol) || [];
            list.push(pos);
            this.activePositions.set(pos.symbol, list);
        });

        this.initialized = true;
        console.log(`[Engine] Cached ${positions?.length || 0} active positions.`);
    }

    /**
     * Main entry point for price ticks.
     * Processes limit orders and TP/SL for a given symbol.
     */
    public async onTick(symbol: string) {
        await this.ensureInitialized();

        const quote = this.marketState.getQuote(symbol);
        if (!quote) return;

        // 1. Process Limit Orders (Still DB-bound for now as they are less frequent)
        await this.processLimitOrders(symbol, quote);

        // 2. Process TP/SL and Liquidations (Using Cache)
        await this.processRiskTriggers(symbol, quote);
    }

    private async processLimitOrders(symbol: string, quote: any) {
        // Fetch open limit orders for this symbol
        const { data: orders } = await supabase
            .from('orders')
            .select('*')
            .eq('symbol', symbol)
            .eq('status', 'open')
            .eq('type', 'limit');

        if (!orders) return;

        for (const order of orders) {
            const limitPrice = new Decimal(order.price);
            let filled = false;
            let fillPrice = new Decimal(0);

            // Buy limit fills when last <= limit_price
            if (order.side === 'buy' && !quote.last.isZero() && quote.last.lte(limitPrice)) {
                filled = true;
                fillPrice = quote.last;
            }
            // Sell limit fills when last >= limit_price
            else if (order.side === 'sell' && !quote.last.isZero() && quote.last.gte(limitPrice)) {
                filled = true;
                fillPrice = quote.last;
            }

            if (filled) {
                await this.executeFill(order, fillPrice);
            }
        }
    }

    private async processRiskTriggers(symbol: string, quote: any) {
        const positions = this.activePositions.get(symbol);
        if (!positions || positions.length === 0) return;

        // We iterate over a copy because executeClose/updatePositionPnL might modify the cache
        const positionsToProcess = [...positions];

        for (const pos of positionsToProcess) {
            const markPrice = quote.markPrice.isZero() ? quote.last : quote.markPrice;
            const lastPrice = quote.last;
            let shouldClose = false;
            let closePrice = markPrice;

            // Check TP/SL
            // Best practice: TP is usually checked against Mark or Last depending on exchange.
            // We'll check against Last for TP/SL and Mark for Liquidation.
            if (pos.side === 'long') {
                if (pos.take_profit_price && lastPrice.gte(pos.take_profit_price)) {
                    shouldClose = true;
                    closePrice = lastPrice;
                }
                if (pos.stop_loss_price && lastPrice.lte(pos.stop_loss_price)) {
                    shouldClose = true;
                    closePrice = lastPrice;
                }
            } else {
                if (pos.take_profit_price && lastPrice.lte(pos.take_profit_price)) {
                    shouldClose = true;
                    closePrice = lastPrice;
                }
                if (pos.stop_loss_price && lastPrice.gte(pos.stop_loss_price)) {
                    shouldClose = true;
                    closePrice = lastPrice;
                }
            }

            // Check Liquidation (Against Mark Price)
            if ((pos.side === 'long' && markPrice.lte(pos.liq_price)) ||
                (pos.side === 'short' && markPrice.gte(pos.liq_price))) {
                shouldClose = true;
                closePrice = markPrice;
            }

            if (shouldClose) {
                console.log(`[Engine] CRITICAL: Triggering close for ${pos.symbol} ${pos.side} at ${closePrice}`);
                await this.executeClose(pos, closePrice);
            } else {
                // Update PnL every tick (throttled updates to DB happen inside updatePositionPnL)
                await this.updatePositionPnL(pos, markPrice);
            }
        }
    }

    public async executeFill(order: any, fillPrice: Decimal) {
        const { agent_id, symbol, side, qty, leverage, reduce_only } = order;
        const fillPriceDec = new Decimal(fillPrice);
        const orderQty = new Decimal(qty);

        try {
            // 1. Fetch existing active position for this symbol
            const { data: existingPos } = await supabase
                .from('positions')
                .select('*')
                .eq('agent_id', agent_id)
                .eq('symbol', symbol)
                .eq('status', 'active')
                .maybeSingle();

            const orderSide = side === 'buy' ? 'long' : 'short';

            if (existingPos) {
                if (existingPos.side !== orderSide) {
                    // --- NETTING (Opposite Side) ---
                    const existingQty = new Decimal(existingPos.qty);

                    if (orderQty.lt(existingQty)) {
                        // PARTIAL CLOSE
                        const realPnL = EngineCalculator.calculateUPnL(existingPos.side, orderQty, new Decimal(existingPos.entry_price), fillPriceDec);
                        await this.settlePartial(existingPos, orderQty, fillPriceDec, realPnL);
                    } else if (orderQty.eq(existingQty)) {
                        // FULL CLOSE
                        await this.executeClose(existingPos, fillPriceDec);
                    } else {
                        // CLOSE & FLIP (unless reduce_only)
                        await this.executeClose(existingPos, fillPriceDec);
                        if (!reduce_only) {
                            const surplusQty = orderQty.minus(existingQty);
                            await this.openNewPosition(agent_id, symbol, orderSide, surplusQty, fillPriceDec, leverage);
                        }
                    }
                } else {
                    // --- PYRAMIDING (Same Side) ---
                    if (!reduce_only) {
                        await this.increasePosition(existingPos, orderQty, fillPriceDec);
                    }
                }
            } else {
                // --- NEW POSITION ---
                if (!reduce_only) {
                    await this.openNewPosition(agent_id, symbol, orderSide, orderQty, fillPriceDec, leverage);
                }
            }

            // 3. Delete Order (Leanness)
            await supabase.from('orders').delete().eq('id', order.id);

            // 4. Log to Ledger
            await supabase.from('ledger').insert({
                agent_id,
                action: 'FILL',
                symbol,
                qty: orderQty.toNumber(),
                price: fillPriceDec.toNumber(),
                metadata: { order_id: order.id, leverage, reduce_only }
            });

        } catch (err) {
            console.error('Fill execution failed:', err);
            await supabase.from('orders').update({ status: 'rejected' }).eq('id', order.id);
        }
    }

    private async openNewPosition(agent_id: string, symbol: string, side: string, qty: Decimal, fillPrice: Decimal, leverage: number) {
        const notional = qty.times(fillPrice);
        const requiredMargin = notional.div(leverage);

        const { data: wallet } = await supabase.from('wallets').select('*').eq('agent_id', agent_id).single();
        if (!wallet) throw new Error('Wallet not found');

        const newUsedMargin = new Decimal(wallet.used_margin_usd).plus(requiredMargin);
        await supabase.from('wallets').update({
            used_margin_usd: newUsedMargin.toNumber(),
            updated_at: new Date().toISOString()
        }).eq('agent_id', agent_id);

        const liqPrice = EngineCalculator.calculateLiqPrice(side as any, fillPrice, leverage);

        const { data: newPos, error: posError } = await supabase.from('positions').insert({
            agent_id,
            symbol,
            side,
            qty: qty.toNumber(),
            entry_price: fillPrice.toNumber(),
            leverage,
            liq_price: liqPrice.toNumber(),
            updated_at: new Date().toISOString()
        }).select().single();

        if (newPos) {
            const list = this.activePositions.get(symbol) || [];
            list.push(newPos);
            this.activePositions.set(symbol, list);
        }
    }

    private async settlePartial(pos: any, qtyToClose: Decimal, closePrice: Decimal, realPnL: Decimal) {
        const { agent_id, leverage, entry_price } = pos;
        const initialMarginReduced = qtyToClose.times(new Decimal(entry_price)).div(leverage);

        const { data: wallet } = await supabase.from('wallets').select('*').eq('agent_id', agent_id).single();
        if (!wallet) return;

        const newBalance = new Decimal(wallet.balance_usd).plus(realPnL);
        const newRealizedPnL = new Decimal(wallet.realized_pnl_usd).plus(realPnL);
        const newUsedMargin = new Decimal(wallet.used_margin_usd).minus(initialMarginReduced);

        await supabase.from('wallets').update({
            balance_usd: newBalance.toNumber(),
            realized_pnl_usd: newRealizedPnL.toNumber(),
            used_margin_usd: newUsedMargin.toNumber(),
            updated_at: new Date().toISOString()
        }).eq('agent_id', agent_id);

        const { data: updatedPos } = await supabase.from('positions').update({
            qty: new Decimal(pos.qty).minus(qtyToClose).toNumber(),
            updated_at: new Date().toISOString()
        }).eq('id', pos.id).select().single();

        if (updatedPos) {
            const list = this.activePositions.get(pos.symbol) || [];
            const idx = list.findIndex(p => p.id === pos.id);
            if (idx !== -1) {
                list[idx] = updatedPos;
            }
        }

        // Record the trade history for the partial close
        await supabase.from('trades').insert({
            agent_id,
            symbol: pos.symbol,
            side: pos.side,
            qty: qtyToClose.toNumber(),
            entry_price: pos.entry_price,
            close_price: closePrice.toNumber(),
            realized_pnl: realPnL.toNumber(),
            leverage: pos.leverage,
            closed_at: new Date().toISOString()
        });
    }

    private async increasePosition(pos: any, qtyToAdd: Decimal, fillPrice: Decimal) {
        const { agent_id, entry_price, qty, leverage } = pos;
        const existingQty = new Decimal(qty);
        const existingEntry = new Decimal(entry_price);
        const totalQty = existingQty.plus(qtyToAdd);

        // Weighted Average Entry Price
        const newEntry = (existingEntry.times(existingQty).plus(fillPrice.times(qtyToAdd))).div(totalQty).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

        const addedMargin = qtyToAdd.times(fillPrice).div(leverage);

        const { data: wallet } = await supabase.from('wallets').select('*').eq('agent_id', agent_id).single();
        if (!wallet) return;

        const newUsedMargin = new Decimal(wallet.used_margin_usd).plus(addedMargin);
        await supabase.from('wallets').update({
            used_margin_usd: newUsedMargin.toNumber(),
            updated_at: new Date().toISOString()
        }).eq('agent_id', agent_id);

        const newLiqPrice = EngineCalculator.calculateLiqPrice(pos.side, newEntry, leverage);

        const { data: updatedPos } = await supabase.from('positions').update({
            qty: totalQty.toNumber(),
            entry_price: newEntry.toNumber(),
            liq_price: newLiqPrice.toNumber(),
            updated_at: new Date().toISOString()
        }).eq('id', pos.id).select().single();

        if (updatedPos) {
            const list = this.activePositions.get(pos.symbol) || [];
            const idx = list.findIndex(p => p.id === pos.id);
            if (idx !== -1) {
                list[idx] = updatedPos;
            }
        }
    }

    public async executeClose(pos: any, closePrice: Decimal) {
        const { agent_id, symbol, side, qty, entry_price, leverage } = pos;
        const closePriceDec = new Decimal(closePrice);
        const entryPriceDec = new Decimal(entry_price);
        const qtyDec = new Decimal(qty);

        const realPnL = EngineCalculator.calculateUPnL(side, qtyDec, entryPriceDec, closePriceDec);
        const initialMargin = qtyDec.times(entryPriceDec).div(leverage);

        try {
            // 1. Mark Position as CLOSED (ATOMIC CHECK)
            // Use status='active' as a guard to prevent race conditions
            const { data: closedPos, error: updateError } = await supabase.from('positions')
                .update({
                    status: 'closed',
                    close_price: closePriceDec.toNumber(),
                    realized_pnl: realPnL.toNumber(),
                    closed_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', pos.id)
                .eq('status', 'active')
                .select()
                .maybeSingle();

            if (updateError || !closedPos) {
                console.warn(`[Engine] Position ${pos.id} already closed or failed to update. skipping.`);
                // Remove from cache if it was there
                const list = this.activePositions.get(symbol) || [];
                this.activePositions.set(symbol, list.filter(p => p.id !== pos.id));
                return;
            }

            // 2. Update Cache
            const list = this.activePositions.get(symbol) || [];
            this.activePositions.set(symbol, list.filter(p => p.id !== pos.id));

            // 3. Update Wallet
            const { data: wallet } = await supabase.from('wallets').select('*').eq('agent_id', agent_id).single();
            if (!wallet) throw new Error('Wallet not found');

            const newBalance = new Decimal(wallet.balance_usd).plus(realPnL);
            const newRealizedPnL = new Decimal(wallet.realized_pnl_usd).plus(realPnL);
            const newUsedMargin = new Decimal(wallet.used_margin_usd).minus(initialMargin);

            await supabase.from('wallets').update({
                balance_usd: newBalance.toNumber(),
                realized_pnl_usd: newRealizedPnL.toNumber(),
                used_margin_usd: newUsedMargin.toNumber(),
                updated_at: new Date().toISOString()
            }).eq('agent_id', agent_id);

            // 3. Insert into Permanent Trades History
            await supabase.from('trades').insert({
                agent_id,
                symbol,
                side,
                qty,
                entry_price: entryPriceDec.toNumber(),
                close_price: closePriceDec.toNumber(),
                realized_pnl: realPnL.toNumber(),
                leverage,
                closed_at: new Date().toISOString()
            });

            // 4. Log to Ledger
            await supabase.from('ledger').insert({
                agent_id,
                action: 'CLOSE',
                symbol,
                qty,
                price: closePriceDec.toNumber(),
                metadata: { position_id: pos.id, pnl: realPnL.toNumber() }
            });
        } catch (err) {
            console.error('Close position failed:', err);
        }
    }

    private lastPnLUpdate: Map<string, number> = new Map();
    private async updatePositionPnL(pos: any, markPrice: Decimal) {
        const now = Date.now();
        const last = this.lastPnLUpdate.get(pos.id) || 0;

        // Update local cache EVERY tick
        const markPriceDec = new Decimal(markPrice);
        const upnl = EngineCalculator.calculateUPnL(pos.side, new Decimal(pos.qty), new Decimal(pos.entry_price), markPriceDec);

        const list = this.activePositions.get(pos.symbol) || [];
        const cachedPos = list.find(p => p.id === pos.id);
        if (cachedPos) {
            cachedPos.mark_price = markPriceDec.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber();
            cachedPos.unrealized_pnl_usd = upnl.toNumber();
        }

        // Throttled update to DB (every 5 seconds)
        if (now - last < 5000) return;
        this.lastPnLUpdate.set(pos.id, now);

        await supabase.from('positions').update({
            mark_price: markPriceDec.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber(),
            unrealized_pnl_usd: upnl.toNumber(),
            updated_at: new Date().toISOString()
        }).eq('id', pos.id);
    }
}
