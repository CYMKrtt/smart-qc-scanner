// Smart QC Scanner — vision engine (pure JS, runs in the browser, no dependencies)
//
// 1) Detector: background subtraction inside a trigger zone (ROI) + a small state machine
//    that fires exactly one "trigger" per item passing (or placed) under the camera.
// 2) buildSample(): turns the captured item into a normalized feature set
//    (96x96 silhouette, lighting-normalized texture, color, size).
// 3) compare(): checks a sample against "golden" (known-good) samples and reports
//    size / shape / surface / color defects plus an anomaly heat-map.

export const N = 96;               // normalized sample resolution
const BLOCK = 4;                   // block size for connected components

export const DEFECT_LABELS = {
  size: 'ขนาดผิดสเปก',
  shape: 'รูปร่างผิด / ชิ้นส่วนขาด',
  surface: 'ตำหนิผิว / รอยขีดข่วน / คราบ',
  color: 'สีผิดเพี้ยน',
  ai: 'AI ตรวจพบของเสีย',
};

// Base tolerances (divided by sensitivity). Learned noise from multiple golden samples can raise them.
export const BASE_TOL = { size: 0.10, shape: 0.022, surface: 0.002, color: 0.028 };

// ---------------------------------------------------------------------------
export class Detector {
  constructor(w, h) {
    this.resize(w, h);
    this.roi = { x: 0.2, y: 0.12, w: 0.6, h: 0.76 }; // normalized
    this.diffThresh = 45;
    this.state = 'nobg';
  }
  resize(w, h) {
    this.w = w; this.h = h;
    this.bg = null;
    this.mask = new Uint8Array(w * h);
    this.bw = Math.ceil(w / BLOCK); this.bh = Math.ceil(h / BLOCK);
    this.blocks = new Uint8Array(this.bw * this.bh);
    this.labels = new Int32Array(this.bw * this.bh);
    this.state = 'nobg';
    this.tracks = [];
  }
  roiPx() {
    const { w, h, roi } = this;
    const x0 = Math.max(0, Math.floor(roi.x * w)), y0 = Math.max(0, Math.floor(roi.y * h));
    const x1 = Math.min(w, Math.ceil((roi.x + roi.w) * w)), y1 = Math.min(h, Math.ceil((roi.y + roi.h) * h));
    return { x0, y0, x1, y1 };
  }
  startCalibration(frames = 20) {
    this.calibLeft = frames;
    this.calibSum = new Float32Array(this.w * this.h * 3);
    this.calibCount = 0;
    this.state = 'calibrating';
  }
  _resetTracking() { this.tracks = []; }

