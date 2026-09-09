import { metaFor } from './weatherCodes.js'

const GEO = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST = 'https://api.open-meteo.com/v1/forecast'

export const DEMO_CITIES = [
  { city: 'Москва', country: 'Россия', lat: 55.7558, lon: 37.6173 },
  { city: 'Санкт-Петербург', country: 'Россия', lat: 59.9311, lon: 30.3609 },
  { city: 'Новосибирск', country: 'Россия', lat: 55.0084, lon: 82.9357 },
  { city: 'Екатеринбург', country: 'Россия', lat: 56.8389, lon: 60.6057 },
  { city: 'Казань', country: 'Россия', lat: 55.7963, lon: 49.1088 },
  { city: 'Берлин', country: 'Германия', lat: 52.52, lon: 13.405 },
  { city: 'Лондон', country: 'Великобритания', lat: 51.505, lon: -0.09 },
  { city: 'Париж', country: 'Франция', lat: 48.8566, lon: 2.3522 },
  { city: 'Нью-Йорк', country: 'США', lat: 40.7128, lon: -74.006 },
  { city: 'Лос-Анджелес', country: 'США', lat: 34.0522, lon: -118.2437 },
  { city: 'Токио', country: 'Япония', lat: 35.6762, lon: 139.6503 },
  { city: 'Пекин', country: 'Китай', lat: 39.9042, lon: 116.4074 },
  { city: 'Дубай', country: 'ОАЭ', lat: 25.2048, lon: 55.2708 },
  { city: 'Стамбул', country: 'Турция', lat: 41.0082, lon: 28.9784 },
  { city: 'Минск', country: 'Беларусь', lat: 53.9006, lon: 27.559 }
]

function hashStr(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function today(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

export async function searchPlaces(query) {
  const q = (query || '').trim()
  if (!q) return []
  try {
    const url = `${GEO}?name=${encodeURIComponent(q)}&count=10&language=ru&format=json`
    const r = await fetch(url, { signal: AbortSignal.timeout(3500) })
    if (r.ok) {
      const data = await r.json()
      if (data && Array.isArray(data.results) && data.results.length) {
        return data.results.map((x) => ({
          city: x.name,
          country: x.country || '',
          admin: x.admin1 || '',
          lat: x.latitude,
          lon: x.longitude
        }))
      }
    }
  } catch (e) {
    // offline fallback below
  }
  const lower = q.toLowerCase()
  const direct = DEMO_CITIES.filter((c) => c.city.toLowerCase().includes(lower))
  const others = DEMO_CITIES.filter((c) => c.city.toLowerCase().startsWith(lower.slice(0, 3)) && !direct.includes(c))
  return [...direct, ...others].slice(0, 8)
}

function generateWeather(location, demo = true) {
  const now = new Date()
  const seed = hashStr(`${location.lat.toFixed(3)}|${location.lon.toFixed(3)}`)
  const rand = mulberry32(seed)

  const absLat = Math.abs(location.lat)
  const month = now.getMonth()
  const seasonWave = Math.cos(((month - 6.5) / 12) * Math.PI * 2) // positive in warmer months
  const northern = location.lat >= 0 ? 1 : -1
  const base = location.lastTemp ?? (24 - absLat * 0.3 + seasonWave * (8 - absLat * 0.08) * northern)
  const spread = Math.max(2, 8 - absLat * 0.05)

  const hour = now.getHours()
  const isDay = hour >= 7 && hour <= 20

  const codes = demo ? [0, 1, 2, 3, 3, 61, 63, 71, 73, 95] : [0, 1, 2, 3, 61, 63]
  const code = codes[Math.floor(rand() * codes.length)]

  const currentTemp = Math.round(base + Math.sin(((hour - 8) / 24) * Math.PI * 2) * spread)
  const current = {
    time: now.toISOString(),
    temperature: currentTemp,
    feels: currentTemp + Math.round((rand() - 0.45) * 4),
    humidity: Math.round(45 + rand() * 45),
    wind: Math.max(0.4, Math.round((15 + rand() * 45) * 10) / 10),
    windDir: Math.round(rand() * 360),
    pressure: Math.round(990 + rand() * 40),
    precipitation: rand() < 0.35 ? Math.round(rand() * 3 * 10) / 10 : 0,
    code,
    isDay
  }

  const hourly = []
  for (let i = 0; i < 48; i++) {
    const d = new Date(now.getTime() + i * 3600 * 1000)
    const h = d.getHours()
    const dayPhase = Math.sin(((h - 8) / 24) * Math.PI * 2)
    const dayIndex = Math.floor(i / 24) || 0
    const c = i === 0 ? code : codes[Math.floor(rand() * codes.length)]
    const precipRand = rand()
    const isDayHour = h >= 7 && h <= 20
    hourly.push({
      time: d.toISOString(),
      date: iso(d),
      hour: h,
      temp: Math.round(base + dayPhase * spread + dayIndex * (rand() - 0.5) * 2),
      code: c,
      precip: precipRand < 0.3 ? Math.round(rand() * 4 * 10) / 10 : 0,
      precipProb: Math.round(clamp(rand() * 100 + (precipRand < 0.3 ? 25 : 0), 0, 100)),
      wind: Math.round((12 + rand() * 42) * 10) / 10,
      humidity: Math.round(40 + rand() * 55),
      isDay: isDayHour
    })
  }

  const daily = []
  const dailyCodes = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * 86400 * 1000)
    dailyCodes.push(codes[Math.floor(rand() * codes.length)])
    const min = Math.round(base - spread - rand() * 3)
    const max = Math.round(base + spread + rand() * 3)
    const mid = Math.round((min + max) / 2)
    const sunrise = new Date(d)
    sunrise.setHours(7 + Math.round(rand() * 2), Math.round(rand() * 59), 0, 0)
    const sunset = new Date(d)
    sunset.setHours(18 + Math.round(rand() * 2), Math.round(rand() * 59), 0, 0)
    daily.push({
      date: iso(d),
      code: dailyCodes[i],
      min,
      max,
      temp: mid,
      precip: min > 0 && dailyCodes[i] % 10 >= 1 ? Math.round(rand() * 8 * 10) / 10 : 0,
      preciProb: Math.round(clamp(rand() * 100 + (dailyCodes[i] % 10 >= 3 ? 20 : 0), 0, 100)),
      wind: Math.round((13 + rand() * 47) * 10) / 10,
      sunrise: sunrise.toISOString(),
      sunset: sunset.toISOString()
    })
  }

  return { current, hourly, daily }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v))
}

