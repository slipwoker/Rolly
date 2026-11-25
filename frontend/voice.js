// Rolly browser voice client: microphone capture, playback with barge-in flush, and the
// WebSocket protocol shared by every provider.  No provider-specific code lives here.

export const qs = new URLSearchParams(location.search);
// A '+' in a pasted token arrives as a space (form decoding of the query string); tokens never contain spaces.
export const TOKEN = (qs.get('token') || '').replace(/ /g, '+');
const withToken = (path) => TOKEN ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}` : path;

export async function api(path, opts = {}) {
  const res = await fetch(withToken(path), { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export class VoiceClient {
  constructor(handlers = {}) {
    this.h = handlers; // onState(state), onEvent(msg), onLevel(rms)
    this.ws = null; this.state = 'idle'; this.flushedSeq = 0; this.firstChunkAt = {}; this.interruptAt = 0;
    this.session = null; this.muted = false;
  }

  setState(s) { if (s !== this.state) { this.state = s; this.h.onState && this.h.onState(s); } }

  async start(startMsg) {
    this.setState('connecting');
    // 1) microphone (browser echo cancellation is essential: the agent must not hear itself)
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    try { this.ctxIn = new AudioContext({ sampleRate: 16000 }); } catch { this.ctxIn = new AudioContext(); }
    try { this.ctxOut = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' }); } catch { this.ctxOut = new AudioContext(); }
    await Promise.all([this.ctxIn.audioWorklet.addModule('worklets.js'), this.ctxOut.audioWorklet.addModule('worklets.js')]);
    await Promise.all([this.ctxIn.resume(), this.ctxOut.resume()]);
    this.capture = new AudioWorkletNode(this.ctxIn, 'capture');
    this.ctxIn.createMediaStreamSource(this.stream).connect(this.capture);
    this.player = new AudioWorkletNode(this.ctxOut, 'player', { outputChannelCount: [1] });
    this.player.connect(this.ctxOut.destination);
    this.player.port.onmessage = (e) => this.onPlayer(e.data);
    try { this.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }

    // 2) socket
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}${withToken('/ws')}`);
    this.ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error('socket error')); });
    this.ws.onmessage = (e) => this.onMessage(e);
    this.ws.onclose = () => { this.cleanup(); this.setState('ended'); };
    this.ws.send(JSON.stringify({ type: 'session.start', ...startMsg }));
    this.capture.port.onmessage = (e) => { if (this.ws && this.ws.readyState === 1) this.ws.send(e.data); };
    this.pingTimer = setInterval(() => this.send({ type: 'ping', t: performance.now() }), 5000);
    this.setState('listening');
  }

  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  onMessage(e) {
    if (e.data instanceof ArrayBuffer) {
      const seq = new DataView(e.data).getUint32(0, true);
      if (seq <= this.flushedSeq) return; // late audio of an interrupted turn
      if (!this.firstChunkAt[seq]) this.firstChunkAt[seq] = performance.now();
      const pcm = e.data.slice(4);
      this.player.port.postMessage({ type: 'audio', seq, pcm }, [pcm]);
      return;
    }
    const m = JSON.parse(e.data);
    switch (m.type) {
      case 'session.created': this.session = m; break;
      case 'user.speech_started': this.setState('hearing'); break;
      case 'user.speech_stopped': this.setState('thinking'); break;
      case 'agent.interrupted':
        this.flushedSeq = Math.max(this.flushedSeq, m.seq);
        this.interruptAt = performance.now();
        this.player.port.postMessage({ type: 'flush' });
        this.setState('hearing');
        break;
      case 'pong': this.rttMs = performance.now() - m.t; break;
      case 'session.closed': this.setState('ended'); break;
    }
    this.h.onEvent && this.h.onEvent(m);
  }

  onPlayer(m) {
    const outLat = ((this.ctxOut.outputLatency || 0) + (this.ctxOut.baseLatency || 0)) * 1000;
    if (m.type === 'started') {
      this.setState('speaking');
      const bufferMs = this.firstChunkAt[m.seq] ? performance.now() - this.firstChunkAt[m.seq] : null;
      this.send({ type: 'client.playback', event: 'first_audio', seq: m.seq, buffer_ms: bufferMs, output_latency_ms: outLat, rtt_ms: this.rttMs });
    } else if (m.type === 'idle') {
      if (this.state === 'speaking') this.setState('listening');
      this.send({ type: 'client.playback', event: 'idle', seq: m.seq, played_ms: m.playedMs });
    } else if (m.type === 'flushed') {
      const stopMs = this.interruptAt ? performance.now() - this.interruptAt + outLat : null;
      this.send({ type: 'client.playback', event: 'flushed', seq: m.seq, played_ms: m.playedMs, dropped_ms: m.droppedMs, stop_ms: stopMs });
    } else if (m.type === 'underrun') {
      this.send({ type: 'client.playback', event: 'underrun', seq: m.seq, count: m.count });
    }
  }

  mute(v) { this.muted = v; this.capture && this.capture.port.postMessage({ type: 'mute', value: v }); }
  journeyEvent(name) { this.send({ type: 'event', name }); }
  end() { this.send({ type: 'session.end' }); this.setState('summarising'); }

  cleanup() {
    clearInterval(this.pingTimer);
    this.stream && this.stream.getTracks().forEach((t) => t.stop());
    this.ctxIn && this.ctxIn.state !== 'closed' && this.ctxIn.close();
    this.ctxOut && this.ctxOut.state !== 'closed' && setTimeout(() => this.ctxOut.close(), 500);
    this.wakeLock && this.wakeLock.release && this.wakeLock.release();
  }
}
