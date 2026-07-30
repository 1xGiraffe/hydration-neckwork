import {sts, Result, Option, Bytes, BitSequence} from './support'

export interface PoolPegInfo {
    source: PegSource[]
    maxPegUpdate: Permill
    current: [bigint, bigint][]
}

export type Permill = number

export type PegSource = PegSource_Oracle | PegSource_Value

export interface PegSource_Oracle {
    __kind: 'Oracle'
    value: [Bytes, OraclePeriod, number]
}

export interface PegSource_Value {
    __kind: 'Value'
    value: [bigint, bigint]
}

export type OraclePeriod = OraclePeriod_Day | OraclePeriod_Hour | OraclePeriod_LastBlock | OraclePeriod_Short | OraclePeriod_TenMinutes | OraclePeriod_Week

export interface OraclePeriod_Day {
    __kind: 'Day'
}

export interface OraclePeriod_Hour {
    __kind: 'Hour'
}

export interface OraclePeriod_LastBlock {
    __kind: 'LastBlock'
}

export interface OraclePeriod_Short {
    __kind: 'Short'
}

export interface OraclePeriod_TenMinutes {
    __kind: 'TenMinutes'
}

export interface OraclePeriod_Week {
    __kind: 'Week'
}

export const ExecutionType: sts.Type<ExecutionType> = sts.closedEnum(() => {
    return  {
        Batch: sts.number(),
        DCA: sts.tuple(() => [sts.number(), sts.number()]),
        Omnipool: sts.number(),
        Router: sts.number(),
        Xcm: sts.tuple(() => [sts.bytes(), sts.number()]),
        XcmExchange: sts.number(),
    }
})

export type ExecutionType = ExecutionType_Batch | ExecutionType_DCA | ExecutionType_Omnipool | ExecutionType_Router | ExecutionType_Xcm | ExecutionType_XcmExchange

export interface ExecutionType_Batch {
    __kind: 'Batch'
    value: number
}

export interface ExecutionType_DCA {
    __kind: 'DCA'
    value: [number, number]
}

export interface ExecutionType_Omnipool {
    __kind: 'Omnipool'
    value: number
}

export interface ExecutionType_Router {
    __kind: 'Router'
    value: number
}

export interface ExecutionType_Xcm {
    __kind: 'Xcm'
    value: [Bytes, number]
}

export interface ExecutionType_XcmExchange {
    __kind: 'XcmExchange'
    value: number
}

export const Fee: sts.Type<Fee> = sts.struct(() => {
    return  {
        asset: sts.number(),
        amount: sts.bigint(),
        destination: Destination,
    }
})

export const Destination: sts.Type<Destination> = sts.closedEnum(() => {
    return  {
        Account: AccountId32,
        Burned: sts.unit(),
    }
})

export type Destination = Destination_Account | Destination_Burned

export interface Destination_Account {
    __kind: 'Account'
    value: AccountId32
}

export interface Destination_Burned {
    __kind: 'Burned'
}

export type AccountId32 = Bytes

export interface Fee {
    asset: number
    amount: bigint
    destination: Destination
}

export const Asset: sts.Type<Asset> = sts.struct(() => {
    return  {
        asset: sts.number(),
        amount: sts.bigint(),
    }
})

export interface Asset {
    asset: number
    amount: bigint
}

export const TradeOperation: sts.Type<TradeOperation> = sts.closedEnum(() => {
    return  {
        ExactIn: sts.unit(),
        ExactOut: sts.unit(),
        Limit: sts.unit(),
        LiquidityAdd: sts.unit(),
        LiquidityRemove: sts.unit(),
    }
})

export type TradeOperation = TradeOperation_ExactIn | TradeOperation_ExactOut | TradeOperation_Limit | TradeOperation_LiquidityAdd | TradeOperation_LiquidityRemove

export interface TradeOperation_ExactIn {
    __kind: 'ExactIn'
}

export interface TradeOperation_ExactOut {
    __kind: 'ExactOut'
}

export interface TradeOperation_Limit {
    __kind: 'Limit'
}

export interface TradeOperation_LiquidityAdd {
    __kind: 'LiquidityAdd'
}

export interface TradeOperation_LiquidityRemove {
    __kind: 'LiquidityRemove'
}

export const Filler: sts.Type<Filler> = sts.closedEnum(() => {
    return  {
        AAVE: sts.unit(),
        LBP: sts.unit(),
        OTC: sts.number(),
        Omnipool: sts.unit(),
        Stableswap: sts.number(),
        XYK: sts.number(),
    }
})

export type Filler = Filler_AAVE | Filler_LBP | Filler_OTC | Filler_Omnipool | Filler_Stableswap | Filler_XYK

export interface Filler_AAVE {
    __kind: 'AAVE'
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

export interface Filler_XYK {
    __kind: 'XYK'
    value: number
}

export const AccountId32 = sts.bytes()

export const PoolPegInfo: sts.Type<PoolPegInfo> = sts.struct(() => {
    return  {
        source: sts.array(() => PegSource),
        maxPegUpdate: Permill,
        current: sts.array(() => sts.tuple(() => [sts.bigint(), sts.bigint()])),
    }
})

export const PegSource: sts.Type<PegSource> = sts.closedEnum(() => {
    return  {
        Oracle: sts.tuple(() => [sts.bytes(), OraclePeriod, sts.number()]),
        Value: sts.tuple(() => [sts.bigint(), sts.bigint()]),
    }
})

export const OraclePeriod: sts.Type<OraclePeriod> = sts.closedEnum(() => {
    return  {
        Day: sts.unit(),
        Hour: sts.unit(),
        LastBlock: sts.unit(),
        Short: sts.unit(),
        TenMinutes: sts.unit(),
        Week: sts.unit(),
    }
})

export const Permill = sts.number()

export const NonZeroU16 = sts.number()
