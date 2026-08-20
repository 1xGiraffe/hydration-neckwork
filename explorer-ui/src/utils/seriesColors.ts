// Keeping asset colours tellable apart.
//
// Asset colours are sampled from each asset's own icon, which is what makes a
// chip, a legend and a band agree on what an asset looks like. It only breaks
// down when a surface holds two assets from the same family: pool 690 stacks
// vDOT (#e6007a) against aDOT (#e43583), both Polkadot pink, and the 100% area
// chart read as a single blob with a line through it. Measured with the
// palette validator: ΔE 3.3 for NORMAL vision, against a floor of 15 — not a
// colour-vision-deficiency edge case, simply two colours nobody can separate.
//
// The contract is IDENTITY BY DEFAULT: an asset's chart colour is its
// icon-sampled colour, byte-identical, unless it truly collides with another —
// two near-duplicates like vDOT/aDOT or the two WETH listings, not merely
// "both purple-ish". On a collision the colour keeps its hue and chroma
// exactly and shifts only LIGHTNESS, by small steps — darker/lighter SHADES of
// the same colour, which is how family members read as related yet distinct.
// There is no hue rotation anywhere: when the shade steps exhaust the walk
// settles for the shade farthest from everything taken rather than leaving
// the colour's family. The walk is deterministic: the same input always
// resolves to the same colours. Collisions are resolved once, app-wide, by
// resolveAssetChartColors (used by utils/iconColor's central resolver), so
// the same asset wears the same colour on every chart.

// OKLab ΔE ×100 below which two colours are the-same-colour to a reader.
// Tight on purpose: DOT/vDOT/aDOT pinks measure 3–5 apart and the WETH/GETH
// greys 3–6, while genuinely different colours sit well above 10.
const FLOOR = 8
// Shade steps, nearest first: hue and chroma stay exact, only L moves. The
// widest steps exist for three/four-way pile-ups (DOT/vDOT/aDOT plus HDX).
const L_STEPS = [0.08, -0.08, 0.16, -0.16, 0.24, -0.24]

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]
}
function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

export function hexToOklab(hex: string): [number, number, number] | null {
  const rgb = parseHex(hex)
  if (!rgb) return null
  const [r, g, b] = rgb.map(srgbToLinear) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}
function oklabToHex([L, a, b]: [number, number, number]): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  return toHex(
    linearToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  )
}

// Perceptual distance on the same scale the palette validator reports.
export function colorDistance(a: string, b: string): number {
  const [la, lb] = [hexToOklab(a), hexToOklab(b)]
  if (!la || !lb) return Infinity      // unparseable (a CSS var): never treated as a collision
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]) * 100
}

// A shade of the same colour: same hue and chroma, shifted lightness. Clamped
// inside the visible band so a shade never collapses into black/white; when
// the clamp eats most of the step the candidate is no real shade — null.
function shiftLightness(hex: string, dl: number): string | null {
  const lab = hexToOklab(hex)
  if (!lab) return null
  const L = Math.min(0.93, Math.max(0.25, lab[0] + dl))
  if (Math.abs(L - lab[0]) < Math.abs(dl) * 0.6) return null
  return oklabToHex([L, lab[1], lab[2]])
}

// One colour against the taken ones: itself unless it truly collides, else the
// nearest shade that clears, else — never a different hue — the shade farthest
// from everything taken.
function separateOne(color: string, taken: readonly string[], floor: number): string {
  const clash = (candidate: string) => taken.some(t => colorDistance(t, candidate) < floor)
  if (!hexToOklab(color) || !clash(color)) return color
  const shades = L_STEPS.map(dl => shiftLightness(color, dl)).filter((c): c is string => c != null)
  const clear = shades.find(candidate => !clash(candidate))
  if (clear) return clear
  let best = color
  let bestDist = -1
  for (const candidate of shades) {
    const d = Math.min(...taken.map(t => colorDistance(t, candidate)))
    if (d > bestDist) { best = candidate; bestDist = d }
  }
  return best
}

// Colours for one list of series, in order, each far enough from the ones
// before it. Anything unparseable (a CSS variable like the "Other" band) passes
// through untouched.
export function separateSeriesColors(colors: readonly string[], floor = FLOOR): string[] {
  const out: string[] = []
  for (const color of colors) out.push(separateOne(color, out, floor))
  return out
}

// THE app-wide assignment of chart colours to assets: every asset that gets
// charted anywhere resolves here, in one canonical order, so the same asset
// wears the same colour on every surface (Omnipool bar vs its history, a pool
// row vs the pool page, a treemap tile vs a legend). Canonical order is
// assetId ascending — the established listing keeps its exact icon colour and
// a newer near-duplicate takes the shade — which also makes the result
// independent of which page happened to ask first. `key` is the caller's
// colour identity; duplicate keys resolve once (lowest assetId wins).
export function resolveAssetChartColors(
  entries: readonly { key: string; assetId: number; base: string }[],
  floor = FLOOR,
): Map<string, string> {
  const byKey = new Map<string, { key: string; assetId: number; base: string }>()
  for (const e of entries) {
    const prev = byKey.get(e.key)
    if (!prev || e.assetId < prev.assetId) byKey.set(e.key, e)
  }
  const ordered = [...byKey.values()].sort((a, b) =>
    a.assetId - b.assetId || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const out = new Map<string, string>()
  const taken: string[] = []
  for (const e of ordered) {
    const color = separateOne(e.base, taken, floor)
    out.set(e.key, color)
    taken.push(color)
  }
  return out
}
