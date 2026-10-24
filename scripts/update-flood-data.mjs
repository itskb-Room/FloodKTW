// scripts/update-flood-data.mjs
// สร้าง data/latest.json สำหรับ "ระบบเฝ้าระวังน้ำท่วม ต.ขุนตัดหวาย"
// รันโดย GitHub Actions (Node 20+, มี global fetch) — ไม่ต้องติดตั้ง dependency ใด ๆ
//
// ดึง 5 แหล่ง: Open-Meteo ECMWF/ผสม, Open-Meteo GFS, MET Norway (Yr),
// thaiwater rain_24h (จะนะ/นาทวี), thaiwater waterlevel (สถานี 849/850)
// คำนวณ: พยากรณ์ฝน 24ชม./6ชม.ข้างหน้า (consensus+ช่วง), ฝนวัดจริงสูงสุด, ระดับน้ำคลอง,
// แล้วประเมินระดับความเสี่ยง (เอาค่าสูงสุดจาก 3 เกณฑ์) เขียนลง data/latest.json

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';

const LAT = 6.7936, LON = 100.7051, ELEV_M = 16;
const UA = 'FloodKTW/1.0 (+https://itskb-room.github.io/FloodKTW/)';
const FRESH_HOURS = 6; // ข้อมูลวัดจริงเก่ากว่านี้ = ไม่นับว่าปลอดภัย
const HISTORY_FILE = 'data/history-wl.json'; // เก็บประวัติระดับน้ำคลอง
const HISTORY_KEEP_HOURS = 48;               // เก็บย้อนหลังกี่ชั่วโมง
const RISE_WINDOWS = [1, 3, 6];              // คำนวณการเปลี่ยนแปลงในช่วง (ชม.)
const ALERT_STATE_FILE = 'data/alert-state.json'; // จำระดับที่แจ้งเตือนล่าสุด (กันเตือนซ้ำ)

const LABELS = ['ปกติ', 'เฝ้าระวัง', 'เสี่ยงสูง', 'อันตราย'];
const CODES  = ['normal', 'watch', 'high', 'danger'];

// ---------- helpers ----------
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// thaiwater คืนชื่อเป็น object {th, en} — ดึงเป็นข้อความไทย
const thName = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return v.th || v.en || '';
  return String(v);
};

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// แปลงสตริงเวลาเป็น Date — thaiwater เป็นเวลาไทย (ไม่มี timezone) จึงเติม +07:00
function parseThaiTime(s) {
  if (!s) return null;
  let str = String(s).trim();
  if (str.includes('T') && /[zZ]|[+\-]\d\d:?\d\d$/.test(str)) return new Date(str);
  str = str.replace(' ', 'T');
  if (!/[+\-]\d\d:?\d\d$/.test(str)) str += '+07:00';
  const d = new Date(str);
  return isNaN(d) ? null : d;
}
function ageHours(dtStr) {
  const d = parseThaiTime(dtStr);
  if (!d) return null;
  return +((Date.now() - d.getTime()) / 3.6e6).toFixed(1);
}

// ---------- forecast: Open-Meteo (เวลาเป็น Asia/Bangkok ไม่มี Z) ----------
function sumOpenMeteo(j, hours) {
  const t = j?.hourly?.time || [];
  const p = j?.hourly?.precipitation || [];
  if (!t.length) return null;
  const now = Date.now();
  let start = t.findIndex((ts) => new Date(ts + '+07:00').getTime() >= now);
  if (start < 0) start = 0;
  let sum = 0, n = 0;
  for (let i = start; i < Math.min(start + hours, p.length); i++) { sum += (num(p[i]) || 0); n++; }
  return n ? +sum.toFixed(1) : null;
}

// ---------- forecast: MET Norway (เวลา UTC) ----------
function sumMetno(j, hours) {
  const ts = j?.properties?.timeseries || [];
  const now = Date.now();
  let sum = 0, n = 0;
  for (const e of ts) {
    if (new Date(e.time).getTime() < now) continue;
    const amt = e?.data?.next_1_hours?.details?.precipitation_amount;
    if (amt === null || amt === undefined) continue;
    sum += Number(amt); n++;
    if (n >= hours) break;
  }
  return n ? +sum.toFixed(1) : null;
}