  // Process one frame (ImageData at w x h). Returns detection info.
  frame(img) {
    const d = img.data, n = this.w * this.h;
    if (this.state === 'calibrating') {
      const s = this.calibSum;
      for (let i = 0, j = 0; i < n; i++, j += 4) { s[i * 3] += d[j]; s[i * 3 + 1] += d[j + 1]; s[i * 3 + 2] += d[j + 2]; }
      this.calibCount++;
      if (--this.calibLeft <= 0) {
        this.bg = new Float32Array(n * 3);
        for (let i = 0; i < n * 3; i++) this.bg[i] = s[i] / this.calibCount;
        this.state = 'idle'; this._resetTracking();
      }
      return { state: this.state };
    }
    if (!this.bg) return { state: 'nobg' };

    // --- foreground mask (with shadow suppression) inside ROI ---
    const { x0, y0, x1, y1 } = this.roiPx();
    const bg = this.bg, mask = this.mask, T = this.diffThresh;
    mask.fill(0);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * this.w + x, j = i * 4, k = i * 3;
        const r = d[j], g = d[j + 1], b = d[j + 2];
        const br = bg[k], bgG = bg[k + 1], bb = bg[k + 2];
        const diff = Math.abs(r - br) + Math.abs(g - bgG) + Math.abs(b - bb);
        if (diff <= T) continue;
        const s1 = r + g + b + 1, s0 = br + bgG + bb + 1, ratio = s1 / s0;
        if (ratio > 0.45 && ratio < 0.93) { // darker: maybe a shadow — keep only if chroma changed
          const dc = Math.abs(r / s1 - br / s0) + Math.abs(g / s1 - bgG / s0) + Math.abs(b / s1 - bb / s0);
          if (dc < 0.06) continue;
        }
        mask[i] = 1;
      }
    }

    // --- blocks + largest connected component ---
    const { bw, bh, blocks, labels } = this;
    blocks.fill(0); labels.fill(0);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let c = 0;
      for (let yy = by * BLOCK; yy < Math.min(this.h, by * BLOCK + BLOCK); yy++)
        for (let xx = bx * BLOCK; xx < Math.min(this.w, bx * BLOCK + BLOCK); xx++) c += mask[yy * this.w + xx];
      if (c >= 6) blocks[by * bw + bx] = 1;
    }
    const comps = [];
    let label = 0;
    const stack = [];
    for (let s = 0; s < bw * bh; s++) {
      if (!blocks[s] || labels[s]) continue;
      label++; labels[s] = label; stack.push(s);
      let area = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      while (stack.length) {
        const p = stack.pop(); area++;
        const px = p % bw, py = (p / bw) | 0;
        if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py;
        if (px > 0 && blocks[p - 1] && !labels[p - 1]) { labels[p - 1] = label; stack.push(p - 1); }
        if (px < bw - 1 && blocks[p + 1] && !labels[p + 1]) { labels[p + 1] = label; stack.push(p + 1); }
        if (py > 0 && blocks[p - bw] && !labels[p - bw]) { labels[p - bw] = label; stack.push(p - bw); }
        if (py < bh - 1 && blocks[p + bw] && !labels[p + bw]) { labels[p + bw] = label; stack.push(p + bw); }
      }
      if (area < 8) continue; // noise
      const box = {
        x: minX * BLOCK, y: minY * BLOCK,
        w: Math.min(this.w, (maxX + 1) * BLOCK) - minX * BLOCK,
        h: Math.min(this.h, (maxY + 1) * BLOCK) - minY * BLOCK,
        label, area,
      };
      box.cx = box.x + box.w / 2; box.cy = box.y + box.h / 2;
      comps.push(box);
    }

    // --- background adaptation on pixels that are not part of any object ---
    const rate = comps.length ? 0.01 : 0.04;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * this.w + x;
      if (mask[i] || labels[((y / BLOCK) | 0) * bw + ((x / BLOCK) | 0)]) continue;
      const j = i * 4, k = i * 3;
      bg[k] += (d[j] - bg[k]) * rate; bg[k + 1] += (d[j + 1] - bg[k + 1]) * rate; bg[k + 2] += (d[j + 2] - bg[k + 2]) * rate;
    }

    // --- multi-object tracking: each item gets exactly one trigger ---
    const tracks = this.tracks;
    const used = new Set();
    for (const t of tracks) {
      let best = null, bd = Infinity;
      for (const c of comps) {
        if (used.has(c)) continue;
        const dist = Math.hypot(c.cx - t.box.cx, c.cy - t.box.cy);
        if (dist < bd) { bd = dist; best = c; }
      }
      if (best && bd < Math.max(24, 0.6 * Math.max(t.box.w, t.box.h))) {
        used.add(best);
        const p = t.box;
        const moved = Math.abs(p.x - best.x) + Math.abs(p.y - best.y) + Math.abs(p.w - best.w) + Math.abs(p.h - best.h);
        t.stable = moved <= 4 ? t.stable + 1 : 0;
        t.box = best; t.missing = 0;
      } else t.missing++;
    }
    this.tracks = tracks.filter(t => t.missing <= (t.inspected ? 4 : 3));
    for (const c of comps) if (!used.has(c)) this.tracks.push({ box: c, entry: { cx: c.cx, cy: c.cy }, stable: 0, missing: 0, inspected: false });

    let trigger = null;
    const rcx = (x0 + x1) / 2, rcy = (y0 + y1) / 2, m = 2;
    for (const t of this.tracks) {
      if (t.inspected || t.missing) continue;
      const b = t.box;
      const inside = b.x > x0 + m && b.y > y0 + m && b.x + b.w < x1 - m && b.y + b.h < y1 - m;
      // moving belt: fire once the item is fully in the zone and has reached / passed the zone center
      const dx = b.cx - t.entry.cx, dy = b.cy - t.entry.cy;
      let centered;
      if (Math.abs(dx) >= Math.abs(dy)) centered = Math.abs(b.cx - rcx) < 0.12 * (x1 - x0) || (dx > 0 ? b.cx > rcx : b.cx < rcx);
      else centered = Math.abs(b.cy - rcy) < 0.12 * (y1 - y0) || (dy > 0 ? b.cy > rcy : b.cy < rcy);
      const moving = Math.abs(dx) + Math.abs(dy) > 6;
      if (inside && !trigger && (t.stable >= 5 || (centered && moving))) { t.inspected = true; trigger = b; }
    }
    this.state = !this.tracks.length ? 'idle' : this.tracks.some(t => !t.inspected) ? 'tracking' : 'inspected';
    return {
      state: this.state, present: comps.length > 0, trigger: !!trigger, box: trigger,
      tracks: this.tracks.filter(t => !t.missing).map(t => ({ box: t.box, inspected: t.inspected })),
    };
  }

  // Filled silhouette of the tracked component, tightened to pixel precision
  silhouette(box) { // → { box, sil: Uint8Array(box.w * box.h) }
    const { w, mask, labels, bw } = this;
    const out = new Uint8Array(box.w * box.h);
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
      const gx = box.x + x, gy = box.y + y;
      if (mask[gy * w + gx] && labels[((gy / BLOCK) | 0) * bw + ((gx / BLOCK) | 0)] === box.label) out[y * box.w + x] = 1;
    }
    // fill holes: inside both the row span and the column span
    const rowA = new Int32Array(box.h).fill(-1), rowB = new Int32Array(box.h).fill(-1);
    const colA = new Int32Array(box.w).fill(-1), colB = new Int32Array(box.w).fill(-1);
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) if (out[y * box.w + x]) {
      if (rowA[y] < 0) rowA[y] = x; rowB[y] = x;
      if (colA[x] < 0) colA[x] = y; colB[x] = y;
    }
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++)
      out[y * box.w + x] = rowA[y] >= 0 && x >= rowA[y] && x <= rowB[y] && colA[x] >= 0 && y >= colA[x] && y <= colB[x] ? 1 : 0;

    // tighten the block-aligned box to pixel precision (ignore thin noisy fringes)
    const rows = new Int32Array(box.h), cols = new Int32Array(box.w);
    for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) if (out[y * box.w + x]) { rows[y]++; cols[x]++; }
    const rMin = Math.max(2, 0.12 * Math.max(...rows)), cMin = Math.max(2, 0.12 * Math.max(...cols));
    let ya = 0, yb = box.h - 1, xa = 0, xb = box.w - 1;
    while (ya < yb && rows[ya] < rMin) ya++;
    while (yb > ya && rows[yb] < rMin) yb--;
    while (xa < xb && cols[xa] < cMin) xa++;
    while (xb > xa && cols[xb] < cMin) xb--;
    const tight = { x: box.x + xa, y: box.y + ya, w: xb - xa + 1, h: yb - ya + 1 };
    const sil = new Uint8Array(tight.w * tight.h);
    for (let y = 0; y < tight.h; y++) for (let x = 0; x < tight.w; x++) sil[y * tight.w + x] = out[(y + ya) * box.w + x + xa];
    return { box: tight, sil };
  }
}

