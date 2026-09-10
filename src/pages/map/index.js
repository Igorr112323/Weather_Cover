/**
 * Вкладка «Карта»: выбор точки, параметров прогноза и запуск движка.
 *
 * Карта занимает всю рабочую область справа от навигации — без отступов и рамки.
 * Состояние (центр, масштаб, слой, точка, сорт, дата, период) переживает
 * переходы между вкладками и перезапуск приложения.
 */

import L from "leaflet";
import "leaflet/dist/leaflet.css";

import { h, icon, setText } from "../../lib/dom.js";
import { fmtCoord, fmtDateRu, fmtPeriodRu } from "../../lib/format.js";
import { addMonths, computePeriod, isValidIsoDate, toOrdinal, todayIso } from "../../../calculations/date-period.js";
import { debounce } from "../../lib/async.js";
import { pushEscHandler } from "../../lib/overlays.js";
import { createSegmented, createButton } from "../../components/button.js";
import { createDateField } from "../../components/date-picker.js";
import { createBadge, createNote } from "../../components/panel.js";
import { createSelectField } from "../../components/field.js";
import { createProgressBar } from "../../components/empty-state.js";
import { BASEMAPS, DEFAULT_BASEMAP, createBasemap, watchTiles } from "./basemaps.js";
import { createCountryLayer, createRegionLayer, loadGeoData, REGION_CLICK_MAX_ZOOM, REGION_ZOOM_MIN } from "./geo-layers.js";
import { runForecast as requestForecast } from "../../services/forecast-service.js";
import { setSetting } from "../../services/repositories.js";
import { MAP_DEFAULTS } from "../../app/state.js";
import { toast } from "../../components/toast.js";

const POINT_PLACEHOLDER = "Выберите точку на карте";