// ---------- thaiwater rain ----------
function parseRain(j) {
  const arr = j?.data || (Array.isArray(j) ? j : []);
  const pick = (amphoe) => arr.filter((s) => thName(s?.geocode?.amphoe_name).includes(amphoe));
  const summarize = (list) => {
    const vals = list
      .map((s) => ({
        name: thName(s?.station?.tele_station_name) || thName(s?.station?.station_name),
        rain_1h: num(s?.rain_1h),
        rain_24h: num(s?.rain_24h),
        datetime: s?.rainfall_datetime ?? null,
      }))
      .filter((v) => v.rain_24h !== null);
    if (!vals.length) return null;
    const max = vals.reduce((a, b) => (b.rain_24h > a.rain_24h ? b : a));
    const avg = +(vals.reduce((s, v) => s + v.rain_24h, 0) / vals.length).toFixed(1);
    return {
      max_mm: max.rain_24h, max_station: max.name, max_rain_1h: max.rain_1h,
      avg_mm: avg, datetime: max.datetime, age_hours: ageHours(max.datetime), station_count: vals.length,
    };
  };
  return { janah: summarize(pick('จะนะ')), nathawi: summarize(pick('นาทวี')) };
}

// ---------- thaiwater waterlevel ----------
function parseWL(j) {
  // โครงสร้างจริง: { waterlevel_data: { data: [...] }, ... }
  const arr = j?.waterlevel_data?.data || j?.data || (Array.isArray(j) ? j : []);
  const byId = (id) => arr.find((s) => String(s?.station?.id) === String(id));
  const one = (s) => {
    if (!s) return null;
    return {
      station: thName(s?.station?.tele_station_name) || thName(s?.station?.station_name),
      waterlevel_msl: num(s?.waterlevel_msl),
      waterlevel_msl_previous: num(s?.waterlevel_msl_previous),
      min_bank: num(s?.station?.min_bank),
      diff_wl_bank: num(s?.diff_wl_bank), // เหลืออีกกี่เมตรถึงตลิ่ง (ต่ำกว่าตลิ่ง = บวก)
      situation_level: s?.situation_level ?? null,
      datetime: s?.waterlevel_datetime ?? null,
      age_hours: ageHours(s?.waterlevel_datetime),
    };
  };
  return { janah: one(byId(849)), nathawi: one(byId(850)) };
}

// ---------- เกณฑ์ระดับ ----------
const fcLevel  = (mm) => (mm == null ? 0 : mm >= 120 ? 3 : mm >= 70 ? 2 : mm >= 35 ? 1 : 0);
const obsLevel = (mm) => (mm == null ? 0 : mm >= 90  ? 3 : mm >= 70 ? 2 : mm >= 35 ? 1 : 0);
const wlLevel  = (d)  => (d  == null ? 0 : d <= 0    ? 3 : d < 0.5  ? 2 : d < 1.0  ? 1 : 0);

function isFresh(ageH) { return ageH !== null && ageH <= FRESH_HOURS; }

// ---------- ประวัติระดับน้ำ (คำนวณว่าสูงขึ้นเท่าไหร่ จากเวลาใด) ----------
function loadHistory() {
  try {
    if (existsSync(HISTORY_FILE)) {
      const arr = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    }
  } catch { /* ไฟล์เสีย → เริ่มใหม่ */ }
  return [];
}

// บันทึก 1 จุดต่อเวลาวัดจริงของสถานี (ไม่ซ้ำ) และตัดของเก่าทิ้ง
function updateHistory(history, wl) {
  const fmtTH = (iso) => (iso ? new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : null);
  const push = (key, node) => {
    if (!node || node.waterlevel_msl == null || !node.datetime) return;
    const t = parseThaiTime(node.datetime);
    if (!t) return;
    const iso = t.toISOString();
    const last = [...history].reverse().find((h) => h.key === key);
    if (last && last.datetime === iso) return; // ค่าเวลาเดิม ไม่บันทึกซ้ำ
    history.push({ key, datetime: iso, datetime_th: fmtTH(iso), msl: node.waterlevel_msl, diff_wl_bank: node.diff_wl_bank });
  };
  push('janah', wl?.janah);
  push('nathawi', wl?.nathawi);
  const cutoff = Date.now() - HISTORY_KEEP_HOURS * 3.6e6;
  return history.filter((h) => new Date(h.datetime).getTime() >= cutoff);
}

