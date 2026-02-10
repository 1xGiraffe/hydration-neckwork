import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v183 from '../v183'
import * as v305 from '../v305'
import * as v323 from '../v323'
import * as v378 from '../v378'

export const poolCreated =  {
    name: 'Stableswap.PoolCreated',
    /**
     * A pool was created.
     */
    v183: new EventType(
        'Stableswap.PoolCreated',
        sts.struct({
            poolId: sts.number(),
            assets: sts.array(() => sts.number()),
            amplification: v183.NonZeroU16,
            fee: v183.Permill,
        })
    ),
    /**
     * A pool was created.
     */
    v305: new EventType(
        'Stableswap.PoolCreated',
        sts.struct({
            poolId: sts.number(),
            assets: sts.array(() => sts.number()),
            amplification: v305.NonZeroU16,
            fee: v305.Permill,
            peg: sts.option(() => v305.PoolPegInfo),
        })
    ),
    /**
     * A pool was created.
     */
    v323: new EventType(
        'Stableswap.PoolCreated',
        sts.struct({
            poolId: sts.number(),
            assets: sts.array(() => sts.number()),
            amplification: v323.NonZeroU16,
            fee: v323.Permill,
            peg: sts.option(() => v323.PoolPegInfo),
        })
    ),
    /**
     * A pool was created.
     */
    v378: new EventType(
        'Stableswap.PoolCreated',
        sts.struct({
            poolId: sts.number(),
            assets: sts.array(() => sts.number()),
            amplification: v378.NonZeroU16,
            fee: v378.Permill,
            peg: sts.option(() => v378.PoolPegInfo),
        })
    ),
}

export const liquidityAdded =  {
    name: 'Stableswap.LiquidityAdded',
    /**
     * Liquidity of an asset was added to a pool.
     */
    v183: new EventType(
        'Stableswap.LiquidityAdded',
        sts.struct({
            poolId: sts.number(),
            who: v183.AccountId32,
            shares: sts.bigint(),
            assets: sts.array(() => v183.AssetAmount),
        })
    ),
}
