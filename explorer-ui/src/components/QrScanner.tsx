import { useEffect, useRef } from 'react'
import jsQR from 'jsqr'

// Camera viewfinder that scans for a QR code: getUserMedia (back camera when
// there is one) + jsQR over a downscaled frame every ~200 ms. jsQR is pure JS,
// so this works wherever the camera opens at all; an insecure context or a
// denied permission surfaces through onUnavailable instead of a dead screen.
// The parent decides what a decoded text means — this component keeps firing
// onCode until it is unmounted, so a foreign QR doesn't end the scan.
const SCAN_EVERY_MS = 200
const SCAN_MAX_DIM = 480

export function QrScanner({ onCode, onUnavailable }: {
  onCode: (text: string) => void
  onUnavailable: (reason: 'unsupported' | 'denied') => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  // Callbacks live in refs so the camera doesn't restart when the parent
  // re-renders with fresh closures.
  const onCodeRef = useRef(onCode)
  const onUnavailableRef = useRef(onUnavailable)
  useEffect(() => { onCodeRef.current = onCode; onUnavailableRef.current = onUnavailable })

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      onUnavailableRef.current('unsupported')
      return
    }
    let stream: MediaStream | null = null
    let raf = 0
    let lastScan = 0
    let stopped = false
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(s => {
        if (stopped) { s.getTracks().forEach(t => t.stop()); return }
        stream = s
        const video = videoRef.current
        if (!video) return
        video.srcObject = s
        void video.play().catch(() => {})
      })
      .catch(() => { if (!stopped) onUnavailableRef.current('denied') })

    const tick = (t: number) => {
      raf = requestAnimationFrame(tick)
      if (t - lastScan < SCAN_EVERY_MS || !ctx) return
      lastScan = t
      const video = videoRef.current
      if (!video || video.readyState < video.HAVE_CURRENT_DATA || !video.videoWidth) return
      const scale = Math.min(1, SCAN_MAX_DIM / Math.max(video.videoWidth, video.videoHeight))
      canvas.width = Math.round(video.videoWidth * scale)
      canvas.height = Math.round(video.videoHeight * scale)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const result = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })
      if (result?.data) onCodeRef.current(result.data)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach(t => t.stop())
    }
  }, [])

  return <video ref={videoRef} className="qr-scan-video" playsInline muted aria-label="Camera viewfinder for QR scanning" />
}
