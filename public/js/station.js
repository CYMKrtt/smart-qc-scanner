import { Detector, buildSample, compare, learnNoise, tolerances, renderHeatmap, DEFECT_LABELS } from './vision.js';
import { ConveyorSim, SIM_DEFECTS } from './simulator.js';
import { Signal, ICE_SERVERS } from './signaling.js';
import { TeachableAI } from './ai.js';

const $ = (id) => document.getElementById(id);
const view = $('view'), vctx = view.getContext('2d');
const video = document.createElement('video');
video.muted = true; video.playsInline = true; video.autoplay = true;
video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
document.body.appendChild(video); // keep it in the DOM so frames keep decoding

// processing canvases
const PROC_W = 400, HI_W = 800;
const proc = document.createElement('canvas'), pctx = proc.getContext('2d', { willReadFrequently: true });
const hi = document.createElement('canvas'), hctx = hi.getContext('2d', { willReadFrequently: true });
const det = new Detector(PROC_W, 180);

const S = {
  source: null, stream: null, sim: null, signal: null, pc: null, cameraPeer: null,
  aspect: 0, goldens: [], noise: null, mode: 'rule', sens: 1, paused: false,
  teachNext: 0, last: null, lastDet: null, mark: null, history: [],
  session: { total: 0, pass: 0, fail: 0, labeled: 0, correct: 0 },
  fps: 0, frames: 0, fpsT: performance.now(), audio: null,
};
const ai = new TeachableAI();
const line = () => $('line').value.trim() || 'line-1';

// ---------------------------------------------------------------- UI helpers
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function setSrcStatus(text, ok) { $('srcStatus').textContent = text; $('srcDot').className = 'dot' + (ok === true ? ' on' : ok === 'warn' ? ' warn' : ''); }
function steps() {
  $('st1').classList.toggle('done', !!S.source && S.aspect > 0);
  $('st2').classList.toggle('done', !!det.bg);
  $('st3').classList.toggle('done', S.goldens.length > 0 || ai.trained());
  $('st4').classList.toggle('done', S.session.total > 0);
}
function beep(fail) {
  if (!$('sound').checked) return;
  try {
    S.audio ||= new AudioContext();
    const ctx = S.audio, now = ctx.currentTime;
    const tones = fail ? [[220, 0], [180, 0.18]] : [[880, 0]];
    for (const [f, t0] of tones) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = fail ? 'square' : 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + t0);
      g.gain.exponentialRampToValueAtTime(fail ? 0.25 : 0.06, now + t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t0 + (fail ? 0.16 : 0.07));
      o.connect(g).connect(ctx.destination); o.start(now + t0); o.stop(now + t0 + 0.2);
    }
  } catch { /* audio not available */ }
}
function segSelect(seg, attr, value) { for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset[attr] === value); }

// ---------------------------------------------------------------- sources
async function stopSource() {
  S.stream?.getTracks().forEach(t => t.stop());
  S.sim?.stop(); S.sim = null;
  S.pc?.close(); S.pc = null;
  S.signal?.close(); S.signal = null;
  S.stream = null; video.srcObject = null; S.aspect = 0; det.bg = null; det.state = 'nobg';
  $('simPanel').classList.add('hidden');
  $('camSelect').classList.add('hidden');
}

async function useSource(src, opts = {}) {
  await stopSource();
  S.source = src;
  segSelect($('srcSeg'), 'src', src);
  $('empty').style.display = 'none';
  if (src === 'sim') {
    S.sim = new ConveyorSim();
    applySimSettings();
    S.sim.start(); // the station reads the simulator canvas directly (calibrates on the empty belt)
    $('simPanel').classList.remove('hidden');
    setSrcStatus('Simulator กำลังทำงาน', true);
  } else if (src === 'webcam') {
    try {
      const deviceId = opts.deviceId || $('camSelect').value || undefined;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
      attach(stream);
      await listCameras(stream);
      setSrcStatus(`Webcam: ${stream.getVideoTracks()[0].label || 'camera'}`, true);
      toast('ให้พื้นที่ในกรอบว่างไว้ ระบบจะคาลิเบรตพื้นหลังอัตโนมัติ');
    } catch (e) {
      setSrcStatus(`เปิดกล้องไม่ได้: ${e.message}`, false);
      $('empty').style.display = '';
    }
  } else if (src === 'rtc') {
    startRtc();
  }
}