// ---------------------------------------------------------------------------
// Build a normalized sample from a hi-res frame (canvas), the detection box (in proc px) and silhouette.
export function buildSample(hiCanvas, procW, procH, box, sil) {
  const sx = hiCanvas.width / procW, sy = hiCanvas.height / procH;
  const crop = document.createElement('canvas');
  crop.width = N; crop.height = N;
  const cctx = crop.getContext('2d', { willReadFrequently: true });
  cctx.drawImage(hiCanvas, box.x * sx, box.y * sy, box.w * sx, box.h * sy, 0, 0, N, N);
  const px = cctx.getImageData(0, 0, N, N).data;

  // thumbnail at true aspect ratio (with a little padding)
  const pad = 0.08;
  const tx = Math.max(0, (box.x - box.w * pad) * sx), ty = Math.max(0, (box.y - box.h * pad) * sy);
  const tw = Math.min(hiCanvas.width - tx, box.w * (1 + 2 * pad) * sx), th = Math.min(hiCanvas.height - ty, box.h * (1 + 2 * pad) * sy);
  const scale = Math.min(1, 260 / Math.max(tw, th));
  const thumb = document.createElement('canvas');
  thumb.width = Math.round(tw * scale); thumb.height = Math.round(th * scale);
  thumb.getContext('2d').drawImage(hiCanvas, tx, ty, tw, th, 0, 0, thumb.width, thumb.height);
  const thumbRect = { // where the object box sits inside the thumbnail (for heat-map overlay)
    x: (box.x * sx - tx) * scale, y: (box.y * sy - ty) * scale, w: box.w * sx * scale, h: box.h * sy * scale,
  };

  // AI input crop (224 x 224, padded square)
  const ai = document.createElement('canvas');
  ai.width = ai.height = 224;
  const side = Math.max(tw, th);
  ai.getContext('2d').drawImage(hiCanvas, tx + tw / 2 - side / 2, ty + th / 2 - side / 2, side, side, 0, 0, 224, 224);

  // silhouette -> N x N
  const mask = new Uint8Array(N * N);
  let area = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = sil[Math.min(box.h - 1, (y * box.h / N) | 0) * box.w + Math.min(box.w - 1, (x * box.w / N) | 0)];
    mask[y * N + x] = v;
  }
  for (let i = 0; i < sil.length; i++) area += sil[i];

  // color + gray
  let R = 0, G = 0, B = 0, c = 0;
  const gray = new Float32Array(N * N), cr = new Float32Array(N * N), cb = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    const sum = r + g + b + 30; // damped chromaticity (stable in dark areas)
    cr[i] = r / sum; cb[i] = b / sum;
    if (mask[i]) { R += r; G += g; B += b; c++; }
  }
  c = Math.max(c, 1);
  R /= c; G /= c; B /= c;
  const S = R + G + B + 1;
  const tex = normalize(blur3(gray), mask);

  return {
    mask, tex, cr: blur3(cr), cb: blur3(cb), area: area / (procW * procH), aspect: box.w / box.h,
    color: { r: R / S, g: G / S, b: B / S, lum: S / 3, rgb: [R, G, B] },
    crop, thumb, thumbRect, ai,
  };
}