// สร้างรายละเอียดการเปลี่ยนแปลงของคลองหนึ่ง ๆ
function computeRise(history, key, current) {
  if (!current || current.waterlevel_msl == null || !current.datetime) return null;
  const nowT = parseThaiTime(current.datetime);
  if (!nowT) return null;
  const nowMs = nowT.getTime();
  const series = history.filter((h) => h.key === key && new Date(h.datetime).getTime() <= nowMs)
                        .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  const fmtTH = (iso) => new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

  // เทียบกับค่าอ่านก่อนหน้าทันที
  const prev = series.length >= 2 ? series[series.length - 2] : null;
  const changes = {};
  for (const w of RISE_WINDOWS) {
    const target = nowMs - w * 3.6e6;
    // หาจุดที่เก่าที่สุดแต่ยังอยู่ในกรอบ w ชม. (จุดแรกที่ datetime >= target)
    const ref = series.find((h) => new Date(h.datetime).getTime() >= target);
    if (ref && ref.datetime !== nowT.toISOString()) {
      const delta = +(current.waterlevel_msl - ref.msl).toFixed(3);
      const hrs = +((nowMs - new Date(ref.datetime).getTime()) / 3.6e6).toFixed(1);
      changes[`${w}h`] = { delta_m: delta, over_hours: hrs, from_datetime: ref.datetime, from_datetime_th: fmtTH(ref.datetime), from_msl: ref.msl };
    } else {
      changes[`${w}h`] = null; // ยังไม่มีประวัติย้อนหลังพอ
    }
  }

  // แนวโน้มหลัก: ใช้ช่วง 3ชม. ถ้ามี ไม่งั้นใช้ค่าอ่านก่อนหน้า
  const basis = changes['3h'] || (prev ? { delta_m: +(current.waterlevel_msl - prev.msl).toFixed(3), over_hours: +((nowMs - new Date(prev.datetime).getTime()) / 3.6e6).toFixed(1), from_datetime: prev.datetime, from_datetime_th: fmtTH(prev.datetime), from_msl: prev.msl } : null);
  let trend = 'ไม่ทราบ (ยังเก็บประวัติไม่พอ)', detail = null;
  if (basis) {
    const d = basis.delta_m;
    trend = d > 0.02 ? 'สูงขึ้น' : d < -0.02 ? 'ลดลง' : 'ทรงตัว';
    const sign = d > 0 ? '+' : '';
    detail = `${trend} ${sign}${d} ม. ในช่วง ~${basis.over_hours} ชม. (จาก ${basis.from_datetime_th} น. ที่ ${basis.from_msl} ม.รทก. → ปัจจุบัน ${current.waterlevel_msl} ม.รทก.)`;
  }
  return { trend, detail, since_prev: prev ? { delta_m: +(current.waterlevel_msl - prev.msl).toFixed(3), from_datetime_th: fmtTH(prev.datetime) } : null, changes };
}

// ---------- แจ้งเตือนระดับน้ำผ่าน webhook ----------
// ส่ง POST {text, content} ไปยัง ALERT_WEBHOOK_URL (รองรับ Google Chat / Slack / Discord / LINE Messaging ผ่าน relay ฯลฯ)
async function sendWebhook(text) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) { console.log('[flood] ไม่ได้ตั้ง ALERT_WEBHOOK_URL — ข้ามการส่งจริง | ข้อความ:', text.replace(/\n/g, ' / ')); return false; }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
    if (!res.ok) { console.error('[flood] webhook ตอบ HTTP', res.status); return false; }
    return true;
  } catch (e) { console.error('[flood] webhook error:', String(e.message || e)); return false; }
}

