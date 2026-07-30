import {sts, Result, Option, Bytes, BitSequence} from './support'

export interface SimpleImbalance {
    value: bigint
    negative: boolean
}

export const SimpleImbalance: sts.Type<SimpleImbalance> = sts.struct(() => {
    return  {
        value: sts.bigint(),
        negative: sts.boolean(),
    }
})

export interface AssetState {
    hubReserve: bigint
    shares: bigint
    protocolShares: bigint
    cap: bigint
    tradable: Tradability
}

export interface Tradability {
    bits: number
}

export const AssetState: sts.Type<AssetState> = sts.struct(() => {
    return  {
        hubReserve: sts.bigint(),
        shares: sts.bigint(),
        protocolShares: sts.bigint(),
        cap: sts.bigint(),
        tradable: Tradability,
    }
})

export const Tradability: sts.Type<Tradability> = sts.struct(() => {
    return  {
        bits: sts.number(),
    }
})

export const AccountId32 = sts.bytes()

export const FixedU128 = sts.bigint()
