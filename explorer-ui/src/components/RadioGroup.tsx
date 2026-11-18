import { useLayoutEffect, useRef } from 'react'
import type React from 'react'

// A role="radiogroup" with the keyboard model of native radios: the group is one tab
// stop (the checked radio, else the first enabled one), and the arrow keys, Home and
// End move to a sibling radio and select it. The radios stay plain buttons with
// role="radio" and aria-checked; their tabIndex is managed here after every render,
// so a group whose options come and go keeps exactly one tab stop.

type Props = Omit<React.HTMLAttributes<HTMLDivElement>, 'role'>

const NEXT: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

function radiosIn(group: HTMLElement): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>('[role="radio"]')].filter(r => !r.hasAttribute('disabled') && r.getAttribute('aria-disabled') !== 'true')
}

export function RadioGroup({ onKeyDown, children, ...rest }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const g = ref.current
    if (!g) return
    const all = [...g.querySelectorAll<HTMLElement>('[role="radio"]')]
    const enabled = radiosIn(g)
    const stop = enabled.find(r => r.getAttribute('aria-checked') === 'true') ?? enabled[0]
    for (const r of all) r.tabIndex = r === stop ? 0 : -1
  })
  const keys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented || !ref.current) return
    const radios = radiosIn(ref.current)
    const at = radios.indexOf(document.activeElement as HTMLElement)
    if (at < 0 || !radios.length) return
    let to: number
    if (e.key in NEXT) to = (at + NEXT[e.key] + radios.length) % radios.length
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = radios.length - 1
    else return
    e.preventDefault()
    radios[to].focus()
    if (radios[to].getAttribute('aria-checked') !== 'true') radios[to].click()
  }
  return <div {...rest} role="radiogroup" ref={ref} onKeyDown={keys}>{children}</div>
}
