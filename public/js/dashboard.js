import { DEFECT_LABELS } from './vision.js';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
let all = [];
let filter = 'all';
const stations = new Map();

const lineSel = () => $('lineSel').value;
const visible = () => (lineSel() ? all.filter(i => i.line === lineSel()) : all);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('th-TH');

// ---------------------------------------------------------------- tooltip
const tip = $('tip');
function showTip(e, html) { tip.innerHTML = html; tip.style.display = 'block'; tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY + 14}px`; }
function hideTip() { tip.style.display = 'none'; }
function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  parent?.appendChild(n);
  return n;
}

// ---------------------------------------------------------------- KPIs
function renderKpis(list) {
  const total = list.length, fail = list.filter(i => i.result === 'FAIL').length, pass = total - fail;
  $('kTotal').textContent = total.toLocaleString();
  $('kPass').textContent = pass.toLocaleString();
  $('kFail').textContent = fail.toLocaleString();
  $('kPassSub').textContent = total ? `${(pass / total * 100).toFixed(1)}%` : ' ';
  $('kFailSub').textContent = total ? `${(fail / total * 100).toFixed(1)}%` : ' ';
  $('kYield').textContent = total ? `${(pass / total * 100).toFixed(1)}%` : '–';
  const now = Date.now();
  $('kRate').textContent = list.filter(i => now - i.ts < 60000).length;
  const recent = list.slice(-200);
  $('kMs').textContent = recent.length ? (recent.reduce((s, i) => s + (i.procMs || 0), 0) / recent.length).toFixed(0) : '–';
  const labeled = list.filter(i => i.truth);
  const correct = labeled.filter(i => (i.truth === 'defect') === (i.result === 'FAIL')).length;
  $('kAcc').textContent = labeled.length ? `${(correct / labeled.length * 100).toFixed(1)}%` : '–';
  $('kAccSub').textContent = labeled.length ? `${correct}/${labeled.length} ชิ้นที่มีเฉลย` : 'ใช้ Simulator เพื่อวัด';
}

// ---------------------------------------------------------------- trend (stacked bars per minute)
function renderTrend(list) {
  const svg = $('trend');
  svg.innerHTML = '';
  const W = svg.clientWidth || 600, H = svg.clientHeight || 240;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const M = { l: 36, r: 8, t: 10, b: 24 };
  const bins = 30, now = Date.now(), start = Math.floor(now / 60000) * 60000 - (bins - 1) * 60000;
  const data = Array.from({ length: bins }, (_, i) => ({ t: start + i * 60000, pass: 0, fail: 0 }));
  for (const it of list) {
    const k = Math.floor((it.ts - start) / 60000);
    if (k >= 0 && k < bins) data[k][it.result === 'FAIL' ? 'fail' : 'pass']++;
  }
  const max = Math.max(4, ...data.map(d => d.pass + d.fail));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (v) => M.t + (H - M.t - M.b) * (1 - v / top);
  for (let v = 0; v <= top; v += step) {
    el('line', { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), stroke: v === 0 ? '#3b7a82' : '#1d5960', 'stroke-width': 1 }, svg);
    const t = el('text', { x: M.l - 6, y: y(v) + 4, 'text-anchor': 'end', fill: '#7fa3a5', 'font-size': 11 }, svg); t.textContent = v;
  }
  const bw = (W - M.l - M.r) / bins;
  data.forEach((d, i) => {
    const x = M.l + i * bw + 2, w = Math.max(2, bw - 4);
    const yp = y(d.pass), yf = y(d.pass + d.fail);
    if (d.pass) el('rect', { x, y: yp, width: w, height: y(0) - yp, fill: '#3ddc84', rx: 2 }, svg);
    if (d.fail) el('rect', { x, y: yf, width: w, height: Math.max(0, yp - yf - (d.pass ? 2 : 0)), fill: '#ff5a5f', rx: 2 }, svg);
    if (i % 5 === 4 || i === bins - 1) {
      const t = el('text', { x: x + w / 2, y: H - 6, 'text-anchor': 'middle', fill: '#7fa3a5', 'font-size': 11 }, svg);
      t.textContent = new Date(d.t).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    }
    const hit = el('rect', { x: M.l + i * bw, y: M.t, width: bw, height: H - M.t - M.b, fill: 'transparent' }, svg);
    hit.addEventListener('mousemove', (e) => {
      const tot = d.pass + d.fail;
      showTip(e, `<b>${new Date(d.t).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</b><br>✓ ผ่าน ${d.pass} · ✕ ไม่ผ่าน ${d.fail}${tot ? `<br>Yield ${(d.pass / tot * 100).toFixed(0)}%` : ''}`);
    });
    hit.addEventListener('mouseleave', hideTip);
  });
}
function niceStep(max) {
  const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

// ---------------------------------------------------------------- defect breakdown (horizontal bars)
function renderDefects(list) {
  const svg = $('defects');
  svg.innerHTML = '';
  const W = svg.clientWidth || 400, H = svg.clientHeight || 240;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const counts = {};
  for (const i of list) for (const d of i.defects || []) counts[d] = (counts[d] || 0) + 1;
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const totalFail = list.filter(i => i.result === 'FAIL').length;
  $('defTotal').textContent = totalFail ? `${totalFail} ชิ้นที่ไม่ผ่าน` : '';
  if (!rows.length) {
    const t = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#7fa3a5', 'font-size': 14 }, svg);
    t.textContent = 'ยังไม่พบตำหนิ';
    return;
  }
  const max = rows[0][1], labelW = Math.min(170, W * 0.45), rh = Math.min(40, (H - 10) / rows.length);
  rows.forEach(([k, v], i) => {
    const yy = 6 + i * rh, bh = Math.min(16, rh - 10);
    const lab = el('text', { x: 0, y: yy + rh / 2 - 2, fill: '#b4cfcf', 'font-size': 12.5 }, svg);
    lab.textContent = DEFECT_LABELS[k] || k;
    const w = Math.max(4, (W - labelW - 44) * v / max);
    el('rect', { x: labelW, y: yy + rh / 2 - bh / 2 - 6, width: w, height: bh, fill: '#4fd0e3', rx: 4 }, svg);
    const val = el('text', { x: labelW + w + 6, y: yy + rh / 2 - 2, fill: '#eef7f6', 'font-size': 12.5, 'font-weight': 600 }, svg);
    val.textContent = v;
    const hit = el('rect', { x: 0, y: yy, width: W, height: rh, fill: 'transparent' }, svg);
    hit.addEventListener('mousemove', (e) => showTip(e, `<b>${esc(DEFECT_LABELS[k] || k)}</b><br>${v} ครั้ง${totalFail ? ` · ${(v / totalFail * 100).toFixed(0)}% ของชิ้นที่ไม่ผ่าน` : ''}`));
    hit.addEventListener('mouseleave', hideTip);
  });
}

// ---------------------------------------------------------------- gallery + log
function renderGallery(list) {
  const fails = list.filter(i => i.result === 'FAIL').slice(-12).reverse();
  $('gallery').innerHTML = fails.length ? fails.map(i => `
    <figure>
      <img src="${i.heatmap || i.image || ''}" alt="">
      <figcaption><b style="color:#ff8b8f">✕ FAIL</b> · ${fmtTime(i.ts)} · ${esc(i.line)}<br>${i.defects.map(d => esc(DEFECT_LABELS[d] || d)).join(', ')}</figcaption>
    </figure>`).join('') : '<span class="small muted">ยังไม่มีของเสีย</span>';
}
function renderLog(list) {
  const rows = list.filter(i => filter === 'all' || i.result === filter).slice(-150).reverse();
  $('log').innerHTML = rows.map(i => `<tr>
    <td class="mono">${fmtTime(i.ts)}</td><td>${esc(i.line)}</td>
    <td><span class="badge ${i.result === 'PASS' ? 'pass' : 'fail'}">${i.result === 'PASS' ? '✓ PASS' : '✕ FAIL'}</span></td>
    <td>${i.defects.map(d => esc(DEFECT_LABELS[d] || d)).join(', ') || '–'}</td>
    <td class="num">${Math.round(i.score)}</td><td class="num">${Math.round(i.procMs)}</td><td class="small muted">${esc(i.mode)}</td></tr>`).join('');
}
function renderStations() {
  const now = Date.now();
  $('stations').innerHTML = [...stations.values()].map(s => {
    const alive = now - s.ts < 10000;
    const label = !alive ? 'ออฟไลน์' : { running: 'กำลังตรวจ', paused: 'หยุดชั่วคราว', setup: 'กำลังตั้งค่า', offline: 'ไม่มีกล้อง' }[s.status] || s.status;
    const src = { sim: 'Simulator', webcam: 'Webcam', rtc: 'มือถือ WebRTC' }[s.source] || '–';
    return `<span class="badge ${alive && s.status === 'running' ? 'pass' : 'idle'}"><span class="dot ${alive && s.status === 'running' ? 'on' : alive ? 'warn' : ''}"></span>${esc(s.line)} · ${label} · ${src}${alive ? ` · ${s.fps.toFixed(0)} fps` : ''}</span>`;
  }).join('');
}
function updateLines() {
  const lines = [...new Set(all.map(i => i.line).concat([...stations.keys()]))].sort();
  const cur = lineSel();
  $('lineSel').innerHTML = '<option value="">ทุกไลน์</option>' + lines.map(l => `<option ${l === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
}

let pending = false;
function render() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const list = visible();
    renderKpis(list); renderTrend(list); renderDefects(list); renderGallery(list); renderLog(list); renderStations();
  });
}

