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
