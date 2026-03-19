import {sts, Block, Bytes, StorageType, RuntimeCtx} from '../support'
import * as v193 from '../v193'

export const accountStorages =  {
    v193: new StorageType('EVM.AccountStorages', 'Default', [v193.H160, v193.H256], v193.H256) as AccountStoragesV193,
}

export interface AccountStoragesV193  {
    is(block: RuntimeCtx): boolean
    getDefault(block: Block): v193.H256
    get(block: Block, key1: v193.H160, key2: v193.H256): Promise<(v193.H256 | undefined)>
    getMany(block: Block, keys: [v193.H160, v193.H256][]): Promise<(v193.H256 | undefined)[]>
    getKeys(block: Block): Promise<[v193.H160, v193.H256][]>
    getKeys(block: Block, key1: v193.H160): Promise<[v193.H160, v193.H256][]>
    getKeys(block: Block, key1: v193.H160, key2: v193.H256): Promise<[v193.H160, v193.H256][]>
    getKeysPaged(pageSize: number, block: Block): AsyncIterable<[v193.H160, v193.H256][]>
    getKeysPaged(pageSize: number, block: Block, key1: v193.H160): AsyncIterable<[v193.H160, v193.H256][]>
    getKeysPaged(pageSize: number, block: Block, key1: v193.H160, key2: v193.H256): AsyncIterable<[v193.H160, v193.H256][]>
    getPairs(block: Block): Promise<[k: [v193.H160, v193.H256], v: (v193.H256 | undefined)][]>
    getPairs(block: Block, key1: v193.H160): Promise<[k: [v193.H160, v193.H256], v: (v193.H256 | undefined)][]>
    getPairs(block: Block, key1: v193.H160, key2: v193.H256): Promise<[k: [v193.H160, v193.H256], v: (v193.H256 | undefined)][]>
    getPairsPaged(pageSize: number, block: Block): AsyncIterable<[k: [v193.H160, v193.H256], v: (v193.H256 | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: v193.H160): AsyncIterable<[k: [v193.H160, v193.H256], v: (v193.H256 | undefined)][]>
    getPairsPaged(pageSize: number, block: Block, key1: v193.H160, key2: v193.H256): AsyncIterable<[k: [v193.H160, v193.H256], v: (v193.H256 | undefined)][]>
}
