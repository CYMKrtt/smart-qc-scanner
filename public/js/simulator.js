// Conveyor-belt simulator: renders products moving on a belt into a canvas and exposes it
// as a MediaStream (same path a real camera takes). Each product carries its ground truth,
// so the station can measure detection accuracy.

export const SIM_DEFECTS = {
  scratch: 'รอยขีดข่วน', stain: 'คราบสกปรก', chip: 'มุมบิ่น/ขาด',
  color: 'สีเพี้ยน', small: 'ขนาดเล็กเกิน', noprint: 'ไม่มีลายพิมพ์',
};

export class ConveyorSim {
  constructor(w = 960, h = 540) {
    this.w = w; this.h = h;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w; this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d');
    this.speed = 160;        // px / s
    this.defectRate = 0.25;
    this.spacing = 330;      // px between items
    this.items = [];
    this.nextId = 1;
    this.forced = 0;
    this.running = false;
    this.paused = false;
    this.t = 0;
    this.emptyUntil = 0;
    this.belt = this._renderBelt();
  }

  _renderBelt() {
    const c = document.createElement('canvas');
    c.width = this.w; c.height = this.h;
    const g = c.getContext('2d');
    g.fillStyle = '#1a2226'; g.fillRect(0, 0, this.w, this.h);
    const top = this.h * 0.2, bot = this.h * 0.8;
    g.fillStyle = '#30393d'; g.fillRect(0, top, this.w, bot - top);
    // static fine texture
    const id = g.getImageData(0, top, this.w, bot - top);
    for (let i = 0; i < id.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 10;
      id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n;
    }
    g.putImageData(id, 0, top);
    // rails
    for (const y of [top - 18, bot]) {
      const gr = g.createLinearGradient(0, y, 0, y + 18);
      gr.addColorStop(0, '#9aa7ac'); gr.addColorStop(1, '#55636a');
      g.fillStyle = gr; g.fillRect(0, y, this.w, 18);
      g.fillStyle = '#2b3438';
      for (let x = 20; x < this.w; x += 80) { g.beginPath(); g.arc(x, y + 9, 3, 0, 7); g.fill(); }
    }
    g.fillStyle = '#7fa3a5'; g.font = '14px sans-serif';
    g.fillText('SIMULATED CONVEYOR — LINE 1', 16, 24);
    return c;
  }

  forceGood(n) { this.forced = n; }

  _spawn() {
    let defect = null;
    if (this.forced > 0) this.forced--;
    else if (Math.random() < this.defectRate) {
      const keys = Object.keys(SIM_DEFECTS);
      defect = keys[(Math.random() * keys.length) | 0];
    }
    const flip = Math.random() < 0.5;
    this.items.push({
      id: this.nextId++, x: -120, y: this.h / 2 + (Math.random() - 0.5) * 16,
      ang: (Math.random() - 0.5) * 0.02 + (flip ? Math.PI : 0), defect,
      // randomize defect geometry
      sx: (Math.random() - 0.5) * 100, sy: (Math.random() - 0.5) * 50, sa: Math.random() * Math.PI,
      corner: (Math.random() * 4) | 0,
    });
  }

