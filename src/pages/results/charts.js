/**
 * Графики результата: температура (линия с лёгкой заливкой) и осадки (столбцы).
 *
 * Подписи оси X сокращаются по ширине контейнера, чтобы на длинном периоде
 * (6 месяцев) текст не обрезался и не налезал друг на друга.
 */

import { Chart } from "chart.js/auto";
import { fmtDateAxis, fmtDateRu, fmtNum } from "../../lib/format.js";

const GREEN = "#16834a";
const GREEN_FILL = "rgba(22, 131, 74, 0.1)";
const GREEN_BAR = "rgba(22, 131, 74, 0.72)";
const GRID = "rgba(223, 231, 225, 0.9)";
const TICK_COLOR = "#58695e";
const BORDER = "#dfe7e1";

Chart.defaults.font.family = "Inter, 'Segoe UI', Arial, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = TICK_COLOR;

function reducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Сколько подписей дат помещается без обрезки. */
function maxTicksFor(width, perLabel = 64) {
  return Math.max(3, Math.min(12, Math.floor((width || 640) / perLabel)));
}

function baseOptions({ series, yTitle, unit }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: reducedMotion() ? false : { duration: 260 },
    interaction: { mode: "index", intersect: false },
    layout: { padding: { top: 4, right: 4, bottom: 0, left: 0 } },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#ffffff",
        borderColor: BORDER,
        borderWidth: 1,
        titleColor: "#18271e",
        bodyColor: "#18271e",
        padding: 8,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 8,
        usePointStyle: true,
        callbacks: {
          title: (items) => {
            const index = items[0]?.dataIndex ?? 0;
            return fmtDateRu(series[index]?.date);
          },
          label: (item) => {
            const raw = item.parsed?.y;
            const value = typeof raw === "number" && Number.isFinite(raw) ? fmtNum(raw, item.dataset.decimals ?? 1) : "—";
            return `${item.dataset.label}: ${value} ${unit}`.trimEnd();
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: BORDER },
        ticks: {
          maxRotation: 0,
          autoSkip: true,
          includeBounds: false,
          callback(value, index) {
            const label = this.getLabelForValue(value);
            const total = series.length;
            const limit = maxTicksFor(this.width);
            if (total <= limit) return label;
            const step = Math.ceil(total / limit);
            return index % step === 0 ? label : "";
          },
        },
      },
      y: {
        title: { display: true, text: yTitle, color: TICK_COLOR, font: { size: 11, weight: "500" } },
        grid: { color: GRID, drawTicks: false },
        border: { display: false, dash: [2, 4] },
        ticks: { padding: 8, maxTicksLimit: 6 },
        grace: "6%",
      },
    },
  };
}

export function createForecastCharts() {
  let temperatureChart = null;
  let precipitationChart = null;
  let series = [];

  function labels() {
    return series.map((day) => fmtDateAxis(day.date));
  }

  function build(temperatureCanvas, precipitationCanvas) {
    destroy();
    if (series.length === 0) return;

    temperatureChart = new Chart(temperatureCanvas, {
      type: "line",
      data: {
        labels: labels(),
        datasets: [
          {
            label: "Средняя температура",
            data: series.map((day) => day.temperatureMean),
            borderColor: GREEN,
            borderWidth: 2,
            backgroundColor: GREEN_FILL,
            fill: "origin",
            tension: 0.28,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: GREEN,
            pointHoverBorderColor: "#ffffff",
            pointHoverBorderWidth: 2,
            decimals: 1,
          },
        ],
      },
      options: baseOptions({ series, yTitle: "°C", unit: "°C" }),
    });

    const rainOptions = baseOptions({ series, yTitle: "мм", unit: "мм" });
    precipitationChart = new Chart(precipitationCanvas, {
      type: "bar",
      data: {
        labels: labels(),
        datasets: [
          {
            label: "Осадки",
            data: series.map((day) => day.precipitationMm),
            backgroundColor: GREEN_BAR,
            hoverBackgroundColor: GREEN,
            borderRadius: 2,
            borderSkipped: "bottom",
            categoryPercentage: series.length > 60 ? 0.98 : 0.72,
            barPercentage: series.length > 60 ? 1 : 0.85,
            decimals: 1,
          },
        ],
      },
      options: {
        ...rainOptions,
        scales: {
          ...rainOptions.scales,
          y: { ...rainOptions.scales.y, beginAtZero: true },
        },
      },
    });
  }

  function destroy() {
    temperatureChart?.destroy();
    precipitationChart?.destroy();
    temperatureChart = null;
    precipitationChart = null;
  }

  return {
    render(temperatureCanvas, precipitationCanvas, nextSeries) {
      series = Array.isArray(nextSeries) ? nextSeries : [];
      build(temperatureCanvas, precipitationCanvas);
    },
    destroy,
    get alive() {
      return Boolean(temperatureChart || precipitationChart);
    },
  };
}
