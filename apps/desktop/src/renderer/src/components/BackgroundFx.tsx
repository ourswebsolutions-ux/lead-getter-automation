import { useEffect, useRef } from 'react'

/**
 * Forvonix background: a slowly turning chrome point-sphere, a perspective grid drifting toward the
 * viewer and twinkling stars, drawn on one canvas behind the app. Capped at 30 fps, paused while
 * the window is hidden, and a single still frame for people who prefer reduced motion.
 */

type V3 = [number, number, number]

/** Unit icosphere (1 subdivision): 42 points, 120 edges — reads as a 3D object without being busy. */
function icosphere(): { pts: V3[]; edges: [number, number][] } {
  const t = (1 + Math.sqrt(5)) / 2
  let pts: V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
  ]
  let faces: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ]
  const norm = (p: V3): V3 => {
    const l = Math.hypot(...p)
    return [p[0] / l, p[1] / l, p[2] / l]
  }
  pts = pts.map(norm)
  const cache = new Map<string, number>()
  const mid = (a: number, b: number) => {
    const k = a < b ? `${a}-${b}` : `${b}-${a}`
    if (!cache.has(k)) {
      pts.push(norm([(pts[a][0] + pts[b][0]) / 2, (pts[a][1] + pts[b][1]) / 2, (pts[a][2] + pts[b][2]) / 2]))
      cache.set(k, pts.length - 1)
    }
    return cache.get(k)!
  }
  faces = faces.flatMap(([a, b, c]) => {
    const ab = mid(a, b)
    const bc = mid(b, c)
    const ca = mid(c, a)
    return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]] as [number, number, number][]
  })
  const edgeSet = new Set<string>()
  const edges: [number, number][] = []
  for (const [a, b, c] of faces)
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const k = x < y ? `${x}-${y}` : `${y}-${x}`
      if (!edgeSet.has(k)) {
        edgeSet.add(k)
        edges.push([x, y])
      }
    }
  return { pts, edges }
}

/** Accent gradient #4DA6FF → #00D1FF → #7B61FF at t ∈ [0,1]. */
function accent(t: number): [number, number, number] {
  const stops: [number, number, number][] = [[77, 166, 255], [0, 209, 255], [123, 97, 255]]
  const x = Math.min(0.999, Math.max(0, t)) * 2
  const i = Math.floor(x)
  const f = x - i
  return [0, 1, 2].map((k) => Math.round(stops[i][k] + (stops[i + 1][k] - stops[i][k]) * f)) as [number, number, number]
}