// ประเมินว่าจะแจ้งเตือนหรือไม่ (เฉพาะตอน "ยกระดับ" ของน้ำคลอง — กันสแปมทุก 15 นาที)
async function maybeSendWaterAlert(out) {
  const w = out.waterlevel || {};
  const nodes = [['จะนะ', w.janah], ['นาทวี', w.nathawi]];
  let idx = 0; const lines = [];
  for (const [name, node] of nodes) {
    if (!node || node.diff_wl_bank == null) continue;
    const fresh = node.age_hours != null && node.age_hours <= FRESH_HOURS;
    const lvl = fresh ? wlLevel(node.diff_wl_bank) : 0; // ข้อมูลเก่า >6ชม. ไม่นับ (กันเตือนผิด)
    if (lvl > idx) idx = lvl;
    if (lvl >= 1 || node?.rise?.trend === 'สูงขึ้น') {
      const riseTxt = node?.rise?.detail ? ` | ${node.rise.detail}` : '';
      lines.push(`คลอง${name}: เหลือถึงตลิ่ง ${node.diff_wl_bank} ม. (${LABELS[lvl]})${riseTxt}`);
    }
  }

  // อ่านสถานะเดิม
  let prev = { index: -1 };
  try { if (existsSync(ALERT_STATE_FILE)) prev = JSON.parse(readFileSync(ALERT_STATE_FILE, 'utf8')); } catch { /* เริ่มใหม่ */ }

  // ส่งเมื่อ "ยกระดับ" จากเดิม (เช่น ปกติ→เฝ้าระวัง, เฝ้าระวัง→เสี่ยงสูง ...)
  const escalated = idx >= 1 && idx > (prev.index ?? -1);
  let sent = false, sentAt = prev.sent_at ?? null;
  if (escalated) {
    const msg = [
      `🌊 เตือนระดับน้ำคลองสูงขึ้น — ${out.location.name}`,
      `ระดับน้ำคลอง: ${LABELS[idx]}`,
      ...lines,
      `ความเสี่ยงรวม: ${out.risk.level}`,
      `เวลา: ${out.generated_at_th} น.`,
      `รายละเอียด: https://itskb-room.github.io/FloodKTW/`,
    ].join('\n');
    sent = await sendWebhook(msg);
    if (sent) sentAt = out.generated_at;
    console.log(`[flood] ALERT (${LABELS[idx]}) escalated — sent=${sent}`);
  }

  return {
    summary: { water_level_index: idx, water_level: LABELS[idx], escalated, sent, lines },
    stateToWrite: { index: idx, level: LABELS[idx], at: out.generated_at, sent_at: sentAt, lines },
  };
}

