'use client'
import { useEffect, useRef, useState } from 'react'

// ─── 类型 ───
interface Particle {
  /** logo 形状上的初始位置（canvas 坐标，中心为原点） */
  originX: number
  originY: number
  /** 当前位置 */
  x: number
  y: number
  /** 当前速度（散开阶段用） */
  vx: number
  vy: number
  /** 基础大小 0-1 */
  size: number
  /** 闪烁相位偏移 0-2PI */
  flickerPhase: number
  /** 闪烁速度倍率 */
  flickerSpeed: number
}

interface AnimationState {
  particles: Particle[]
  time: number           // 流逝时间（秒），用于闪烁波形
  splashProgress: number // splash 模式下的进度 0→1
  width: number
  height: number
  centerX: number
  centerY: number
  splashMode: boolean
  destroyed: boolean
}

// ─── Props ───
export interface SpiralAnimationProps {
  /** logo 图片地址 */
  logoImageSrc?: string
  /** splash 动画总时长 (ms)，仅 splash 模式有效 */
  duration?: number
  /** 粒子数量，默认 2000 */
  particleCount?: number
  /** logo 形状缩放，默认 0.4 */
  logoScale?: number
  /** 进度回调 0→1，设置后进入 splash 模式（单次播放）；不设置则为背景模式（持续闪烁） */
  onProgress?: (progress: number) => void
  /** 动画完成回调 */
  onComplete?: () => void
}

// ─── 工具函数 ───

function extractShapeFromImage(
  img: HTMLImageElement,
  targetWidth: number,
  targetHeight: number
): { x: number; y: number }[] {
  const offCanvas = document.createElement('canvas')
  offCanvas.width = targetWidth
  offCanvas.height = targetHeight
  const offCtx = offCanvas.getContext('2d')!
  offCtx.clearRect(0, 0, targetWidth, targetHeight)

  const imgAspect = img.naturalWidth / img.naturalHeight
  const canvasAspect = targetWidth / targetHeight
  let drawW: number, drawH: number, offsetX: number, offsetY: number

  if (imgAspect > canvasAspect) {
    drawW = targetWidth
    drawH = targetWidth / imgAspect
    offsetX = 0
    offsetY = (targetHeight - drawH) / 2
  } else {
    drawH = targetHeight
    drawW = targetHeight * imgAspect
    offsetX = (targetWidth - drawW) / 2
    offsetY = 0
  }

  offCtx.drawImage(img, offsetX, offsetY, drawW, drawH)
  const imageData = offCtx.getImageData(0, 0, targetWidth, targetHeight)
  const data = imageData.data

  const points: { x: number; y: number }[] = []
  const step = 2

  for (let y = 0; y < targetHeight; y += step) {
    for (let x = 0; x < targetWidth; x += step) {
      const idx = (y * targetWidth + x) * 4
      if (data[idx + 3] > 128) {
        points.push({ x: x - targetWidth / 2, y: y - targetHeight / 2 })
      }
    }
  }

  return points
}

function sampleParticles(shapePoints: { x: number; y: number }[], count: number): Particle[] {
  if (shapePoints.length === 0) {
    return Array.from({ length: count }, () => {
      const angle = Math.random() * Math.PI * 2
      const radius = 40 + Math.random() * 80
      return {
        originX: Math.cos(angle) * radius,
        originY: Math.sin(angle) * radius,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0, vy: 0,
        size: 0.3 + Math.random() * 0.7,
        flickerPhase: Math.random() * Math.PI * 2,
        flickerSpeed: 0.5 + Math.random() * 2.0,
      }
    })
  }

  const particles: Particle[] = []
  for (let i = 0; i < count; i++) {
    const pt = shapePoints[Math.floor(Math.random() * shapePoints.length)]
    const angle = Math.random() * Math.PI * 2
    const speed = 2 + Math.random() * 8
    particles.push({
      originX: pt.x, originY: pt.y,
      x: pt.x, y: pt.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 0.2 + Math.random() * 0.8,
      flickerPhase: Math.random() * Math.PI * 2,
      flickerSpeed: 0.5 + Math.random() * 2.5,
    })
  }

  return particles
}

// ─── 渲染 ───

