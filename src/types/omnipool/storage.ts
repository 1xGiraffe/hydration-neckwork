import {sts, Block, Bytes, Option, Result, StorageType, RuntimeCtx} from '../support'
import * as v115 from '../v115'

export const assets =  {
    /**
     *  State of an asset in the omnipool
     */
    v115: new StorageType('Omnipool.Assets', 'Optional', [sts.number()], v115.AssetState) as AssetsV115,
}

/**
 *  State of an asset in the omnipool
 */
export interface AssetsV115  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v115.AssetState | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v115.AssetState | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v115.AssetState | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v115.AssetState | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v115.AssetState | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v115.AssetState | undefined)][]>
}

export const hubAssetImbalance =  {
    /**
     *  Imbalance of hub asset
     */
    v115: new StorageType('Omnipool.HubAssetImbalance', 'Default', [], v115.SimpleImbalance) as HubAssetImbalanceV115,
}

/**
 *  Imbalance of hub asset
 */
export interface HubAssetImbalanceV115  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v115.SimpleImbalance
    get(block: Block): Promise<(v115.SimpleImbalance | undefined)>
}
