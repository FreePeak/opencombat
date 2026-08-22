// Adaptive Music Director — WebAudio binding (P2.9): feeds gameplay signals
// into the PURE core (musicDirectorCore.js) and crossfades synthesized
// intensity layers on bar boundaries. Everything hangs off the existing
// SoundManager context/master, so mute + volume keep working (AC3) and the
// game still ships zero audio assets. Without a SoundManager/context every
// method is a safe no-op (AC2 — headless import must not throw).
//
// Layer map per tier (PRD-music-director.md):
//   0 calm   — pad only
//   1 explore— pad + slow pulse bass
//   2 combat — pad + double-time pulse + noise hats
//   3 threat — everything + a one-shot filtered-noise riser on entry
import { TIERS, decideTier, nextBarBoundary, transitionDue } from './musicDirectorCore.js';

const BAR_MS = 1800;      // musical bar the core quantizes transitions to
const FADE_S = 0.4;       // linear crossfade length for every layer move
const LOOKAHEAD_S = 2.5;  // rhythm-gate scheduling horizon (ctx seconds)
const PULSE_LEVEL = 0.16; // pulse-bass full-open level (pre-master scale)
const HATS_LEVEL = 0.045; // hats full-open level
const RISER_LEVEL = 0.2;  // threat-entry riser peak

// Per-tier mix: layer levels + pulses per bar. Pad is the base layer present
// in EVERY tier (calm = pad only); pulse enters at explore, hats at combat.
const MIX = [
  { pad: 1,   pulse: 0,    ppb: 0, hats: 0 }, // 0 calm
  { pad: 0.9, pulse: 0.55, ppb: 2, hats: 0 }, // 1 explore — slow pulse
  { pad: 0.8, pulse: 0.7,  ppb: 4, hats: 1 }, // 2 combat — double time + hats
  { pad: 0.8, pulse: 0.9,  ppb: 4, hats: 1 }  // 3 threat — everything (+riser)
];

export default class MusicDirector {
  /** sound: the shared SoundManager (needs .ctx/.master/.padGain post-init). */
  constructor({ sound } = {}) {
    this.sound = sound ?? null;
    this.disposed = false;
    this.ready = false;
    this.inputs = {};       // last setSignals() merge, consumed each update()
    this.decision = null;   // core state { tier, sinceChangeAt }
    this.appliedTier = null;// tier the audio graph currently shows
    this.layers = null;     // { pad, pulse:{osc,lp,level,gate}, hats:{src,hp,level,gate} }
    this._noise = null;     // white-noise buffer, created once
    this._pulseUntil = 0;   // rhythm gate scheduled up to here (ctx time)
  }

  /** Merge partial gameplay inputs; cheap field copy for the next update(). */
  setSignals(partial) {
    if (partial && typeof partial === 'object') Object.assign(this.inputs, partial);
  }

  /** Per-frame tick (ms clock). Decides, then applies quantized crossfades. */
  update(nowMs) {
    if (this.disposed || !this._ensureLayers()) return;
    const now = Number.isFinite(nowMs) ? nowMs : performance.now();
    if (!this.decision) this.decision = { tier: TIERS.CALM, sinceChangeAt: now };
    this.decision = decideTier(this.inputs, this.decision, now);
    if (this.appliedTier === null) this.appliedTier = this.decision.tier;
    // Audio follows decisions only at bar edges the core points at.
    if (
      this.appliedTier !== this.decision.tier &&
      transitionDue(this.decision.tier, this.decision, BAR_MS, now)
    ) {
      const boundaryMs = nextBarBoundary(BAR_MS, this.decision.sinceChangeAt);
      const delayMs = Math.max(0, boundaryMs - now);
      this._applyTier(this.decision.tier, delayMs);
      if (this.decision.tier === TIERS.THREAT) this._fireRiser(delayMs);
      this.appliedTier = this.decision.tier;
    }
    this._scheduleRhythm();
  }