export function BackgroundFx({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !enabled) return
    const ctx = canvas.getContext('2d', { alpha: false })!
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const sphere = icosphere()
    const stars = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random() * 0.7, r: Math.random() * 1.1 + 0.3, p: Math.random() * Math.PI * 2, s: 0.4 + Math.random() * 1.2 }))
    let w = 0
    let h = 0
    let dpr = 1
    let raf = 0
    let last = 0
    let t0 = performance.now()
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 }

    const resize = () => {
      dpr = Math.min(1.5, window.devicePixelRatio || 1)
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const onMove = (e: PointerEvent) => {
      mouse.tx = (e.clientX / w - 0.5) * 2
      mouse.ty = (e.clientY / h - 0.5) * 2
    }

    const draw = (now: number) => {
      const t = (now - t0) / 1000
      mouse.x += (mouse.tx - mouse.x) * 0.04
      mouse.y += (mouse.ty - mouse.y) * 0.04

      // Base + hero glows (guide §4: right blue 0.06, left purple 0.05).
      ctx.fillStyle = '#020204'
      ctx.fillRect(0, 0, w, h)
      const g1 = ctx.createRadialGradient(w * 0.85, h * 0.08, 0, w * 0.85, h * 0.08, Math.max(w, h) * 0.6)
      g1.addColorStop(0, 'rgba(77,166,255,0.07)')
      g1.addColorStop(1, 'rgba(77,166,255,0)')
      ctx.fillStyle = g1
      ctx.fillRect(0, 0, w, h)
      const g2 = ctx.createRadialGradient(w * 0.12, h * 0.95, 0, w * 0.12, h * 0.95, Math.max(w, h) * 0.55)
      g2.addColorStop(0, 'rgba(123,97,255,0.06)')
      g2.addColorStop(1, 'rgba(123,97,255,0)')
      ctx.fillStyle = g2
      ctx.fillRect(0, 0, w, h)

      // Stars (white, 0.03–0.2).
      for (const s of stars) {
        const a = 0.03 + 0.17 * (0.5 + 0.5 * Math.sin(t * s.s + s.p))
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`
        ctx.beginPath()
        ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2)
        ctx.fill()
      }

      // Perspective grid floor drifting toward the viewer.
      const horizon = h * 0.62
      const fov = 260
      const camY = 70
      ctx.lineWidth = 1
      const zShift = (t * 26) % 40
      for (let z = 40; z < 1400; z += 40) {
        const zz = z - zShift
        if (zz <= 1) continue
        const y = horizon + (camY * fov) / zz
        if (y > h) continue
        const a = Math.max(0, Math.min(0.16, 0.16 * (1 - zz / 1400)))
        ctx.strokeStyle = `rgba(77,166,255,${a.toFixed(3)})`
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }
      for (let x = -1600; x <= 1600; x += 80) {
        const xo = x + mouse.x * 40
        const near = 40
        const far = 1400
        const x1 = w / 2 + (xo * fov) / near
        const y1 = horizon + (camY * fov) / near
        const x2 = w / 2 + (xo * fov) / far
        const y2 = horizon + (camY * fov) / far
        const grad = ctx.createLinearGradient(0, y2, 0, y1)
        grad.addColorStop(0, 'rgba(123,97,255,0)')
        grad.addColorStop(1, 'rgba(0,209,255,0.12)')
        ctx.strokeStyle = grad
        ctx.beginPath()
        ctx.moveTo(x2, y2)
        ctx.lineTo(x1, y1)
        ctx.stroke()
      }
      // Horizon line (accent bar, faded at the ends).
      const hl = ctx.createLinearGradient(0, 0, w, 0)
      hl.addColorStop(0, 'rgba(77,166,255,0)')
      hl.addColorStop(0.3, 'rgba(77,166,255,0.35)')
      hl.addColorStop(0.5, 'rgba(0,209,255,0.45)')
      hl.addColorStop(0.7, 'rgba(123,97,255,0.35)')
      hl.addColorStop(1, 'rgba(123,97,255,0)')
      ctx.strokeStyle = hl
      ctx.beginPath()
      ctx.moveTo(0, horizon)
      ctx.lineTo(w, horizon)
      ctx.stroke()

      // Rotating chrome point-sphere.
      const R = Math.min(w, h) * 0.24
      const cx = w * 0.68 + mouse.x * 18
      const cy = h * 0.42 + mouse.y * 12
      const ay = t * 0.18 + mouse.x * 0.35
      const ax = 0.42 + Math.sin(t * 0.13) * 0.15 + mouse.y * 0.2
      const cyR = Math.cos(ay)
      const syR = Math.sin(ay)
      const cxR = Math.cos(ax)
      const sxR = Math.sin(ax)
      const breathe = 1 + Math.sin(t * 0.6) * 0.025
      const proj = sphere.pts.map(([x, y, z]) => {
        const x1 = x * cyR + z * syR
        const z1 = -x * syR + z * cyR
        const y2 = y * cxR - z1 * sxR
        const z2 = y * sxR + z1 * cxR
        const d = 3.2 / (3.2 + z2)
        return { x: cx + x1 * R * breathe * d, y: cy + y2 * R * breathe * d, z: z2, d }
      })
      for (const [a, b] of sphere.edges) {
        const p = proj[a]
        const q = proj[b]
        const depth = (2 - (p.z + q.z) / 2) / 3 // near → 1
        const [r, g, bl] = accent(((p.y + q.y) / 2 - (cy - R)) / (2 * R))
        ctx.strokeStyle = `rgba(${r},${g},${bl},${(0.05 + depth * 0.22).toFixed(3)})`
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(q.x, q.y)
        ctx.stroke()
      }
      for (const p of proj) {
        const depth = (1 - p.z) / 2
        ctx.fillStyle = `rgba(201,201,203,${(0.15 + depth * 0.65).toFixed(3)})` // liquid chrome
        ctx.beginPath()
        ctx.arc(p.x, p.y, 0.8 + depth * 1.8 * p.d, 0, Math.PI * 2)
        ctx.fill()
      }
      // Soft core glow.
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.3)
      core.addColorStop(0, 'rgba(0,209,255,0.06)')
      core.addColorStop(1, 'rgba(0,209,255,0)')
      ctx.fillStyle = core
      ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8)
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (document.hidden || now - last < 33) return // ~30 fps, nothing while hidden
      last = now
      draw(now)
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onMove, { passive: true })
    if (reduce) draw(performance.now())
    else raf = requestAnimationFrame(loop)
    const onVis = () => {
      if (!document.hidden) t0 = performance.now() - (last - t0 > 0 ? last - t0 : 0)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [enabled])

  return <canvas ref={ref} className={`bg-fx ${enabled ? '' : 'off'}`} aria-hidden="true" />
}
