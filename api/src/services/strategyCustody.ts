import { JUICER_VAULTS } from './juicer.ts'
import { juicerBeneficialFor } from './juicerState.ts'
import { BIL_VAULT } from './bil.ts'
import { bilBeneficialFor } from './bilState.ts'

// Every strategy share token whose vault holds shares in custody (escrowed requests,
// exits, a yield fund), and where its refresher states the BENEFICIAL balances — the
// custody attributed to whom it belongs — that the erc20-wallets refresher publishes
// instead of the raw wallet balances. `auditBalanceOf` false: the share's balanceOf
// includes earnings no Transfer moves (jETH's funded earnings), so the hourly balanceOf
// audit is the strategy refresher's own reconciliation instead.

interface StrategyShareCustody {
  contracts: readonly string[]
  beneficialFor: (contract: string) => { block: number; balances: Map<string, bigint> } | null
  auditBalanceOf: boolean
}
const STRATEGY_SHARE_CUSTODY: readonly StrategyShareCustody[] = [
  { contracts: JUICER_VAULTS.map(v => v.vault), beneficialFor: juicerBeneficialFor, auditBalanceOf: false },
  { contracts: [BIL_VAULT], beneficialFor: bilBeneficialFor, auditBalanceOf: true },
]
const custodyOf = (contract: string) => STRATEGY_SHARE_CUSTODY.find(s => s.contracts.includes(contract.toLowerCase())) ?? null

export const isStrategyShareContract = (contract: string): boolean => custodyOf(contract) != null
export function strategyBeneficialFor(contract: string): { block: number; balances: Map<string, bigint> } | null {
  return custodyOf(contract)?.beneficialFor(contract.toLowerCase()) ?? null
}
/** Whether the hourly balanceOf audit applies to this contract (every contract that is not a strategy share opting out). */
export const auditsBalanceOf = (contract: string): boolean => custodyOf(contract)?.auditBalanceOf ?? true