function attach(stream) {
  S.stream = stream;
  video.srcObject = stream;
  video.play().catch(() => {});
}

async function listCameras(stream) {
  const sel = $('camSelect');
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const cur = stream.getVideoTracks()[0].getSettings().deviceId;
  sel.innerHTML = devs.map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === cur ? 'selected' : ''}>${d.label || 'Camera ' + (i + 1)}</option>`).join('');
  sel.classList.toggle('hidden', devs.length < 2);
}

// ---- WebRTC receiver (phone camera → this station)
async function startRtc() {
  const info = await fetch('/api/info').then(r => r.json()).catch(() => ({ ips: [] }));
  const host = info.publicUrl ? info.publicUrl : info.httpsPort && info.ips[0] ?`https://${info.ips[0]}:${info.httpsPort}` : location.origin;
  setSrcStatus(`รอกล้องมือถือ… เปิด ${host}/camera.html?room=${line()} บนมือถือ`, 'warn');
  $('empty').innerHTML = `รอกล้องมือถือเชื่อมต่อ…<br><span class="mono" style="color:var(--mint)">${host}/camera.html?room=${encodeURIComponent(line())}</span><br><span class="small">(หรือเปิดหน้าแรกเพื่อสแกน QR code)</span>`;
  $('empty').style.display = '';
  const pending = [];
  S.signal = new Signal(line(), 'station', async (m) => {
    if (m.type === 'welcome') {
      // ask any camera already in the room to (re)send an offer
      S.signal.send({ type: 'station-ready' });
    } else if (m.type === 'peer-left' && m.id === S.cameraPeer) {
      setSrcStatus('กล้องมือถือตัดการเชื่อมต่อ — รอเชื่อมต่อใหม่', 'warn');
    } else if (m.type === 'signal') {
      const d = m.data;
      if (d.type === 'offer') {
        S.pc?.close();
        pending.length = 0;
        S.cameraPeer = m.from;
        const pc = S.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pc.onicecandidate = (e) => e.candidate && S.signal.send({ type: 'candidate', candidate: e.candidate }, m.from);
        pc.ontrack = (e) => { attach(e.streams[0] || new MediaStream([e.track])); $('empty').style.display = 'none'; };
        pc.onconnectionstatechange = () => {
          const st = pc.connectionState;
          if (st === 'connected') {
            setSrcStatus(`กล้องมือถือเชื่อมต่อแล้ว (WebRTC)`, true);
            toast('ให้พื้นที่ในกรอบว่างไว้ ระบบจะคาลิเบรตพื้นหลังอัตโนมัติ');
          } else if (st === 'failed' || st === 'disconnected') setSrcStatus(`WebRTC: ${st}`, false);
        };
        await pc.setRemoteDescription(d.sdp);
        for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        await pc.setLocalDescription(await pc.createAnswer());
        S.signal.send({ type: 'answer', sdp: pc.localDescription, callId: d.callId }, m.from);
      } else if (d.type === 'candidate') {
        if (S.pc?.remoteDescription) await S.pc.addIceCandidate(d.candidate).catch(() => {});
        else pending.push(d.candidate);
      }
    }
  });
  S.signal.connect();
}

// ---------------------------------------------------------------- calibration / teaching
function calibrate() {
  if (!S.aspect) { toast('ยังไม่มีภาพจากกล้อง'); return; }
  det.startCalibration(20);
  toast('กำลังคาลิเบรตพื้นหลัง…', 1200);
}

