import { useState, type KeyboardEvent } from 'react'

// Expand/collapse state for a clickable table row: the whole row toggles, and
// Enter/Space work when the row itself has focus (nested links/buttons keep
// their own behavior via stopPropagation at the call sites).
export function useExpandableRow() {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen(value => !value)
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggle()
  }
  return { open, toggle, onKeyDown }
}
