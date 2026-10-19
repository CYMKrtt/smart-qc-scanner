// Minimal WebRTC signaling client: Server-Sent Events down, HTTP POST up.
export const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]; // only used if the LAN path fails

export class Signal {
  constructor(room, role, onMessage) {
    this.room = room; this.role = role; this.onMessage = onMessage;
    this.id = `${role}-${Math.random().toString(36).slice(2, 10)}`;
  }
  connect() {
    const q = new URLSearchParams({ room: this.room, id: this.id, role: this.role });
    this.es = new EventSource(`/signal/events?${q}`);
    this.es.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    this.es.onerror = () => this.onMessage({ type: 'disconnected' });
  }
  send(data, to) {
    return fetch('/signal/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: this.room, from: this.id, to, data }),
    }).catch(() => {});
  }
  close() { this.es?.close(); }
}