export function createMapPage(context = {}) {
  const { db, navigate, refreshVarieties, state: appState } = context;

  let map = null;
  let tileLayer = null;
  let tileWatch = null;
  let countryLayer = null;
  let regionApi = null;
  let marker = null;
  let resizeObserver = null;
  let unsubscribe = null;
  let popEsc = null;
  let destroyed = false;
  let currentBasemap = DEFAULT_BASEMAP;
  let point = null;
  let varietyId = null;
  let period = MAP_DEFAULTS.rangeMonths;
  let startDate = todayIso();
  let minDate = todayIso();
  let maxDate = addMonths(todayIso(), 12);
  let restoreStack = [];
  let tilesFailed = false;
  let lastVarieties = null;

  /* ── Панель прогноза ──────────────────────────────────────────────────── */

  const coordsText = h("span", { class: "control__adorn", style: "flex:1;justify-content:flex-start;text-align:left", text: POINT_PLACEHOLDER });
  const coordsControl = h("div", { class: "control control--readonly" }, [coordsText]);
  const coordsField = h("div", { class: "field" }, [h("span", { class: "field__label", text: "Координаты" }), coordsControl]);

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

  const dateField = createDateField({
    label: "Начало периода",
    value: startDate,
    minDate,
    maxDate,
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

  const resetButton = h(
    "button",
    { type: "button", class: "btn-icon", "aria-label": "Сбросить вид карты", title: "Сбросить вид карты", onclick: () => resetView() },
    [icon("locate", { size: 16 })],
  );

  const panel = h("section", { class: "forecast-panel", "aria-label": "Параметры прогноза" }, [
    h("div", { class: "forecast-panel__head" }, [h("h2", { class: "forecast-panel__title", text: "Прогноз" }), resetButton]),
    coordsField,
    hintsHost,
    varietySelect,
    h("div", { class: "field" }, [h("span", { class: "field__label", text: "Период" }), periodControl, periodHint]),
    dateField,
    errorHost,
    runButton,
    h("div", { class: "forecast-panel__row" }, [createBadge("Демонстрационный режим", { tone: "warning", iconName: "flask-conical" })]),
    progressHost,
  ]);

  const container = h("div", { class: "map-canvas" });
  const zoomControls = h("div", { class: "map-card" }, [
    h("div", { class: "map-controls__row" }, [
      h("button", { type: "button", class: "map-btn", "aria-label": "Приблизить", onclick: () => map?.zoomIn() }, [icon("plus", { size: 16 })]),
      h("button", { type: "button", class: "map-btn", "aria-label": "Отдалить", onclick: () => map?.zoomOut() }, [icon("minus", { size: 16 })]),
    ]),
  ]);

  const mapErrorHost = h("div");
  const node = h("div", { class: "map-page" }, [
    container,
    h("div", { class: "map-ui map-ui--left" }, [zoomControls]),
    h("div", { class: "map-ui map-ui--right" }, [panel]),
    mapErrorHost,
  ]);

  const saveStateSoon = debounce(() => saveState(), 1200);
  const syncRegionViewSoon = debounce(() => syncRegionVisibility(), 100);

  function prefersReducedMotion() {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /* ── Создание карты ───────────────────────────────────────────────────── */

  function createMap() {
    const saved = appState?.state.map ?? MAP_DEFAULTS;
    const center = validCenter(saved.center) ? saved.center : MAP_DEFAULTS.center;
    const zoom = Number.isFinite(saved.zoom) ? clampZoom(saved.zoom) : MAP_DEFAULTS.zoom;

    map = L.map(container, {
      center: [center.lat, center.lng],
      zoom,
      minZoom: 2,
      maxZoom: 19,
      zoomControl: false,
      attributionControl: true,
      keyboard: true,
      worldCopyJump: false,
      fadeAnimation: !prefersReducedMotion(),
      zoomAnimation: !prefersReducedMotion(),
      maxBounds: [
        [-85, -200],
        [85, 200],
      ],
    });

    setBasemap(BASEMAPS[saved.layer] ? saved.layer : DEFAULT_BASEMAP);

    // Выбор точки — обычный клик по свободной поверхности карты.
    map.on("click", (event) => selectPoint(event.latlng.lat, event.latlng.lng));
    map.on("moveend zoomend", () => {
      syncRegionViewSoon();
      saveStateSoon();
    });

    void loadGeo();

    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => {
        if (destroyed || !map) return;
        map.invalidateSize({ animate: false });
      });
      resizeObserver.observe(container);
    }
  }

  function validCenter(center) {
    return center && Number.isFinite(center.lat) && Number.isFinite(center.lng);
  }

  function clampZoom(value) {
    return Math.min(19, Math.max(2, Math.round(Number(value))));
  }

  async function loadGeo() {
    const data = await loadGeoData();
    if (destroyed || !map) return;

    if (data.countries) {
      countryLayer = createCountryLayer({
        onCountryClick: (event) => selectPoint(event.latlng.lat, event.latlng.lng),
      });
      countryLayer.addData(data.countries);
      countryLayer.addTo(map);
    }

    if (data.regions) {
      regionApi = createRegionLayer({
        onRegionClick: (featureLayer, event) => {
          // Явное разделение: на масштабе 4–6 клик по региону приближает регион,
          // выбор точки при этом не выполняется. Вне этого диапазона клик означает точку.
          // События слоя не всплывают до карты (bubblingMouseEvents: false), поэтому
          // точку выбираем здесь же, а не надеемся на «проваливание» клика.
          if (map.getZoom() < REGION_ZOOM_MIN || map.getZoom() > REGION_CLICK_MAX_ZOOM) {
            selectPoint(event.latlng.lat, event.latlng.lng);
            return true;
          }
          focusRegion(featureLayer, event);
          return true;
        },
      });
      regionApi.layer.addData(data.regions);
      syncRegionVisibility();
    }

    if (data.missing) {
      hintsHost.append(
        h("p", { class: "forecast-panel__hint", text: "Границы стран и регионов недоступны — точка выбирается кликом по карте." }),
      );
    }
    updateHints();
  }

  function syncRegionVisibility() {
    if (!map || !regionApi) return;
    const zoom = map.getZoom();
    const present = map.hasLayer(regionApi.layer);
    const shouldShow = zoom >= REGION_ZOOM_MIN - 1;
    if (shouldShow && !present) regionApi.layer.addTo(map);
    if (!shouldShow && present) map.removeLayer(regionApi.layer);
    if (present || shouldShow) {
      const clickable = zoom <= REGION_CLICK_MAX_ZOOM;
      regionApi.layer.setStyle({ weight: clickable ? 0.9 : 0.6, opacity: clickable ? 0.6 : 0.4 });
    }
    updateHints();
  }

  function focusRegion(featureLayer, event) {
    restoreStack.push({ center: map.getCenter(), zoom: map.getZoom(), basemap: currentBasemap });
    regionApi.markSelected(featureLayer);
    setBasemap("satellite", { save: false });
    map.flyToBounds(featureLayer.getBounds().pad(0.12), { duration: prefersReducedMotion() ? 0 : 0.6, maxZoom: 8 });
    if (event?.originalEvent) L.DomEvent.stop(event.originalEvent);
    saveStateSoon();
  }

  function restorePreviousView() {
    if (restoreStack.length === 0 || !map) return false;
    const snapshot = restoreStack.pop();
    regionApi?.clearSelected();
    setBasemap(snapshot.basemap, { save: false });
    map.flyTo(snapshot.center, snapshot.zoom, { duration: prefersReducedMotion() ? 0 : 0.45 });
    updateHints();
    saveStateSoon();
    return true;
  }

  function resetView() {
    if (!map) return;
    restoreStack = [];
    regionApi?.clearSelected();
    setBasemap(DEFAULT_BASEMAP, { save: true });
    map.flyTo([MAP_DEFAULTS.center.lat, MAP_DEFAULTS.center.lng], MAP_DEFAULTS.zoom, {
      duration: prefersReducedMotion() ? 0 : 0.45,
    });
    updateHints();
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
    const iconDefinition = L.divIcon({ className: "map-grain-icon", iconSize: [24, 24], iconAnchor: [12, 12] });
    let target = marker;
    if (target) {
      target.setLatLng([point.lat, point.lng]);
      target.setIcon(iconDefinition);
    } else {
      target = L.marker([point.lat, point.lng], {
        icon: iconDefinition,
        interactive: false,
        keyboard: false,
        zIndexOffset: 900,
      }).addTo(map);
      marker = target;
    }
    const element = target.getElement();
    if (element) {
      // Содержимое маркера собирается узлами, строковой HTML-разметки нет
      const grain = h("span", { class: ["grain", pulse && !prefersReducedMotion() ? "grain--pulse" : ""].filter(Boolean).join(" ") });
      element.replaceChildren(h("span", { class: "map-grain-icon" }, [grain]));
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

  /* ── Период и подсказки ───────────────────────────────────────────────── */

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

  function updateHints() {
    for (const stale of hintsHost.querySelectorAll("[data-hint='region'], [data-hint='point']")) stale.remove();
    if (restoreStack.length > 0) {
      hintsHost.append(
        h("div", { class: "note note--info", dataset: { hint: "region" } }, [
          icon("info", { size: 15 }),
          h("span", {}, [
            h("span", { text: "Регион выделен. " }),
            h("kbd", { text: "Esc", style: "font:inherit;font-weight:600" }),
            h("span", { text: " — вернуть прежний вид и слой." }),
          ]),
        ]),
      );
    }
    if (point && map && map.getZoom() <= REGION_CLICK_MAX_ZOOM && map.getZoom() >= REGION_ZOOM_MIN && regionApi) {
      hintsHost.append(
        h("p", { class: "forecast-panel__hint", dataset: { hint: "point" }, text: "Точка выбрана на этом же месте: клик по региону приближает регион, а не перемещает точку." }),
      );
    }
  }

  /* ── Слой карты ───────────────────────────────────────────────────────── */

  function setBasemap(id, { save = true } = {}) {
    const basemap = createBasemap(id);
    currentBasemap = basemap.id;
    if (!map) return;
    if (tileLayer) {
      map.removeLayer(tileLayer);
      tileLayer = null;
    }
    tileLayer = basemap.create();
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
    if (save) saveStateSoon();
  }

  function paintMapError() {
    mapErrorHost.replaceChildren(
      h("div", { class: "map-error", role: "status" }, [
        icon("cloud-off", { size: 16 }),
        h("span", { text: "Не удалось загрузить карту" }),
        createButton({
          label: "Повторить",
          tone: "secondary",
          size: "sm",
          onClick: (event, button) => {
            tilesFailed = false;
            mapErrorHost.replaceChildren();
            button.setLoading(true, "Повторяем…");
            tileWatch?.reset();
            setBasemap(currentBasemap, { save: false });
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
    dateField.clearError();
    if (!message) return;
    errorHost.append(createNote(message, { tone: "danger" }));
    if (fields?.varietyId) varietySelect.setError(fields.varietyId);
    if (fields?.targetDate) dateField.setError(fields.targetDate);
  }

  function currentVariety() {
    const varieties = appState?.state.varieties ?? [];
    return varieties.find((variety) => variety.id === varietyId) ?? null;
  }

  async function startForecast() {
    if (!point) {
      showFieldError("Сначала выберите точку на карте");
      return;
    }
    const variety = currentVariety();
    if (!variety) {
      showFieldError("Выберите сорт из справочника", { varietyId: "Выберите сорт" });
      return;
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
      layer: currentBasemap,
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
    if (BASEMAPS[saved.layer]) setBasemap(saved.layer, { save: false });

    period = [1, 3, 6].includes(saved.rangeMonths) ? saved.rangeMonths : MAP_DEFAULTS.rangeMonths;
    periodControl.setValue(period);

    minDate = todayIso();
    maxDate = addMonths(minDate, 12);
    dateField.setRange(minDate, maxDate);
    const savedStart = isValidIsoDate(saved.startDate) ? saved.startDate : null;
    const outOfRange = savedStart && (toOrdinal(savedStart) < toOrdinal(minDate) || toOrdinal(savedStart) > toOrdinal(maxDate));
    startDate = !savedStart || outOfRange ? minDate : savedStart;
    dateField.setValue(startDate, { notify: false });
    if (outOfRange) {
      dateField.setError(`Дата вне доступного диапазона — начало периода перенесено на ${fmtDateRu(startDate)}`);
    }
    updatePeriodLine();

    if (saved.point && Number.isFinite(saved.point.lat) && Number.isFinite(saved.point.lng)) {
      point = { lat: saved.point.lat, lng: saved.point.lng };
      paintPoint({ pulse: false });
    }
    paintCoords();

    varietyId = typeof saved.varietyId === "string" ? saved.varietyId : null;
    syncVarieties();
    syncRegionVisibility();
  }

  /* ── Жизненный цикл страницы ──────────────────────────────────────────── */

  function subscribeOverlays() {
    popEsc = pushEscHandler({
      node: panel,
      onEscape: () => restorePreviousView(),
    });
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
      subscribeOverlays();
      if (!map && !destroyed) {
        createMap();
        applySaved(appState?.state.map ?? null);
        return;
      }
      // Повторный вход: только пересчёт доступного диапазона дат и размеров карты
      minDate = todayIso();
      maxDate = addMonths(minDate, 12);
      dateField.setRange(minDate, maxDate);
      syncVarieties();
      updatePeriodLine();
      updateHints();
      window.requestAnimationFrame(() => map?.invalidateSize({ animate: false }));
    },
    hide() {
      unsubscribe?.();
      unsubscribe = null;
      popEsc?.();
      popEsc = null;
      void saveState();
    },
    destroy() {
      destroyed = true;
      saveStateSoon.cancel();
      unsubscribe?.();
      popEsc?.();
      resizeObserver?.disconnect();
      if (map) {
        map.off();
        map.remove();
      }
      map = null;
      marker = null;
      countryLayer = null;
      regionApi = null;
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
