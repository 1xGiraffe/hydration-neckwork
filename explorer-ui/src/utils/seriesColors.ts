// Keeping the bands of one chart tellable apart.
//
// Asset colours are sampled from each asset's own icon, which is what makes a
// chip, a legend and a band agree on what an asset looks like. It only breaks
// down when one chart holds two assets from the same family: pool 690 stacks
// vDOT (#e6007a) against aDOT (#e43583), both Polkadot pink, and the 100% area
// chart read as a single blob with a line through it. Measured with the
// palette validator: ΔE 3.3 for NORMAL vision, against a floor of 15 — not a
// colour-vision-deficiency edge case, simply two colours nobody can separate.
//
// So a series keeps its own colour whenever it can, and only a band that
// collides with one already used in the same chart is rotated away in OKLCH
// until it clears the floor. Hue rotation preserves the lightness and chroma
// the surface was chosen against, so a nudged band stays legible on the same
// background, and the walk is deterministic: the same chart always resolves to
// the same colours.

const FLOOR = 15          // OKLab ΔE ×100 — the validator's normal-vision floor
const STEPS = [28, -28, 56, -56, 84, -84, 112, -112, 140, -140, 168, -168, 180]

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

function rotateHue(hex: string, degrees: number): string {
  const lab = hexToOklab(hex)
  if (!lab) return hex
  const [L, a, b] = lab
  const chroma = Math.hypot(a, b)
  const hue = Math.atan2(b, a) + (degrees * Math.PI) / 180
  return oklabToHex([L, Math.cos(hue) * chroma, Math.sin(hue) * chroma])
}

// Colours for one chart's series, in order, each far enough from the ones
// before it. Anything unparseable (a CSS variable like the "Other" band) passes
// through untouched.
export function separateSeriesColors(colors: readonly string[], floor = FLOOR): string[] {
  const out: string[] = []
  for (const color of colors) {
    const clash = (candidate: string) => out.some(taken => colorDistance(taken, candidate) < floor)
    if (!hexToOklab(color) || !clash(color)) { out.push(color); continue }
    const rotated = STEPS.map(d => rotateHue(color, d)).find(candidate => !clash(candidate))
    out.push(rotated ?? color)
  }
  return out
}