function alertFail(rec) {
  const a = $('alert');
  a.textContent = `✕ ${rec.line}: พบของเสีย — ${rec.defects.map(d => DEFECT_LABELS[d] || d).join(', ')}`;
  a.classList.add('show');
  clearTimeout(alertFail.t);
  alertFail.t = setTimeout(() => a.classList.remove('show'), 2500);
}

// ---------------------------------------------------------------- data
async function load() {
  all = await fetch('/api/inspections?limit=5000').then(r => r.json());
  updateLines(); render();
}
function live() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { $('live').className = 'dot on'; $('liveTxt').textContent = 'Real-time'; };
  es.onerror = () => { $('live').className = 'dot warn'; $('liveTxt').textContent = 'กำลังเชื่อมต่อใหม่…'; };
  es.addEventListener('inspection', (e) => {
    const rec = JSON.parse(e.data);
    all.push(rec);
    if (all.length > 20000) all = all.slice(-20000);
    if (!lineSel() || rec.line === lineSel()) { if (rec.result === 'FAIL') alertFail(rec); }
    if (![...$('lineSel').options].some(o => o.value === rec.line)) updateLines();
    render();
  });
  es.addEventListener('station', (e) => { const s = JSON.parse(e.data); const isNew = !stations.has(s.line); stations.set(s.line, s); if (isNew) updateLines(); render(); });
  es.addEventListener('reset', () => { all = []; render(); });
}

$('lineSel').onchange = render;
$('filterSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  filter = b.dataset.f;
  for (const x of $('filterSeg').querySelectorAll('button')) x.classList.toggle('on', x === b);
  render();
});
$('resetBtn').onclick = async () => {
  if (!confirm('ล้างข้อมูลการตรวจทั้งหมดบนเซิร์ฟเวอร์ (รวมรูปภาพ)?')) return;
  await fetch('/api/reset', { method: 'POST' });
};
window.addEventListener('resize', render);
setInterval(render, 5000); // keep "per minute" + station liveness fresh

load().then(live);
