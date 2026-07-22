import type { AssetListItem } from '../types'
import { ACTIVITY_ACTIONS } from './ui'
import { tokenFilterOptions, type FilterField } from './Filters'

const DATE_FIELDS: FilterField[] = [
  { kind: 'date', key: 'from', title: 'From date' },
  { kind: 'date', key: 'to', title: 'To date' },
]

export function activityFilterFields(type: string, assets: AssetListItem[], includeToken = true): FilterField[] {
  const actions = ACTIVITY_ACTIONS[type]
  return [
    ...(actions ? [{
      kind: 'select' as const,
      key: 'action',
      options: [{ value: '', label: 'All actions' }, ...actions.map(action => ({ value: action.v, label: action.label }))],
    }] : []),
    ...(includeToken ? [{ kind: 'combo' as const, key: 'token', placeholder: 'All tokens', width: 150, options: tokenFilterOptions(assets) }] : []),
    ...DATE_FIELDS,
    { kind: 'number', key: 'min', placeholder: '$ from' },
  ]
}

export function extrinsicFilterFields(includeOrigin = false): FilterField[] {
  return [
    { kind: 'text', key: 'call', placeholder: 'Call name', width: 210 },
    ...(includeOrigin ? [{
      kind: 'select' as const,
      key: 'origin',
      options: [
        { value: '', label: 'All origins' },
        { value: 'signed', label: 'Signed' },
        { value: 'proxy', label: 'Via proxy' },
        { value: 'multisig', label: 'Multisig' },
      ],
    }] : []),
    {
      kind: 'select',
      key: 'result',
      options: [
        { value: '', label: 'All results' },
        { value: 'success', label: 'Success' },
        { value: 'failed', label: 'Failed' },
      ],
    },
    ...DATE_FIELDS,
  ]
}

export const eventFilterFields: FilterField[] = [
  { kind: 'text', key: 'event', placeholder: 'Event name', width: 230 },
  ...DATE_FIELDS,
]
