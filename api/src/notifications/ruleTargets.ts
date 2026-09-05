import { mmMarketByKey } from '../services/explorerService.ts'
import { getTag as getSystemTag } from '../services/tagService.ts'
import { canView, getList, tagDisplayIcon } from '../services/userListService.ts'
import type { AccountActivityTarget, NotificationKind, RuleParams } from './notificationRules.ts'

// Where an account-activity rule's TAG targets are resolved: the system tag
// directory (tagService) and the rule owner's own lists (userListService), both
// already resident in memory, so a resolution costs a Map lookup rather than a
// query. Kept out of notificationRules.ts, which stays dependency-free so the
// UI can mirror it verbatim.
//
// A tag target is resolved on every use — describing the rule, rendering it for
// the rules list, and fetching its feed each tick — never frozen into the rule.
// That is what makes the membership LIVE: an account added to the tag is
// watched from the next tick, and a list the owner has lost access to stops
// contributing rows without the rule having to be rewritten or deleted.

export interface ResolvedTarget {
  /** The tag's own display name. */
  name: string
  /** Accounts currently in the tag — the member set the feed is scoped to. */
  members: string[]
  memberCount: number
  icon: string
  color: string
  /** Set for a list tag: the list the tag lives on. */
  listName?: string
}

/**
 * A tag target's current presentation and member set for one viewer, or null
 * when the target no longer resolves — an unknown system tag, a deleted list or
 * tag, or a list this viewer may no longer read. Null is always silent: a rule
 * pointing at something the owner cannot see contributes nothing rather than
 * erroring, so losing access to a shared list quietly stops the alert.
 */
export function resolveActivityTarget(viewer: string, target: AccountActivityTarget): ResolvedTarget | null {
  if (target.kind === 'address') return null
  if (target.kind === 'tag') {
    const tag = getSystemTag(target.tagId)
    if (!tag) return null
    return { name: tag.name, members: [...tag.members], memberCount: tag.members.length, icon: tag.icon, color: tag.color }
  }
  // The same read gate the list's own pages use (owner, active subscriber, or a
  // public list) — a rule may never widen what its owner can see.
  if (!canView(viewer, target.listId)) return null
  const list = getList(target.listId)
  const tag = list?.tags.get(target.tagId)
  if (!list || !tag) return null
  return {
    name: tag.name, members: [...tag.order], memberCount: tag.members.size,
    icon: tagDisplayIcon(tag.icon, tag.order), color: tag.color, listName: list.name,
  }
}

/** The rule's activity target, for the kinds that have one. */
export function activityTargetOf(kind: NotificationKind, params: unknown): AccountActivityTarget | null {
  if (kind !== 'account-activity' && kind !== 'health-factor') return null
  const target = (params as RuleParams['account-activity'] | undefined)?.target
  return target && typeof target === 'object' ? target : null
}

/** The money market a rule names, for the kinds that name one. */
export function ruleMarketOf(kind: NotificationKind, params: unknown): string | null {
  if (kind !== 'health-factor' && kind !== 'mm-cap') return null
  const market = (params as RuleParams['mm-cap'] | undefined)?.market
  return typeof market === 'string' ? market : null
}

/**
 * Creation-time validation, in the store's own vocabulary: a 422 message, or
 * null when the params name nothing that has to exist. Deliberately does NOT
 * name the id it could not resolve — rule params are private user data.
 *
 * A market key is checked against the deployment's configured markets the same
 * way a tag id is checked against the directory: the registry only knows the
 * shape, and a rule on a market nobody configured could never match.
 */
export function ruleTargetError(viewer: string, kind: NotificationKind, params: unknown): string | null {
  const market = ruleMarketOf(kind, params)
  if (market != null && !mmMarketByKey(market)) return 'That money market does not exist'
  const target = activityTargetOf(kind, params)
  if (!target || target.kind === 'address') return null
  if (target.kind === 'tag') {
    return getSystemTag(target.tagId) ? null : 'That tag does not exist'
  }
  if (!canView(viewer, target.listId)) return 'That list is not one you can see'
  return getList(target.listId)?.tags.has(target.tagId) ? null : 'That list has no such tag'
}
