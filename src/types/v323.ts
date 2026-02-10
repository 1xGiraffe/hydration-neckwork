import {sts, Result, Option, Bytes, BitSequence} from './support'

export const PoolPegInfo: sts.Type<PoolPegInfo> = sts.struct(() => {
    return  {
        source: sts.array(() => PegSource),
        maxPegUpdate: Permill,
        current: sts.array(() => sts.tuple(() => [sts.bigint(), sts.bigint()])),
    }
})

export const PegSource: sts.Type<PegSource> = sts.closedEnum(() => {
    return  {
        MMOracle: H160,
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

export const H160 = sts.bytes()

export type PegSource = PegSource_MMOracle | PegSource_Oracle | PegSource_Value

export interface PegSource_MMOracle {
    __kind: 'MMOracle'
    value: H160
}

export interface PegSource_Oracle {
    __kind: 'Oracle'
    value: [Bytes, OraclePeriod, number]
}

export interface PegSource_Value {
    __kind: 'Value'
    value: [bigint, bigint]
}

export type H160 = Bytes

export interface PoolPegInfo {
    source: PegSource[]
    maxPegUpdate: Permill
    current: [bigint, bigint][]
}

export type Permill = number

export const Permill = sts.number()

export const NonZeroU16 = sts.number()
