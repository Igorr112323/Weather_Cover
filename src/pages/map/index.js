/**
 * Вкладка «Карта»: выбор точки, параметров прогноза и запуск движка.
 *
 * Сценарий намеренно простой: спутниковая карта, клик в любом месте ставит
 * точку (второй клик — переносит), справа — сорт, период и месяц начала.
 * Мир показывается одной копией: минимальный масштаб подбирается под размер
 * окна так, чтобы снимок закрывал всю карту, а за край (±180°) уехать нельзя.
 * Максимальный масштаб ограничен уровнем, где снимки ещё есть (см. basemaps.js).
 * Состояние (центр, масштаб, точка, сорт, месяц, период) переживает
 * переходы между вкладками и перезапуск приложения.
 */

import L from "leaflet";
import "leaflet/dist/leaflet.css";

import { h, icon, setText } from "../../lib/dom.js";
import { fmtCoord, fmtPeriodRu } from "../../lib/format.js";
import { computePeriod, isValidIsoDate } from "../../../calculations/date-period.js";
import { monthRange, normalizeStartMonth } from "../../../calculations/month-range.js";
import { debounce } from "../../lib/async.js";
import { createSegmented, createButton } from "../../components/button.js";
import { createMonthField, fmtMonthRu } from "../../components/month-picker.js";
import { createNote } from "../../components/panel.js";
import { createSelectField } from "../../components/field.js";
import { createProgressBar } from "../../components/empty-state.js";
import { DEFAULT_BASEMAP, MAX_ZOOM, WORLD_BOUNDS, createBasemap, watchTiles } from "./basemaps.js";
import { runForecast as requestForecast } from "../../services/forecast-service.js";
import { setSetting } from "../../services/repositories.js";
import { MAP_DEFAULTS } from "../../app/state.js";
import { toast } from "../../components/toast.js";

const POINT_PLACEHOLDER = "Нажмите на карту, чтобы выбрать поле";
/** Ниже этого масштаба не уходим даже в очень узком окне. */
const ABS_MIN_ZOOM = 2;
const TILE_SIZE = 256;