  _drawItem(g, it) {
    const scale = it.defect === 'small' ? 0.84 : 1;
    const W = 180 * scale, H = 112 * scale;
    g.save();
    g.translate(it.x, it.y); g.rotate(it.ang);
    // body path (with chipped corner when defect = chip)
    g.beginPath();
    const r = 12, x0 = -W / 2, y0 = -H / 2;
    if (it.defect === 'chip') {
      const c = 44;
      const pts = [[x0, y0], [x0 + W, y0], [x0 + W, y0 + H], [x0, y0 + H]];
      const k = it.corner;
      const out = [];
      pts.forEach((p, i) => {
        if (i !== k) { out.push(p); return; }
        const prev = pts[(i + 3) % 4], next = pts[(i + 1) % 4];
        const t1 = c / Math.hypot(prev[0] - p[0], prev[1] - p[1]), t2 = c / Math.hypot(next[0] - p[0], next[1] - p[1]);
        out.push([p[0] + (prev[0] - p[0]) * t1, p[1] + (prev[1] - p[1]) * t1]);
        out.push([p[0] + (next[0] - p[0]) * t2, p[1] + (next[1] - p[1]) * t2]);
      });
      g.moveTo(...out[0]); out.slice(1).forEach(p => g.lineTo(...p)); g.closePath();
    } else {
      g.roundRect(x0, y0, W, H, r);
    }
    g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 6; g.shadowOffsetY = 3;
    g.fillStyle = it.defect === 'color' ? '#d9b38c' : '#e9dcb8';
    g.fill();
    g.shadowColor = 'transparent';
    g.clip();
    // print / label
    if (it.defect !== 'noprint') {
      g.fillStyle = '#1b7f86';
      g.beginPath(); g.arc(x0 + 38 * scale, 0, 22 * scale, 0, 7); g.fill();
      g.fillStyle = '#e9dcb8';
      g.beginPath(); g.arc(x0 + 38 * scale, 0, 10 * scale, 0, 7); g.fill();
      g.fillStyle = '#3c4a4e';
      g.fillRect(x0 + 72 * scale, -26 * scale, 84 * scale, 12 * scale);
      g.fillRect(x0 + 72 * scale, -6 * scale, 64 * scale, 8 * scale);
      g.fillRect(x0 + 72 * scale, 10 * scale, 74 * scale, 8 * scale);
    }
    g.fillStyle = '#c8b994';
    g.fillRect(x0 + 8, y0 + H - 14, W - 16, 4);
    if (it.defect === 'scratch') {
      g.strokeStyle = '#4a3a2c'; g.lineWidth = 3; g.lineCap = 'round';
      g.beginPath();
      g.moveTo(it.sx * 0.5 - Math.cos(it.sa) * 40, it.sy * 0.5 - Math.sin(it.sa) * 40);
      g.lineTo(it.sx * 0.5 + Math.cos(it.sa) * 40, it.sy * 0.5 + Math.sin(it.sa) * 40);
      g.stroke();
    }
    if (it.defect === 'stain') {
      g.fillStyle = 'rgba(92, 62, 30, .85)';
      g.beginPath(); g.ellipse(it.sx * 0.6, it.sy * 0.5, 16, 11, it.sa, 0, 7); g.fill();
    }
    g.restore();
  }

  // Advance + render one frame. Driven by the station's timer (keeps running in background tabs).
  step(now) {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    if (!this.paused) {
      this.t += dt;
      for (const it of this.items) it.x += this.speed * dt;
      this.items = this.items.filter(it => it.x < this.w + 140);
      const last = this.items[this.items.length - 1];
      if (this.t > this.emptyUntil && (!last || last.x > -120 + this.spacing)) this._spawn();
    }
    const g = this.ctx;
    g.drawImage(this.belt, 0, 0);
    for (const it of this.items) this._drawItem(g, it);
    // gentle lighting drift (tests lighting normalization)
    const flick = Math.sin(this.t * 0.7) * 0.03;
    if (flick > 0) { g.fillStyle = `rgba(255,255,255,${flick})`; g.fillRect(0, 0, this.w, this.h); }
    else { g.fillStyle = `rgba(0,0,0,${-flick})`; g.fillRect(0, 0, this.w, this.h); }
  }

  start() {
    this.running = true;
    this.emptyUntil = this.t + 1.5; // give the station an empty belt to calibrate on
    this.step(performance.now());
  }
  stop() { this.running = false; }

  // ground truth for the item nearest to a normalized x position
  truthAt(nx) {
    const x = nx * this.w;
    let best = null;
    for (const it of this.items) if (!best || Math.abs(it.x - x) < Math.abs(best.x - x)) best = it;
    return best && Math.abs(best.x - x) < 120 ? best : null;
  }
}
