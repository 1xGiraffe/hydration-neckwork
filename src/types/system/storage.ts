import {sts, Block, Bytes, Option, Result, StorageType, RuntimeCtx} from '../support'
import * as v100 from '../v100'
import * as v205 from '../v205'

export const account =  {
    /**
     *  The full account information for a particular account ID.
     */
    v100: new StorageType('System.Account', 'Default', [v100.AccountId32], v100.AccountInfo) as AccountV100,
    /**
     *  The full account information for a particular account ID.
     */
    v205: new StorageType('System.Account', 'Default', [v205.AccountId32], v205.AccountInfo) as AccountV205,
}

/**
 *  The full account information for a particular account ID.
 */
export interface AccountV100  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v100.AccountInfo
    get(block: Block, key: v100.AccountId32): Promise<(v100.AccountInfo | undefined)>
    getMany(block: Block, keys: v100.AccountId32[]): Promise<(v100.AccountInfo | undefined)[]>
    getKeys(block: Block): Promise<v100.AccountId32[]>
    getKeys(block: Block, key: v100.AccountId32): Promise<v100.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v100.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block, key: v100.AccountId32): AsyncIterable<v100.AccountId32[]>
    getPairs(block: Block): Promise<[k: v100.AccountId32, v: (v100.AccountInfo | undefined)][]>
    getPairs(block: Block, key: v100.AccountId32): Promise<[k: v100.AccountId32, v: (v100.AccountInfo | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v100.AccountId32, v: (v100.AccountInfo | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v100.AccountId32): AsyncIterable<[k: v100.AccountId32, v: (v100.AccountInfo | undefined)][]>
}

/**
 *  The full account information for a particular account ID.
 */
export interface AccountV205  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v205.AccountInfo
    get(block: Block, key: v205.AccountId32): Promise<(v205.AccountInfo | undefined)>
    getMany(block: Block, keys: v205.AccountId32[]): Promise<(v205.AccountInfo | undefined)[]>
    getKeys(block: Block): Promise<v205.AccountId32[]>
    getKeys(block: Block, key: v205.AccountId32): Promise<v205.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<v205.AccountId32[]>
    getKeysPaged(pageSize: number, block: Block, key: v205.AccountId32): AsyncIterable<v205.AccountId32[]>
    getPairs(block: Block): Promise<[k: v205.AccountId32, v: (v205.AccountInfo | undefined)][]>
    getPairs(block: Block, key: v205.AccountId32): Promise<[k: v205.AccountId32, v: (v205.AccountInfo | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: v205.AccountId32, v: (v205.AccountInfo | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key: v205.AccountId32): AsyncIterable<[k: v205.AccountId32, v: (v205.AccountInfo | undefined)][]>
}