function addGolden(sample) {
  S.goldens.push(sample);
  if (S.goldens.length > 5) S.goldens.shift();
  S.noise = S.goldens.length > 1 ? learnNoise(S.goldens) : null;
  renderGoldens();
  toast(`บันทึกชิ้นงานต้นแบบแล้ว (${S.goldens.length} ชิ้น)`);
  steps();
}
function renderGoldens() {
  const box = $('goldens');
  if (!S.goldens.length) { box.innerHTML = '<span class="small muted">ยังไม่มี — วางชิ้นงานดีในกรอบ แล้วกดปุ่มด้านล่าง</span>'; return; }
  box.innerHTML = '';
  for (const g of S.goldens) { const im = new Image(); im.src = g.thumbUrl ||= g.thumb.toDataURL('image/jpeg', 0.85); box.appendChild(im); }
}

// ---------------------------------------------------------------- main loop
// current frame source: the simulator canvas or the <video> (webcam / WebRTC)
function source() {
  if (S.sim) return { el: S.sim.canvas, w: S.sim.w, h: S.sim.h };
  if (video.srcObject && video.readyState >= 2 && video.videoWidth) return { el: video, w: video.videoWidth, h: video.videoHeight };
  return null;
}

function setupCanvases(src) {
  S.aspect = src.w / src.h;
  view.width = 960; view.height = Math.round(960 / S.aspect);
  hi.width = HI_W; hi.height = Math.round(HI_W / S.aspect);
  proc.width = PROC_W; proc.height = Math.round(PROC_W / S.aspect);
  det.resize(proc.width, proc.height);
  steps();
}

function tick() {
  S.sim?.step(performance.now());
  const src = source();
  if (!src) { drawIdle(); return; }
  if (!S.aspect || Math.abs(src.w / src.h - S.aspect) > 0.02) {
    setupCanvases(src);
    if (S.sim) calibrate(); else { clearTimeout(S.calibT); S.calibT = setTimeout(calibrate, 1500); }
  }

  hctx.drawImage(src.el, 0, 0, hi.width, hi.height);
  pctx.drawImage(hi, 0, 0, proc.width, proc.height);
  const img = pctx.getImageData(0, 0, proc.width, proc.height);
  const wasCalib = det.state === 'calibrating';
  const r = det.frame(img);
  if (wasCalib && r.state === 'idle') { toast('คาลิเบรตพื้นหลังเสร็จแล้ว ✓'); steps(); }
  S.lastDet = r;
  if (r.trigger && !S.paused) inspect(r);

  // fps
  S.frames++;
  const now = performance.now();
  if (now - S.fpsT > 1000) { S.fps = S.frames * 1000 / (now - S.fpsT); S.frames = 0; S.fpsT = now; }
  draw(r, src);
}

function draw(r, src) {
  const k = view.width / proc.width;
  vctx.drawImage(src.el, 0, 0, view.width, view.height);
  if ($('showMask').checked && det.bg) {
    const id = vctx.getImageData(0, 0, view.width, view.height);
    for (let y = 0; y < view.height; y++) for (let x = 0; x < view.width; x++) {
      if (det.mask[((y / k) | 0) * proc.width + ((x / k) | 0)]) { const i = (y * view.width + x) * 4; id.data[i] = 255; id.data[i + 1] *= 0.5; id.data[i + 2] = 255; }
    }
    vctx.putImageData(id, 0, 0);
  }
  // trigger zone
  const roi = det.roi;
  vctx.save();
  vctx.strokeStyle = '#8ff5b4'; vctx.lineWidth = 2; vctx.setLineDash([10, 6]);
  vctx.strokeRect(roi.x * view.width, roi.y * view.height, roi.w * view.width, roi.h * view.height);
  vctx.setLineDash([]);
  vctx.fillStyle = 'rgba(6,42,48,.8)'; vctx.fillRect(roi.x * view.width, roi.y * view.height - 24, 150, 24);
  vctx.fillStyle = '#8ff5b4'; vctx.font = '600 14px "IBM Plex Sans Thai", sans-serif';
  vctx.fillText('TRIGGER ZONE', roi.x * view.width + 8, roi.y * view.height - 7);
  // current object
  for (const tr of r.tracks || []) {
    vctx.strokeStyle = tr.inspected ? 'rgba(255,255,255,.45)' : '#4fd0e3'; vctx.lineWidth = 2;
    vctx.strokeRect(tr.box.x * k, tr.box.y * k, tr.box.w * k, tr.box.h * k);
  }
  // result marker
  if (S.mark && performance.now() < S.mark.until) {
    const b = S.mark.box, col = S.mark.pass ? '#3ddc84' : '#ff5a5f';
    vctx.strokeStyle = col; vctx.lineWidth = 4;
    vctx.strokeRect(b.x * k - 4, b.y * k - 4, b.w * k + 8, b.h * k + 8);
    vctx.fillStyle = col; vctx.fillRect(b.x * k - 4, b.y * k - 34, 110, 30);
    vctx.fillStyle = '#05221f'; vctx.font = '800 20px sans-serif';
    vctx.fillText(S.mark.pass ? '✓ PASS' : '✕ FAIL', b.x * k + 4, b.y * k - 12);
  }
  // drag preview
  if (drag) {
    vctx.strokeStyle = '#fff'; vctx.setLineDash([4, 4]);
    vctx.strokeRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0);
  }
  vctx.restore();
  const label = { nobg: 'ยังไม่คาลิเบรต', calibrating: 'กำลังคาลิเบรต…', idle: 'รอชิ้นงาน', tracking: 'ติดตามชิ้นงาน', inspected: 'ตรวจแล้ว — รอชิ้นงานออก' }[r.state] || r.state;
  $('detStatus').textContent = `${label} · ${S.fps.toFixed(0)} fps${S.paused ? ' · หยุดตรวจ' : ''}`;
}
function drawIdle() {
  vctx.fillStyle = '#000'; vctx.fillRect(0, 0, view.width, view.height);
}

