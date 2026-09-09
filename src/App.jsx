import React, { useCallback, useEffect, useMemo, useState } from 'react'
import SearchBar from './components/SearchBar.jsx'
import CurrentWeather from './components/CurrentWeather.jsx'
import HourlyForecast from './components/HourlyForecast.jsx'
import DailyForecast from './components/DailyForecast.jsx'
import MapCard from './components/MapCard.jsx'
import WeatherBackground from './components/WeatherBackground.jsx'
import { fetchWeather, DEMO_CITIES } from './api.js'
import { metaFor, getParticleType, getTone } from './weatherCodes.js'
import { WINDOWS_DOWNLOAD_URL } from './release.js'

const DEFAULT = DEMO_CITIES[0]

export default function App() {
  const [location, setLocation] = useState(DEFAULT)
  const [weather, setWeather] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [quick, setQuick] = useState(false)

  const load = useCallback(async (loc, opts = {}) => {
    if (!loc) return
    setLoading(true)
    setError('')
    const started = performance.now()
    const data = await fetchWeather(loc, opts?.forceDemo)
    const elapsed = Math.max(0, 360 - (performance.now() - started))
    window.setTimeout(() => {
      setWeather(data)
      setLocation(loc)
      setLoading(false)
    }, Math.min(elapsed, 360))
  }, [])

  useEffect(() => {
    load(DEFAULT, { forceDemo: false })
  }, [load])

  const selectCity = useCallback((city) => {
    setQuick(true)
    load(city)
  }, [load])

  const locate = useCallback(() => {
    if (!navigator.geolocation) {
      setError('Геолокация недоступна в этом браузере.')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setQuick(true)
        load({ city: 'Моё местоположение', country: 'по координатам', lat: pos.coords.latitude, lon: pos.coords.longitude })
      },
      () => {
        setError('Не удалось определить местоположение. Разрешите доступ или выберите город.')
      },
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 600000 }
    )
  }, [load])

  const current = weather?.current
  const code = current?.code ?? 2
  const meta = metaFor(code)
  const particle = getParticleType(code)
  const tone = getTone(code)
  const isDay = current?.isDay ?? true

  const enrichedCurrent = useMemo(() => current ? { ...current, label: meta.label } : null, [current, meta])

  return (
    <div className="app">
      <WeatherBackground type={particle} tone={tone} isDay={isDay} />

      <div className="app-layer">
        <header className="topbar">
          <div className="brand">
            <span className="brand-logo">☀</span>
            <span className="brand-name">Weather<b>Cover</b></span>
          </div>
          <SearchBar onSelect={selectCity} onLocate={locate} />
          <a className="btn-download" href={WINDOWS_DOWNLOAD_URL} target="_blank" rel="noreferrer">
            <span className="download-ico">⬇</span>
            <span className="download-text">Скачать EXE</span>
          </a>
        </header>

        <div className="quick">
          {DEMO_CITIES.slice(0, 5).map((c) => (
            <button key={c.city} className={`quick-btn ${location.city === c.city ? 'active' : ''}`} onClick={() => selectCity(c)}>
              {c.city}
            </button>
          ))}
        </div>

        <main className="grid">
          <div className="col-left">
            <CurrentWeather current={enrichedCurrent} location={location} source={weather?.source} />
            <MapCard location={location} weather={weather} />
          </div>
          <div className="col-right">
            <HourlyForecast hourly={weather?.hourly} />
            <DailyForecast daily={weather?.daily} />
          </div>
        </main>

        <footer className="footer">
          <span>WeatherCover 1.0</span>
          <span className="footer-sep">•</span>
          <span>Быстрая и красивая погода</span>
          {!quick && <span className="footer-hint">Нажмите ⬇, чтобы скачать EXE-версию.</span>}
        </footer>
      </div>

      {loading && (
        <div className="loading">
          <div className="loader-ring" />
          <div className="loading-text">Загружаем погоду…</div>
        </div>
      )}
      {error && <div className="toast-error">{error}</div>}
    </div>
  )
}
