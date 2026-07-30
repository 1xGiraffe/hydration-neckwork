import {sts, Result, Option, Bytes, BitSequence} from './support'

export interface AssetDetails {
    name?: (Bytes | undefined)
    assetType: AssetType
    existentialDeposit: bigint
    symbol?: (Bytes | undefined)
    decimals?: (number | undefined)
    xcmRateLimit?: (bigint | undefined)
    isSufficient: boolean
}

export type AssetType = AssetType_Bond | AssetType_External | AssetType_StableSwap | AssetType_Token | AssetType_XYK

export interface AssetType_Bond {
    __kind: 'Bond'
}

export interface AssetType_External {
    __kind: 'External'
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
        name: sts.option(() => sts.bytes()),
        assetType: AssetType,
        existentialDeposit: sts.bigint(),
        symbol: sts.option(() => sts.bytes()),
        decimals: sts.option(() => sts.number()),
        xcmRateLimit: sts.option(() => sts.bigint()),
        isSufficient: sts.boolean(),
    }
})

export const AssetType: sts.Type<AssetType> = sts.closedEnum(() => {
    return  {
        Bond: sts.unit(),
        External: sts.unit(),
        StableSwap: sts.unit(),
        Token: sts.unit(),
        XYK: sts.unit(),
    }
})
