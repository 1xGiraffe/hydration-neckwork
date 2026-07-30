import {sts, Block, Bytes, Option, Result, EventType, RuntimeCtx} from '../support'
import * as v108 from '../v108'

export const transfer =  {
    name: 'Tokens.Transfer',
    /**
     * Transfer succeeded.
     */
    v108: new EventType(
        'Tokens.Transfer',
        sts.struct({
            currencyId: sts.number(),
            from: v108.AccountId32,
            to: v108.AccountId32,
            amount: sts.bigint(),
        })
    ),
}
