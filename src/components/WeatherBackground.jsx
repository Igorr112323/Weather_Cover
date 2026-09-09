import React, { useEffect, useRef, useMemo } from 'react'

const COLORS = {
  rain: ['rgba(150, 196, 255, 0.75)', 'rgba(96, 154, 245, 0.6)'],
  snow: ['rgba(255, 255, 255, 0.95)', 'rgba(225, 240, 255, 0.8)'],
  clear: ['rgba(255, 235, 170, 0.7)', 'rgba(255, 220, 130, 0.45)'],
  sparkle: ['rgba(255, 255, 255, 0.8)', 'rgba(255, 255, 255, 0.35)'],
  cloud: ['rgba(255, 255, 255, 0.28)', 'rgba(215, 225, 240, 0.22)'],
  fog: ['rgba(235, 240, 250, 0.38)', 'rgba(240, 245, 252, 0.2)']
}

export default function WeatherBackground({ type = 'clear', tone = 'sunny', isDay = true }) {
  const ref = useRef(null)
  const reduced = useMemo(() => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let raf = 0
    let w = 0
    let h = 0
    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    let particles = []
    let last = performance.now()
    let bolt = { active: false, until: 0 }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = Math.max(1, w * dpr)
      canvas.height = Math.max(1, h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed()
    }

    function rand(min, max) {
      return min + Math.random() * (max - min)
    }

    function seed() {
      const count = Math.round((w * h) / (type === 'clear' ? 9000 : type === 'snow' ? 7200 : 5400))
      const n = Math.min(Math.max(count, 35), type === 'snow' ? 90 : 170)
      particles = []
      for (let i = 0; i < n; i++) {
        if (type === 'rain' || type === 'storm') {
          particles.push({
            kind: 'rain',
            x: rand(0, w),
            y: rand(-h, h),
            len: rand(10, 24),
            speed: rand(9, 17),
            tilt: rand(-0.22, -0.08),
            o: rand(0.5, 0.95),
            sat: Math.random() < 0.25 ? 1 : 0
          })
        } else if (type === 'snow') {
          particles.push({
            kind: 'snow',
            x: rand(0, w),
            y: rand(-h, h),
            r: rand(1.2, 4.4),
            speed: rand(0.45, 1.5),
            sway: rand(0.4, 2.2),
            phase: rand(0, Math.PI * 2),
            o: rand(0.5, 1)
          })
        } else if (type === 'clear' || type === 'sparkle') {
          particles.push({
            kind: 'sparkle',
            x: rand(0, w),
            y: rand(0, h),
            r: rand(0.6, 2),
            vx: rand(-0.18, 0.18),
            vy: rand(-0.12, 0.18),
            phase: rand(0, Math.PI * 2)
          })
        } else {
          particles.push({
            kind: 'cloud',
            x: rand(-w * 0.2, w),
            y: rand(0, h),
            r: rand(70, 180),
            speed: rand(0.08, 0.35),
            o: rand(0.25, 0.55),
            pulse: rand(0, Math.PI * 2)
          })
        }
      }
      if (type === 'storm' && !reduced) {
        bolt.active = true
        bolt.until = performance.now() + rand(900, 1800)
      }
    }

    function draw(t) {
      const dt = Math.min((t - last) / 16.7, 2.2)
      last = t
      ctx.clearRect(0, 0, w, h)
      const speeds = reduced ? 0.25 : 1

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]
        if (p.kind === 'rain') {
          p.y += p.speed * dt * speeds
          p.x += p.speed * p.tilt * dt * speeds
          if (p.y - p.len > h) {
            p.y = -p.len
            p.x = rand(0, w + 80)
          }
          ctx.strokeStyle = p.sat ? 'rgba(190, 220, 255, 0.8)' : `rgba(125, 177, 247, ${p.o})`
          ctx.lineWidth = 1.15
          ctx.beginPath()
          ctx.moveTo(p.x, p.y)
          ctx.lineTo(p.x + p.tilt * p.len, p.y + p.len)
          ctx.stroke()
        } else if (p.kind === 'snow') {
          p.y += p.speed * dt * speeds
          p.phase += p.sway * dt * 0.02 * speeds
          const sx = p.x + Math.sin(p.phase) * 7
          if (p.y > h + 8) {
            p.y = -8
            p.x = rand(0, w)
          }
          ctx.fillStyle = `rgba(255, 255, 255, ${p.o})`
          ctx.shadowBlur = 5
          ctx.shadowColor = 'rgba(200, 225, 255, 0.35)'
          ctx.beginPath()
          ctx.arc(sx, p.y, p.r, 0, Math.PI * 2)
          ctx.fill()
          ctx.shadowBlur = 0
        } else if (p.kind === 'sparkle') {
          p.phase += 0.03 * dt
          p.x += p.vx * dt * speeds
          p.y += p.vy * dt * speeds
          if (p.x < -10) p.x = w + 10
          if (p.x > w + 10) p.x = -10
          if (p.y < -10) p.y = h + 10
          if (p.y > h + 10) p.y = -10
          const a = (0.35 + Math.sin(p.phase) * 0.3)
          ctx.fillStyle = `rgba(255, 250, 235, ${a})`
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
          ctx.fill()
        } else {
          p.x += p.speed * dt * speeds
          p.pulse += 0.002 * dt
          if (p.x - p.r > w) {
            p.x = -p.r
            p.y = rand(0, h)
          }
          const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r)
          grad.addColorStop(0, `rgba(255,255,255,${p.o})`)
          grad.addColorStop(1, 'rgba(255,255,255,0)')
          ctx.fillStyle = grad
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      if (type === 'storm' && !reduced) {
        if (bolt.active && t > bolt.until) {
          bolt.active = false
          bolt.until = t + rand(2400, 5200)
        }
        if (bolt.active && ((t / 130) % 2 < 1)) {
          const a = 0.18 + Math.random() * 0.12
          ctx.fillStyle = `rgba(235, 245, 255, ${a})`
          ctx.fillRect(0, 0, w, h)
        }
      }

      raf = requestAnimationFrame(draw)
    }

    function go() {
      if (reduced) {
        seed()
        draw(performance.now())
      } else {
        raf = requestAnimationFrame(draw)
      }
    }

    resize()
    window.addEventListener('resize', resize)
    go()
    const idle = window.setTimeout(() => {}, 1)
    return () => {
      window.removeEventListener('resize', resize)
      window.clearTimeout(idle)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [type, tone, isDay, reduced])

  const cls = ['weather-bg', tone, isDay ? 'day' : 'night']
  return <canvas ref={ref} className={cls.join(' ')} aria-hidden="true" />
}
