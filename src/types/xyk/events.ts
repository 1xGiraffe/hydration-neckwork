import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v183 from '../v183'

export const poolCreated =  {
    name: 'XYK.PoolCreated',
    /**
     * Pool was created.
     */
    v183: new EventType(
        'XYK.PoolCreated',
        sts.struct({
            who: v183.AccountId32,
            assetA: sts.number(),
            assetB: sts.number(),
            initialSharesAmount: sts.bigint(),
            shareToken: sts.number(),
            pool: v183.AccountId32,
        })
    ),
}

export const poolDestroyed =  {
    name: 'XYK.PoolDestroyed',
    /**
     * Pool was destroyed.
     */
    v183: new EventType(
        'XYK.PoolDestroyed',
        sts.struct({
            who: v183.AccountId32,
            assetA: sts.number(),
            assetB: sts.number(),
            shareToken: sts.number(),
            pool: v183.AccountId32,
        })
    ),
}