function blur3(src) {
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < N && yy < N) { s += src[yy * N + xx]; c++; }
    }
    out[y * N + x] = s / c;
  }
  return out;
}
function normalize(g, mask) {
  let s = 0, s2 = 0, c = 0;
  for (let i = 0; i < N * N; i++) if (mask[i]) { s += g[i]; s2 += g[i] * g[i]; c++; }
  c = Math.max(c, 1);
  const mean = s / c, std = Math.max(8, Math.sqrt(Math.max(0, s2 / c - mean * mean)));
  const out = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) out[i] = (g[i] - mean) / std;
  return out;
}
// rotate an N x N array clockwise k*90°
function rot(arr, k) {
  let a = arr;
  for (let t = 0; t < k; t++) {
    const o = new arr.constructor(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) o[x * N + (N - 1 - y)] = a[y * N + x];
    a = o;
  }
  return a;
}
function erode(mask, r) {
  const out = new Uint8Array(N * N);
  for (let y = r; y < N - r; y++) for (let x = r; x < N - r; x++) {
    let ok = 1;
    for (let dy = -r; dy <= r && ok; dy++) for (let dx = -r; dx <= r; dx++) if (!mask[(y + dy) * N + x + dx]) { ok = 0; break; }
    out[y * N + x] = ok;
  }
  return out;
}
// size of the most significant anomaly blob: area, or length for thin features like scratches
function largestBlob(bin) {
  const seen = new Uint8Array(N * N), stack = [];
  let best = 0;
  for (let s = 0; s < N * N; s++) {
    if (!bin[s] || seen[s]) continue;
    let a = 0, x0 = N, y0 = N, x1 = 0, y1 = 0; seen[s] = 1; stack.push(s);
    while (stack.length) {
      const p = stack.pop(); a++;
      const x = p % N, y = (p / N) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < N - 1 ? p + 1 : -1, y > 0 ? p - N : -1, y < N - 1 ? p + N : -1])
        if (q >= 0 && bin[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
    }
    const score = a >= 6 ? Math.max(a, 1.5 * Math.hypot(x1 - x0, y1 - y0)) : a;
    if (score > best) best = score;
  }
  return best;
}

