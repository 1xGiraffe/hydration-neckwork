import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v282 from '../v282'
import * as v305 from '../v305'
import * as v313 from '../v313'
import * as v323 from '../v323'

export const swapped =  {
    name: 'Broadcast.Swapped',
    /**
     * Trade executed.
     */
    v282: new EventType(
        'Broadcast.Swapped',
        sts.struct({
            swapper: v282.AccountId32,
            filler: v282.AccountId32,
            fillerType: v282.Filler,
            operation: v282.TradeOperation,
            inputs: sts.array(() => v282.Asset),
            outputs: sts.array(() => v282.Asset),
            fees: sts.array(() => v282.Fee),
            operationStack: sts.array(() => v282.ExecutionType),
        })
    ),
}

export const swapped2 =  {
    name: 'Broadcast.Swapped2',
    /**
     * Trade executed.
     * 
     * Swapped2 is a fixed and renamed version of original Swapped,
     * as Swapped contained wrong input/output amounts for XYK buy trade
     */
    v305: new EventType(
        'Broadcast.Swapped2',
        sts.struct({
            swapper: v305.AccountId32,
            filler: v305.AccountId32,
            fillerType: v305.Filler,
            operation: v305.TradeOperation,
            inputs: sts.array(() => v305.Asset),
            outputs: sts.array(() => v305.Asset),
            fees: sts.array(() => v305.Fee),
            operationStack: sts.array(() => v305.ExecutionType),
        })
    ),
}

export const swapped3 =  {
    name: 'Broadcast.Swapped3',
    /**
     * Trade executed.
     * 
     * Swapped3 is a fixed and renamed version of original Swapped,
     * as Swapped contained wrong input/output amounts for XYK buy trade
     * 
     * Swapped3 is a fixed and renamed version of original Swapped3,
     * as Swapped contained wrong filler account on AAVE trades
     * 
     */
    v313: new EventType(
        'Broadcast.Swapped3',
        sts.struct({
            swapper: v313.AccountId32,
            filler: v313.AccountId32,
            fillerType: v313.Filler,
            operation: v313.TradeOperation,
            inputs: sts.array(() => v313.Asset),
            outputs: sts.array(() => v313.Asset),
            fees: sts.array(() => v313.Fee),
            operationStack: sts.array(() => v313.ExecutionType),
        })
    ),
    /**
     * Trade executed.
     * 
     * Swapped3 is a fixed and renamed version of original Swapped,
     * as Swapped contained wrong input/output amounts for XYK buy trade
     * 
     * Swapped3 is a fixed and renamed version of original Swapped3,
     * as Swapped contained wrong filler account on AAVE trades
     * 
     */
    v323: new EventType(
        'Broadcast.Swapped3',
        sts.struct({
            swapper: v323.AccountId32,
            filler: v323.AccountId32,
            fillerType: v323.Filler,
            operation: v323.TradeOperation,
            inputs: sts.array(() => v323.Asset),
            outputs: sts.array(() => v323.Asset),
            fees: sts.array(() => v323.Fee),
            operationStack: sts.array(() => v323.ExecutionType),
        })
    ),
}