// ---------------------------------------------------------------- inspection
async function inspect(r) {
  const t0 = performance.now();
  const { box, sil } = det.silhouette(r.box);
  const sample = buildSample(hi, proc.width, proc.height, box, sil);
  const truthItem = S.sim?.truthAt((r.box.x + r.box.w / 2) / proc.width);
  const truth = truthItem ? (truthItem.defect ? 'defect' : 'good') : null;
  S.lastSample = sample;
  $('aiGood').disabled = $('aiBad').disabled = !ai.ready;

  if (S.teachNext > 0) {
    if (truth === 'defect') { toast('ข้ามชิ้นนี้ (Simulator เฉลยว่าเป็นของเสีย)'); return; }
    S.teachNext--;
    addGolden(sample);
    S.mark = { box: r.box, pass: true, until: performance.now() + 900 };
    return;
  }

  const useRule = S.mode !== 'ai', useAI = S.mode !== 'rule';
  if (useRule && !S.goldens.length) { showNeedTeach('ยังไม่มีชิ้นงานต้นแบบ — กด “ใช้ชิ้นล่าสุดเป็นต้นแบบ” ถ้าชิ้นนี้เป็นของดี', sample); return; }
  if (useAI && !ai.trained() && S.mode === 'ai') { showNeedTeach('AI ยังไม่ได้สอน — ต้องมีตัวอย่างทั้ง “ดี” และ “เสีย”', sample); maybeAutoTeach(sample, truth); return; }

  let res = { pass: true, defects: [], score: 100, metrics: {}, ratios: null, heat: null, gold: null };
  const tol = tolerances(S.sens, S.noise);
  if (useRule) { res = compare(sample, S.goldens, tol); res.metrics.tol = tol; }
  let aiRes = null;
  if (useAI && ai.trained()) {
    aiRes = await ai.predict(sample.ai);
    if (aiRes.label === 'defect') {
      res.pass = false;
      if (!res.defects.includes('ai')) res.defects.push('ai');
      if (S.mode === 'ai') res.score = Math.round((1 - aiRes.confidence) * 100);
    } else if (S.mode === 'ai') res.score = Math.round(aiRes.confidence * 100);
  }
  maybeAutoTeach(sample, truth);
  const procMs = performance.now() - t0;

  // session stats
  const s = S.session;
  s.total++; res.pass ? s.pass++ : s.fail++;
  if (truth) { s.labeled++; if ((truth === 'defect') === !res.pass) s.correct++; }

  const heatCanvas = renderHeatmap(sample, res.heat);
  const entry = {
    ts: Date.now(), pass: res.pass, defects: res.defects, score: res.score, ratios: res.ratios,
    heatUrl: heatCanvas.toDataURL('image/jpeg', 0.85),
    goldUrl: res.gold ? (res.gold.thumbUrl ||= res.gold.thumb.toDataURL('image/jpeg', 0.85)) : null,
    ai: aiRes, truth, truthDefect: truthItem?.defect || null, procMs,
  };
  S.history.unshift(entry); S.history.length = Math.min(S.history.length, 40);
  showResult(entry);
  renderRecent();
  renderSession();
  steps();

  S.mark = { box: r.box, pass: res.pass, until: performance.now() + 1100 };
  const fl = $('flash');
  fl.className = 'flash ' + (res.pass ? 'pass' : 'fail');
  setTimeout(() => (fl.className = 'flash'), res.pass ? 250 : 700);
  beep(!res.pass);

  // report to server (dashboard) + tell the phone camera
  const body = {
    line: line(), result: res.pass ? 'PASS' : 'FAIL', defects: res.defects, score: res.score,
    metrics: res.metrics, procMs, mode: S.mode, truth, truthDefect: truthItem?.defect || null,
    image: sample.thumb.toDataURL('image/jpeg', 0.8), heatmap: res.pass ? null : entry.heatUrl,
  };
  fetch('/api/inspections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .catch(() => toast('ส่งข้อมูลไป Dashboard ไม่สำเร็จ'));
  if (S.signal && S.cameraPeer) S.signal.send({ type: 'result', pass: res.pass, defects: res.defects.map(d => DEFECT_LABELS[d]) }, S.cameraPeer);
}

function maybeAutoTeach(sample, truth) {
  if ($('aiAuto').checked && ai.ready && truth) { ai.add(sample.ai, truth); renderAI(); }
}

function showNeedTeach(msg, sample) {
  $('verdict').className = 'verdict idle'; $('verdict').textContent = 'รอสอน';
  $('defectList').innerHTML = `<span class="small muted">${msg}</span>`;
  $('heatBox').innerHTML = ''; $('heatBox').appendChild(sample.thumb);
  $('goldBox').innerHTML = ''; $('meters').innerHTML = ''; $('score').textContent = '–';
}

function showResult(e) {
  $('verdict').className = 'verdict ' + (e.pass ? 'pass' : 'fail');
  $('verdict').textContent = e.pass ? 'PASS ✓' : 'FAIL ✕';
  $('score').textContent = Math.round(e.score);
  $('lastTime').textContent = new Date(e.ts).toLocaleTimeString('th-TH') + ` · ${e.procMs.toFixed(0)} ms`;
  $('defectList').innerHTML = e.defects.length
    ? e.defects.map(d => `<span class="badge fail">${DEFECT_LABELS[d] || d}</span>`).join('')
    : '<span class="badge pass">ไม่พบตำหนิ</span>';
  if (e.truth) {
    const ok = (e.truth === 'defect') === !e.pass;
    $('defectList').innerHTML += `<span class="small muted" style="margin-left:auto">เฉลย: ${e.truthDefect ? SIM_DEFECTS[e.truthDefect] : 'ของดี'} ${ok ? '✓' : '✗ ผิด'}</span>`;
  }
  $('heatBox').innerHTML = `<img src="${e.heatUrl}">`;
  $('goldBox').innerHTML = e.goldUrl ? `<img src="${e.goldUrl}">` : '<span class="small muted">—</span>';
  const names = { size: 'ขนาด', shape: 'รูปร่าง', surface: 'ผิว/ตำหนิ', color: 'สี' };
  $('meters').innerHTML = e.ratios ? Object.entries(names).map(([k, n]) => {
    const v = e.ratios[k], w = Math.min(100, v * 50);
    return `<div class="meter"><span>${n}</span><span class="bar"><i class="${v > 1 ? 'over' : ''}" style="width:${w}%"></i></span><span class="mono">${(v * 100).toFixed(0)}%</span></div>`;
  }).join('') + '<div class="small muted">เส้นกลาง = เกณฑ์ (100%) · เกินเส้น = ไม่ผ่าน</div>' : '';
  $('aiLine').textContent = e.ai ? `AI: ${e.ai.label === 'good' ? 'ดี' : 'เสีย'} (ความมั่นใจ ${(e.ai.confidence * 100).toFixed(0)}%)` : '';
}

function renderRecent() {
  const box = $('recent');
  box.innerHTML = '';
  S.history.forEach((e) => {
    const f = document.createElement('figure');
    f.className = e.pass ? '' : 'fail';
    f.innerHTML = `<img src="${e.heatUrl}" title="${e.pass ? 'PASS' : 'FAIL: ' + e.defects.map(d => DEFECT_LABELS[d]).join(', ')}">`;
    f.onclick = () => showResult(e);
    box.appendChild(f);
  });
}
function renderSession() {
  const s = S.session;
  $('sTotal').textContent = s.total; $('sPass').textContent = s.pass; $('sFail').textContent = s.fail;
  $('sYield').textContent = s.total ? `${(s.pass / s.total * 100).toFixed(1)}%` : '–';
  $('accLine').textContent = s.labeled ? `ความแม่นยำเทียบเฉลย Simulator: ${(s.correct / s.labeled * 100).toFixed(1)}% (${s.correct}/${s.labeled} ชิ้น)` : '';
}
function renderAI() {
  $('aiStatus').textContent = ai.ready ? `พร้อม · ตัวอย่าง ดี ${ai.counts.good} / เสีย ${ai.counts.defect}` : 'ยังไม่โหลด';
  $('aiClear').disabled = !ai.ready;
  steps();
}

// ---------------------------------------------------------------- ROI drag
let drag = null;
function evPos(e) {
  const r = view.getBoundingClientRect();
  return [(e.clientX - r.left) * view.width / r.width, (e.clientY - r.top) * view.height / r.height];
}
view.addEventListener('pointerdown', (e) => { const [x, y] = evPos(e); drag = { x0: x, y0: y, x1: x, y1: y }; view.setPointerCapture(e.pointerId); });
view.addEventListener('pointermove', (e) => { if (!drag) return; const [x, y] = evPos(e); drag.x1 = x; drag.y1 = y; });
view.addEventListener('pointerup', () => {
  if (!drag) return;
  const x = Math.min(drag.x0, drag.x1) / view.width, y = Math.min(drag.y0, drag.y1) / view.height;
  const w = Math.abs(drag.x1 - drag.x0) / view.width, h = Math.abs(drag.y1 - drag.y0) / view.height;
  drag = null;
  if (w < 0.1 || h < 0.1) return;
  det.roi = { x, y, w, h };
  det.state = det.bg ? 'idle' : det.state;
  try { localStorage.setItem('qc.roi', JSON.stringify(det.roi)); } catch { /* ignore */ }
  toast('ตั้งกรอบตรวจใหม่แล้ว');
});

// ---------------------------------------------------------------- controls
function applySimSettings() {
  const sp = +$('simSpeed').value, rate = +$('simRate').value, gap = +$('simGap').value;
  $('vSpeed').textContent = `${sp} px/s`; $('vRate').textContent = `${rate}%`; $('vGap').textContent = `${gap} px`;
  if (S.sim) { S.sim.speed = sp; S.sim.defectRate = rate / 100; S.sim.spacing = gap; }
}
for (const id of ['simSpeed', 'simRate', 'simGap']) $(id).addEventListener('input', applySimSettings);
$('simPause').onclick = () => { if (!S.sim) return; S.sim.paused = !S.sim.paused; $('simPause').textContent = S.sim.paused ? '▶ เดินสายพาน' : '⏸ หยุดสายพาน'; };

$('srcSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) useSource(b.dataset.src); });
$('camSelect').addEventListener('change', () => useSource('webcam', { deviceId: $('camSelect').value }));
$('calibBtn').onclick = calibrate;
$('pauseBtn').onclick = () => { S.paused = !S.paused; $('pauseBtn').textContent = S.paused ? '▶ เริ่มตรวจ' : '⏸ หยุดตรวจ'; };
$('teachLast').onclick = () => { if (!S.lastSample) return toast('ยังไม่มีชิ้นงานที่ถูกจับภาพ — ให้ชิ้นงานผ่าน/วางในกรอบก่อน'); addGolden(S.lastSample); };
$('teachNext').onclick = () => { S.teachNext = 1; toast('ชิ้นถัดไปที่เข้ากรอบจะถูกบันทึกเป็นต้นแบบ'); };
$('clearGold').onclick = () => { S.goldens = []; S.noise = null; renderGoldens(); steps(); };
$('resetSession').onclick = () => { S.session = { total: 0, pass: 0, fail: 0, labeled: 0, correct: 0 }; S.history = []; renderSession(); renderRecent(); };
$('modeSeg').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.mode = b.dataset.mode; segSelect($('modeSeg'), 'mode', S.mode);
  if (S.mode !== 'rule') { $('aiDetails').open = true; if (!ai.ready) $('aiLoad').click(); }
});
$('sens').oninput = () => { S.sens = $('sens').value / 100; $('vSens').textContent = `${S.sens.toFixed(2)}×`; };
$('diff').oninput = () => { det.diffThresh = +$('diff').value; $('vDiff').textContent = $('diff').value; };
$('aiLoad').onclick = async () => {
  $('aiLoad').disabled = true; $('aiStatus').textContent = 'กำลังโหลดโมเดล… (ครั้งแรกอาจใช้เวลา 10–30 วินาที)';
  try { await ai.load(); renderAI(); $('aiGood').disabled = $('aiBad').disabled = !S.lastSample; toast('โหลด AI สำเร็จ'); }
  catch (err) { $('aiStatus').textContent = `โหลดไม่สำเร็จ: ${err.message}`; $('aiLoad').disabled = false; }
};
$('aiGood').onclick = () => { if (S.lastSample) { ai.add(S.lastSample.ai, 'good'); renderAI(); } };
$('aiBad').onclick = () => { if (S.lastSample) { ai.add(S.lastSample.ai, 'defect'); renderAI(); } };
$('aiClear').onclick = () => { ai.clear(); renderAI(); };
$('line').addEventListener('change', () => { if (S.source === 'rtc') useSource('rtc'); });

