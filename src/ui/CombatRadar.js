// CombatRadar — match-mode HUD radar (PRD-combat-radar.md, Cycle 19): compact
// self-centered canvas for waves/daily/weekly/arena showing enemies (red),
// allies (player tints) and the arena frame. Zero-build plain 2D canvas like
// src/ui/Minimap.js; projection math lives in shared/sim/radar.js so it stays
// headlessly testable. Consumes the same synced x/z fields both rooms publish.

import { projectRadar } from '../shared/sim/radar.js';

export class CombatRadar {
  constructor({ size = 140, half = 30 } = {}) {
    this.size = size;
    this.half = half;
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.canvas.style.cssText = `position:fixed; bottom:12px; right:12px; width:${size}px; height:${size}px; border:1px solid #333; border-radius:50%; background:#0b0e14cc; z-index:12`;
    this.ctx = this.canvas.getContext('2d');
    if (typeof document !== 'undefined') document.body.appendChild(this.canvas);
  }

  // entities: [{x,z,color?,isSelf?}] — caller filters out the local player.
  render(entities, self) {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = this.size;
    ctx.clearRect(0, 0, s, s);
    // Arena frame + cardinal ticks
    ctx.strokeStyle = '#ffffff26';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - 2, 0, Math.PI * 2);
    ctx.stroke();

    const blips = projectRadar(entities, self, this.half);
    for (let i = 0; i < blips.length; i++) {
      const b = blips[i];
      const e = entities[i];
      const x = b.u * s;
      const y = b.v * s;
      const css = e.isSelf ? '#fff'
        : e.color != null ? `#${(e.color >>> 0).toString(16).padStart(6, '0')}`
        : '#ff4d4d';
      ctx.beginPath();
      ctx.arc(x, y, e.isSelf ? 4 : 3, 0, Math.PI * 2);
      ctx.fillStyle = css;
      ctx.globalAlpha = b.clamped ? 0.55 : 1; // rim blips read as "off-radar"
      ctx.fill();
      ctx.globalAlpha = 1;
      if (b.clamped) {
        ctx.strokeStyle = '#ff4d4d88';
        ctx.stroke();
      }
    }

    // Self ring at center
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#ffffff40';
    ctx.beginPath();
    ctx.moveTo(s / 2 - 6, s / 2);
    ctx.lineTo(s / 2 + 6, s / 2);
    ctx.moveTo(s / 2, s / 2 - 6);
    ctx.lineTo(s / 2, s / 2 + 6);
    ctx.stroke();
  }

  dispose() {
    this.canvas.remove();
    this.ctx = null;
  }
}
