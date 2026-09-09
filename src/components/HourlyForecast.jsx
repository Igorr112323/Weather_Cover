import React, { useMemo } from 'react'
import { WeatherIcon } from './icons.jsx'

export default function HourlyForecast({ hourly }) {
  const hours = (hourly || []).slice(0, 24)
  const chart = useMemo(() => {
    if (!hours.length) return null
    const w = 620
    const h = 110
    const pad = 14
    const temps = hours.map((x) => x.temp)
    const min = Math.min(...temps)
    const max = Math.max(...temps)
    const range = Math.max(1, max - min)
    const pts = temps.map((t, i) => {
      const x = pad + (i / (hours.length - 1)) * (w - pad * 2)
      const y = h - pad - ((t - min) / range) * (h - pad * 2)
      return [x, y]
    })
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
    return { pts, line, w, h, min, max }
  }, [hours])

  if (!hours.length) return null

  const nowLabel = (x) => {
    if (x.index === 0) return 'Сейчас'
    return `${String(x.hour).padStart(2, '0')}:00`
  }

  return (
    <section className="card hourly-card">
      <div className="card-head">
        <h2>Почасовой прогноз</h2>
        <span className="card-note">ближайшие 24 часа</span>
      </div>
      {chart && (
        <div className="chart-wrap">
          <svg viewBox={`0 0 ${chart.w} ${chart.h}`} className="temp-chart" preserveAspectRatio="none">
            <defs>
              <linearGradient id="chartArea" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="rgba(112, 175, 255, 0.55)" />
                <stop offset="1" stopColor="rgba(112, 175, 255, 0)" />
              </linearGradient>
            </defs>
            <path d={`${chart.line} L${chart.pts[chart.pts.length - 1][0]},${chart.h} L${chart.pts[0][0]},${chart.h} Z`} fill="url(#chartArea)" />
            <path d={chart.line} fill="none" stroke="#71b0ff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            {chart.pts.map((p, i) => (
              <circle key={i} cx={p[0]} cy={p[1]} r={i % 6 === 0 ? 3.4 : 2.2} fill="#eaf4ff" stroke="#71b0ff" strokeWidth="1.4" />
            ))}
          </svg>
          <div className="chart-labels">
            <span>{chart.min}°</span>
            <span>{chart.max}°</span>
          </div>
        </div>
      )}
      <div className="hours">
        {hours.map((x, i) => (
          <div className={`hour ${i === 0 ? 'now' : ''}`} key={x.time}>
            <div className="hour-time">{nowLabel({ hour: x.hour, index: i })}</div>
            <WeatherIcon code={x.code} className="hour-icon" w={42} h={42} />
            <div className="hour-temp">{Math.round(x.temp)}°</div>
            <div className="hour-rain">{x.precipProb > 0 ? `💧 ${Math.round(x.precipProb)}%` : ''}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
