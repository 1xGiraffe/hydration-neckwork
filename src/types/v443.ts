import {sts} from './support'

// Runtime 443 (hydration-node v52.0.0, block 14362830) added the UniswapV3 router
// venue. In pallet_broadcast::types::Filler that is one new unit variant; every
// other type Broadcast.Swapped3 carries is unchanged from v323, so they are
// re-exported rather than duplicated. Hand-written because only this one enum
// moved — regenerate with `@subsquid/substrate-typegen` if a later runtime changes more.
export {
    AccountId32,
    Asset,
    Destination,
    ExecutionType,
    Fee,
    TradeOperation,
} from './v323'

export const Filler: sts.Type<Filler> = sts.closedEnum(() => {
    return  {
        AAVE: sts.unit(),
        HSM: sts.unit(),
        LBP: sts.unit(),
        OTC: sts.number(),
        Omnipool: sts.unit(),
        Stableswap: sts.number(),
        UniswapV3: sts.unit(),
        XYK: sts.number(),
    }
})

export type Filler = Filler_AAVE | Filler_HSM | Filler_LBP | Filler_OTC | Filler_Omnipool | Filler_Stableswap | Filler_UniswapV3 | Filler_XYK

export interface Filler_AAVE {
    __kind: 'AAVE'
}

export interface Filler_HSM {
    __kind: 'HSM'
}

export interface Filler_LBP {
    __kind: 'LBP'
}

export interface Filler_OTC {
    __kind: 'OTC'
    value: number
}

export interface Filler_Omnipool {
    __kind: 'Omnipool'
}

export interface Filler_Stableswap {
    __kind: 'Stableswap'
    value: number
}

export interface Filler_UniswapV3 {
    __kind: 'UniswapV3'
}

export interface Filler_XYK {
    __kind: 'XYK'
    value: number
}
