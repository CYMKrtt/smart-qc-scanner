// Optional "teachable" AI mode: MobileNet image embeddings + K-nearest-neighbour classifier
// (TensorFlow.js, loaded on demand from a CDN — needs internet the first time).
const LIBS = [
  'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
  'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2/dist/mobilenet.min.js',
  'https://cdn.jsdelivr.net/npm/@tensorflow-models/knn-classifier@1/dist/knn-classifier.min.js',
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`โหลดไม่สำเร็จ: ${src}`));
    document.head.appendChild(s);
  });
}

export class TeachableAI {
  constructor() { this.ready = false; this.counts = { good: 0, defect: 0 }; }
  async load() {
    if (this.ready) return;
    for (const src of LIBS) await loadScript(src);
    this.net = await window.mobilenet.load({ version: 2, alpha: 1.0 });
    this.knn = window.knnClassifier.create();
    this.ready = true;
  }
  add(canvas, label) {
    const emb = window.tf.tidy(() => this.net.infer(canvas, true));
    this.knn.addExample(emb, label);
    emb.dispose();
    this.counts[label] = (this.counts[label] || 0) + 1;
  }
  trained() { return this.ready && this.counts.good > 0 && this.counts.defect > 0; }
  async predict(canvas) {
    const emb = window.tf.tidy(() => this.net.infer(canvas, true));
    const r = await this.knn.predictClass(emb, Math.min(5, this.counts.good + this.counts.defect));
    emb.dispose();
    return { label: r.label, confidence: r.confidences[r.label] ?? 0 };
  }
  clear() { this.knn?.clearAllClasses(); this.counts = { good: 0, defect: 0 }; }
}
