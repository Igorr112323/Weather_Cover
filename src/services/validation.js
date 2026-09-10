/**
 * Проверка полей справочника сортов.
 *
 * Проверяются только формат, обязательность и положительность чисел.
 * Научных диапазонов для ФАО и вегетации здесь нет сознательно: их не задал
 * ни один справочник, а выдуманные границы отклоняли бы реальные сорта.
 */

export const VARIETY_TYPES = Object.freeze([
  { value: "sort", label: "Сорт" },
  { value: "hybrid", label: "Гибрид" },
]);

export const LIMITS = Object.freeze({
  nameMax: 160,
  breederMax: 160,
  notesMax: 2000,
});

export function typeLabel(value) {
  return VARIETY_TYPES.find((type) => type.value === value)?.label ?? "—";
}

function trimToNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

/**
 * Целое положительное число из поля формы.
 * @returns {{value:number|null, error:string|null}}
 */
export function parsePositiveInt(raw) {
  const text = trimToNull(raw);
  if (text === null) return { value: null, error: null };
  if (!/^\d+$/.test(text)) {
    return { value: null, error: "Целое положительное число" };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { value: null, error: "Целое положительное число" };
  }
  return { value, error: null };
}

/** @returns {{ok:boolean, value:object, errors:Record<string,string>}} */
export function validateVariety(input) {
  const errors = {};
  const name = trimToNull(input?.name);
  if (!name) errors.name = "Укажите название";
  else if (name.length > LIMITS.nameMax) errors.name = `Не более ${LIMITS.nameMax} символов`;

  const type = trimToNull(input?.type) ?? "sort";
  if (!VARIETY_TYPES.some((option) => option.value === type)) errors.type = "Выберите тип";

  const breeder = trimToNull(input?.breeder);
  if (breeder && breeder.length > LIMITS.breederMax) errors.breeder = `Не более ${LIMITS.breederMax} символов`;

  const fao = parsePositiveInt(input?.fao);
  if (fao.error) errors.fao = fao.error;

  const vegetation = parsePositiveInt(input?.vegetationDays);
  if (vegetation.error) errors.vegetationDays = vegetation.error;

  const notes = trimToNull(input?.notes);
  if (notes && notes.length > LIMITS.notesMax) errors.notes = `Не более ${LIMITS.notesMax} символов`;

  if (Object.keys(errors).length > 0) return { ok: false, value: null, errors };

  return {
    ok: true,
    errors: {},
    value: {
      name,
      type,
      breeder,
      fao: fao.value,
      vegetationDays: vegetation.value,
      notes,
    },
  };
}

/** Значение записи базы к плоскому виду формы. */
export function varietyToForm(variety) {
  return {
    name: variety?.name ?? "",
    type: variety?.type ?? "sort",
    breeder: variety?.breeder ?? "",
    fao: variety?.fao === null || variety?.fao === undefined ? "" : String(variety.fao),
    vegetationDays: (() => {
      const raw = variety?.vegetationDays ?? variety?.vegetation_days;
      return raw === null || raw === undefined ? "" : String(raw);
    })(),
    notes: variety?.notes ?? "",
  };
}
