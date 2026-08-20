// WorldScene — open world rendering: chunk streaming + InstancedMesh + minimap.
// Reuses GameScene's player/enemy/orb rendering but adds chunked ground and props.

import * as THREE from 'three';
import { ChunkManager } from '../client/ChunkManager.js';
import { Minimap } from '../ui/Minimap.js';
import { WorldState } from '../server/schema/StateSchema.js';

export class WorldScene {
  constructor({ renderer, camera, worldSeed = 1337 }) {
    this.renderer = renderer;
    this.camera = camera;
    this.worldSeed = worldSeed;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    this.chunkManager = new ChunkManager(this.scene, worldSeed);
    this.minimap = new Minimap({ worldSeed });
    this.minimap.attachChunkManager(this.chunkManager);
    this.players = new Map();
    this.selfSid = null;
    // Lighting (CC0 ambientCG style)
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(30, 40, 20);
    dir.castShadow = true;
    this.scene.add(dir);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));
  }

  attachRoom(room) {
    this.room = room;
    this.selfSid = room.sessionId;
    room.onStateChange((state) => this.onState(state));
    room.onMessage('chunksLoad', (msg) => this.onChunksLoad(msg));
    // Initial chunk load around origin
    this.chunkManager.updateForPos(0, 0);
  }

  onState(state) {
    if (!state) return;
    // Update minimap with player positions
    this.minimap.setPlayers(state.players, this.selfSid);
    // Stream chunks based on self position
    const me = state.players.get(this.selfSid);
    if (me) {
      this.chunkManager.updateForPos(me.x, me.z);
      this.minimap.update(me.x, me.z);
      // Camera follow
      const target = new THREE.Vector3(me.x, 7, me.z + 10);
      this.camera.position.lerp(target, 0.08);
      this.camera.lookAt(me.x, 0, me.z);
    }
  }

  onChunksLoad(msg) {
    // Server confirms chunk load — client already generates same chunks deterministically via ChunkManager
    // This is just a hook for future server-authoritative props (e.g., rare spawns)
    // For now, ensure those chunks are loaded (idempotent)
    if (msg.chunks) {
      for (const c of msg.chunks) {
        const key = `${c.cx},${c.cz}`;
        this.chunkManager.loadChunk(key);
      }
    }
  }

  update(dt) {
    // Called each frame from main loop
    this.minimap.update();
  }

  dispose() {
    this.chunkManager.dispose();
    this.minimap.dispose();
  }
}
