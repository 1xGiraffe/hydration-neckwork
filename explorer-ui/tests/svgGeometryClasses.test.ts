import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// CSS width/height/display on an SVG geometry element WIN over its geometry
// attributes in Chromium. So a class worn by a <rect>/<circle>/<line> and a
// class worn by a layout <div> must never share a name — the div's rule silently
// resizes the shape.
//
// This is not hypothetical: /liquidity's composition bar was `.liq-bar`
// (`width: 100%; height: 10px`), the same class the GIGAHDX liquidation
// histogram puts on every <rect>. All 14 of its bars became 860 x 10px — one
// flat line where a distribution had been, on a page nothing in that change
// touched.

const SRC = new URL('../src/', import.meta.url)
const GEOMETRY = ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']
// Properties that override SVG geometry (or hide the shape outright).
const GEOMETRY_PROPS = /(^|[;{\s])(width|height|display|padding|margin)\s*:/

function sources(dir: URL): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const at = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
    if (entry.isDirectory()) return sources(at)
    return entry.name.endsWith('.tsx') ? [readFileSync(at, 'utf8')] : []
  })
}

// Every class name that appears on an SVG geometry element in the components.
function svgGeometryClasses(): Map<string, string> {
  const owners = new Map<string, string>()
  const tag = new RegExp(`<(${GEOMETRY.join('|')})\\b[^>]*className=(?:"([^"]*)"|\\{\`([^\`]*)\`\\})`, 'g')
  for (const src of sources(SRC)) {
    for (const m of src.matchAll(tag)) {
      const classes = (m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ')
      for (const cls of classes.split(/\s+/).filter(Boolean)) owners.set(cls, m[1])
    }
  }
  return owners
}

// Every class the stylesheet gives a geometry-affecting property to, EXCEPT
// where the rule is itself scoped to that shape (`rect.foo`, `svg .foo`) — a
// rule written for the shape is not the collision this guards against.
function layoutSizedClasses(): Map<string, string> {
  // Comments first: they sit between rules, so a `/* … */` above a selector
  // otherwise lands inside it and shows up in the failure message.
  const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const sized = new Map<string, string>()
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [selector, body] = [m[1].trim(), m[2]]
    if (!GEOMETRY_PROPS.test(body)) continue
    for (const part of selector.split(',')) {
      const last = part.trim().split(/\s+/).pop() ?? ''
      // `rect.comp-bar` / `.giga-liq-chart .bar` are deliberate; a bare
      // `.comp-bar` in a stylesheet full of divs is the accident.
      if (GEOMETRY.some(g => last.startsWith(g + '.')) || /^(svg|g)\b/.test(part.trim())) continue
      const cls = /^\.([a-z][a-z0-9-]*)$/.exec(last)?.[1]
      if (cls) sized.set(cls, part.trim())
    }
  }
  return sized
}

describe('SVG geometry classes', () => {
  it('are never also sized as layout boxes in global.css', () => {
    const svg = svgGeometryClasses()
    const sized = layoutSizedClasses()
    // The guard is worthless if the scan found no shapes at all.
    expect(svg.size).toBeGreaterThan(5)

    const clashes = [...svg].filter(([cls]) => sized.has(cls))
      .map(([cls, el]) => `.${cls} is on <${el}> but sized by \`${sized.get(cls)}\``)
    expect(clashes).toEqual([])
  })
})