// ---------- main ----------
async function main() {
  const out = {
    generated_at: new Date().toISOString(),
    generated_at_th: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
    location: { name: 'ต.ขุนตัดหวาย อ.จะนะ จ.สงขลา', lat: LAT, lon: LON, elevation_m: ELEV_M },
    sources: {}, // สถานะดึงแต่ละแหล่ง
  };

  // ยิงทุกแหล่งพร้อมกัน
  const jobs = {
    ecmwf: getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=precipitation&forecast_days=4&timezone=Asia%2FBangkok`),
    gfs:   getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=precipitation&forecast_days=4&timezone=Asia%2FBangkok&models=gfs_seamless`),
    metno: getJSON(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${LAT}&lon=${LON}`),
    rain:  getJSON('https://api-v3.thaiwater.net/api/v1/thaiwater30/public/rain_24h?province_code=90'),
    wl:    getJSON('https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load?province_code=90'),
  };
  const r = Object.fromEntries(
    await Promise.all(Object.entries(jobs).map(async ([k, p]) => {
      try { return [k, { ok: true, data: await p }]; }
      catch (e) { return [k, { ok: false, error: String(e.message || e) }]; }
    }))
  );
  for (const k of Object.keys(r)) out.sources[k] = r[k].ok ? 'ok' : `error: ${r[k].error}`;

  // ---- พยากรณ์ 24ชม. / 6ชม. ----
  const f24 = {
    ecmwf: r.ecmwf.ok ? sumOpenMeteo(r.ecmwf.data, 24) : null,
    gfs:   r.gfs.ok   ? sumOpenMeteo(r.gfs.data, 24)   : null,
    metno: r.metno.ok ? sumMetno(r.metno.data, 24)     : null,
  };
  const f6 = {
    ecmwf: r.ecmwf.ok ? sumOpenMeteo(r.ecmwf.data, 6) : null,
    gfs:   r.gfs.ok   ? sumOpenMeteo(r.gfs.data, 6)   : null,
    metno: r.metno.ok ? sumMetno(r.metno.data, 6)     : null,
  };
  const vals24 = Object.values(f24).filter((v) => v !== null);
  const vals6  = Object.values(f6).filter((v) => v !== null);

  let consensus = null, min = null, max = null, agreement = 'ไม่มีข้อมูล', chosen = null;
  if (vals24.length) {
    min = Math.min(...vals24); max = Math.max(...vals24);
    const mean = +(vals24.reduce((a, b) => a + b, 0) / vals24.length).toFixed(1);
    consensus = mean;
    const spread = +(max - min).toFixed(1);
    if (vals24.length === 1) agreement = 'มีแหล่งเดียว';
    else if (spread <= 10)   agreement = `สอดคล้องกันดี (ช่วง ${spread} มม.)`;
    else if (spread <= 30)   agreement = `สอดคล้องปานกลาง (ช่วง ${spread} มม.)`;
    else                     agreement = `กระจายมาก (ช่วง ${spread} มม.)`;
    // "ค่าที่ปลอดภัยที่สุด": ถ้าสอดคล้องดีใช้ค่าเฉลี่ย ไม่งั้นใช้ค่าสูง
    chosen = spread <= 10 ? mean : max;
  }
  const max6 = vals6.length ? Math.max(...vals6) : null;

  out.forecast_24h = { by_source: f24, consensus_mm: consensus, min_mm: min, max_mm: max, chosen_mm: chosen, agreement, source_count: vals24.length };
  out.forecast_6h  = { by_source: f6, max_mm: max6 };

  // ---- ฝนวัดจริง ----
  out.rain_observed = r.rain.ok ? parseRain(r.rain.data) : { error: r.rain.error };

  // ---- ระดับน้ำคลอง + ประวัติ/แนวโน้ม ----
  out.waterlevel = r.wl.ok ? parseWL(r.wl.data) : { error: r.wl.error };
  let history = loadHistory();
  if (r.wl.ok) {
    history = updateHistory(history, out.waterlevel);
    if (out.waterlevel.janah)   out.waterlevel.janah.rise   = computeRise(history, 'janah',   out.waterlevel.janah);
    if (out.waterlevel.nathawi) out.waterlevel.nathawi.rise = computeRise(history, 'nathawi', out.waterlevel.nathawi);
  }

  // ---- ประเมินความเสี่ยง (เอาค่าสูงสุดของ 3 เกณฑ์) ----
  const reasons = [];
  let fLvl = fcLevel(chosen);
  if (chosen != null) reasons.push(`พยากรณ์ 24ชม. ${chosen} มม. → ${LABELS[fcLevel(chosen)]}`);
  if (max6 != null && max6 >= 60) { fLvl = 3; reasons.push(`พยากรณ์ 6ชม.ข้างหน้า ${max6} มม. (≥60) → อันตราย`); }

  const ro = out.rain_observed;
  const obsJ = ro?.janah, obsN = ro?.nathawi;
  const freshObsJ = obsJ && isFresh(obsJ.age_hours);
  const freshObsN = obsN && isFresh(obsN.age_hours);
  const oLvlJ = freshObsJ ? obsLevel(obsJ.max_mm) : 0;
  const oLvlN = freshObsN ? obsLevel(obsN.max_mm) : 0;
  if (obsJ) reasons.push(`ฝนจริงจะนะสูงสุด ${obsJ.max_mm} มม. (${obsJ.max_station}, เก่า ${obsJ.age_hours ?? '?'} ชม.)${freshObsJ ? '' : ' [เก่า>6ชม. ไม่นับเข้าเกณฑ์]'}`);
  if (obsN) reasons.push(`ฝนจริงนาทวีสูงสุด ${obsN.max_mm} มม. (${obsN.max_station}, เก่า ${obsN.age_hours ?? '?'} ชม.)${freshObsN ? '' : ' [เก่า>6ชม. ไม่นับเข้าเกณฑ์]'}`);

  const wl = out.waterlevel;
  const wlJ = wl?.janah, wlN = wl?.nathawi;
  const freshWlJ = wlJ && isFresh(wlJ.age_hours);
  const freshWlN = wlN && isFresh(wlN.age_hours);
  const wLvlJ = freshWlJ ? wlLevel(wlJ.diff_wl_bank) : 0;
  const wLvlN = freshWlN ? wlLevel(wlN.diff_wl_bank) : 0;
  const riseTxt = (node) => (node?.rise?.trend === 'สูงขึ้น' && node.rise.detail ? ` — ⬆ ${node.rise.detail}` : (node?.rise?.detail ? ` — ${node.rise.detail}` : ''));
  if (wlJ) reasons.push(`คลองจะนะเหลือถึงตลิ่ง ${wlJ.diff_wl_bank} ม. (เก่า ${wlJ.age_hours ?? '?'} ชม.)${freshWlJ ? '' : ' [เก่า>6ชม.]'}${riseTxt(wlJ)}`);
  if (wlN) reasons.push(`คลองนาทวีเหลือถึงตลิ่ง ${wlN.diff_wl_bank} ม. (เก่า ${wlN.age_hours ?? '?'} ชม.)${freshWlN ? '' : ' [เก่า>6ชม.]'}${riseTxt(wlN)}`);

  const overall = Math.max(fLvl, oLvlJ, oLvlN, wLvlJ, wLvlN);

  // freshness รวม (เฉพาะข้อมูลวัดจริง/ระดับน้ำ)
  const ages = [obsJ?.age_hours, obsN?.age_hours, wlJ?.age_hours, wlN?.age_hours].filter((a) => a != null);
  const dataFresh = ages.length ? ages.every((a) => a <= FRESH_HOURS) : false;

  // score ตาม methodology ของเว็บ (ฝนสะสม24 + 0.8×พยากรณ์24) — ไว้อ้างอิง
  const obsMax = Math.max(obsJ?.max_mm ?? 0, obsN?.max_mm ?? 0);
  const score = chosen != null ? +(obsMax + 0.8 * chosen).toFixed(1) : null;

  // ถ้าไม่มีพยากรณ์เลย + ไม่มีข้อมูลวัดจริง/ระดับน้ำที่สด → อย่ารายงานว่า "ปกติ" (กันเข้าใจผิดว่าปลอดภัย)
  const hasForecast = vals24.length > 0;
  const hasFreshObs = freshObsJ || freshObsN || freshWlJ || freshWlN;
  const insufficient = !hasForecast && !hasFreshObs;
  if (insufficient) reasons.push('⚠️ ดึงข้อมูลไม่ได้/ไม่มีค่าสด — ไม่สามารถประเมินได้ ห้ามตีความว่าปลอดภัย');

  out.risk = {
    level: insufficient ? 'ไม่ทราบ (ข้อมูลไม่พอ)' : LABELS[overall],
    level_code: insufficient ? 'unknown' : CODES[overall],
    level_index: insufficient ? -1 : overall,
    insufficient_data: insufficient,
    score,
    data_fresh: dataFresh,
    forecast_level: LABELS[fLvl],
    observed_level: LABELS[Math.max(oLvlJ, oLvlN)],
    waterlevel_level: LABELS[Math.max(wLvlJ, wLvlN)],
    reasons,
    note: 'ประเมินจากตัวเลข 3 เกณฑ์เท่านั้น — ยังต้องพิจารณาประกาศทางการ (TMD/สทนช./ปภ./ผู้ว่าฯ) ประกอบ ซึ่งไฟล์นี้ไม่ได้ดึงอัตโนมัติ. ไม่ใช่การเตือนภัยอย่างเป็นทางการ',
  };

  // ---- แจ้งเตือนอัตโนมัติเมื่อระดับน้ำคลองขึ้นข้ามเกณฑ์ ----
  const alertRes = await maybeSendWaterAlert(out);
  out.alert = alertRes.summary;

  mkdirSync('data', { recursive: true });
  writeFileSync('data/latest.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
  if (r.wl.ok) writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n', 'utf8');
  if (alertRes.stateToWrite) writeFileSync(ALERT_STATE_FILE, JSON.stringify(alertRes.stateToWrite, null, 2) + '\n', 'utf8');
  console.log(`[flood] ${out.risk.level} (${out.risk.level_code}) | fresh=${dataFresh} | sources:`, out.sources);
  if (out.waterlevel?.janah?.rise?.detail)   console.log('[flood] คลองจะนะ:', out.waterlevel.janah.rise.detail);
  if (out.waterlevel?.nathawi?.rise?.detail) console.log('[flood] คลองนาทวี:', out.waterlevel.nathawi.rise.detail);
}

// รัน main() เฉพาะเมื่อถูกเรียกเป็นสคริปต์หลัก (ทำให้ import มาทดสอบ function ได้)
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => { console.error('FATAL', e); process.exit(1); });
}

export { computeRise, updateHistory, loadHistory, parseThaiTime, ageHours, fcLevel, obsLevel, wlLevel, maybeSendWaterAlert, parseRain, parseWL, thName };
