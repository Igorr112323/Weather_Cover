/* ============================================================================
   AgroCast 2.5 — desktop.js (вся логика каркаса; без реальных расчётов)
   ES-module. Работает в QtWebEngine (QWebChannel) и в обычном браузере.
   ========================================================================== */
"use strict";

/* ---------------------------------- константы ---------------------------- */
const VERSION = "2.5";
const REGION_NAME = "Краснодарский край";
const REGION_BOUNDS = [[43.2, 36.1], [47.3, 42.4]];   // [ [lat,lon],[lat,lon] ]
const KRAI_RECT = [[44.0, 37.0], [46.5, 40.5]];
const YMAPS_CENTER = [45.3, 39.0];
const YMAPS_ZOOM = 8;
const YMAPS_KEY = "";                                  // при необходимости: 'ваш-ключ'
const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const LS_REPORTS = "ac_reports_v25";
const LS_DOWNLOADS = "ac_downloads_v25";
const LS_SEL = "ac_selection_v25";
const MONTHS_RU = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август",
                   "Сентябрь","Октябрь","Ноябрь","Декабрь"];
const MARKER_URL = (c) => `/assets/markers/marker-${c}.svg`;

/* ---------------------------------- состояние ---------------------------- */
const state = {
  mapApi: null,          // 'yandex' | 'leaflet'
  yandexMap: null,
  leafletMap: null,
  leafletTiles: null,
  grid: [],              // клетки из /api/region/grid
  crops: [],             // сорта из /api/local/crops
  markers: {},           // id -> объект маркера
  selected: null,        // выбранный id точки
  hovered: null,
  running: false,
  abortCtrl: null,
  reports: [],
  downloads: [],
  bridge: null,
  mapReady: false,
};

/* ---------------------------------- helpers ------------------------------ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`.trim();
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, 2800);
  setTimeout(() => t.remove(), 3200);
}
function uiConfirm(text) {
  return new Promise((resolve) => {
    const m = $("#confirmModal");
    $("#confirmText").textContent = text;
    m.classList.remove("hidden");
    const close = (val) => { m.classList.add("hidden"); $("#confirmOk").onclick = null; $("#confirmNo").onclick = null; resolve(val); };
    $("#confirmOk").onclick = () => close(true);
    $("#confirmNo").onclick = () => close(false);
  });
}
function fmt1(v) { return (Math.round((v ?? 0) * 10) / 10).toLocaleString("ru-RU"); }
function fmt0(v) { return Math.round(v ?? 0).toLocaleString("ru-RU"); }
function pad2(n) { return String(n).padStart(2, "0"); }
function dateRu(d = new Date()) {
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}
function nowRu() {
  const d = new Date();
  return `${dateRu(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function monthLabel(ym) {                       // "2026-03" -> "Март 2026"
  if (!ym) return "";
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS_RU[m - 1]} ${y}`;
}
function monthRuShort(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS_RU[m - 1].slice(0, 3)} ${String(y).slice(2)}`;
}
function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const dt = new Date(y, m - 1 + n, 1);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`;
}
function loadLS(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }
  catch { return fallback; }
}
function saveLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371e3, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function nearestGridPoint(lat, lon) {
  let best = null, bd = Infinity;
  for (const c of state.grid) {
    const d = haversineM(lat, lon, c.lat, c.lon);
    if (d < bd) { bd = d; best = c; }
  }
  return { cell: best, dist: bd };
}
function km(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(1)} км` : `${Math.round(v)} м`;
}

/* ------------------------------- мост (QtWebEngine) ---------------------- */
function setupBridge() {
  try {
    if (window.qt && window.qt.webChannelTransport && window.QWebChannel) {
      const channel = new QWebChannel(window.qt.webChannelTransport, (ch) => {
        state.bridge = ch.objects.bridge;
        state.bridge.info((s) => {
          try { console.log("[agrocast] bridge:", JSON.parse(s)); } catch {}
        });
      });
    }
  } catch (e) { console.warn("QWebChannel недоступен — браузерный режим", e); }
}
function bridgeSaveText(name, text) {
  return new Promise((resolve) => {
    if (!state.bridge || !state.bridge.saveTextFile) return resolve(null);
    try { state.bridge.saveTextFile(name, text, (p) => resolve(p || null)); }
    catch { resolve(null); }
  });
}

/* ---------------------------------- сплеш -------------------------------- */
function bootSplash() {
  const el = $("#bootSplash"), fill = $("#bootFill"), step = $("#bootStep");
  if (!el) return;
  const steps = [
    "Стартуем AgroCast…",
    "Читаем справочник сортов…",
    "Готовим Яндекс.Карту…",
    "Проверяем точки сетки…",
  ];
  let si = 0;
  if (step) step.textContent = steps[0];
  const stepTimer = setInterval(() => {
    si = Math.min(si + 1, steps.length - 1);
    if (step) step.textContent = steps[si];
    if (si === steps.length - 1) clearInterval(stepTimer);
  }, 340);

  const t0 = performance.now();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(stepTimer);
    if (step) step.textContent = "Всё готово ✓";
    el.classList.add("splash-done");
    setTimeout(() => el.remove(), 650);
  };
  const grow = () => {
    const p = Math.min(100, ((performance.now() - t0) / 1350) * 100);
    if (fill) fill.style.width = p + "%";
    if (p < 100) requestAnimationFrame(grow);
    else finish();
  };
  requestAnimationFrame(grow);
  // страховка: сплеш не должен «зависнуть» дольше 2.2 с
  setTimeout(finish, 2200);
}

