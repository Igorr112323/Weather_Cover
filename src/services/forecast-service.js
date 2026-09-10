/**
 * Слой между интерфейсом и движком прогноза.
 *
 * Здесь решается, какой модуль считать движком. Замена демонстрации на реальные
 * расчёты — это правка ENGINE_LOADER (или новый файл с тем же контрактом):
 * generateForecast(request) + validateForecastRequest(request). Остальные
 * разделы приложения об этом слое ничего не знают.
 */

import { auditResult } from "../../calculations/forecast_engine.js";
import {
  computeResultKey,
  findReportByKey,
  formatLabel,
  insertDatasetSnapshot,
  insertReportSnapshot,
  varietySnapshot,
} from "./repositories.js";

/** Единственная точка импорта движка. */
const ENGINE_LOADER = () => import("../../calculations/forecast_engine.js");

export class ForecastError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ForecastError";
    this.code = options.code ?? "FORECAST_FAILED";
    this.fields = options.fields;
    this.cause = options.cause;
  }
}

/** Проверка параметров прогноза без запуска движка (для мгновенных ошибок формы). */
export async function validateRequest(request) {
  const engine = await ENGINE_LOADER();
  return engine.validateForecastRequest(request);
}

/**
 * Запускает движок и сохраняет результат как набор данных.
 *
 * @param {{db:any, request:object, variety:object|null, onProgress?:(stage:string)=>void}} options
 * @returns {Promise<{result:object, datasetId:string, datasetCreated:boolean}>}
 */
export async function runForecast({ db, request, variety }) {
  const engine = await ENGINE_LOADER();
  const checked = engine.validateForecastRequest(request);
  if (!checked.ok) {
    throw new ForecastError("Проверьте параметры прогноза", { code: "INVALID_REQUEST", fields: checked.errors });
  }

  let result;
  try {
    result = await engine.generateForecast(checked.value);
  } catch (error) {
    if (error?.code === "INVALID_REQUEST") {
      throw new ForecastError("Проверьте параметры прогноза", { code: "INVALID_REQUEST", fields: error.fields });
    }
    const message = String(error?.message ?? "");
    throw new ForecastError(message ? `Движок вернул ошибку: ${message.slice(0, 160)}` : "Движок вернул ошибку", {
      code: "ENGINE_FAILED",
      cause: error,
    });
  }

  const problems = auditResult(result);
  if (problems.length > 0) {
    throw new ForecastError("Результат движка не прошёл проверку целостности", {
      code: "ENGINE_OUTPUT_INVALID",
      cause: new Error(problems.join("; ")),
    });
  }

  const stored = db
    ? await db.commit((handle) => insertDatasetSnapshot(handle, result, { varietyId: variety?.id ?? null }))
    : { id: null, created: false };

  return { result, datasetId: stored.id, datasetCreated: stored.created };
}

/**
 * Сохраняет снимок результата в архив отчётов.
 * @returns {Promise<{id:string, created:boolean, existing:boolean}>}
 */
export async function saveReport({ db, result, variety, datasetId = null }) {
  if (!result) throw new ForecastError("Нечего сохранять: результат не сформирован", { code: "NO_RESULT" });
  const key = computeResultKey(result);
  const already = findReportByKey(db.handle, key);
  if (already) return { id: already.id, created: false, existing: true };

  const name = formatLabel(
    variety?.name ?? result.request?.varietyName,
    result.period?.startDate,
    result.period?.endDate,
  );
  const saved = await db.commit((handle) =>
    insertReportSnapshot(handle, result, {
      variety: variety ?? varietySnapshot(null),
      datasetId,
      name,
    }),
  );
  return { ...saved, existing: false };
}

/** Отчёт уже сохранён? Нужно для состояния кнопки «Сохранено». */
export function isReportSaved(db, result) {
  if (!db || !result) return false;
  return Boolean(findReportByKey(db.handle, computeResultKey(result)));
}

export { ENGINE_LOADER };
