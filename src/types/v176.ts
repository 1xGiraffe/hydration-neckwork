import {sts, Result, Option, Bytes, BitSequence} from './support'

export interface AssetDetails {
    name: Bytes
    assetType: AssetType
    existentialDeposit: bigint
    xcmRateLimit?: (bigint | undefined)
}

export type AssetType = AssetType_Bond | AssetType_PoolShare | AssetType_StableSwap | AssetType_Token | AssetType_XYK

export interface AssetType_Bond {
    __kind: 'Bond'
}

export interface AssetType_PoolShare {
    __kind: 'PoolShare'
    value: [number, number]
}

export interface AssetType_StableSwap {
    __kind: 'StableSwap'
}

export interface AssetType_Token {
    __kind: 'Token'
}

export interface AssetType_XYK {
    __kind: 'XYK'
}

export const AssetDetails: sts.Type<AssetDetails> = sts.struct(() => {
    return  {
        name: sts.bytes(),
        assetType: AssetType,
        existentialDeposit: sts.bigint(),
        xcmRateLimit: sts.option(() => sts.bigint()),
    }
})

export const AssetType: sts.Type<AssetType> = sts.closedEnum(() => {
    return  {
        Bond: sts.unit(),
        PoolShare: sts.tuple(() => [sts.number(), sts.number()]),
        StableSwap: sts.unit(),
        Token: sts.unit(),
        XYK: sts.unit(),
    }
})
