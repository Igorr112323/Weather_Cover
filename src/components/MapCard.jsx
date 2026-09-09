import React, { useEffect, useRef, useState } from 'react'
import L from 'leaflet'

function pinIcon() {
  return L.divIcon({
    className: 'weather-pin',
    html: '<div class="pin-pulse"></div><div class="pin-core"></div>',
    iconSize: [48, 48],
    iconAnchor: [24, 44]
  })
}

export default function MapCard({ location, weather }) {
  const mapRef = useRef(null)
  const leafMap = useRef(null)
  const markerRef = useRef(null)
  const circleRef = useRef(null)
  const [tileError, setTileError] = useState(false)

  useEffect(() => {
    if (!mapRef.current || leafMap.current) return
    const map = L.map(mapRef.current, {
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true
    })
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).on('tileerror', () => setTileError(true)).addTo(map)
    leafMap.current = map
    return () => {
      map.remove()
      leafMap.current = null
    }
  }, [])

  useEffect(() => {
    const map = leafMap.current
    if (!map || !location) return
    const ll = [location.lat, location.lon]
    if (!markerRef.current) {
      markerRef.current = L.marker(ll, { icon: pinIcon() }).addTo(map)
      circleRef.current = L.circle(ll, { radius: 22000, color: '#69a9ff', fillColor: '#69a9ff', fillOpacity: 0.15, opacity: 0.8, weight: 1 }).addTo(map)
    } else {
      markerRef.current.setLatLng(ll)
      circleRef.current.setLatLng(ll)
    }
    map.setView(ll, Math.max(map.getZoom(), 6), { animate: true })
  }, [location])

  const temp = weather?.current?.temperature
  const code = weather?.current?.code
  return (
    <section className="card map-card">
      <div className="card-head">
        <h2>Карта погоды</h2>
        {location && <span className="card-note">{location.city || ''}</span>}
      </div>
      <div className="map-wrap">
        <div ref={mapRef} className="leaflet map" />
        <div className="map-veil" />
        {temp !== undefined && (
          <div className="map-temp">
            <span className="map-icon">{typeof window !== 'undefined' ? '' : ''}</span>
            <strong>{Math.round(temp)}°</strong>
            <span>{location.city || 'точка'}</span>
          </div>
        )}
        {tileError && (
          <div className="map-fallback">Карта не загрузилась офлайн. Откройте приложение с интернетом, чтобы увидеть тайлы.</div>
        )}
      </div>
    </section>
  )
}
