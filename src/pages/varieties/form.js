/**
 * Форма сорта: модальное окно 640 px.
 *
 * Название и примечания — на всю ширину, короткие поля в две колонки.
 * Проверяются обязательность, формат и положительность чисел; научных
 * диапазонов для ФАО и вегетации нет сознательно. При ошибке введённые
 * значения сохраняются, при закрытии изменённой формы — предупреждение.
 */

import { h } from "../../lib/dom.js";
import { openModal } from "../../components/modal.js";
import { createButton } from "../../components/button.js";
import { createNumberField, createSelectField, createTextField, createTextareaField, varietyTypeOptions } from "../../components/field.js";
import { validateVariety, varietyToForm } from "../../services/validation.js";
import { insertVariety, updateVariety } from "../../services/repositories.js";
import { toast } from "../../components/toast.js";

export function openVarietyForm({ context, variety = null, onSaved }) {
  const initial = varietyToForm(variety ?? {});

  const nameField = createTextField({
    label: "Название",
    required: true,
    maxlength: 160,
    value: initial.name,
    placeholder: "Название сорта или гибрида",
  });

  const typeField = createSelectField({
    label: "Тип",
    options: varietyTypeOptions,
    value: initial.type,
  });

  const faoField = createNumberField({
    label: "ФАО",
    value: initial.fao,
    placeholder: "напр. 250",
    hint: "Целое положительное число",
  });

  const vegetationField = createNumberField({
    label: "Продолжительность вегетации, дней",
    value: initial.vegetationDays,
    placeholder: "напр. 115",
    hint: "Целое положительное число",
  });

  const breederField = createTextField({
    label: "Оригинатор",
    maxlength: 160,
    value: initial.breeder,
    placeholder: "Организация или селекционер",
  });

  const notesField = createTextareaField({
    label: "Примечания",
    value: initial.notes,
    maxlength: 2000,
    rows: 4,
    placeholder: "Необязательный текст",
  });

  const fields = {
    name: nameField,
    type: typeField,
    fao: faoField,
    vegetationDays: vegetationField,
    breeder: breederField,
    notes: notesField,
  };

  const readValues = () => ({
    name: nameField.getValue(),
    type: typeField.getValue(),
    fao: faoField.getValue(),
    vegetationDays: vegetationField.getValue(),
    breeder: breederField.getValue(),
    notes: notesField.getValue(),
  });

  const snapshotInitial = JSON.stringify(initial);
  const isDirty = () => JSON.stringify({ ...initial, ...readValues() }) !== snapshotInitial;

  const saveButton = createButton({ label: "Сохранить", tone: "primary", onClick: () => submit() });
  const cancelButton = createButton({ label: "Отмена", tone: "secondary", onClick: () => dialog.requestClose() });

  const form = h(
    "form",
    {
      class: "form-grid",
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        submit();
      },
    },
    [
    h("div", { class: "form-grid__full" }, [nameField]),
    typeField,
    faoField,
    vegetationField,
    breederField,
    h("div", { class: "form-grid__full" }, [notesField]),
  ]);
  const dialog = openModal({
    title: variety ? "Редактировать сорт" : "Добавить сорт",
    wide: true,
    body: form,
    actions: [cancelButton, saveButton],
    dirty: () => isDirty() && !saved,
  });

  let saved = false;

  function applyErrors(errors) {
    for (const [key, field] of Object.entries(fields)) {
      if (errors[key]) field.setError(errors[key]);
      else field.clearError();
    }
    const firstKey = Object.keys(errors)[0];
    if (firstKey) fields[firstKey].input?.focus?.();
  }

  async function submit() {
    const check = validateVariety(readValues());
    if (!check.ok) {
      applyErrors(check.errors);
      toast.error("Проверьте поля формы");
      return;
    }
    applyErrors({});

    saveButton.setLoading(true, "Сохраняем…");
    try {
      const record = await context.db.commit((handle) =>
        variety ? updateVariety(handle, variety.id, check.value) : insertVariety(handle, check.value),
      );
      saved = true;
      await context.refreshVarieties?.();
      toast.success("Изменения сохранены");
      onSaved?.(record);
      dialog.close();
    } catch (error) {
      console.error("Сорт не сохранён", error);
      saveButton.setLoading(false, "Сохранить");
      toast.error(error?.message ?? "Не удалось сохранить данные");
      // Введённые значения остаются в форме
      nameField.input.focus();
    }
  }

  window.requestAnimationFrame(() => nameField.input.focus());

  return { dialog };
}
