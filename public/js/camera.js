// Phone / remote camera: captures video and streams it to the QC station via WebRTC.
import { Signal, ICE_SERVERS } from './signaling.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.get('room')) $('room').value = params.get('room');

let callId = 0;
let stream = null, signal = null, pc = null, stationId = null, facing = 'environment', torch = false, wakeLock = null;
const pending = [];

function status(text, state) { $('status').textContent = text; $('dot').className = 'dot' + (state ? ' ' + state : ''); }

async function openCamera() {
  stream?.getTracks().forEach(t => t.stop());
  const [w, h] = $('resSel').value.split('x').map(Number);
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } }, audio: false,
  });
  $('video').srcObject = stream;
  const track = stream.getVideoTracks()[0];
  // fixed focus/exposure would be ideal for QC; keep continuous when unsupported
  try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* unsupported */ }
  torch = false;
  if (pc) { // replace track on a live call
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(track);
  }
}

async function call(to) {
  stationId = to;
  const id = ++callId;
  pending.length = 0;
  pc?.close();
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  for (const t of stream.getTracks()) {
    const sender = pc.addTrack(t, stream);
    const p = sender.getParameters();
    p.encodings = p.encodings?.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = 4_000_000;
    p.degradationPreference = 'maintain-resolution'; // sharp frames matter more than frame-rate for QC
    sender.setParameters(p).catch(() => {});
  }
  pc.onicecandidate = (e) => e.candidate && signal.send({ type: 'candidate', candidate: e.candidate }, to);
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') status('กำลังส่งภาพไปยังสถานีตรวจ ✓', 'on');
    else if (st === 'connecting') status('กำลังเชื่อมต่อ…', 'warn');
    else if (st === 'failed' || st === 'disconnected') status(`การเชื่อมต่อ ${st} — รอสถานีตรวจ…`, 'warn');
  };
  await pc.setLocalDescription(await pc.createOffer());
  signal.send({ type: 'offer', sdp: pc.localDescription, callId: id }, to);
  status('ส่งคำขอเชื่อมต่อแล้ว…', 'warn');
}

function connect() {
  signal?.close();
  signal = new Signal($('room').value.trim() || 'line-1', 'camera', async (m) => {
    if (m.type === 'welcome') {
      const st = m.peers.find(p => p.role === 'station');
      if (st) call(st.id); else status('รอสถานีตรวจ (เปิดหน้า Station → เลือก “มือถือ (WebRTC)”)', 'warn');
    } else if (m.type === 'peer-left' && m.id === stationId) {
      status('สถานีตรวจออฟไลน์ — รอเชื่อมต่อใหม่', 'warn');
    } else if (m.type === 'signal') {
      const d = m.data;
      if (d.type === 'station-ready') call(m.from);
      else if (d.type === 'answer' && pc && d.callId === callId) {
        await pc.setRemoteDescription(d.sdp);
        for (const c of pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (d.type === 'candidate') {
        if (pc?.remoteDescription) await pc.addIceCandidate(d.candidate).catch(() => {});
        else pending.push(d.candidate);
      } else if (d.type === 'result') showResult(d);
    }
  });
  signal.connect();
}

function showResult(d) {
  const r = $('result'), o = $('overlay');
  r.className = 'result ' + (d.pass ? 'pass' : 'fail');
  r.textContent = d.pass ? 'PASS' : `FAIL · ${d.defects.join(', ')}`;
  o.className = 'overlay ' + (d.pass ? 'pass' : 'fail');
  if (!d.pass && navigator.vibrate) navigator.vibrate([120, 60, 120]);
  clearTimeout(showResult.t);
  showResult.t = setTimeout(() => { r.className = 'result'; o.className = 'overlay'; }, 1200);
}

async function keepAwake() {
  if (!$('wake').checked || !('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
}

$('startBtn').onclick = async () => {
  if (!window.isSecureContext) {
    status('ต้องเปิดผ่าน https:// (ดู URL ที่หน้าแรก) จึงจะใช้กล้องได้', '');
    alert('เบราว์เซอร์อนุญาตกล้องเฉพาะ https:// หรือ localhost — เปิดลิงก์ https ที่แสดงบนหน้าแรกของเซิร์ฟเวอร์');
    return;
  }
  try {
    await openCamera();
    $('startBox').style.display = 'none';
    connect();
    keepAwake();
  } catch (e) { status(`เปิดกล้องไม่ได้: ${e.message}`, ''); }
};
$('flipBtn').onclick = async () => { facing = facing === 'environment' ? 'user' : 'environment'; if (stream) await openCamera(); };
$('resSel').onchange = async () => { if (stream) await openCamera(); };
$('torchBtn').onclick = async () => {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  try { torch = !torch; await track.applyConstraints({ advanced: [{ torch }] }); $('torchBtn').classList.toggle('primary', torch); }
  catch { status('อุปกรณ์นี้ไม่รองรับการเปิดไฟแฟลชจากเบราว์เซอร์', 'warn'); }
};
$('room').onchange = () => { if (stream) connect(); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
