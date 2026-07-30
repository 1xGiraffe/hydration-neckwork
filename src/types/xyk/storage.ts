import {sts, Block, Bytes, Option, Result, StorageType, RuntimeCtx} from '../support'
import * as v183 from '../v183'

export const shareToken =  {
    /**
     *  Asset id storage for shared pool tokens
     */
    v183: new StorageType('XYK.ShareToken', 'Default', [v183.AccountId32], sts.number()) as ShareTokenV183,
}

/**
 *  Asset id storage for shared pool tokens
 */
export interface ShareTokenV183  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): number
    get(block: Block, key: v183.AccountId32): Promise<(number | undefined)>
    getMany(block: Block, keys: v183.AccountId32[]): Promise<(number | undefined)[]>
    getKeys(block: Block): Promise<v183.AccountId32[]>
    getKeys(block: Block, key: v183.AccountId32): Promise<v183.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v183.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block, key: v183.AccountId32): AsyncIterable<v183.AccountId32[]>
    getPairs(block: Block): Promise<[k: v183.AccountId32, v: (number | undefined)][]>
    getPairs(block: Block, key: v183.AccountId32): Promise<[k: v183.AccountId32, v: (number | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v183.AccountId32, v: (number | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v183.AccountId32): AsyncIterable<[k: v183.AccountId32, v: (number | undefined)][]>
}

export const totalLiquidity =  {
    /**
     *  Total liquidity in a pool.
     */
    v183: new StorageType('XYK.TotalLiquidity', 'Default', [v183.AccountId32], sts.bigint()) as TotalLiquidityV183,
}

/**
 *  Total liquidity in a pool.
 */
export interface TotalLiquidityV183  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): bigint
    get(block: Block, key: v183.AccountId32): Promise<(bigint | undefined)>
    getMany(block: Block, keys: v183.AccountId32[]): Promise<(bigint | undefined)[]>
    getKeys(block: Block): Promise<v183.AccountId32[]>
    getKeys(block: Block, key: v183.AccountId32): Promise<v183.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v183.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block, key: v183.AccountId32): AsyncIterable<v183.AccountId32[]>
    getPairs(block: Block): Promise<[k: v183.AccountId32, v: (bigint | undefined)][]>
    getPairs(block: Block, key: v183.AccountId32): Promise<[k: v183.AccountId32, v: (bigint | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v183.AccountId32, v: (bigint | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v183.AccountId32): AsyncIterable<[k: v183.AccountId32, v: (bigint | undefined)][]>
}

export const poolAssets =  {
    /**
     *  Asset pair in a pool.
     */
    v183: new StorageType('XYK.PoolAssets', 'Optional', [v183.AccountId32], sts.tuple(() => [sts.number(), sts.number()])) as PoolAssetsV183,
}

/**
 *  Asset pair in a pool.
 */
export interface PoolAssetsV183  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: v183.AccountId32): Promise<([number, number] | undefined)>
    getMany(block: Block, keys: v183.AccountId32[]): Promise<([number, number] | undefined)[]>
    getKeys(block: Block): Promise<v183.AccountId32[]>
    getKeys(block: Block, key: v183.AccountId32): Promise<v183.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v183.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block, key: v183.AccountId32): AsyncIterable<v183.AccountId32[]>
    getPairs(block: Block): Promise<[k: v183.AccountId32, v: ([number, number] | undefined)][]>
    getPairs(block: Block, key: v183.AccountId32): Promise<[k: v183.AccountId32, v: ([number, number] | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v183.AccountId32, v: ([number, number] | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v183.AccountId32): AsyncIterable<[k: v183.AccountId32, v: ([number, number] | undefined)][]>
}
