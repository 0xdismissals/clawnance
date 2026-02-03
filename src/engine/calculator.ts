import { Decimal } from 'decimal.js';

export class EngineCalculator {
    /**
     * Calculate unrealized PnL for a position.
     */
    public static calculateUPnL(side: string, qty: Decimal, entryPrice: Decimal, markPrice: Decimal): Decimal {
        let pnl: Decimal;
        if (side === 'long') {
            pnl = markPrice.minus(entryPrice).times(qty);
        } else {
            pnl = entryPrice.minus(markPrice).times(qty);
        }
        return pnl.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    }

    /**
     * Calculate liquidation price.
     * Simple model: liquidates when 80% of margin is gone.
     */
    public static calculateLiqPrice(side: string, entryPrice: Decimal, leverage: number): Decimal {
        const maintenanceMarginFactor = new Decimal(0.8); // 80% loss of initial margin
        const margin = entryPrice.div(leverage);
        const lossToLiq = margin.times(maintenanceMarginFactor);

        let liqPrice: Decimal;
        if (side === 'long') {
            liqPrice = entryPrice.minus(lossToLiq);
        } else {
            liqPrice = entryPrice.plus(lossToLiq);
        }
        return liqPrice.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    }
}
