// Every inline SVG that more than one surface draws, in one place. Sizing stays
// with the caller: these all sit inside buttons whose CSS already sizes `svg`,
// so they carry no width/height unless a call site has no such rule (the close
// button in the mobile drawer and the pair picker, which pass their own).

/** The Hydration mark's path, also rasterized into screenshots by `brandWatermark`. */
export const HYDRATION_LOGO_PATH = 'M18.0532 11.3604C18.2827 11.1319 18.5778 10.8381 18.8718 10.5463C19.5265 9.89543 19.5265 8.83853 18.8718 8.18664L18.1782 7.49598C15.6959 9.96786 11.982 10.4637 9.00484 8.98646C11.017 9.35678 13.1028 9.06807 14.951 8.0785C16.1876 7.41641 16.4222 5.74741 15.4295 4.75886L11.3366 0.683262C10.4217 -0.227754 8.93928 -0.227754 8.02542 0.683262L3.61392 5.07613C6.51941 3.84682 10.0089 4.4171 12.3714 6.78594C8.76716 5.04349 4.30136 5.66171 1.3088 8.64164C1.07931 8.87016 0.78323 9.16499 0.490223 9.45676C-0.163408 10.1086 -0.163408 11.1645 0.490223 11.8154L1.18279 12.505C3.66515 10.0332 7.37896 9.53735 10.3562 11.0146C8.34404 10.6442 6.25816 10.933 4.40996 11.9225C3.17339 12.5846 2.93878 14.2536 3.93152 15.2422L8.0244 19.3178C8.93928 20.2288 10.4217 20.2288 11.3356 19.3178L15.7471 14.9249C12.8416 16.1542 9.35215 15.5839 6.98965 13.2151C10.5938 14.9575 15.0596 14.3393 18.0522 11.3594L18.0532 11.3604Z'

export function HydrationLogo({ size = 20 }: { size?: number }) {
  return (
    <svg className="logo" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" style={{ width: size, height: size }}>
      <path d={HYDRATION_LOGO_PATH} />
    </svg>
  )
}

export function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

export function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

export function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

export function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

export function TrendlineIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <line x1="7.5" y1="16.5" x2="16.5" y2="7.5" />
      <circle cx="5.5" cy="18.5" r="2" />
      <circle cx="18.5" cy="5.5" r="2" />
    </svg>
  )
}

export function CloseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  )
}
