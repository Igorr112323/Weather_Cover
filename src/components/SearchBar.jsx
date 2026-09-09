import React, { useEffect, useRef, useState } from 'react'
import { searchPlaces } from '../api.js'

export default function SearchBar({ onSelect, onLocate }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const boxRef = useRef(null)

  useEffect(() => {
    const onDoc = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      setOpen(false)
      return
    }
    let alive = true
    setLoading(true)
    const id = window.setTimeout(async () => {
      const r = await searchPlaces(query)
      if (!alive) return
      setResults(r)
      setOpen(true)
      setLoading(false)
    }, 250)
    return () => {
      alive = false
      window.clearTimeout(id)
    }
  }, [query])

  const choose = (item) => {
    onSelect(item)
    setQuery(item.city)
    setOpen(false)
    setResults([])
  }

  const submit = (e) => {
    e.preventDefault()
    if (results.length) choose(results[0])
    else if (query.trim()) onSelect({ city: query.trim(), country: '', lat: 55.75, lon: 37.61, guessed: true })
  }

  return (
    <div className="searchbar" ref={boxRef}>
      <form className="search-input" onSubmit={submit}>
        <span className="search-ico">{loading ? <i className="spinner" /> : '⌕'}</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск города…"
          aria-label="Поиск города"
        />
        <button type="submit" className="search-go" title="Найти">→</button>
      </form>
      {open && results.length > 0 && (
        <div className="search-drop">
          {results.map((r, i) => (
            <button key={`${r.lat}-${r.lon}-${i}`} className="search-item" onClick={() => choose(r)}>
              <span className="pin">◉</span>
              <span className="city">{r.city}</span>
              <span className="country">{r.country || r.admin || ''}</span>
            </button>
          ))}
        </div>
      )}
      {open && !loading && query.trim() && results.length === 0 && (
        <div className="search-drop empty">Город не найден. Попробуйте другой запрос.</div>
      )}
      <button className="locate" onClick={onLocate} title="Определить моё местоположение">
        <span className="locate-ico">◎</span>
      </button>
    </div>
  )
}
