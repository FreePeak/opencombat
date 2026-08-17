// Procedural WebAudio sound effects — zero audio files. Every sound is a
// short synth patch (oscillator / noise through envelopes); the background
// pad is two detuned sawtooths through a lowpass. Browsers require a user
// gesture before audio can start, so init() is called from the first
// key/click (the name-entry JOIN button).
//
// Mute toggle + volume persist in localStorage.
export default class SoundManager {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('opengame.muted') === '1';
    this.volume = parseFloat(localStorage.getItem('opengame.volume') ?? '0.5');
  }

  /** Create the AudioContext (must run inside a user gesture). */
  init() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(this.ctx.destination);
    this.startPad();
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('opengame.muted', this.muted ? '1' : '0');
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  }

  setVolume(v) {
    this.volume = clamp01(v);
    localStorage.setItem('opengame.volume', String(this.volume));
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  /** Oscillator blip with an exponential frequency slide. */
  blip(f0, f1, dur, type = 'sine', gain = 0.2, when = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Short filtered noise sweep (swing / impact textures). */
  noiseSweep(dur, gain, f0, f1, type = 'bandpass', when = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + when;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(f0, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
  }

  // --- Game events -----------------------------------------------------------
  pickup() { this.blip(440, 880, 0.09, 'sine', 0.18); this.blip(660, 1320, 0.12, 'sine', 0.15, 0.07); }
  powerUp() { this.blip(330, 660, 0.1, 'triangle', 0.2); this.blip(495, 990, 0.14, 'triangle', 0.18, 0.09); }
  swing() { this.noiseSweep(0.12, 0.12, 1200, 300, 'bandpass'); }
  hit() { this.blip(130, 60, 0.12, 'sine', 0.3); this.noiseSweep(0.08, 0.15, 400, 100, 'lowpass'); }
  enemyHit() { this.blip(190, 95, 0.09, 'square', 0.16); this.noiseSweep(0.06, 0.1, 900, 200, 'lowpass'); }
  waveClear() { // wave-cleared fanfare: rising arpeggio + shimmer
    this.blip(523, 523, 0.12, 'triangle', 0.2);
    this.blip(659, 659, 0.12, 'triangle', 0.2, 0.12);
    this.blip(784, 784, 0.2, 'triangle', 0.22, 0.24);
    this.noiseSweep(0.5, 0.05, 6000, 1200, 'highpass', 0.24);
  }
  blocked() { // metallic clang: the guard held, no damage taken
    this.blip(520, 500, 0.06, 'square', 0.15);
    this.blip(700, 690, 0.09, 'square', 0.12, 0.05);
    this.noiseSweep(0.06, 0.1, 2400, 900, 'highpass');
  }
  death() { this.blip(400, 70, 0.5, 'sawtooth', 0.16); this.noiseSweep(0.4, 0.1, 800, 60, 'lowpass'); }
  tick() { this.blip(880, 880, 0.05, 'square', 0.08); }
  go() { this.blip(440, 880, 0.18, 'square', 0.12); }
  gameOver() {
    this.blip(392, 392, 0.15, 'triangle', 0.18);
    this.blip(311, 311, 0.15, 'triangle', 0.18, 0.17);
    this.blip(233, 220, 0.4, 'triangle', 0.2, 0.34);
  }

  /** Soft looping pad: two detuned oscillators through a lowpass. */
  startPad() {
    if (!this.ctx || this.padGain) return;
    const g = this.ctx.createGain();
    g.gain.value = 0.04;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.connect(g).connect(this.master);
    for (const detune of [-6, 6]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 110;
      osc.detune.value = detune;
      osc.connect(lp);
      osc.start();
    }
    this.padGain = g;
  }
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
