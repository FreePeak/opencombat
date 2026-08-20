// Minimap — top-down canvas showing active chunks (biome colors), player dots, and chunk grid.
// Zero-build: plain 2D canvas, no extra deps. Updates each frame from ChunkManager + player positions.

import { CHUNK_SIZE, biomeColor } from '../shared/worldgen.js';

export class Minimap {
  constructor({ size = 160, worldSeed = 1337 } = {}) {
    this.size = size;
    this.worldSeed = worldSeed;
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.canvas.style.cssText = `position:fixed; bottom:12px; right:12px; width:${size}px; height:${size}px; border:1px solid #333; border-radius:8px; background:#0b0e14; z-index:12; image-rendering:pixelated`;
    this.ctx = this.canvas.getContext('2d');
    this.chunkManager = null;
    this.players = new Map(); // sid -> {x,z, color, isSelf}
    // Append to DOM lazily
    if (typeof document !== 'undefined') {
      document.body.appendChild(this.canvas);
    }
  }

  attachChunkManager(chunkManager) {
    this.chunkManager = chunkManager;
  }

  setPlayers(playersMap, selfSid) {
    // playersMap is MapSchema or Map of PlayerState
    this.players.clear();
    for (const [sid, p] of playersMap) {
      this.players.set(sid, { x: p.x, z: p.z, color: p.color, isSelf: sid === selfSid });
    }
  }

  // World bounds to show: centered on self, span ~5 chunks
  update(selfX = 0, selfZ = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = this.size;
    ctx.clearRect(0, 0, s, s);
    // Background
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, s, s);

    const viewChunks = 5; // 5 chunk span
    const viewWorld = viewChunks * CHUNK_SIZE; // e.g. 160 units
    const half = viewWorld / 2;
    // Map world (wx,wz) to canvas (cx,cy)
    const toCanvas = (wx, wz) => {
      const dx = wx - selfX;
      const dz = wz - selfZ;
      const cx = s / 2 + (dx / viewWorld) * s;
      const cy = s / 2 + (dz / viewWorld) * s;
      return { x: cx, y: cy };
    };

    // Draw loaded chunks (biome tint)
    if (this.chunkManager) {
      for (const [, entry] of this.chunkManager.loaded) {
        const c = entry.chunk;
        const p0 = toCanvas(c.x, c.z);
        const p1 = toCanvas(c.x + CHUNK_SIZE, c.z + CHUNK_SIZE);
        const w = p1.x - p0.x;
        const h = p1.y - p0.y;
        const col = biomeColor(c.biome);
        // Convert hex to css
        const css = `#${col.toString(16).padStart(6, '0')}`;
        ctx.fillStyle = css;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(p0.x, p0.y, w, h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff12';
        ctx.strokeRect(p0.x, p0.y, w, h);
      }
    }

    // Draw players
    for (const [, p] of this.players) {
      const pos = toCanvas(p.x, p.z);
      const r = p.isSelf ? 4 : 3;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      const css = `#${(p.color >>> 0).toString(16).padStart(6, '0')}`;
      ctx.fillStyle = css;
      ctx.fill();
      if (p.isSelf) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Crosshair for self
    const center = toCanvas(selfX, selfZ);
    ctx.strokeStyle = '#ffffff40';
    ctx.beginPath();
    ctx.moveTo(center.x - 6, center.y);
    ctx.lineTo(center.x + 6, center.y);
    ctx.moveTo(center.x, center.y - 6);
    ctx.lineTo(center.x, center.y + 6);
    ctx.stroke();

    // Label
    ctx.fillStyle = '#fff8';
    ctx.font = '10px monospace';
    ctx.fillText('MAP', 6, 12);
  }

  dispose() {
    this.canvas.remove();
  }
}
