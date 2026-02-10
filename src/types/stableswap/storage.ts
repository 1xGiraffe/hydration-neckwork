import {sts, Block, Bytes, Option, Result, StorageType, RuntimeCtx} from '../support'
import * as v183 from '../v183'

export const pools =  {
    /**
     *  Existing pools
     */
    v183: new StorageType('Stableswap.Pools', 'Optional', [sts.number()], v183.PoolInfo) as PoolsV183,
}

/**
 *  Existing pools
 */
export interface PoolsV183  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v183.PoolInfo | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v183.PoolInfo | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v183.PoolInfo | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v183.PoolInfo | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v183.PoolInfo | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v183.PoolInfo | undefined)][]>
}

export const assetTradability =  {
    /**
     *  Tradability state of pool assets.
     */
    v183: new StorageType('Stableswap.AssetTradability', 'Default', [sts.number(), sts.number()], v183.Type_101) as AssetTradabilityV183,
}

/**
 *  Tradability state of pool assets.
 */
export interface AssetTradabilityV183  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v183.Type_101
    get(block: Block, key1: number, key2: number): Promise<(v183.Type_101 | undefined)>
    getMany(block: Block, keys: [number, number][]): Promise<(v183.Type_101 | undefined)[]>
    getKeys(block: Block): Promise<[number, number][]>
    getKeys(block: Block, key1: number): Promise<[number, number][]>
    getKeys(block: Block, key1: number, key2: number): Promise<[number, number][]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<[number, number][]>
    getKeysPaged(pageSize: number, block: Block, key1: number): AsyncIterable<[number, number][]>
    getKeysPaged(pageSize: number, block: Block, key1: number, key2: number): AsyncIterable<[number, number][]>
    getPairs(block: Block): Promise<[k: [number, number], v: (v183.Type_101 | undefined)][]>
    getPairs(block: Block, key1: number): Promise<[k: [number, number], v: (v183.Type_101 | undefined)][]>
    getPairs(block: Block, key1: number, key2: number): Promise<[k: [number, number], v: (v183.Type_101 | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: [number, number], v: (v183.Type_101 | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: number): AsyncIterable<[k: [number, number], v: (v183.Type_101 | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: number, key2: number): AsyncIterable<[k: [number, number], v: (v183.Type_101 | undefined)][]>
}