  /** Stop all director-owned sources + disconnect. Pad is left as found. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const L = this.layers;
    if (!L) return;
    try { L.pulse.osc.stop(); } catch {}
    try { L.hats.src.stop(); } catch {}
    const ctx = this.sound?.ctx;
    if (L.pad && ctx) {
      try {
        L.pad.gain.gain.cancelScheduledValues(ctx.currentTime);
        L.pad.gain.gain.setValueAtTime(L.pad.base, ctx.currentTime);
      } catch {}
    }
    for (const n of [L.pulse.lp, L.pulse.level, L.pulse.gate, L.hats.hp, L.hats.level, L.hats.gate]) {
      try { n.disconnect(); } catch {}
    }
    this.layers = null;
    this.ready = false;
  }

  // --- internals ------------------------------------------------------------

  /** Build the synth graph lazily (first tick after sound.init()). */
  _ensureLayers() {
    const ctx = this.sound?.ctx;
    if (!ctx || !this.sound?.master) return false;
    if (this.ready) return true;

    // Layer 0 — the EXISTING looping pad gain: reuse, never re-synthesize.
    let pad = null;
    if (this.sound.padGain) pad = { gain: this.sound.padGain, base: this.sound.padGain.gain.value };

    // Layer 1 — pulse bass: square @55Hz through a lowpass; rhythm comes from
    // a gate gain scheduled per beat (no LFO), level from a crossfade gain.
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 55;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160;
    const pLevel = ctx.createGain(); pLevel.gain.value = 0;
    const pGate = ctx.createGain(); pGate.gain.value = 0;
    osc.connect(lp).connect(pLevel).connect(pGate).connect(this.sound.master);
    osc.start();

    // Layer 2 — hats: ONE looping noise source through a highpass into a
    // gated gain (buffer built once, shared with the riser).
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(ctx);
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6500;
    const hLevel = ctx.createGain(); hLevel.gain.value = 0;
    const hGate = ctx.createGain(); hGate.gain.value = 0;
    src.connect(hp).connect(hLevel).connect(hGate).connect(this.sound.master);
    src.start();

    this.layers = { pad, pulse: { osc, lp, level: pLevel, gate: pGate }, hats: { src, hp, level: hLevel, gate: hGate } };
    this._pulseUntil = ctx.currentTime;
    this.ready = true;
    return true;
  }

  /** Crossfade every layer to its tier mix, starting `delayMs` from now. */
  _applyTier(tier, delayMs) {
    const ctx = this.sound.ctx;
    const mix = MIX[tier] ?? MIX[TIERS.CALM];
    const t0 = ctx.currentTime + delayMs / 1000;
    const t1 = t0 + FADE_S;
    const fade = (param, to) => {
      param.cancelScheduledValues(t0);
      param.setValueAtTime(param.value, t0);
      param.linearRampToValueAtTime(to, t1);
    };
    const L = this.layers;
    if (L.pad) fade(L.pad.gain.gain, L.pad.base * mix.pad);
    fade(L.pulse.level.gain, mix.pulse * PULSE_LEVEL);
    fade(L.hats.level.gain, mix.hats * HATS_LEVEL);
    // Restart the rhythm grid on the new tier's beat spacing.
    for (const gate of [L.pulse.gate.gain, L.hats.gate.gain]) {
      gate.cancelScheduledValues(t0);
      gate.setValueAtTime(0, t0);
    }
    this._pulseUntil = t0;
  }

  /** Schedule pulse beats (+ offbeat hat ticks) up to the lookahead edge. */
  _scheduleRhythm() {
    if (!this.ready) return;
    const ctx = this.sound.ctx;
    const mix = MIX[this.appliedTier ?? TIERS.CALM] ?? MIX[TIERS.CALM];
    const horizon = ctx.currentTime + LOOKAHEAD_S;
    const barS = BAR_MS / 1000;
    if (mix.ppb <= 0) { this._pulseUntil = horizon; return; } // calm: park ahead
    while (this._pulseUntil < horizon) {
      const t = this._pulseUntil;
      const beat = barS / mix.ppb;
      const pg = this.layers.pulse.gate.gain;
      pg.setValueAtTime(0, t);
      pg.linearRampToValueAtTime(1, t + 0.012);
      pg.exponentialRampToValueAtTime(0.001, t + Math.min(beat * 0.8, 0.4));
      if (mix.hats > 0) {
        const ht = t + beat / 2; // offbeat tick
        const hg = this.layers.hats.gate.gain;
        hg.setValueAtTime(0, ht);
        hg.linearRampToValueAtTime(1, ht + 0.004);
        hg.exponentialRampToValueAtTime(0.001, ht + 0.07);
      }
      this._pulseUntil += beat;
    }
  }

  /** Threat-entry riser: one-shot bandpass noise sweep, self-stopping. */
  _fireRiser(delayMs) {
    const ctx = this.sound.ctx;
    const t = ctx.currentTime + delayMs / 1000;
    const dur = BAR_MS / 1000;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(180, t);
    bp.frequency.exponentialRampToValueAtTime(3800, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(RISER_LEVEL, t + dur * 0.85);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.15);
    src.connect(bp).connect(g).connect(this.sound.master);
    src.start(t);
    src.stop(t + dur + 0.2);
  }

  /** One second of mono white noise, built once and reused. */
  _noiseBuffer(ctx) {
    if (this._noise) return this._noise;
    const len = Math.max(1, Math.floor(ctx.sampleRate));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return (this._noise = buf);
  }
}
