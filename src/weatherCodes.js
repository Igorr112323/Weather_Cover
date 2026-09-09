const CODES = {
  0: { label: 'Ясно', icon: 'sun', particle: 'clear', tone: 'sunny' },
  1: { label: 'В основном ясно', icon: 'sun', particle: 'clear', tone: 'sunny' },
  2: { label: 'Переменная облачность', icon: 'partly', particle: 'cloud', tone: 'partly' },
  3: { label: 'Пасмурно', icon: 'cloud', particle: 'cloud', tone: 'cloudy' },
  45: { label: 'Туман', icon: 'fog', particle: 'fog', tone: 'foggy' },
  48: { label: 'Иней и туман', icon: 'fog', particle: 'fog', tone: 'foggy' },
  51: { label: 'Лёгкая морось', icon: 'drizzle', particle: 'rain', tone: 'rainy' },
  53: { label: 'Морось', icon: 'drizzle', particle: 'rain', tone: 'rainy' },
  55: { label: 'Сильная морось', icon: 'drizzle', particle: 'rain', tone: 'rainy' },
  56: { label: 'Ледяная морось', icon: 'drizzle', particle: 'rain', tone: 'rainy' },
  57: { label: 'Ледяная морось', icon: 'drizzle', particle: 'rain', tone: 'rainy' },
  61: { label: 'Небольшой дождь', icon: 'rain', particle: 'rain', tone: 'rainy' },
  63: { label: 'Дождь', icon: 'rain', particle: 'rain', tone: 'rainy' },
  65: { label: 'Сильный дождь', icon: 'rain', particle: 'rain', tone: 'rainy' },
  66: { label: 'Ледяной дождь', icon: 'rain', particle: 'rain', tone: 'rainy' },
  67: { label: 'Ледяной дождь', icon: 'rain', particle: 'rain', tone: 'rainy' },
  71: { label: 'Небольшой снег', icon: 'snow', particle: 'snow', tone: 'snowy' },
  73: { label: 'Снегопад', icon: 'snow', particle: 'snow', tone: 'snowy' },
  75: { label: 'Сильный снегопад', icon: 'snow', particle: 'snow', tone: 'snowy' },
  77: { label: 'Снежная крупа', icon: 'snow', particle: 'snow', tone: 'snowy' },
  80: { label: 'Кратковременный дождь', icon: 'rain', particle: 'rain', tone: 'rainy' },
  81: { label: 'Ливень', icon: 'rain', particle: 'rain', tone: 'rainy' },
  82: { label: 'Сильный ливень', icon: 'rain', particle: 'rain', tone: 'rainy' },
  85: { label: 'Снегопад', icon: 'snow', particle: 'snow', tone: 'snowy' },
  86: { label: 'Сильный снегопад', icon: 'snow', particle: 'snow', tone: 'snowy' },
  95: { label: 'Гроза', icon: 'storm', particle: 'storm', tone: 'storm' },
  96: { label: 'Гроза с градом', icon: 'storm', particle: 'storm', tone: 'storm' },
  99: { label: 'Сильная гроза', icon: 'storm', particle: 'storm', tone: 'storm' }
}

export function metaFor(code = 0) {
  return CODES[code] || CODES[2]
}

export function getIconName(code) {
  return metaFor(code).icon
}

export function getParticleType(code) {
  return metaFor(code).particle
}

export function getTone(code) {
  return metaFor(code).tone
}

export const WEEK = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
export const MONTHS = [
  'янв', 'фев', 'мар', 'апр', 'мая', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'
]

export function dayName(dateStr) {
  return WEEK[new Date(dateStr).getDay()]
}

export function monthDay(dateStr) {
  const d = new Date(dateStr)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}