/* ---------------------------------- API ---------------------------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

/* ---------------------------------- селекты ------------------------------ */
function fillSelects() {
  const selP = $("#point"), selC = $("#crop");
  selP.innerHTML = "";
  state.grid.forEach((c, i) => {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = `${c.id} · ${c.name}`;
    o.dataset.lat = c.lat; o.dataset.lon = c.lon;
    selP.appendChild(o);
  });
  selC.innerHTML = '<option value="">— выберите сорт —</option>';
  state.crops.forEach((c) => {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name;
    selC.appendChild(o);
  });
  // восстановление последнего выбора
  const saved = loadLS(LS_SEL, {});
  if (saved.point && [...selP.options].some((o) => o.value === saved.point)) selP.value = saved.point;
  if (saved.crop && [...selC.options].some((o) => o.value === saved.crop)) selC.value = saved.crop;
  // если сортов нет вообще — первый станет выбранным после загрузки; здесь просто подскажем
  if (!selC.value && state.crops.length) selC.value = state.crops[0].id;
  if (!selP.value && state.grid.length) selP.value = state.grid[0].id;
}
function persistSelection() {
  saveLS(LS_SEL, {
    point: $("#point").value || state.selected,
    crop: $("#crop").value,
    issue: $("#issue").value || currentMonth(),
    horizon: $("#horizon").value || "3",
  });
}
function syncSegHorizon() {
  const v = $("#horizon").value;
  $$("#segHorizon .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
}

/* ---------------------------------- карта -------------------------------- */
function cellById(id) { return state.grid.find((c) => c.id === id); }

function mapBaseState(id) { return (id === state.selected) ? "red" : "green"; }

function setCoordChip(id) {
  const c = cellById(id);
  const chip = $("#coordChip");
  if (c) chip.textContent = `${c.id} · ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}`;
  else chip.textContent = "P– · —";
  const info = $("#selInfo");
  if (c) {
    const prev = state.selected ? cellById(state.selected) : null;
    info.textContent = prev && prev.id !== c.id
      ? `Выбрано: ${c.id} ${c.name} · ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)} (клик — ближайшая к указанному месту)`
      : `Выбрано: ${c.id} ${c.name} · ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}`;
    info.classList.remove("flash");
    void info.offsetWidth; // перезапуск CSS-анимации
    info.classList.add("flash");
    setTimeout(() => info.classList.remove("flash"), 900);
  }
}

function selectPoint(id, opts = {}) {  if (!cellById(id)) return;
  const prev = state.selected;
  state.selected = id;
  setCoordChip(id);
  $("#point").value = id;
  persistSelection();
  // обновляем цвета маркеров
  if (prev && state.markers[prev]) setMarkerState(prev, mapBaseState(prev));
  if (state.markers[id]) setMarkerState(id, "red");
  // сместим центр, если просили
  if (opts.pan !== false) {
    const c = cellById(id);
    if (state.yandexMap) state.yandexMap.panTo([c.lat, c.lon], { duration: 300 });
    else if (state.leafletMap) state.leafletMap.panTo([c.lat, c.lon]);
  }
  if (opts.toast) {
    const c = cellById(id);
    toast(`Выбрана точка ${c.id} ${c.name} — ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}`, "ok");
  }
}

/* --- Яндекс.Карта --- */
function placemarkIcon(color) {
  const href = MARKER_URL(color);
  return {
    iconLayout: "default#image",
    iconImageHref: href,
    iconImageSize: [36, 48],
    iconImageOffset: [-18, -47],
  };
}
function makeYandexMarker(c, color) {
  const pm = new ymaps.Placemark(
    [c.lat, c.lon],
    {
      balloonContentBody:
        `<b>${esc(c.id)}</b> · ${esc(c.name)}<br>` +
        `координаты: ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}<br>` +
        `<span style="font-size:11px;color:#5a6e5d">кликните, чтобы выбрать</span>`,
    },
    placemarkIcon(color || mapBaseState(c.id))
  );
  pm.events.add("click", (e) => {
    e.stopPropagation();
    selectPoint(c.id, { toast: true });
    pm.balloon.open();
  });
  pm.events.add("mouseenter", () => { if (state.hovered !== c.id) { state.hovered = c.id; if (state.markers[c.id]) setMarkerState(c.id, "yellow"); } });
  pm.events.add("mouseleave", () => {
    if (state.hovered === c.id) { state.hovered = null; if (state.markers[c.id]) setMarkerState(c.id, mapBaseState(c.id)); }
  });
  return pm;
}
function setMarkerState(id, color) {
  if (!state.markers[id]) return;
  const old = state.markers[id];
  const c = cellById(id);
  if (old.pm) state.yandexMap.geoObjects.remove(old.pm);
  const pm = makeYandexMarker(c, color);
  state.yandexMap.geoObjects.add(pm);
  state.markers[id] = { pm, color };
}
function handleMapClick(lat, lon) {
  const { cell, dist } = nearestGridPoint(lat, lon);
  if (!cell) return;
  selectPoint(cell.id, { pan: false });
  if (dist > 60000) toast(`Клик далеко от точек — выбрана ближайшая ${cell.id} (${km(dist)})`);
  else toast(`Выбрана ближайшая точка ${cell.id} · ${km(dist)} от клика`, "ok");
}
function initYandexMap() {
  const myMap = new ymaps.Map(
    $("#map"),
    { center: YMAPS_CENTER, zoom: YMAPS_ZOOM, controls: ["zoomControl", "typeSelector", "fullscreenControl"] },
    { suppressMapOpenBlock: true }
  );
  const krai = new ymaps.Rectangle(KRAI_RECT, {}, {
    fillColor: "#1c6b3c33", strokeColor: "#1c6b3c", strokeWidth: 2, cursor: "default",
  });
  myMap.geoObjects.add(krai);
  const mapClick = (e) => handleMapClick(e.get("coords")[0], e.get("coords")[1]);
  myMap.events.add("click", mapClick);
  krai.events.add("click", mapClick);
  state.yandexMap = myMap;
  state.mapReady = true;
  state.grid.forEach((c) => {
    const pm = makeYandexMarker(c);
    myMap.geoObjects.add(pm);
    state.markers[c.id] = { pm, color: "green" };
  });
  try { myMap.setBounds(REGION_BOUNDS, { checkZoomRange: true, zoomMargin: 48 }); } catch {}
  state.mapApi = "yandex";
  $("#mapMode").textContent = "Яндекс.Карта";
  $("#mapMode").title = "Основная карта — Яндекс.Карты (при недоступности включается Leaflet OSM)";
  hideMapEmpty();
}

/* --- Leaflet (fallback) --- */
function leafletReady() {
  return new Promise((resolve) => {
    if (window.L) return resolve(true);
    const t0 = Date.now();
    const poll = () => {
      if (window.L) resolve(true);
      else if (Date.now() - t0 > 8000) resolve(false);
      else setTimeout(poll, 60);
    };
    poll();
  });
}
function markerIconLeaflet(color) {
  return L.icon({
    iconUrl: MARKER_URL(color),
    iconSize: [36, 48],
    iconAnchor: [18, 46],
    popupAnchor: [0, -44],
  });
}
function makeLeafletMarker(c) {
  const m = L.marker([c.lat, c.lon], { icon: markerIconLeaflet(mapBaseState(c.id)), zIndexOffset: c.id === state.selected ? 400 : 0 })
    .addTo(state.leafletMap);
  m.bindTooltip(`${c.id} · ${c.name}`, { direction: "top", offset: [0, -40], opacity: 0.95 });
  m.on("click", () => selectPoint(c.id, { toast: true, pan: false }));
  m.on("mouseover", () => { state.hovered = c.id; if (state.markers[c.id]) setLeafletState(c.id, "yellow"); });
  m.on("mouseout", () => { if (state.hovered === c.id) { state.hovered = null; if (state.markers[c.id]) setLeafletState(c.id, mapBaseState(c.id)); } });
  return m;
}
function setLeafletState(id, color) {
  const mk = state.markers[id];
  if (mk) mk.m.setIcon(markerIconLeaflet(color));
}
function initLeafletMap() {
  const mapEl = $("#map");
  mapEl.innerHTML = "";
  mapEl.appendChild(chipsMarkup());
  const map = L.map(mapEl, { zoomControl: true, minZoom: 6, maxZoom: 12 })
    .setView([45.3, 39.0], 7);
  const krai = L.rectangle(REGION_BOUNDS, {
    color: "#1c6b3c", weight: 2, fillColor: "#1c6b3c", fillOpacity: 0.10, dashArray: "6 4",
  }).addTo(map);
  krai.on("click", (e) => handleMapClick(e.latlng.lat, e.latlng.lng));
  const tiles = L.tileLayer(OSM_TILE_URL, {
    maxZoom: 12, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  tiles.on("tileerror", () => {
    // сеть недоступна — убираем тайлы, оставляем узор + маркеры + полигон
    try { tiles.remove(); } catch {}
    state.leafletTiles = null;
    $("#mapMode").textContent = "Leaflet · офлайн-фон";
    toast("Тайлы OSM недоступны — карта показывает сетку и точки", "");
  });
  state.leafletMap = map;
  state.leafletTiles = tiles;
  map.on("click", (e) => {
    const { cell, dist } = nearestGridPoint(e.latlng.lat, e.latlng.lng);
    if (!cell) return;
    selectPoint(cell.id, { pan: false });
    if (dist > 60000) toast(`Клик далеко от точек — выбрана ближайшая ${cell.id} (${km(dist)})`);
    else toast(`Выбрана ближайшая точка ${cell.id} · ${km(dist)} от клика`, "ok");
  });
  state.grid.forEach((c) => { state.markers[c.id] = { m: makeLeafletMarker(c) }; });
  state.mapReady = true;
  const cells = state.grid;
  if (cells.length) {
    try {
      map.fitBounds(L.latLngBounds(cells.map((c) => [c.lat, c.lon])).pad(0.25), { maxZoom: 9 });
    } catch {}
  } else {
    map.fitBounds(REGION_BOUNDS);
  }
  state.mapApi = "leaflet";
  $("#mapMode").textContent = "Leaflet OSM";
  if (state.selected) setCoordChip(state.selected);
  hideMapEmpty();
}
function chipsMarkup() {
  const wrap = document.createElement("div");
  wrap.className = "map-chips";
  wrap.innerHTML =
    '<span class="chip" id="mapMode">Leaflet OSM</span>' +
    '<span class="chip coords" id="coordChip">P– · —</span>';
  return wrap;
}
function hideMapEmpty() {
  const em = $("#mapEmpty");
  if (em) em.remove();
}
function waitYandex(ms = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const poll = () => {
      if (window.ymaps) {
        try { ymaps.ready(() => resolve(true)); } catch { resolve(false); }
        return;
      }
      if (Date.now() - t0 > ms) resolve(false);
      else setTimeout(poll, 70);
    };
    poll();
  });
}
async function initMap() {
  if (!state.grid.length) {
    $("#mapEmpty").textContent = "Сетка точек не загрузилась — проверьте API";
    return;
  }
  const yandexOk = await waitYandex(3000);
  if (!yandexOk) {
    console.warn("[agrocast] Яндекс.Карты не загрузились за 3 с — Leaflet OSM");
    $("#mapMode").textContent = "Leaflet OSM";
    await leafletReady();
    try { initLeafletMap(); } catch (e) { console.error(e); toast("Карта недоступна: " + e.message, "err"); }
    return;
  }
  try { initYandexMap(); }
  catch (err) {
    console.warn("[agrocast] Яндекс.Карта не поднялась, fallback Leaflet:", err);
    await leafletReady();
    try { initLeafletMap(); } catch (e2) { console.error(e2); toast("Карта недоступна: " + e2.message, "err"); }
  }
}

/* ---------------------------------- сорта -------------------------------- */
function cropSub(c) {
  const parts = [];
  if (c.fao != null) parts.push(`ФАО ${c.fao}`);
  if (c.sat != null) parts.push(`САТ ${fmt0(c.sat)}°`);
  if (c.veg_days != null) parts.push(`${c.veg_days} дн`);
  if (c.breeder) parts.push(c.breeder);
  return parts.join(" · ");
}
function pickCrop(c) {
  $("#crop").value = c.id;
  persistSelection();
  markActiveCrop();
  toast(`В прогнозе: ${c.name}`, "ok");
}
function renderCrops() {
  const list = $("#cropsList");
  list.innerHTML = "";
  const sel = $("#crop").value;
  state.crops.forEach((c) => {
    const row = document.createElement("div");
    row.className = "crop-item" + (c.id === sel ? " active" : "");
    row.innerHTML =
      `<div class="crop-main">
         <div class="crop-name">${esc(c.name)}</div>
         <div class="crop-sub">${esc(cropSub(c))}</div>
       </div>
       <div class="crop-actions">
         <button class="btn primary sm" data-act="pick" title="Использовать в прогнозе">✓ В прогноз</button>
         <button class="btn ghost sm" data-act="edit" title="Изменить сорт">✎</button>
         <button class="btn ghost sm danger" data-act="del" title="Удалить сорт">✕</button>
       </div>`;
    row.dataset.id = c.id;
    row.querySelector('[data-act="pick"]').onclick = (e) => { e.stopPropagation(); pickCrop(c); };
    row.querySelector('[data-act="edit"]').onclick = (e) => { e.stopPropagation(); openCropForm(c); };
    row.querySelector('[data-act="del"]').onclick = (e) => { e.stopPropagation(); deleteCrop(c); };
    row.addEventListener("click", () => pickCrop(c));
    list.appendChild(row);
  });
  if (!state.crops.length) {
    list.innerHTML = '<div class="empty-state">База сортов пуста — добавьте первый сорт кнопкой «＋ Добавить сорт»</div>';
  }
}
function markActiveCrop() {
  const sel = $("#crop").value;
  $$("#cropsList .crop-item").forEach((r) => {
    r.classList.toggle("active", r.dataset.id === sel);
  });
}
function openCropForm(c = null) {
  const wrap = $("#cropFormWrap");
  $("#cropId").value = c?.id || "";
  $("#fName").value = c?.name || "";
  $("#fBreeder").value = c?.breeder || "";
  $("#fFao").value = c?.fao ?? "";
  $("#fSat").value = c?.sat ?? "";
  $("#fVeg").value = c?.veg_days ?? "";
  $("#fYield").value = c?.yield_t_ha ?? "";
  $("#fFrostTol").value = c?.frost_tolerable_c ?? -2;
  $("#fFrostLeth").value = c?.frost_lethal_c ?? -3;
  $("#fSowFrom").value = c?.sow_from || "";
  $("#fSowTo").value = c?.sow_to || "";
  $("#fNotes").value = c?.notes || "";
  const title = $("#cropFormTitle");
  if (title) title.textContent = c ? `✎ Редактирование: ${c.name}` : "＋ Новый сорт";
  $("#cropFormMsg").textContent = "";
  wrap.classList.remove("hidden");
  wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("#fName").focus();
}
function clearCropForm() {
  ["cropId","fName","fBreeder","fFao","fSat","fVeg","fYield","fFrostTol","fFrostLeth","fSowFrom","fSowTo","fNotes"]
    .forEach((id) => { $("#" + id).value = ""; });
  $("#fFrostTol").value = -2; $("#fFrostLeth").value = -3;
  $("#cropFormMsg").textContent = "";
  const title = $("#cropFormTitle");
  if (title) title.textContent = "＋ Новый сорт";
}
async function deleteCrop(c) {
  const ok = await uiConfirm(`Удалить сорт «${c.name}» из базы?`);
  if (!ok) return;
  try {
    const r = await api(`/api/local/crops/${encodeURIComponent(c.id)}`, { method: "DELETE" });
    toast(`Сорт «${c.name}» удалён`, "ok");
    if ($("#crop").value === c.id) $("#crop").value = "";
    await reloadCrops();
  } catch (e) { toast(`Ошибка удаления: ${e.message}`, "err"); }
}
async function reloadCrops() {
  const data = await api("/api/local/crops");
  state.crops = data.crops || [];
  // аккуратно обновляем select, не теряя выбранный сорт
  const cur = $("#crop").value;
  const selC = $("#crop");
  selC.innerHTML = '<option value="">— выберите сорт —</option>';
  state.crops.forEach((c) => {
    const o = document.createElement("option");
    o.value = c.id; o.textContent = c.name; selC.appendChild(o);
  });
  if (state.crops.some((c) => c.id === cur)) selC.value = cur;
  renderCrops();
  return data;
}
async function saveCrop(ev) {
  ev.preventDefault();
  const msg = $("#cropFormMsg");
  const name = $("#fName").value.trim();
  if (!name) { msg.textContent = "Укажите название сорта"; return; }
  if (name.length > 120) { msg.textContent = "Название длиннее 120 символов"; return; }
  const num = (id, lo, hi, label) => {
    const v = $("#" + id).value;
    if (v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${label}: вне диапазона ${lo}..${hi}`);
    return n;
  };
  let payload;
  try {
    const sowFrom = $("#fSowFrom").value.trim();
    const sowTo = $("#fSowTo").value.trim();
    if (sowFrom && !/^\d{2}-\d{2}$/.test(sowFrom)) throw new Error("«Сев с»: формат ММ-ДД (например 04-10)");
    if (sowTo && !/^\d{2}-\d{2}$/.test(sowTo)) throw new Error("«Сев по»: формат ММ-ДД (например 04-30)");
    payload = {
      id: $("#cropId").value || null,
      name,
      breeder: $("#fBreeder").value.trim(),
      fao: num("fFao", 50, 650, "ФАО"),
      sat: num("fSat", 1500, 3500, "САТ"),
      veg_days: num("fVeg", 60, 200, "Вегетация"),
      yield_t_ha: num("fYield", 0.1, 30, "Урожай"),
      frost_tolerable_c: num("fFrostTol", -8, 0, "Мороз переносимый"),
      frost_lethal_c: num("fFrostLeth", -8, 0, "Гибель"),
      sow_from: sowFrom || null,
      sow_to: sowTo || null,
      notes: $("#fNotes").value.trim(),
    };
  } catch (e) { msg.textContent = e.message; return; }
  msg.textContent = "Сохранение…";
  try {
    const r = await api("/api/local/crops/save", { method: "POST", body: JSON.stringify(payload) });
    msg.textContent = "";
    toast(`Сорт «${r.crop.name}» сохранён (${r.saved === "created" ? "создан" : "обновлён"})`, "ok");
    clearCropForm();
    await reloadCrops();
    if ($("#crop").value !== r.crop.id) { $("#crop").value = r.crop.id; persistSelection(); renderCrops(); }
  } catch (e) { msg.textContent = `Ошибка: ${e.message}`; }
}

/* ------------------------------ скачанные данные ------------------------- */
function dlCardHtml(d) {
  const statusCls = d.status === "ready" ? "ready" : d.status === "doing" ? "doing" : "wait";
  const statusTxt = d.status === "ready" ? "готово" : d.status === "doing" ? "скачивается…" : "в очереди";
  return `<div class="dl-card" data-id="${esc(d.id)}">
    <div class="dl-ico">📦</div>
    <div class="dl-main">
      <div class="dl-title">${esc(d.kind)}</div>
      <div class="dl-meta">${esc(d.years || "")}${d.point ? " · Точка " + esc(d.point) : ""}${d.size ? " · " + esc(d.size) : ""} · ${dateRu(new Date(d.date || Date.now()))}</div>
      <div class="progress" style="margin-top:6px"><div class="fill" style="width:${Math.round(d.pct || 0)}%"></div></div>
    </div>
    <div class="dl-right">
      <span class="status-chip ${statusCls}">${statusTxt}</span>
    </div>
  </div>`;
}
function renderDownloads() {
  const list = $("#downloadList");
  if (!state.downloads.length) {
    list.innerHTML = '<div class="empty-state">Пока ничего не скачано — нажмите «▶ Показать прогноз»</div>';
    return;
  }
  list.innerHTML = state.downloads.map(dlCardHtml).join("");
}
function noteDownloaded(pointId) {
  // появляется вкладка «Скачанные данные»
  const btn = $("#tabBtnData");
  btn.classList.remove("hidden");
  btn.classList.add("active-new"); // лёгкое привлечение внимания
  const tpl = [
    { kind: "CPC daily 1979-2024", years: "1979–2024", size: "45 МБ" },
    { kind: "Почва NCEP", size: "12 МБ" },
    { kind: "ERA5 поля", size: "180 МБ" },
    { kind: "Модели блендера", size: "—" },
  ];
  const now = Date.now();
  const ids = tpl.map((t, i) => {
    const d = { id: `dl_${now}_${i}`, kind: t.kind, years: t.years, size: t.size, point: pointId, status: "doing", pct: 0, date: now };
    state.downloads.unshift(d);
    return d;
  });
  saveLS(LS_DOWNLOADS, state.downloads);
  renderDownloads();
  switchTab("tab-data");
  // прогресс ~0.9 c, потом «готово»
  const t0 = performance.now();
  const anim = () => {
    const p = Math.min(100, ((performance.now() - t0) / 900) * 100);
    ids.forEach((d, i) => { d.pct = Math.max(d.pct, Math.min(100, p - i * 9)); });
    renderDownloads();
    if (p < 100) requestAnimationFrame(anim);
    else {
      ids.forEach((d) => { d.pct = 100; d.status = "ready"; });
      saveLS(LS_DOWNLOADS, state.downloads);
      renderDownloads();
    }
  };
  requestAnimationFrame(anim);
  setTimeout(() => btn.classList.remove("active-new"), 2600);
}

/* ---------------------------------- отчёты ------------------------------- */
function tbarHtml(vals, aboveClass, unit) {
  const total = (vals.below + vals.normal + vals.above) || 1;
  const seg = (key, cls, label) => {
    const w = Math.round((vals[key] / total) * 1000) / 10;
    if (w <= 0.5) return "";
    const txt = w >= 9 ? `${Math.round(vals[key] * 100)}%` : "";
    return `<div class="seg ${cls}" style="width:${w}%" title="${label}: ${Math.round(vals[key] * 100)}%"><span class="lbl">${txt}</span></div>`;
  };
  return `<div class="tbar" aria-hidden="false">
      ${seg("below", "below", "ниже нормы")}
      ${seg("normal", "normal", "норма")}
      ${seg("above", aboveClass, "выше нормы")}
    </div>`;
}
function seasonCardHtml(s, idx) {
  const t = s.t2m || {}, tp = s.tp || {};
  const tq = t.quantiles_c || {}, tpQ = tp.quantiles_mm || {};
  const tT = t.tercile_probs || { below: 0.2, normal: 0.5, above: 0.3 };
  const pT = tp.tercile_probs || { below: 0.2, normal: 0.5, above: 0.3 };
  const months = (s.months || []).map(monthLabel).join(", ");
  return `<div class="season-card">
    <div class="s-title">🌡 ${esc(months || "—")}</div>
    <div class="var-row">
      <div class="v-name"><span>Температура</span><span>${fmt1(tq.p10)} / ${fmt1(tq.p50)} / ${fmt1(tq.p90)} °C</span></div>
      ${tbarHtml(tT, "above-temp", "ниже/норма/выше")}
    </div>
    <div class="var-row">
      <div class="v-name"><span>Осадки</span><span>${fmt1(tpQ.p10)} / ${fmt1(tpQ.p50)} / ${fmt1(tpQ.p90)} мм</span></div>
      ${tbarHtml(pT, "above-precip", "ниже/норма/выше")}
    </div>
  </div>`;
}
function wtdHtml(list) {
  if (!list || !list.length) return '<div class="empty-state">Рекомендаций нет (мок)</div>';
  return `<div class="wtd">${list.map((w) => `
    <div class="wtd-card ${w.level === "ok" ? "ok" : w.level === "warn" ? "gold" : "info"}">
      <div class="a">${esc(w.action || "")}</div>
      <div class="r">${esc(w.reason || "")}</div>
    </div>`).join("")}</div>`;
}
function kvRow(k, v) { return `<div class="kv-row"><span class="k">${esc(k)}</span><span>${v}</span></div>`; }
function tableHtml(headers, rows) {
  return `<table class="data"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i > 0 ? "num" : ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function reportHtml(r) {
  const p = r.payload || {};
  const ins = p.agro?.insight || {};
  const water = ins.water || {};
  const frost = ins.frost || {};
  const seasons = p.seasons || [];
  const wtd = p.agro?.what_to_do || [];
  const gddCrops = ins.sat?.gdd?.crops || [];
  const pheno = p.agro?.phenology?.crops || [];
  const risks = ins.risks || [];
  const issueLabel = monthLabel(p.start || r.issue);
  const spanLabel = (p.seasons || []).map((s) => (s.months || [])[0]).filter(Boolean);
  const horizonTxt = spanLabel.length
    ? `${r.horizon} мес · ${monthRuShort(spanLabel[0])}–${monthRuShort(spanLabel[spanLabel.length - 1])}`
    : `${r.horizon} мес`;
  // заморозки: дополним из снапшота сорта
  let frostRows = [
    [`Окно вероятных заморозков`, frost.span ? `${esc(frost.span[0])} … ${esc(frost.span[1])}` : "—"],
    [`P(заморозок после окна)`, frost.p_frost_any != null ? `${Math.round(frost.p_frost_any * 100)}%` : "—"],
  ];
  if (r.crop) {
    if (r.crop.frost_tolerable_c != null) frostRows.push([`Повреждения при`, `${fmt1(r.crop.frost_tolerable_c)} °C`]);
    if (r.crop.frost_lethal_c != null) frostRows.push([`Гибель при`, `${fmt1(r.crop.frost_lethal_c)} °C`]);
  }
  const satRows = gddCrops.map((g) => [
    esc(g.name || r.cropName || "—"),
    g.fao != null ? g.fao : "—",
    g.need_gdd != null ? fmt0(g.need_gdd) : "—",
    g.p_enough != null ? `${Math.round(g.p_enough * 100)}%` : "—",
  ]);
  const phenoRows = pheno.flatMap((c) =>
    (c.phases || []).map((ph) => [esc(c.name), esc(ph.phase), esc(ph.window), esc(ph.note)])
  );
  const riskChips = risks.map((x) =>
    `<span class="risk-chip ${esc(x.level || "low")}">${esc(x.risk)} · p≈${Math.round((x.p ?? 0) * 100)}%</span>`
  ).join("") || '<span class="muted">Риски не выделены (мок)</span>';

  return `<div class="report-card" id="report-${esc(r.rid)}">
    <div class="report-head">
      <h2>🌾 Прогноз · ${esc(r.pointId)} · ${esc(issueLabel)} · ${esc(r.cropName || "—")}</h2>
      <div class="sub">${esc(r.pointName || "")} · ${esc(REGION_NAME)} · AgroCast ${esc(r.appVersion || VERSION)}</div>
      <div class="report-ts">сформирован ${esc(r.createdAt)} · каркас-мок: данные демонстрационные, расчёты не выполнялись</div>
    </div>

    <div class="kvTable">
      ${kvRow("Точка", `${esc(r.pointId)} · ${esc(r.pointName || "—")}`)}
      ${kvRow("Координаты", `${Number(p.lat ?? 0).toFixed(3)}, ${Number(p.lon ?? 0).toFixed(3)}`)}
      ${kvRow("Выпуск", issueLabel)}
      ${kvRow("Горизонт", horizonTxt)}
      ${kvRow("Сорт", esc(r.cropName || "—"))}
    </div>

    <div class="r-section">
      <h3>📅 Сезонный прогноз</h3>
      <div class="legend">
        <span class="li"><span class="sw below"></span>ниже нормы</span>
        <span class="li"><span class="sw normal"></span>норма</span>
        <span class="li"><span class="sw above"></span>осадки выше</span>
        <span class="li"><span class="sw abovet"></span>температура выше</span>
      </div>
      <div class="seasons-grid">${seasons.map(seasonCardHtml).join("") || '<div class="empty-state">Сезонов нет</div>'}</div>
    </div>

    <div class="r-section">
      <h3>✅ Что делать (топ-3)</h3>
      ${wtdHtml(wtd)}
    </div>

    <div class="r-section">
      <h3>💧 Вода</h3>
      ${tableHtml(["Показатель", "Значение"], [
        ["ET0, мм", `${fmt1(water.et0_mm?.p50)}`],
        ["Осадки, мм", `${fmt1(water.precip_mm?.p50)}`],
        ["Дефицит влаги, мм", `${fmt1(water.deficit_mm)}`],
        ["Полив, м³/га (p50)", fmt0(water.irrigation_m3_ha?.p50)],
        ["Полив, м³/га (p10)", fmt0(water.irrigation_m3_ha?.p10)],
      ])}
    </div>

    <div class="r-section">
      <h3>🌡 САТ (сумма активных температур)</h3>
      ${satRows.length
        ? tableHtml(["Сорт", "ФАО", "Потребность САТ, °", "P(хватит)"], satRows)
        : '<div class="empty-state">Нет данных по сортам</div>'}
    </div>

    <div class="r-section">
      <h3>❄ Заморозки</h3>
      ${tableHtml(["Параметр", "Значение"], frostRows)}
    </div>

    <div class="r-section">
      <h3>⚠ Риски</h3>
      <div>${riskChips}</div>
    </div>

    <div class="r-section">
      <h3>🌱 Фенология</h3>
      ${phenoRows.length
        ? tableHtml(["Сорт", "Фаза", "Окно", "Примечание"], phenoRows)
        : '<div class="empty-state">Фенология появится после выбора сорта (мок)</div>'}
    </div>

    <div class="report-ts" style="border-top:1px solid var(--line);padding-top:8px">
      AgroCast ${esc(r.appVersion || VERSION)} · каркас без реальных расчётов · ${esc(r.rid)}
    </div>
  </div>`;
}
function renderReports() {
  const list = $("#reportsList");
  $("#reportsCount").textContent = state.reports.length;
  if (!state.reports.length) {
    list.innerHTML = '<div class="empty-state">Отчётов пока нет — нажмите «▶ Показать прогноз»</div>';
    $("#btnClearReports").classList.add("hidden");
    return;
  }
  list.innerHTML = state.reports.map((r) => {
    const html = reportHtml(r);
    const title = `${r.pointId} · ${monthLabel(r.issue)} · ${esc(r.cropName || "—")}`;
    return `<div class="report-wrap">
      <div class="report-actions">
        <button class="btn ghost sm" data-p="${esc(r.rid)}" data-act="print-this" title="Печать в PDF">🖨 Печать PDF</button>
        <button class="btn ghost sm" data-p="${esc(r.rid)}" data-act="json-this" title="Экспорт отчёта в JSON">⇩ JSON</button>
        <button class="btn ghost sm danger" data-p="${esc(r.rid)}" data-act="del-report" title="Удалить из архива">✕</button>
        <span class="report-date">${esc(r.createdAt)}</span>
      </div>
      ${html}
    </div>`;
  }).join("");
  $("#btnClearReports").classList.remove("hidden");
  // действия у каждого отчёта
  $$("#reportsList [data-act]").forEach((b) => {
    b.onclick = () => {
      const r = state.reports.find((x) => x.rid === b.dataset.p);
      if (!r) return;
      if (b.dataset.act === "print-this") printReport(r);
      else if (b.dataset.act === "json-this") exportReportJson(r);
      else if (b.dataset.act === "del-report") deleteReport(r);
    };
  });
}
async function deleteReport(r) {
  const ok = await uiConfirm(`Удалить отчёт «${r.pointId} · ${monthLabel(r.issue)}${r.cropName ? " · " + r.cropName : ""}» из архива?`);
  if (!ok) return;
  state.reports = state.reports.filter((x) => x.rid !== r.rid);
  saveLS(LS_REPORTS, state.reports);
  renderReports();
  toast("Отчёт удалён");
}
function addReport(report) {
  state.reports.unshift(report);
  // архив ограничим 60 отчётами
  if (state.reports.length > 60) state.reports.length = 60;
  saveLS(LS_REPORTS, state.reports);
  renderReports();
}
function flashReport(rid) {
  const el = $(`#report-${rid}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 2000);
}

/* ------------------------------ формирование отчёта ---------------------- */
function buildReport(payload, cropSnap, elapsed) {
  const c = cellById(payload.point_id);
  const rid = `r${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return {
    rid,
    appVersion: VERSION,
    pointId: payload.point_id,
    pointName: payload.point_name || c?.name || payload.point_id,
    issue: payload.start,
    horizon: payload.horizon_months || 3,
    cropId: payload.crop_id,
    cropName: payload.crop_name || (cropSnap?.name ?? "—"),
    crop: cropSnap || null,
    lat: payload.lat, lon: payload.lon,
    payload,
    elapsed,
    createdAt: nowRu(),
    ts: Date.now(),
  };
}

/* ---------------------------------- прогноз ------------------------------ */
function startElapsed(statusEl) {
  const t0 = Date.now();
  statusEl.dataset.elapsed = String(t0);
  const upd = () => {
    if (state.running) statusEl.textContent = `Расчёт: ${Math.max(1, Math.round((Date.now() - t0) / 1000))}с…`;
  };
  upd();
  return setInterval(upd, 100);
}
async function runForecast() {
  if (state.running) return;
  const issue = $("#issue").value;
  const horizon = Number($("#horizon").value);
  const pointId = $("#point").value;
  const cropId = $("#crop").value || null;
  const statusEl = $("#status"), logEl = $("#log"), btnCancel = $("#btnCancel");

  if (!pointId) { toast("Сначала выберите точку (клик по карте или селект)", "err"); return; }
  if (issue < "2004-01") { toast("Месяц выпуска не раньше 2004-01", "err"); return; }

  state.running = true;
  state.abortCtrl = new AbortController();
  btnCancel.classList.remove("hidden");
  statusEl.classList.remove("hidden", "ok", "err");
  statusEl.classList.add("busy");
  const logRow = $("#logRow");
  if (logRow) logRow.classList.remove("hidden");
  logEl.textContent = "";
  const timer = startElapsed(statusEl);

  const c = cellById(pointId);
  const cropSnap = state.crops.find((x) => x.id === cropId) || null;
  const startedAt = Date.now();
  const finish = () => {
    state.running = false;
    clearInterval(timer);
    btnCancel.classList.add("hidden");
    if (state.abortCtrl) { state.abortCtrl = null; }
  };
  $("#btnCancel").onclick = () => {
    if (state.abortCtrl) state.abortCtrl.abort();
    finish();
    statusEl.classList.remove("busy");
    statusEl.classList.add("err");
    statusEl.textContent = "✕ Расчёт отменён";
    logEl.textContent += "\n[отменено пользователем]";
  };
  try {
    const body = {
      point_id: pointId,
      crop_id: cropId,
      issue,
      horizon_months: horizon,
      lat: c.lat,
      lon: c.lon,
    };
    // локальный мок отвечает быстро; держим минимум ~1.4 с, чтобы был виден прогресс
    const [resp] = await Promise.all([
      api("/api/local/forecast", { method: "POST", body: JSON.stringify(body), signal: state.abortCtrl.signal }),
      new Promise((res) => setTimeout(res, Math.max(0, 1400 - (Date.now() - startedAt)))),
    ]);
    if (state.abortCtrl && state.abortCtrl.signal.aborted) return;
    const elapsed = (Date.now() - startedAt) / 1000;
    finish();
    const log = resp.log || [];
    logEl.textContent = [...log, `ответ: ${elapsed.toFixed(1)} с, cached=${resp.cached}`].join("\n");
    statusEl.classList.remove("busy");
    statusEl.classList.add("ok");
    statusEl.textContent = `✓ Готово за ${elapsed.toFixed(1)} с — отчёт добавлен в архив`;
    // журнал можно свернуть автоматически через несколько секунд
    setTimeout(() => {
      const lr = $("#logRow");
      if (lr && !state.running) lr.classList.add("hidden");
    }, 7000);

    const report = buildReport(resp.payload, cropSnap, elapsed);
    addReport(report);

    // вкладка «Скачанные данные» с прогрессом
    noteDownloaded(pointId);
    // через ~2 сек — вкладка «Отчеты» с красивым отчётом
    setTimeout(() => {
      renderReports();
      switchTab("tab-reports");
      flashReport(report.rid);
      toast("Отчёт готов: " + report.cropName, "ok");
    }, 900);
  } catch (e) {
    if (e?.name === "AbortError") return;
    finish();
    statusEl.classList.remove("busy", "ok");
    statusEl.classList.add("err");
    statusEl.textContent = `Ошибка расчёта: ${e.message}`;
    logEl.textContent += `\n[ошибка] ${e.message}`;
    toast(`Не удалось получить прогноз: ${e.message}`, "err");
  }
}

/* ---------------------------------- вкладки ------------------------------ */
const PANE_IDS = ["tab-crops", "tab-data", "tab-reports"];
function activeTabName() {
  const b = document.querySelector(".tabs .tab.active");
  return b ? b.dataset.tab : "tab-crops";
}
function moveTabThumb(name) {
  const thumb = $("#tabThumb"), btn = $(`.tabs .tab[data-tab="${name}"]`);
  if (!thumb || !btn) return;
  thumb.style.width = btn.offsetWidth + "px";
  thumb.style.left = btn.offsetLeft + "px";
}
function switchTab(name) {
  $$(".tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  PANE_IDS.forEach((id) => {
    const p = $("#" + id);
    if (p) p.classList.toggle("active", id === name);
  });
  moveTabThumb(name);
}

/* ---------------------------------- экспорт ------------------------------ */
function currentReport() { return state.reports[0] || null; }
function snapshotJSON() {
  const r = currentReport();
  const rep = r
    ? { type: "report", app: "AgroCast", version: VERSION, ...r }
    : { type: "archive", app: "AgroCast", version: VERSION, reports: state.reports, downloads: state.downloads };
  rep.exportedAt = nowRu();
  rep.note = "AgroCast 2.5 каркас: данные моковые, расчёты не выполнялись";
  return JSON.stringify(rep, null, 2);
}
async function downloadText(text, fname) {
  const path = await bridgeSaveText(fname, text);
  if (path) { toast(`Сохранено: ${path}`, "ok"); return; }
  // браузерный путь: blob + download
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  toast("JSON сформирован — сохранён в «Загрузки»", "ok");
}
async function exportJson() {
  const text = snapshotJSON();
  const fname = `AgroCast-2.5-${currentReport()?.rid || "archive"}.json`;
  await downloadText(text, fname);
}
async function exportReportJson(r) {
  const rep = {
    type: "report", app: "AgroCast", version: VERSION,
    ...JSON.parse(JSON.stringify(r)),
    exportedAt: nowRu(),
    note: "AgroCast 2.5 каркас: данные моковые, расчёты не выполнялись",
  };
  await downloadText(JSON.stringify(rep, null, 2), `AgroCast-2.5-${r.rid}.json`);
}
function printReport(r) {
  let root = $("#printRoot");
  if (!root) {
    root = document.createElement("div");
    root.id = "printRoot";
    document.body.appendChild(root);
  }
  root.innerHTML = reportHtml(r);
  window.onafterprint = () => { root.innerHTML = ""; window.onafterprint = null; };
  setTimeout(() => window.print(), 60);
}

/* ---------------------------------- init --------------------------------- */
function bindEvents() {
  $$(".tabs .tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $$("#segHorizon .seg-btn").forEach((b) => b.addEventListener("click", () => {
    $("#horizon").value = b.dataset.v;
    syncSegHorizon();
    persistSelection();
  }));
  $("#btnForecast").addEventListener("click", runForecast);
  $("#btnPrint").addEventListener("click", () => {
    const r = currentReport();
    if (r) printReport(r);
    else toast("Сначала сделайте прогноз — печатать пока нечего");
  });
  $("#btnJson").addEventListener("click", exportJson);
  $("#point").addEventListener("change", (e) => {
    selectPoint(e.target.value, { pan: true });
  });
  $("#crop").addEventListener("change", () => { persistSelection(); markActiveCrop(); });
  $("#issue").addEventListener("change", () => persistSelection());
  $("#btnLogClose").addEventListener("click", () => {
    const lr = $("#logRow");
    if (lr) lr.classList.add("hidden");
  });
  $("#btnCropAdd").addEventListener("click", () => {
    const wrap = $("#cropFormWrap");
    if (wrap.classList.contains("hidden")) {
      if (state.crops.length && !confirmClearNeeded()) { /* не затираем непустую форму */ }
      clearCropForm();
      openCropForm(null);
    } else wrap.classList.add("hidden");
  });
  $("#btnCropClear").addEventListener("click", clearCropForm);
  $("#btnCropCancel").addEventListener("click", () => $("#cropFormWrap").classList.add("hidden"));
  $("#cropForm").addEventListener("submit", saveCrop);
  $("#btnClearReports").addEventListener("click", async () => {
    const ok = await uiConfirm("Очистить архив отчётов? Это действие необратимо.");
    if (!ok) return;
    state.reports = [];
    saveLS(LS_REPORTS, []);
    renderReports();
    toast("Архив отчётов очищен");
  });
  window.addEventListener("resize", () => {
    if (state.leafletMap) setTimeout(() => state.leafletMap.invalidateSize(), 120);
    setTimeout(() => moveTabThumb(activeTabName()), 160);
  });
}
function confirmClearNeeded() {
  // если форма пустая — возвращаем false, чтобы не дёргать clear без нужды
  return Boolean($("#fName").value || $("#fBreeder").value || $("#fNotes").value);
}
function setIssueLimits() {
  const el = $("#issue");
  el.min = "2004-01";
  el.max = addMonths(currentMonth(), 3);
  const saved = loadLS(LS_SEL, {});
  const def = saved.issue && saved.issue >= el.min && saved.issue <= el.max ? saved.issue : currentMonth();
  el.value = def;
}

async function init() {
  bootSplash();
  setupBridge();
  bindEvents();
  setIssueLimits();
  // восстановить горизонт из сохранённых настроек и синхронизировать сегменты
  const saved0 = loadLS(LS_SEL, {});
  if (saved0.horizon && ["1", "3", "6"].includes(String(saved0.horizon))) {
    $("#horizon").value = String(saved0.horizon);
  }
  syncSegHorizon();
  moveTabThumb("tab-crops");

  // загрузка мира: сетка + сорта (параллельно)
  const [gridData, cropsData] = await Promise.allSettled([
    api("/api/region/grid"),
    api("/api/local/crops"),
  ]);
  if (gridData.status === "fulfilled" && gridData.value.cells?.length) {
    state.grid = gridData.value.cells;
  } else {
    toast("Не удалось загрузить сетку точек /api/region/grid", "err");
  }
  if (cropsData.status === "fulfilled") {
    state.crops = cropsData.value.crops || [];
  } else {
    toast("Не удалось загрузить сорта /api/local/crops", "err");
  }

  state.reports = loadLS(LS_REPORTS, []);
  state.downloads = loadLS(LS_DOWNLOADS, []);
  if (state.downloads.length) $("#tabBtnData").classList.remove("hidden");
  renderDownloads();
  renderReports();

  fillSelects();
  renderCrops();
  markActiveCrop();

  // восстановить выбранную точку из сохранений/селекта
  const savedPoint = $("#point").value;
  if (savedPoint && cellById(savedPoint)) {
    state.selected = savedPoint;
    setCoordChip(savedPoint);
  } else if (state.grid.length) {
    selectPoint(state.grid[0].id, { pan: false });
  }

  // плавающий индикатор вкладок — после того как раскладка устоялась
  requestAnimationFrame(() => requestAnimationFrame(() => moveTabThumb(activeTabName())));

  initMap();
}

document.addEventListener("DOMContentLoaded", () => { init().catch((e) => { console.error(e); toast("Ошибка инициализации: " + e.message, "err"); }); });
