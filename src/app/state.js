/**
 * Состояние приложения.
 *
 * Небольшойobservable-хранилище: страницы читают и пишут через set(), подписчики
 * уведомляются пакетно (microtask), чтобы быстрое переключение вкладок не
 * вызывало каскад перерисовок.
 */

export function createStore(initial = {}) {
  let state = { ...initial };
  const listeners = new Set();
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const snapshot = state;
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("Ошибка в подписчике состояния", error);
      }
    }
  };

  return {
    get state() {
      return state;
    },
    set(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      let changed = false;
      for (const [key, value] of Object.entries(next ?? {})) {
        if (!Object.is(state[key], value)) {
          state = { ...state, [key]: value };
          changed = true;
        }
      }
      if (!changed) return;
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    },
    /** Подписка; возвращает функцию отписки. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Значения по умолчанию для карты: вид на Россию и соседние страны. */
export const MAP_DEFAULTS = Object.freeze({
  center: { lat: 55.5, lng: 48 },
  zoom: 4,
  layer: "satellite",
  point: null,
  varietyId: null,
  startDate: null,
  rangeMonths: 3,
});

export const state = createStore({
  boot: "loading",
  bootError: null,
  storageLabel: "",
  appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0",

  route: { name: "map", params: {}, query: {} },
  narrow: false,

  varieties: [],
  varietiesStatus: "idle",

  map: { ...MAP_DEFAULTS },

  forecast: {
    status: "idle", // idle | running | error
    result: null,
    datasetId: null,
    savedReportId: null,
    error: null,
    fieldErrors: {},
  },

  resultsView: { tab: "charts", source: "none", reportId: null },

  filters: {
    datasets: { query: "", rangeMonths: "all", sort: { key: "created", dir: "desc" } },
    reports: { query: "", varietyId: "all", order: "desc" },
    varieties: { query: "", type: "all", sort: { key: "name", dir: "asc" } },
  },
});

export function resetForecast() {
  state.set({
    forecast: {
      status: "idle",
      result: null,
      datasetId: null,
      savedReportId: null,
      error: null,
      fieldErrors: {},
    },
  });
}