function renderFrame(state: AnimationState, ctx: CanvasRenderingContext2D) {
  const { particles, width, height, centerX, centerY, time, splashProgress, splashMode } = state

  // 清屏：背景模式用透明（让父级背景透出），splash 用纯黑
  if (splashMode) {
    ctx.fillStyle = '#0a0a0f'
  } else {
    ctx.clearRect(0, 0, width, height)
  }
  ctx.fillRect(0, 0, width, height)

  ctx.save()
  ctx.translate(centerX, centerY)

  if (splashMode) {
    // ─── Splash 模式：出现 → 闪两下 → 消散 ───
    for (const p of particles) {
      let px: number, py: number, alpha: number, dotSize: number

      if (splashProgress <= 0.15) {
        // 阶段1：粒子渐显
        const fadeIn = splashProgress / 0.15  // 0→1
        px = p.originX; py = p.originY
        alpha = fadeIn * 0.6
        dotSize = p.size * 1.6 + 0.4 + fadeIn * 0.5
      } else if (splashProgress <= 0.55) {
        // 阶段2：闪烁两下
        const flashT = (splashProgress - 0.15) / 0.40  // 0→1
        // 两下闪烁：两个 sin 波峰
        const flash1 = Math.sin(flashT * Math.PI * 4)  // 2个完整周期
        const flash2 = Math.sin(flashT * Math.PI * 4 - 0.5)
        const combined = Math.max(flash1, flash2)
        const flash = 0.4 + 0.6 * Math.max(0, combined)

        const noise = Math.sin(time * p.flickerSpeed * 25 + p.flickerPhase) * 0.15
        alpha = Math.max(0.15, Math.min(1, flash + noise))
        px = p.originX; py = p.originY
        dotSize = p.size * 2.0 + 0.6
      } else if (splashProgress <= 0.85) {
        // 阶段3：慢慢消散（粒子飞散 + 淡出）
        const dissolveT = (splashProgress - 0.55) / 0.30  // 0→1
        const easedT = dissolveT * dissolveT
        px = p.originX + p.vx * easedT * 80
        py = p.originY + p.vy * easedT * 80
        alpha = Math.max(0, 0.6 * (1 - dissolveT))
        dotSize = Math.max(0.15, p.size * 2.0 + 0.6 - dissolveT * 2.0)
      } else {
        // 阶段4：完全消散
        px = p.originX + p.vx * 200
        py = p.originY + p.vy * 200
        alpha = 0
        dotSize = 0.1
      }

      if (alpha <= 0.01) continue
      drawParticle(ctx, px, py, dotSize, alpha)
    }
  } else {
    // ─── 背景模式：持续闪烁，不散开 ───
    for (const p of particles) {
      const flickerVal = Math.sin(time * p.flickerSpeed * 3 + p.flickerPhase)
      const flicker = 0.5 + 0.5 * flickerVal
      const noise = Math.sin(time * p.flickerSpeed * 5.5 + p.flickerPhase * 1.7) * 0.25
      const alpha = Math.max(0.08, Math.min(1, 0.15 + flicker * 0.35 + noise))
      const dotSize = p.size * 1.4 + 0.3

      drawParticle(ctx, p.originX, p.originY, dotSize, alpha)
    }
  }

  ctx.restore()
}

function drawParticle(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, alpha: number) {
  // 光晕
  ctx.fillStyle = `rgba(255,255,255,${alpha * 0.12})`
  ctx.beginPath()
  ctx.arc(x, y, size * 3, 0, Math.PI * 2)
  ctx.fill()

  // 主体
  ctx.fillStyle = `rgba(255,255,255,${alpha})`
  ctx.beginPath()
  ctx.arc(x, y, size, 0, Math.PI * 2)
  ctx.fill()

  // 亮点
  if (alpha > 0.2) {
    ctx.fillStyle = `rgba(255,255,255,${alpha * 1.4})`
    ctx.beginPath()
    ctx.arc(x, y, size * 0.35, 0, Math.PI * 2)
    ctx.fill()
  }
}

// ─── React 组件 ───

export function SpiralAnimation({
  logoImageSrc = '/logo.png',
  duration = 3200,
  particleCount = 2000,
  logoScale = 0.4,
  onProgress,
  onComplete,
}: SpiralAnimationProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef<AnimationState | null>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [ready, setReady] = useState(false)
  const splashMode = !!onProgress

  useEffect(() => {
    const updateSize = () => {
      setDimensions({ width: window.innerWidth, height: window.innerHeight })
    }
    updateSize()
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || dimensions.width === 0) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = dimensions.width
    const h = dimensions.height

    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`

    ctx.scale(dpr, dpr)

    const centerX = w / 2
    const centerY = h / 2

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const extractWidth = Math.min(dimensions.width, 600)
      const extractHeight = Math.min(dimensions.height, 600)
      const shapePoints = extractShapeFromImage(img, extractWidth, extractHeight)

      const rawScaleX = dimensions.width / extractWidth
      const rawScaleY = dimensions.height / extractHeight
      const uniformScale = Math.min(rawScaleX, rawScaleY) * logoScale
      const scaledPoints = shapePoints.map(pt => ({
        x: pt.x * uniformScale,
        y: pt.y * uniformScale,
      }))

      const particles = sampleParticles(scaledPoints, particleCount)
      const state: AnimationState = {
        particles,
        time: 0,
        splashProgress: 0,
        width: w,
        height: h,
        centerX,
        centerY,
        splashMode,
        destroyed: false,
      }

      stateRef.current = state
      setReady(true)

      if (splashMode) {
        runSplash(state, ctx, performance.now(), duration, onProgress!, onComplete)
      } else {
        runBackground(state, ctx)
      }
    }
    img.src = logoImageSrc

    return () => {
      if (stateRef.current) stateRef.current.destroyed = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimensions])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.3s ease' }}
    />
  )
}

// ─── 背景模式：持续循环 ───

function runBackground(state: AnimationState, ctx: CanvasRenderingContext2D) {
  let lastTime = performance.now()

  function frame(now: number) {
    if (state.destroyed) return
    const delta = (now - lastTime) / 1000
    lastTime = now
    state.time += delta
    renderFrame(state, ctx)
    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
}

// ─── Splash 模式：单次播放 ───

function runSplash(
  state: AnimationState,
  ctx: CanvasRenderingContext2D,
  startTime: number,
  duration: number,
  onProgress: (p: number) => void,
  onComplete?: () => void
) {
  let completeFired = false

  function frame(now: number) {
    if (state.destroyed) return

    const elapsed = (now - startTime) / 1000
    state.time = elapsed
    const rawProgress = Math.min(elapsed / (duration / 1000), 1)
    const progress = easeInOutCubic(rawProgress)
    state.splashProgress = progress

    onProgress(progress)
    renderFrame(state, ctx)

    if (rawProgress < 1) {
      requestAnimationFrame(frame)
    } else if (!completeFired) {
      completeFired = true
      onComplete?.()
    }
  }

  requestAnimationFrame(frame)
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export default SpiralAnimation
