import {sts, Result, Option, Bytes, BitSequence} from './support'

export type H160 = Bytes

export type H256 = Bytes

export const H256 = sts.bytes()

export const H160 = sts.bytes()
