import React from 'react'
import { WeatherIcon } from './icons.jsx'
import { windDirection, degree } from '../api.js'

function Stat({ label, value, sub, className = '', children }) {
  return (
    <div className={`stat ${className}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}{children}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export default function CurrentWeather({ current, location, source }) {
  if (!current) return null
  const windK = current.wind
  const windMs = Math.round(windK * 10) / 10
  const windKmh = Math.round(windK * 3.6)
  return (
    <section className={`current-card ${current.isDay ? 'day' : 'night'}`}>
      <div className="current-top">
        <div className="place">
          <span className="live-dot" />
          <h1>{location?.city || 'Местоположение'}</h1>
          <div className="place-sub">{location?.country || ''}</div>
        </div>
        <div className={`source ${source === 'live' ? 'on' : ''}`}>
          <span className="source-dot" />
          {source === 'live' ? 'Live' : 'Офлайн-режим'}
        </div>
      </div>

      <div className="current-main">
        <div className="current-left">
          <div className="temp-row">
            <span className="temp">{Math.round(current.temperature)}</span>
            <span className="deg">°</span>
          </div>
          <div className="feels">Ощущается как {degree(current.feels)}</div>
        </div>
        <div className="current-icon">
          <WeatherIcon code={current.code} />
          <div className="condition">{(current.label || '')}</div>
        </div>
      </div>

      <div className="current-stats">
        <Stat label="Ветер" value={`${windMs} м/с`} sub={windDirection(current.windDir)}>
          <span className="wind-chip">{windKmh} км/ч</span>
        </Stat>
        <Stat label="Влажность" value={`${Math.round(current.humidity)}%`} />
        <Stat label="Осадки" value={`${current.precipitation ?? 0} мм`} />
        <Stat label="Атм. давление" value={`${Math.round(current.pressure)}`} sub="гПа" />
      </div>
    </section>
  )
}
