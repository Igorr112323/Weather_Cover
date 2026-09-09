import React from 'react'

const S = ({ children, className = '', w = 80, h = 80 }) => (
  <svg className={`wi ${className}`} width={w} height={h} viewBox="0 0 120 120" fill="none" aria-hidden="true">
    {children}
  </svg>
)

export function SunIcon({ className = '' }) {
  return (
    <S className={className}>
      <circle cx="60" cy="60" r="26" fill="#ffd36b" />
      <circle cx="60" cy="60" r="17" fill="#ffb648" />
      <g stroke="#ffd36b" strokeWidth="5" strokeLinecap="round">
        <path d="M60 22V10" />
        <path d="M60 98v12" />
        <path d="M98 60h12" />
        <path d="M10 60h12" />
        <path d="M87 33l8-8" />
        <path d="M25 95l8-8" />
        <path d="M87 87l8 8" />
        <path d="M25 25l8 8" />
      </g>
    </S>
  )
}

export function PartlyIcon({ className = '' }) {
  return (
    <S className={className}>
      <circle cx="42" cy="46" r="18" fill="#ffd36b" />
      <circle cx="42" cy="46" r="11" fill="#ffb648" />
      <path d="M45 82a19 19 0 0 1 2-38 25 25 0 0 1 48 3 17 17 0 0 1-2 34Z" fill="#e9edf5" />
      <path d="M55 63a13 13 0 0 1 11-10 16 16 0 0 1 22 2" stroke="#aab4c8" strokeWidth="3" fill="none" strokeLinecap="round" />
    </S>
  )
}

export function CloudIcon({ className = '' }) {
  return (
    <S className={className}>
      <path d="M36 86a20 20 0 0 1 3-39 26 26 0 0 1 51 3 18 18 0 0 1-3 36Z" fill="#e9edf5" />
      <path d="M46 67a14 14 0 0 1 12-11 18 18 0 0 1 24 2" stroke="#aab4c8" strokeWidth="3" fill="none" strokeLinecap="round" />
    </S>
  )
}

export function FogIcon({ className = '' }) {
  return (
    <S className={className}>
      <path d="M32 50h56" stroke="#d3dbe8" strokeWidth="7" strokeLinecap="round" />
      <path d="M44 68h44" stroke="#d3dbe8" strokeWidth="7" strokeLinecap="round" />
      <path d="M28 84h61" stroke="#d3dbe8" strokeWidth="7" strokeLinecap="round" />
      <circle cx="75" cy="34" r="10" fill="#c4cede" />
      <circle cx="51" cy="28" r="14" fill="#d3dbe8" />
    </S>
  )
}

export function RainIcon({ className = '' }) {
  return (
    <S className={className}>
      <path d="M36 76a20 20 0 0 1 3-38 26 26 0 0 1 51 3 18 18 0 0 1-3 35Z" fill="#dfe6f1" />
      <g stroke="#4f8bff" strokeWidth="5" strokeLinecap="round">
        <path d="M43 86l-5 15" />
        <path d="M60 88l-5 15" />
        <path d="M77 86l-5 15" />
      </g>
    </S>
  )
}

export function DrizzleIcon({ className = '' }) {
  return (
    <S className={className}>
      <path d="M36 70a19 19 0 0 1 3-36 25 25 0 0 1 50 3 18 18 0 0 1-3 33Z" fill="#dfe6f1" />
      <g stroke="#6ab7ff" strokeWidth="4" strokeLinecap="round">
        <path d="M49 80l-3 9" />
        <path d="M62 80l-3 9" />
        <path d="M75 80l-3 9" />
      </g>
    </S>
  )
}

export function SnowIcon({ className = '' }) {
  return (
    <S className={className}>
      <path d="M36 72a19 19 0 0 1 3-36 25 25 0 0 1 50 3 18 18 0 0 1-3 33Z" fill="#edf2f8" />
      <g fill="#9fd8ff">
        <circle cx="47" cy="84" r="3.4" />
        <circle cx="62" cy="90" r="3.4" />
        <circle cx="77" cy="84" r="3.4" />
      </g>
    </S>
  )
}

export function StormIcon({ className = '' }) {
  return (
    <S className={className}>
      <path d="M36 66a20 20 0 0 1 3-38 26 26 0 0 1 51 3 18 18 0 0 1-3 35Z" fill="#cdd6e6" />
      <path d="M57 70l-9 22h11l-4 15 17-28h-12l6-9Z" fill="#ffd45e" />
    </S>
  )
}

export function WeatherIcon({ code, className = '' }) {
  const c = Number(code)
  if (c === 0 || c === 1) return <SunIcon className={className} />
  if (c === 2) return <PartlyIcon className={className} />
  if (c === 3) return <CloudIcon className={className} />
  if (c === 45 || c === 48) return <FogIcon className={className} />
  if (c === 51 || c === 53 || c === 55 || c === 56 || c === 57) return <DrizzleIcon className={className} />
  if (c === 95 || c === 96 || c === 99) return <StormIcon className={className} />
  if (c === 71 || c === 73 || c === 75 || c === 77 || c === 85 || c === 86) return <SnowIcon className={className} />
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(c)) return <RainIcon className={className} />
  return <CloudIcon className={className} />
}

export function WindArrow({ deg = 0 }) {
  return (
    <svg width="44" height="44" viewBox="0 0 48 48" className="windarrow" style={{ transform: `rotate(${deg}deg)` }}>
      <path d="M24 5L35 40L24 31L13 40Z" fill="#86b7ff" stroke="#dff0ff" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M24 9L32 37L24 30L16 37Z" fill="#cfe4ff" />
    </svg>
  )
}

export function SmallIcon({ type = 'wind', ...p }) {
  return <span className={`mini ${type}`} {...p}>{''}</span>
}
