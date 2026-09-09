import React from 'react'
import { WeatherIcon } from './icons.jsx'
import { dayName, monthDay, metaFor } from '../weatherCodes.js'

function TempBar({ min, max }) {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  return (
    <div className="tempbar">
      <span className="tempbar-min">{Math.round(lo)}°</span>
      <div className="tempbar-track">
        <div className="tempbar-fill" style={{ left: '0%', width: '100%' }} />
      </div>
      <span className="tempbar-max">{Math.round(hi)}°</span>
    </div>
  )
}

export default function DailyForecast({ daily }) {
  if (!daily || !daily.length) return null
  const show = daily.slice(0, 7)
  return (
    <section className="card daily-card">
      <div className="card-head">
        <h2>Прогноз на 7 дней</h2>
        <span className="card-note">погода по дням</span>
      </div>
      <div className="days">
        {show.map((d, i) => {
          const meta = metaFor(d.code)
          return (
            <div className="day" key={d.date}>
              <div className="day-date">
                <strong>{i === 0 ? 'Сегодня' : dayName(d.date)}</strong>
                <span>{monthDay(d.date)}</span>
              </div>
              <div className="day-icon">
                <WeatherIcon code={d.code} w={52} h={52} />
                <span className="day-cond">{meta.label}</span>
              </div>
              <div className="day-details">
                <span className="day-detail rain">💧 {Math.round(d.precip || 0)} мм</span>
                <span className="day-detail wind">~{Math.round(d.wind)} м/с</span>
                <span className="day-detail prob">{d.preciProb > 0 ? `${Math.round(d.preciProb)}%` : ''}</span>
              </div>
              <div className="day-temp">
                <span className="day-min">{Math.round(d.min)}°</span>
                <span className="day-max">{Math.round(d.max)}°</span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