// Raw metrics of sample vs one golden (best of 4 orientations)
function metricsVs(sample, gold) {
  let best = null;
  const gInner = gold._inner || (gold._inner = erode(gold.mask, 3));
  let gArea = 0; for (let i = 0; i < N * N; i++) gArea += gold.mask[i];
  // remove a global tint before the local color check (a global shift is reported as 'color')
  const dCr = sample.color.r - gold.color.r, dCb = sample.color.b - gold.color.b;
  for (let k = 0; k < 4; k++) {
    // a 90° turn swaps the aspect ratio — skip orientations that don't fit the golden's shape
    const asp = k % 2 ? 1 / sample.aspect : sample.aspect;
    if (Math.abs(Math.log(asp / gold.aspect)) > 0.35) continue;
    const sm = rot(sample.mask, k), st = rot(sample.tex, k), scr = rot(sample.cr, k), scb = rot(sample.cb, k);
    // shape: mismatches away from the golden's boundary (ignore 2px edge jitter)
    const shapeMap = new Uint8Array(N * N);
    let shapeErr = 0;
    for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
      const i = y * N + x, g = gold.mask[i];
      if (sm[i] === g) continue;
      let uniform = true;
      for (let dy = -2; dy <= 2 && uniform; dy++) for (let dx = -2; dx <= 2; dx++) if (gold.mask[i + dy * N + dx] !== g) { uniform = false; break; }
      if (uniform) { shapeErr++; shapeMap[i] = 1; }
    }
    // texture: shift-tolerant absolute difference on the interior
    const anom = new Uint8Array(N * N);
    let texSum = 0, texN = 0;
    for (let y = 3; y < N - 3; y++) for (let x = 3; x < N - 3; x++) {
      const i = y * N + x;
      if (!gInner[i] || !sm[i]) continue;
      // brightness pattern + color (so a brown stain on dark print still shows up)
      let m = 1e9, mc = 1e9;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const j = i + dy * N + dx;
        const v = Math.abs(st[i] - gold.tex[j]);
        if (v < m) m = v;
        const c = Math.abs(scr[i] - dCr - gold.cr[j]) + Math.abs(scb[i] - dCb - gold.cb[j]);
        if (c < mc) mc = c;
      }
      texSum += m; texN++;
      if (m > 0.95 || mc > 0.07) anom[i] = 1;
    }
    const cand = { k, shapeMap, anom, shape: shapeErr / Math.max(gArea, 1), texMean: texSum / Math.max(texN, 1) };
    cand.rank = cand.shape * 10 + cand.texMean;
    if (!best || cand.rank < best.rank) best = cand;
  }
  if (!best) { // aspect ratio is off for every orientation → strong shape/size defect
    best = { k: 0, shapeMap: new Uint8Array(N * N), anom: new Uint8Array(N * N), shape: 1, texMean: 9, rank: 99 };
  }
  const surface = largestBlob(best.anom) / Math.max(gArea, 1);
  const size = Math.abs(sample.area / gold.area - 1);
  const c1 = sample.color, c2 = gold.color;
  const color = Math.hypot(c1.r - c2.r, c1.g - c2.g, c1.b - c2.b);
  return { size, shape: best.shape, surface, color, k: best.k, anom: best.anom, shapeMap: best.shapeMap };
}

