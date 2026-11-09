import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync('index.html', 'utf8');
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/\bsrc=/.test(m[1])) new vm.Script(m[2]);
}
const fn = html.slice(html.indexOf('function renderRainTiming('), html.indexOf('let AREA_ELEV='));
const elements = { rainTiming: {}, rainTimingMeta: {} };
const context = { Intl, Date, Number, Math, $: id => elements[id], fmt: n => n.toFixed(1) };
vm.createContext(context);
vm.runInContext(fn, context);
context.renderRainTiming({
  time: ['2026-11-05T14:00', '2026-11-05T15:00', '2026-11-05T16:00', '2026-11-05T23:00'],
  precipitation: [1, 2, 0, 1], precipitation_probability: [70, 80, 0, 60],
}, new Date('2026-11-05T14:30:00+07:00'));
assert.match(elements.rainTiming.textContent, /14:00–16:00/);
assert.match(elements.rainTiming.textContent, /23:00–24:00/);
context.renderRainTiming({}, new Date());
assert.match(elements.rainTiming.textContent, /ไม่เพียงพอ/);
console.log('Inline script syntax and rain window checks passed');
const dateFunction = html.slice(html.indexOf('function formatWaterHistoryTime('), html.indexOf('/* ===== แนวโน้มจากข้อมูลฝั่งเซิร์ฟเวอร์'));
vm.runInContext(dateFunction, context);
const label = context.formatWaterHistoryTime('2026-11-04T17:30:00.000Z');
assert.match(label, /05\/11\/2569/);
assert.match(label, /00:30/);
console.log('Thai history date and midnight timezone checks passed');
const sparklineFunction = html.slice(html.indexOf('function wlSparkline('), html.indexOf('function formatWaterHistoryTime('));
context.WL_HISTORY = Array.from({ length: 25 }, (_, i) => ({
  key: 'janah', datetime: new Date(Date.UTC(2026, 10, i + 1)).toISOString(), msl: 2 + i / 100,
}));
context.isFinite = isFinite;
context.parseFloat = parseFloat;
vm.runInContext(sparklineFunction, context);
const graph = context.wlSparkline('janah', 4.75);
assert.match(graph, /20\/20 จุดล่าสุด/);
assert.equal(graph.match(/points="([^"]+)"/)[1].split(' ').length, 20);
console.log('History chart shows latest 20 points across more than 36 hours');

const { updateHistory } = await import('./update-flood-data.mjs');
const history = Array.from({ length: 25 }, (_, i) => ({
  key: 'janah', datetime: new Date(Date.now() - (30 - i) * 86400000).toISOString(), msl: 2,
}));
assert.equal(updateHistory(history, {}).length, 20);
console.log('History retention preserves 20 points even beyond 48 hours');
const mergeFunction = html.slice(html.indexOf('function waterSeries('), html.indexOf('async function loadWaterLevel('));
context.Map = Map;
context.WL_LATEST = null;
context.parseT = value => new Date(value.includes('Z') ? value : value.replace(' ', 'T') + '+07:00');
vm.runInContext(mergeFunction, context);
context.WL_HISTORY = [
  { key: 'janah', datetime: '2026-11-09T00:30:00Z', msl: 2.64 },
  { key: 'janah', datetime: '2026-11-09T04:30:00Z', msl: 2.60 },
  { key: 'janah', datetime: '2026-11-09T05:30:00Z', msl: 9 },
  { key: 'nathawi', datetime: '2026-11-09T00:30:00Z', msl: 20.30 },
];
const current = new Date('2026-11-09T11:30:00+07:00');
const series = context.waterSeries('janah', [], current, 2.57);
assert.equal(series.length, 2);
assert.equal(series.at(-1).t, current.getTime());
assert.equal(series.at(-1).v, 2.57);
const mergedGraph = context.wlSparkline('janah', 4.75, series);
assert.match(mergedGraph, /09\/11\/2569 11:30/);
const trendFunction = html.slice(html.indexOf('function wlTrend(h)'), html.indexOf('// สร้าง badge'));
context.WL_REF_WIN = 6 * 3600000;
context.WL_TREND_MIN = 0.02;
vm.runInContext(trendFunction, context);
const trend = context.wlTrend(series);
assert.equal(trend.dir, 'down');
assert.ok(Math.abs(trend.dCm + 7) < 1e-8);
assert.equal(trend.dt, 4);
assert.equal(context.waterSeries('janah', [], null, 2.57).length, 0);
console.log('Latest card reading, graph endpoint and trend use identical values and timestamps');