export async function fetchWeather(location, demo = false) {
  if (demo || navigator.userAgent.includes('Electron') === false) {
    const real = await tryRemote(location)
    if (real) return real
  }
  const generated = generateWeather(location, true)
  return {
    ...generated,
    demo: true,
    source: 'offline'
  }
}

async function tryRemote(location) {
  try {
    const params = new URLSearchParams({
      latitude: String(location.lat),
      longitude: String(location.lon),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl',
      hourly: 'temperature_2m,weather_code,precipitation_probability,precipitation,wind_speed_10m,relative_humidity_2m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset',
      timezone: 'auto',
      forecast_days: '7'
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 7000)
    const r = await fetch(`${FORECAST}?${params}`, { signal: controller.signal })
    clearTimeout(timer)
    if (!r.ok) return null
    const j = await r.json()
    if (!j.current) return null
    const mapHour = (i) => ({
      time: j.hourly.time[i],
      date: j.hourly.time[i].slice(0, 10),
      hour: Number(j.hourly.time[i].slice(11, 13)),
      temp: Math.round(j.hourly.temperature_2m[i]),
      code: j.hourly.weather_code[i],
      precip: j.hourly.precipitation[i],
      precipProb: j.hourly.precipitation_probability[i],
      wind: j.hourly.wind_speed_10m[i],
      humidity: j.hourly.relative_humidity_2m[i],
      isDay: Number(j.hourly.time[i].slice(11, 13)) >= 7 && Number(j.hourly.time[i].slice(11, 13)) <= 20
    })
    const current = {
      time: j.current.time,
      temperature: Math.round(j.current.temperature_2m),
      feels: Math.round(j.current.apparent_temperature),
      humidity: j.current.relative_humidity_2m,
      wind: j.current.wind_speed_10m,
      windDir: j.current.wind_direction_10m,
      pressure: j.current.pressure_msl,
      precipitation: j.current.precipitation,
      code: j.current.weather_code,
      isDay: j.current.is_day === 1
    }
    const daily = j.daily.time.map((date, i) => ({
      date,
      code: j.daily.weather_code[i],
      min: Math.round(j.daily.temperature_2m_min[i]),
      max: Math.round(j.daily.temperature_2m_max[i]),
      temp: Math.round((j.daily.temperature_2m_min[i] + j.daily.temperature_2m_max[i]) / 2),
      precip: j.daily.precipitation_sum[i],
      preciProb: j.daily.precipitation_probability_max ? j.daily.precipitation_probability_max[i] : 0,
      wind: j.daily.wind_speed_10m_max[i],
      sunrise: j.daily.sunrise[i],
      sunset: j.daily.sunset[i]
    }))
    return {
      current,
      hourly: j.hourly.time.map((_, i) => mapHour(i)).slice(0, 48),
      daily,
      demo: false,
      source: 'live'
    }
  } catch (e) {
    return null
  }
}

export function statusFor(code) {
  return metaFor(code)
}

export function degree(v) {
  return `${Math.round(v)}°C`
}

export function windDirection(deg) {
  const dirs = ['с', 'св', 'в', 'юв', 'ю', 'юз', 'з', 'сз']
  return dirs[Math.round(deg / 45) % 8]
}