export function createMapPage(context = {}) {
  const { db, navigate, refreshVarieties, state: appState } = context;

  let map = null;
  let tileLayer = null;
  let tileWatch = null;
  let marker = null;
  let resizeObserver = null;
  let unsubscribe = null;
  let destroyed = false;
  let point = null;
  let varietyId = null;
  let period = MAP_DEFAULTS.rangeMonths;
  let { minMonth, maxMonth } = monthRange();
  let startDate = maxMonth;
  let tilesFailed = false;
  let lastVarieties = null;

  /* ── Панель прогноза ──────────────────────────────────────────────────── */

  const coordsText = h("span", { class: "control__adorn", style: "flex:1;justify-content:flex-start;text-align:left", text: POINT_PLACEHOLDER });
  const coordsControl = h("div", { class: "control control--readonly" }, [coordsText]);
  const coordsField = h("div", { class: "field" }, [h("span", { class: "field__label", text: "Точка на карте" }), coordsControl]);

  const varietySelect = createSelectField({ label: "Сорт", options: [], value: "", placeholder: "Выберите сорт" });

  const periodHint = h("p", { class: "forecast-panel__hint" });
  const periodControl = createSegmented({
    label: "Период",
    size: "sm",
    value: period,
    options: [
      { value: 1, label: "1 мес.", title: "30–31 календарный день" },
      { value: 3, label: "3 мес.", title: "90–92 календарных дня" },
      { value: 6, label: "6 мес.", title: "181–184 календарных дня" },
    ],
    onChange: (value) => {
      period = value;
      updatePeriodLine();
      saveStateSoon();
    },
  });

  const monthField = createMonthField({
    label: "Месяц начала",
    value: startDate,
    minMonth,
    maxMonth,
    onChange: (iso) => {
      startDate = iso;
      updatePeriodLine();
      saveStateSoon();
    },
  });

  const runButton = createButton({
    label: "Спрогнозировать",
    tone: "primary",
    icon: "sparkles",
    block: true,
    onClick: () => startForecast(),
  });

  const progressHost = h("div");
  const errorHost = h("div");
  const hintsHost = h("div", { style: "display:flex;flex-direction:column;gap:8px" });

  const panel = h("section", { class: "forecast-panel", "aria-label": "Параметры прогноза" }, [
    h("div", { class: "forecast-panel__head" }, [h("h2", { class: "forecast-panel__title", text: "Прогноз" })]),
    coordsField,
    hintsHost,
    varietySelect,
    h("div", { class: "field" }, [h("span", { class: "field__label", text: "Период" }), periodControl, periodHint]),
    monthField,
    errorHost,
    runButton,
    progressHost,
  ]);

  const container = h("div", { class: "map-canvas" });
  const zoomInButton = h("button", { type: "button", class: "map-btn", "aria-label": "Приблизить", title: "Приблизить", onclick: () => map?.zoomIn() }, [icon("plus", { size: 16 })]);
  const zoomOutButton = h("button", { type: "button", class: "map-btn", "aria-label": "Отдалить", title: "Отдалить", onclick: () => map?.zoomOut() }, [icon("minus", { size: 16 })]);
  const zoomControls = h("div", { class: "map-card" }, [h("div", { class: "map-controls__row" }, [zoomInButton, zoomOutButton])]);

  const mapErrorHost = h("div");
  const node = h("div", { class: "map-page" }, [
    container,
    h("div", { class: "map-ui map-ui--left" }, [zoomControls]),
    h("div", { class: "map-ui map-ui--right" }, [panel]),
    mapErrorHost,
  ]);

  const saveStateSoon = debounce(() => saveState(), 1200);

  function prefersReducedMotion() {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /* ── Создание карты ───────────────────────────────────────────────────── */

  function createMap() {
    const saved = appState?.state.map ?? MAP_DEFAULTS;
    const center = validCenter(saved.center) ? saved.center : MAP_DEFAULTS.center;
    const minZoom = minZoomFor(container);
    const zoom = Number.isFinite(saved.zoom) ? clampZoom(saved.zoom, minZoom) : Math.max(MAP_DEFAULTS.zoom, minZoom);

    map = L.map(container, {
      center: [center.lat, center.lng],
      zoom,
      minZoom,
      maxZoom: MAX_ZOOM,
      zoomControl: false,
      attributionControl: true,
      keyboard: true,
      fadeAnimation: !prefersReducedMotion(),
      zoomAnimation: !prefersReducedMotion(),
      // Одна копия мира: карту нельзя утащить за ±180°, поэтому соседние
      // копии Евразии и Америки по бокам не появляются.
      worldCopyJump: false,
      maxBounds: WORLD_BOUNDS,
      maxBoundsViscosity: 1,
      // Щипок на тачпаде не «перелетает» за предельный масштаб: иначе слой
      // на мгновение снимает все тайлы, и карта мигает пустотой.
      bounceAtZoomLimits: false,
    });

    setBasemap();

    // Единственное действие на карте: клик ставит (или переносит) точку.
    map.on("click", (event) => selectPoint(event.latlng.lat, event.latlng.lng));
    map.on("moveend zoomend", () => saveStateSoon());
    map.on("zoomend zoomlevelschange", () => syncZoomButtons());
    syncZoomButtons();

    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => {
        if (destroyed || !map) return;
        map.invalidateSize({ animate: false });
        syncMinZoom();
      });
      resizeObserver.observe(container);
    }
  }

  function validCenter(center) {
    return center && Number.isFinite(center.lat) && Number.isFinite(center.lng);
  }

  /**
   * Минимальный масштаб, при котором одна копия мира закрывает контейнер
   * целиком: сторона мира 256·2^z px должна быть не меньше большей стороны
   * контейнера. Иначе Leaflet показывал бы соседние копии мира или пустоту.
   */
  function minZoomFor(element) {
    const side = Math.max(element.clientWidth, element.clientHeight, TILE_SIZE);
    const zoom = Math.ceil(Math.log2(side / TILE_SIZE));
    return Math.min(MAX_ZOOM, Math.max(ABS_MIN_ZOOM, zoom));
  }

  function syncMinZoom() {
    if (!map) return;
    const minZoom = minZoomFor(container);
    // setMinZoom сам приближает карту, если текущий масштаб стал меньше нового минимума.
    if (map.getMinZoom() !== minZoom) map.setMinZoom(minZoom);
  }

  function syncZoomButtons() {
    if (!map) return;
    zoomInButton.disabled = map.getZoom() >= map.getMaxZoom();
    zoomOutButton.disabled = map.getZoom() <= map.getMinZoom();
  }

  function clampZoom(value, minZoom = map?.getMinZoom() ?? minZoomFor(container)) {
    return Math.min(MAX_ZOOM, Math.max(minZoom, Math.round(Number(value))));
  }

  /* ── Точка и маркер ───────────────────────────────────────────────────── */

  function selectPoint(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    point = { lat, lng };
    paintPoint({ pulse: true });
    paintCoords();
    showFieldError(null);
    saveStateSoon();
  }

  function paintPoint({ pulse = false } = {}) {
    if (!map || !point) return;
    if (!marker) {
      // Содержимое маркера собирается узлами, строковой HTML-разметки нет.
      const iconDefinition = L.divIcon({ className: "map-grain-icon", iconSize: [24, 24], iconAnchor: [12, 12], html: h("span", { class: "grain" }) });
      marker = L.marker([point.lat, point.lng], {
        icon: iconDefinition,
        interactive: false,
        keyboard: false,
        zIndexOffset: 900,
      }).addTo(map);
    } else {
      marker.setLatLng([point.lat, point.lng]);
    }
    const grain = marker.getElement()?.querySelector(".grain");
    if (grain) {
      grain.classList.remove("grain--pulse");
      if (pulse && !prefersReducedMotion()) {
        // Перезапуск анимации при повторном клике: сначала снять класс, затем вернуть.
        void grain.offsetWidth;
        grain.classList.add("grain--pulse");
      }
    }
  }

  function clearPoint() {
    point = null;
    if (marker && map) map.removeLayer(marker);
    marker = null;
    paintCoords();
    saveStateSoon();
  }

  function paintCoords() {
    const existing = coordsControl.querySelector(".btn-icon");
    if (point) {
      setText(coordsText, fmtCoord(point.lat, point.lng, 5));
      coordsControl.classList.remove("control--readonly");
      coordsControl.setAttribute("aria-label", `Координаты выбранной точки: ${fmtCoord(point.lat, point.lng, 5)}`);
      if (!existing) {
        coordsControl.append(
          h("button", { type: "button", class: "btn-icon", style: "width:26px;height:26px", "aria-label": "Снять точку", title: "Снять точку", onclick: () => clearPoint() }, [
            icon("x", { size: 14 }),
          ]),
        );
      }
    } else {
      setText(coordsText, POINT_PLACEHOLDER);
      coordsControl.classList.add("control--readonly");
      coordsControl.removeAttribute("aria-label");
      existing?.remove();
    }
  }

  /* ── Период ───────────────────────────────────────────────────────────── */

  function updatePeriodLine() {
    if (!isValidIsoDate(startDate)) {
      setText(periodHint, "");
      return;
    }
    try {
      const info = computePeriod(startDate, period);
      setText(periodHint, `${fmtPeriodRu(info.startDate, info.endDate)} · ${info.days} дн.`);
    } catch {
      setText(periodHint, "");
    }
  }

  /** Диапазон месяцев пересчитывается при каждом показе: наступил новый месяц — он стал доступен. */
  function refreshMonthRange({ announce = false } = {}) {
    ({ minMonth, maxMonth } = monthRange());
    monthField.setRange(minMonth, maxMonth);
    const normalized = normalizeStartMonth(startDate);
    if (normalized.value !== startDate) {
      startDate = normalized.value;
      monthField.setValue(startDate, { notify: false });
      if (announce && normalized.adjusted) {
        monthField.setError(`Месяц вне доступного диапазона — начало перенесено на ${fmtMonthRu(startDate)}`);
      }
    }
    updatePeriodLine();
  }

  /* ── Слой карты ───────────────────────────────────────────────────────── */

  function setBasemap() {
    if (!map) return;
    if (tileLayer) {
      map.removeLayer(tileLayer);
      tileLayer = null;
    }
    tileLayer = createBasemap(DEFAULT_BASEMAP).create();
    tileWatch = watchTiles(tileLayer, {
      onFailure: () => {
        if (tilesFailed) return;
        tilesFailed = true;
        paintMapError();
      },
      onLoaded: () => {
        tilesFailed = false;
        mapErrorHost.replaceChildren();
      },
    });
    tileLayer.addTo(map);
  }

  function paintMapError() {
    mapErrorHost.replaceChildren(
      h("div", { class: "map-error", role: "status" }, [
        icon("cloud-off", { size: 16 }),
        h("span", { text: "Не удалось загрузить спутниковые снимки. Проверьте подключение к интернету." }),
        createButton({
          label: "Повторить",
          tone: "secondary",
          size: "sm",
          onClick: (event, button) => {
            tilesFailed = false;
            mapErrorHost.replaceChildren();
            button.setLoading(true, "Повторяем…");
            tileWatch?.reset();
            setBasemap();
            window.setTimeout(() => button.setLoading(false, "Повторить"), 1200);
          },
        }),
      ]),
    );
  }

  /* ── Запуск прогноза ──────────────────────────────────────────────────── */

  function showFieldError(message, fields = null) {
    errorHost.replaceChildren();
    varietySelect.clearError();
    monthField.clearError();
    if (!message) return;
    errorHost.append(createNote(message, { tone: "danger" }));
    if (fields?.varietyId) varietySelect.setError(fields.varietyId);
    if (fields?.targetDate) monthField.setError(fields.targetDate);
  }

  function currentVariety() {
    const varieties = appState?.state.varieties ?? [];
    return varieties.find((variety) => variety.id === varietyId) ?? null;
  }

  async function startForecast() {
    if (!point) {
      showFieldError("Сначала нажмите на карту и выберите поле");
      return;
    }
    const variety = currentVariety();
    if (!variety) {
      showFieldError("Выберите сорт из справочника", { varietyId: "Выберите сорт" });
      return;
    }
    const normalized = normalizeStartMonth(startDate);
    if (normalized.value !== startDate) {
      startDate = normalized.value;
      monthField.setValue(startDate, { notify: false });
      updatePeriodLine();
    }

    showFieldError(null);
    runButton.setLoading(true, "Подготовка демонстрационного прогноза");
    progressHost.replaceChildren(createProgressBar({ label: "Подготовка демонстрационного прогноза" }));
    appState?.set({ forecast: { ...(appState.state.forecast ?? {}), status: "running", error: null, fieldErrors: {} } });

    const request = {
      lat: point.lat,
      lon: point.lng,
      varietyId: variety.id,
      varietyName: variety.name,
      rangeMonths: period,
      targetDate: startDate,
    };

    try {
      const outcome = await requestForecast({ db, request, variety });
      appState?.set({
        forecast: {
          status: "ready",
          result: outcome.result,
          datasetId: outcome.datasetId,
          datasetCreated: outcome.datasetCreated,
          savedReportId: null,
          error: null,
          fieldErrors: {},
        },
      });
      await saveState();
      navigate?.("/results");
    } catch (error) {
      const message = error?.code === "INVALID_REQUEST" ? "Проверьте параметры прогноза" : (error?.message ?? "Не удалось сформировать прогноз");
      showFieldError(message, error?.fields ?? null);
      toast.error("Прогноз не сформирован");
      appState?.set({ forecast: { ...(appState.state.forecast ?? {}), status: "error", error: message, fieldErrors: error?.fields ?? {} } });
    } finally {
      runButton.setLoading(false, "Спрогнозировать");
      progressHost.replaceChildren();
    }
  }

  /* ── Сорта ────────────────────────────────────────────────────────────── */

  function syncVarieties() {
    const varieties = appState?.state.varieties ?? [];
    const options = varieties.map((variety) => ({ value: variety.id, label: varietyLabel(variety) }));
    if (!varieties.some((variety) => variety.id === varietyId)) varietyId = options.length > 0 ? options[0].value : null;
    varietySelect.setOptions(options, varietyId ?? "");
    renderVarietyHint(options.length);
  }

  function renderVarietyHint(count) {
    const existing = hintsHost.querySelector("[data-hint='varieties']");
    existing?.remove();
    if (count > 0 || !node.isConnected) return;
    hintsHost.append(
      h("div", { class: "note note--warning", dataset: { hint: "varieties" } }, [
        icon("triangle-alert", { size: 15 }),
        h("span", {}, [
          h("span", { text: "В справочнике нет сортов. " }),
          createButton({ label: "Добавить сорт", tone: "ghost", size: "sm", onClick: () => navigate?.("/varieties") }),
        ]),
      ]),
    );
  }

  varietySelect.onChange((value) => {
    varietyId = value || null;
    showFieldError(null);
    saveStateSoon();
  });

  /* ── Сохранение и восстановление состояния ─────────────────────────────── */

  function snapshot() {
    const center = map?.getCenter();
    return {
      center: center ? { lat: center.lat, lng: center.lng } : MAP_DEFAULTS.center,
      zoom: map?.getZoom() ?? MAP_DEFAULTS.zoom,
      layer: DEFAULT_BASEMAP,
      point: point ? { lat: point.lat, lng: point.lng } : null,
      varietyId,
      startDate,
      rangeMonths: period,
    };
  }

  function saveState() {
    if (!db || destroyed) return Promise.resolve();
    saveStateSoon.cancel();
    return db
      .commit((handle) => setSetting(handle, "mapState", snapshot()))
      .then(() => {
        appState?.set({ map: snapshot() });
      })
      .catch((error) => {
        console.error("Состояние карты не сохранено", error);
        toast.error("Не удалось сохранить состояние карты");
      });
  }

  function applySaved(saved) {
    if (!saved || typeof saved !== "object" || !map) return;
    if (validCenter(saved.center)) {
      map.setView([saved.center.lat, saved.center.lng], clampZoom(saved.zoom ?? MAP_DEFAULTS.zoom), { animate: false });
    }

    period = [1, 3, 6].includes(saved.rangeMonths) ? saved.rangeMonths : MAP_DEFAULTS.rangeMonths;
    periodControl.setValue(period);

    startDate = isValidIsoDate(saved.startDate) ? saved.startDate : maxMonth;
    monthField.setValue(startDate, { notify: false });
    refreshMonthRange({ announce: true });

    if (saved.point && Number.isFinite(saved.point.lat) && Number.isFinite(saved.point.lng)) {
      point = { lat: saved.point.lat, lng: saved.point.lng };
      paintPoint({ pulse: false });
    }
    paintCoords();

    varietyId = typeof saved.varietyId === "string" ? saved.varietyId : null;
    syncVarieties();
  }

  /* ── Жизненный цикл страницы ──────────────────────────────────────────── */

  function subscribeState() {
    unsubscribe = appState?.subscribe((snapshotState) => {
      if (snapshotState.varieties !== lastVarieties) {
        lastVarieties = snapshotState.varieties;
        syncVarieties();
      }
    });
    if ((appState?.state.varieties ?? []).length === 0) void refreshVarieties?.();
    window.requestAnimationFrame(() => map?.invalidateSize({ animate: false }));
  }

  return {
    node,
    show() {
      subscribeState();
      if (!map && !destroyed) {
        createMap();
        applySaved(appState?.state.map ?? null);
        updatePeriodLine();
        return;
      }
      // Повторный вход: пересчёт доступных месяцев и размеров карты.
      refreshMonthRange();
      syncVarieties();
      window.requestAnimationFrame(() => map?.invalidateSize({ animate: false }));
    },
    hide() {
      monthField.closePicker();
      unsubscribe?.();
      unsubscribe = null;
      void saveState();
    },
    destroy() {
      destroyed = true;
      saveStateSoon.cancel();
      monthField.closePicker();
      unsubscribe?.();
      resizeObserver?.disconnect();
      if (map) {
        map.off();
        map.remove();
      }
      map = null;
      marker = null;
    },
    setError(error) {
      showFieldError(error?.message ?? "Не удалось открыть карту");
    },
  };
}

function varietyLabel(variety) {
  const parts = [variety.name];
  if (Number.isFinite(variety.fao)) parts.push(`ФАО ${variety.fao}`);
  else if (variety.type === "hybrid") parts.push("гибрид");
  return parts.join(" · ");
}
