// SVG path for the Hydration logo, matching the one used in the Topbar.
const HYDRATION_PATH = 'M18.0532 11.3604C18.2827 11.1319 18.5778 10.8381 18.8718 10.5463C19.5265 9.89543 19.5265 8.83853 18.8718 8.18664L18.1782 7.49598C15.6959 9.96786 11.982 10.4637 9.00484 8.98646C11.017 9.35678 13.1028 9.06807 14.951 8.0785C16.1876 7.41641 16.4222 5.74741 15.4295 4.75886L11.3366 0.683262C10.4217 -0.227754 8.93928 -0.227754 8.02542 0.683262L3.61392 5.07613C6.51941 3.84682 10.0089 4.4171 12.3714 6.78594C8.76716 5.04349 4.30136 5.66171 1.3088 8.64164C1.07931 8.87016 0.78323 9.16499 0.490223 9.45676C-0.163408 10.1086 -0.163408 11.1645 0.490223 11.8154L1.18279 12.505C3.66515 10.0332 7.37896 9.53735 10.3562 11.0146C8.34404 10.6442 6.25816 10.933 4.40996 11.9225C3.17339 12.5846 2.93878 14.2536 3.93152 15.2422L8.0244 19.3178C8.93928 20.2288 10.4217 20.2288 11.3356 19.3178L15.7471 14.9249C12.8416 16.1542 9.35215 15.5839 6.98965 13.2151C10.5938 14.9575 15.0596 14.3393 18.0522 11.3594L18.0532 11.3604Z'

function logoDataUrl(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="${color}"><path d="${HYDRATION_PATH}"/></svg>`
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
