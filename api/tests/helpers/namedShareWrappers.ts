import { registerNamedShareWrappers } from '../../src/services/explorerAssets.ts'

/**
 * The live share → named-wrapper pairs a registry load derives under the one
 * share/wrapper rule (2026-09-29, the price writer's `[LpAlias]` set). For tests of
 * the rule's CONSUMERS that never load a registry; the rule itself is tested
 * against a registry + reserve map (shareSupplyFold, shareDisplayFace).
 */
export const LIVE_NAMED_SHARE_WRAPPERS: [number, number][] = [
  [110, 1110], [111, 1111], [112, 1112], [113, 1113],
  [690, 69], [4200, 420], [10044, 4444], [90001, 9001],
]

export function useLiveNamedShareWrappers(): void {
  registerNamedShareWrappers(LIVE_NAMED_SHARE_WRAPPERS)
}