$('demoBtn').onclick = async () => {
  S.goldens = []; S.noise = null; renderGoldens();
  S.mode = 'rule'; segSelect($('modeSeg'), 'mode', 'rule');
  $('resetSession').click();
  await useSource('sim');
  S.sim.forceGood(2);
  S.teachNext = 2;
  toast('เดโม: ระบบจะสอนชิ้นงานดี 2 ชิ้นแรกเป็นต้นแบบ แล้วเริ่มตรวจอัตโนมัติ', 4500);
};

// ---------------------------------------------------------------- boot
try { const roi = JSON.parse(localStorage.getItem('qc.roi')); if (roi?.w) det.roi = roi; } catch { /* ignore */ }
const params = new URLSearchParams(location.search);
if (params.get('line')) $('line').value = params.get('line');
$('sens').oninput(); $('diff').oninput(); applySimSettings();
segSelect($('modeSeg'), 'mode', 'rule');
$('simPanel').classList.add('hidden');
renderSession(); steps();
drawIdle();

// Drive the loop from a worker timer so it keeps running when the tab is in the background
const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 40)'], { type: 'text/javascript' })));
let busy = false;
ticker.onmessage = () => {
  if (busy) return;
  busy = true;
  try { tick(); } finally { busy = false; }
  if (performance.now() - (S.beatT || 0) > 3000) { S.beatT = performance.now(); heartbeat(); }
};

// heartbeat → dashboard
function heartbeat() {
  const status = !S.source ? 'offline' : S.paused ? 'paused' : det.bg ? 'running' : 'setup';
  fetch('/api/station', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: line(), status, source: S.source || '', fps: S.fps }) }).catch(() => {});
}

if (params.get('demo') === '1') $('demoBtn').click();