// Noise floor learned from the spread among golden samples
export function learnNoise(goldens) {
  const floor = { size: 0, shape: 0, surface: 0, color: 0 };
  for (let a = 0; a < goldens.length; a++) for (let b = 0; b < goldens.length; b++) {
    if (a === b) continue;
    const m = metricsVs(goldens[a], goldens[b]);
    for (const key in floor) floor[key] = Math.max(floor[key], m[key]);
  }
  return floor;
}

export function tolerances(sensitivity, noise) {
  const t = {};
  for (const key in BASE_TOL) t[key] = Math.max(BASE_TOL[key] / sensitivity, (noise?.[key] || 0) * 1.5);
  return t;
}

// Compare a sample against all golden samples; pick the closest.
export function compare(sample, goldens, tol) {
  let best = null;
  for (const g of goldens) {
    const m = metricsVs(sample, g);
    m.worst = Math.max(m.size / tol.size, m.shape / tol.shape, m.surface / tol.surface, m.color / tol.color);
    m.gold = g;
    if (!best || m.worst < best.worst) best = m;
  }
  const defects = [];
  for (const key of ['shape', 'surface', 'size', 'color']) if (best[key] > tol[key]) defects.push(key);
  defects.sort((a, b) => best[b] / tol[b] - best[a] / tol[a]);
  const score = Math.max(0, Math.min(100, 100 - 50 * best.worst));
  return {
    pass: defects.length === 0, defects, score,
    metrics: { size: best.size, shape: best.shape, surface: best.surface, color: best.color },
    ratios: { size: best.size / tol.size, shape: best.shape / tol.shape, surface: best.surface / tol.surface, color: best.color / tol.color },
    heat: { anom: best.anom, shapeMap: best.shapeMap, k: best.k },
    gold: best.gold,
  };
}

// Draw sample thumbnail with defect heat-map overlay → canvas
export function renderHeatmap(sample, heat) {
  const out = document.createElement('canvas');
  out.width = sample.thumb.width; out.height = sample.thumb.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(sample.thumb, 0, 0);
  if (!heat) return out;
  // map back into the sample's own orientation
  const inv = (4 - heat.k) % 4;
  const anom = rot(heat.anom, inv), shp = rot(heat.shapeMap, inv);
  const ov = document.createElement('canvas');
  ov.width = ov.height = N;
  const octx = ov.getContext('2d');
  const id = octx.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    if (anom[i]) { id.data[i * 4] = 255; id.data[i * 4 + 1] = 40; id.data[i * 4 + 2] = 60; id.data[i * 4 + 3] = 200; }
    else if (shp[i]) { id.data[i * 4] = 255; id.data[i * 4 + 1] = 190; id.data[i * 4 + 2] = 40; id.data[i * 4 + 3] = 170; }
  }
  octx.putImageData(id, 0, 0);
  const r = sample.thumbRect;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(ov, r.x, r.y, r.w, r.h);
  return out;
}
