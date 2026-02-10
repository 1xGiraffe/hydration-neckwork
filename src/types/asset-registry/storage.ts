import {sts, Block, Bytes, Option, Result, StorageType, RuntimeCtx} from '../support'
import * as v108 from '../v108'
import * as v160 from '../v160'
import * as v176 from '../v176'
import * as v222 from '../v222'
import * as v244 from '../v244'
import * as v264 from '../v264'

export const assets =  {
    /**
     *  Details of an asset.
     */
    v108: new StorageType('AssetRegistry.Assets', 'Optional', [sts.number()], v108.AssetDetails) as AssetsV108,
    /**
     *  Details of an asset.
     */
    v160: new StorageType('AssetRegistry.Assets', 'Optional', [sts.number()], v160.AssetDetails) as AssetsV160,
    /**
     *  Details of an asset.
     */
    v176: new StorageType('AssetRegistry.Assets', 'Optional', [sts.number()], v176.AssetDetails) as AssetsV176,
    /**
     *  Details of an asset.
     */
    v222: new StorageType('AssetRegistry.Assets', 'Optional', [sts.number()], v222.AssetDetails) as AssetsV222,
    /**
     *  Details of an asset.
     */
    v264: new StorageType('AssetRegistry.Assets', 'Optional', [sts.number()], v264.AssetDetails) as AssetsV264,
}

/**
 *  Details of an asset.
 */
export interface AssetsV108  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v108.AssetDetails | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v108.AssetDetails | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v108.AssetDetails | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v108.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v108.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v108.AssetDetails | undefined)][]>
}

/**
 *  Details of an asset.
 */
export interface AssetsV160  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v160.AssetDetails | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v160.AssetDetails | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v160.AssetDetails | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v160.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v160.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v160.AssetDetails | undefined)][]>
}

/**
 *  Details of an asset.
 */
export interface AssetsV176  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v176.AssetDetails | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v176.AssetDetails | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v176.AssetDetails | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v176.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v176.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v176.AssetDetails | undefined)][]>
}

/**
 *  Details of an asset.
 */
export interface AssetsV222  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v222.AssetDetails | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v222.AssetDetails | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v222.AssetDetails | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v222.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v222.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v222.AssetDetails | undefined)][]>
}

/**
 *  Details of an asset.
 */
export interface AssetsV264  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v264.AssetDetails | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v264.AssetDetails | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v264.AssetDetails | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v264.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v264.AssetDetails | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v264.AssetDetails | undefined)][]>
}

export const assetLocations =  {
    /**
     *  Native location of an asset.
     */
    v108: new StorageType('AssetRegistry.AssetLocations', 'Optional', [sts.number()], v108.AssetLocation) as AssetLocationsV108,
    /**
     *  Native location of an asset.
     */
    v160: new StorageType('AssetRegistry.AssetLocations', 'Optional', [sts.number()], v160.AssetLocation) as AssetLocationsV160,
    /**
     *  Native location of an asset.
     */
    v244: new StorageType('AssetRegistry.AssetLocations', 'Optional', [sts.number()], v244.AssetLocation) as AssetLocationsV244,
}

/**
 *  Native location of an asset.
 */
export interface AssetLocationsV108  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v108.AssetLocation | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v108.AssetLocation | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v108.AssetLocation | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v108.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v108.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v108.AssetLocation | undefined)][]>
}

/**
 *  Native location of an asset.
 */
export interface AssetLocationsV160  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v160.AssetLocation | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v160.AssetLocation | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v160.AssetLocation | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v160.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v160.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v160.AssetLocation | undefined)][]>
}

/**
 *  Native location of an asset.
 */
export interface AssetLocationsV244  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v244.AssetLocation | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v244.AssetLocation | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v244.AssetLocation | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v244.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v244.AssetLocation | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v244.AssetLocation | undefined)][]>
}

export const assetMetadataMap =  {
    /**
     *  Metadata of an asset.
     */
    v108: new StorageType('AssetRegistry.AssetMetadataMap', 'Optional', [sts.number()], v108.AssetMetadata) as AssetMetadataMapV108,
}

/**
 *  Metadata of an asset.
 */
export interface AssetMetadataMapV108  {
    is(block: RuntimeCtx): boolean
    get(block: Block, key: number): Promise<(v108.AssetMetadata | undefined)>
    getMany(block: Block, keys: number[]): Promise<(v108.AssetMetadata | undefined)[]>
    getKeys(block: Block): Promise<number[]>
    getKeys(block: Block, key: number): Promise<number[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<number[]>
    getKeysPaged(pageSize: number, block: Block, key: number): AsyncIterable<number[]>
    getPairs(block: Block): Promise<[k: number, v: (v108.AssetMetadata | undefined)][]>
    getPairs(block: Block, key: number): Promise<[k: number, v: (v108.AssetMetadata | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: number, v: (v108.AssetMetadata | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: number): AsyncIterable<[k: number, v: (v108.AssetMetadata | undefined)][]>
}
