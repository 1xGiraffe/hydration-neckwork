// Squarified treemap layout (Bruls, Huizing & van Wijk, 2000). Given a list of
// positive values and a container box in pixels, it tiles the box so each tile's
// area is proportional to its value while keeping tile aspect ratios close to 1
// (rows are laid along the shorter free side, greedily, closing a row as soon as
// adding another tile would make its worst aspect ratio worse).
//
// Pure and framework-free so it can be unit-tested directly. The caller passes
// values already sorted descending by magnitude (the algorithm's quality depends
// on that order); the returned rects are aligned index-for-index with the input.

export interface Rect { x: number; y: number; w: number; h: number }

interface Free { x: number; y: number; w: number; h: number }

// Worst (largest) aspect ratio produced by laying `areas` in a strip whose fixed
// dimension is `side`. Standard squarify metric over the row's min/max area.
function worst(areas: number[], side: number): number {
  let sum = 0, min = Infinity, max = 0
  for (const a of areas) { sum += a; if (a < min) min = a; if (a > max) max = a }
  const side2 = side * side
  const sum2 = sum * sum
  return Math.max((side2 * max) / sum2, sum2 / (side2 * min))
}

// Place one closed row of tiles against the shorter free edge, then shrink the
// free rectangle by the thickness the row consumed.
function layoutRow(areas: number[], idx: number[], free: Free, out: Rect[]): void {
  let sum = 0
  for (const a of areas) sum += a
  if (free.w >= free.h) {
    // Column on the left spanning the full free height.
    const colW = sum / free.h
    let cy = free.y
    for (let k = 0; k < areas.length; k++) {
      const tileH = areas[k] / colW
      out[idx[k]] = { x: free.x, y: cy, w: colW, h: tileH }
      cy += tileH
    }
    free.x += colW
    free.w -= colW
  } else {
    // Row across the top spanning the full free width.
    const rowH = sum / free.w
    let cx = free.x
    for (let k = 0; k < areas.length; k++) {
      const tileW = areas[k] / rowH
      out[idx[k]] = { x: cx, y: free.y, w: tileW, h: rowH }
      cx += tileW
    }
    free.y += rowH
    free.h -= rowH
  }
}

export function squarify(values: number[], width: number, height: number): Rect[] {
  const n = values.length
  if (n === 0 || width <= 0 || height <= 0) return []
  let total = 0
  for (const v of values) total += Math.max(0, v)
  if (!(total > 0)) return []
  const scale = (width * height) / total
  const areas = values.map(v => Math.max(0, v) * scale)

  const out: Rect[] = new Array(n)
  const free: Free = { x: 0, y: 0, w: width, h: height }
  let rowA: number[] = []
  let rowI: number[] = []
  let i = 0
  while (i < n) {
    const side = Math.min(free.w, free.h)
    // Keep extending the current row while doing so does not worsen its worst
    // aspect ratio; otherwise close the row and start a fresh one for this tile.
    if (rowA.length === 0 || worst(rowA, side) >= worst([...rowA, areas[i]], side)) {
      rowA.push(areas[i]); rowI.push(i); i++
    } else {
      layoutRow(rowA, rowI, free, out)
      rowA = []; rowI = []
    }
  }
  if (rowA.length) layoutRow(rowA, rowI, free, out)
  return out
}
