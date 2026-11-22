import { lib, fontFiles } from './deps.mjs';

/**
 * Charts without a browser: ECharts renders SVG on the server, resvg turns it into PNG with the
 * bundled Roboto font (accented and non-English Latin letters included). The same chart can go into a PDF (as SVG), a
 * Word file or an Excel sheet (as PNG).
 *
 * spec: { type: 'bar'|'line'|'area'|'pie'|'doughnut'|'scatter', title, labels: [...],
 *         series: [{ name, values: [...] }], horizontal, stacked, width, height, locale }
 *   or  { echarts: <raw ECharts option> } for anything else.
 */
export function chartOption(spec = {}) {
  if (spec.echarts && typeof spec.echarts === 'object') return { animation: false, ...spec.echarts };
  const type = String(spec.type || 'bar').toLowerCase();
  const locale = spec.locale || 'en-US';
  const labels = (spec.labels || []).map(String);
  const series = (Array.isArray(spec.series) ? spec.series : spec.values ? [{ name: spec.title || '', values: spec.values }] : []).map((s, i) => ({ name: String(s.name ?? `Seri ${i + 1}`), values: (s.values || s.data || []).map((v) => (v === null || v === '' ? null : Number(v))) }));
  const fmt = (v) => (typeof v === 'number' ? v.toLocaleString(locale, { maximumFractionDigits: 2 }) : v);
  const base = {
    animation: false,
    backgroundColor: '#ffffff',
    textStyle: { fontFamily: 'Roboto' },
    title: spec.title ? { text: String(spec.title), left: 'center', top: 8, textStyle: { fontSize: 16, fontWeight: 500 } } : undefined,
    legend: series.length > 1 || type === 'pie' || type === 'doughnut' ? { bottom: 6, type: 'plain' } : undefined,
    grid: { left: 16, right: 24, top: spec.title ? 52 : 24, bottom: series.length > 1 ? 44 : 24, containLabel: true },
  };
  if (type === 'pie' || type === 'doughnut') {
    const s = series[0] || { name: '', values: [] };
    return {
      ...base,
      grid: undefined,
      series: [{ type: 'pie', name: s.name, radius: type === 'doughnut' ? ['40%', '68%'] : '68%', center: ['50%', '52%'], label: { formatter: (p) => `${p.name}: ${fmt(p.value)} (${p.percent.toLocaleString(locale, { maximumFractionDigits: 1 })}%)` }, data: labels.map((name, i) => ({ name, value: s.values[i] })) }],
    };
  }
  const horizontal = !!spec.horizontal;
  const category = { type: 'category', data: labels, axisLabel: { interval: labels.length > 12 ? 'auto' : 0, rotate: !horizontal && labels.length > 8 ? 30 : 0 } };
  const value = { type: 'value', axisLabel: { formatter: fmt } };
  if (type === 'scatter') {
    return { ...base, xAxis: { type: 'value', axisLabel: { formatter: fmt } }, yAxis: value, series: series.map((s) => ({ type: 'scatter', name: s.name, data: s.values.map((y, i) => [Number(labels[i]) || i, y]) })) };
  }
  return {
    ...base,
    xAxis: horizontal ? value : category,
    yAxis: horizontal ? category : value,
    series: series.map((s) => ({
      type: type === 'area' ? 'line' : type === 'line' ? 'line' : 'bar',
      name: s.name,
      data: s.values,
      ...(type === 'area' ? { areaStyle: {} } : {}),
      ...(spec.stacked ? { stack: 'total' } : {}),
      ...(spec.showValues || (series.length === 1 && labels.length <= 12 && type === 'bar') ? { label: { show: true, position: horizontal ? 'right' : 'top', formatter: (p) => fmt(p.value) } } : {}),
    })),
  };
}

export function chartSvg(spec = {}) {
  const echarts = lib('echarts');
  const width = clamp(spec.width, 200, 3000, 800);
  const height = clamp(spec.height, 150, 3000, 450);
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption(chartOption(spec));
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

export function chartPng(spec = {}) {
  const { Resvg } = lib('@resvg/resvg-js');
  const f = fontFiles();
  const scale = clamp(spec.scale, 1, 4, 2);
  const r = new Resvg(chartSvg(spec), {
    background: 'white',
    fitTo: { mode: 'zoom', value: scale },
    font: { fontFiles: [f.normal, f.bold], loadSystemFonts: false, defaultFontFamily: 'Roboto', sansSerifFamily: 'Roboto' },
  });
  return r.render().asPng();
}

function clamp(v, min, max, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
