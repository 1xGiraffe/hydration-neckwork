// Design tokens are authored as hex, and the canvas surfaces (the volume
// histogram, the measure overlay) need them at a fixed alpha. Both read the
// same token and tint it here, so a theme change moves them together.
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].replace(/./g, d => d + d) : hex[1]
    const n = Number.parseInt(digits, 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color)
  if (rgb) {
    const [r, g, b] = rgb[1].split(/[,/\s]+/).filter(Boolean)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return color
}
