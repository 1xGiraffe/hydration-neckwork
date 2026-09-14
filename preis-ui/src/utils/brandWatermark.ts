import { HYDRATION_LOGO_PATH } from '../components/icons'

function logoDataUrl(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="${color}"><path d="${HYDRATION_LOGO_PATH}"/></svg>`
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

interface WatermarkOpts {
  pairLine?: string
  subLine?: string
}

// Brand mark and pair info burned into screenshots. Matches the topbar's
// look-and-feel exactly: the Hydration logo in the accent coral, "Hydration"
// in Gazpacho 500 at the topbar's 18 px size, and italic "preis" in coral —
// same fonts, sizes, gaps, and colors. Scaled up by `dpr` to stay crisp.
export async function drawBrandWatermark(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  isLight: boolean,
  opts: WatermarkOpts = {},
): Promise<void> {
  const ACCENT = 'rgb(229, 62, 118)'
  const INK = isLight ? 'rgb(35, 34, 38)' : 'rgb(245, 241, 248)'
  const DIM = isLight ? 'rgba(36, 14, 50, 0.45)' : 'rgba(245, 241, 248, 0.55)'

  // Topbar uses logo 20 px, wordmark 18 px, gap 8 px. Mirror that here.
  const LOGO_PX = Math.round(20 * dpr)
  const WORDMARK_PX = Math.round(18 * dpr)
  const ELEM_GAP = Math.round(8 * dpr)
  const padX = 24 * dpr
  const padY = 22 * dpr

  const logo = await loadImage(logoDataUrl(ACCENT))

  ctx.save()
  ctx.textBaseline = 'alphabetic'

  // Row 1: Hydration logo + "Hydration preis" wordmark.
  // Topbar aligns the logo's vertical center with the wordmark's cap-line midpoint.
  // For Gazpacho at this size, cap-height ≈ 0.72 * font-size.
  const capHeight = WORDMARK_PX * 0.72
  // Place the wordmark first so we can derive the baseline.
  const wordmarkBaseline = padY + WORDMARK_PX  // approximate top-line padding then descend by full em
  const capTopY = wordmarkBaseline - capHeight
  const logoY = capTopY + capHeight / 2 - LOGO_PX / 2

  if (logo) ctx.drawImage(logo, padX, logoY, LOGO_PX, LOGO_PX)

  const wordmarkX = padX + LOGO_PX + ELEM_GAP
  ctx.font = `500 ${WORDMARK_PX}px Gazpacho, Georgia, serif`
  ctx.fillStyle = INK
  ctx.fillText('Hydration', wordmarkX, wordmarkBaseline)
  const hydW = ctx.measureText('Hydration').width

  ctx.font = `italic 400 ${WORDMARK_PX}px Gazpacho, Georgia, serif`
  ctx.fillStyle = ACCENT
  ctx.fillText('preis', wordmarkX + hydW + ELEM_GAP, wordmarkBaseline)

  // Row 2: pair · interval (mono, slightly dimmed so the brand still leads).
  if (opts.pairLine) {
    const pairFontPx = Math.round(15 * dpr)
    ctx.font = `500 ${pairFontPx}px GeistMono, monospace`
    ctx.fillStyle = isLight ? 'rgba(36, 14, 50, 0.65)' : 'rgba(245, 241, 248, 0.65)'
    const pairBaseline = wordmarkBaseline + Math.round(20 * dpr) + pairFontPx
    ctx.fillText(opts.pairLine, padX, pairBaseline)

    if (opts.subLine) {
      const subSize = Math.round(12 * dpr)
      ctx.font = `400 ${subSize}px Geist, system-ui, sans-serif`
      ctx.fillStyle = DIM
      const subBaseline = pairBaseline + Math.round(6 * dpr) + subSize
      ctx.fillText(opts.subLine, padX, subBaseline)
    }
  }
  ctx.restore()
}
