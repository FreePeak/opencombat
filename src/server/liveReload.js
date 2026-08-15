// Dev-only live reload (zero dependencies): watches the CLIENT sources
// (index.html, assets/, src/ minus src/server) and pushes a "reload" event
// over SSE to every connected page. Server-file changes are NOT watched
// here — `npm run dev` runs the server under `node --watch`, which restarts
// the process; pages detect that via the SSE connection drop and reload.
//
// Gate: enabled outside NODE_ENV=production (and unless LIVE_RELOAD=0).
import fs from 'node:fs';
import path from 'node:path';

const DEBOUNCE_MS = 250;

export function liveReloadEnabled(env = process.env) {
  return env.NODE_ENV !== 'production' && env.LIVE_RELOAD !== '0';
}

/**
 * Watch a directory tree with one non-recursive fs.watch per directory, so
 * it works on macOS/Linux/Windows without extra packages. `skip` is an
 * optional (dirPath) => boolean filter. Returns a disposer.
 */
function watchTree(root, onChange, skip) {
  const watchers = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip && skip(p)) continue;
        walk(p);
      }
    }
    try { watchers.push(fs.watch(dir, onChange)); } catch { /* unwatchable dir */ }
  };
  walk(root);
  return () => { for (const w of watchers) { try { w.close(); } catch { /* closed */ } } };
}

/**
 * The live-reload hub: `.clients` holds the open SSE responses, `broadcast()`
 * pushes "reload" to them, `start()` begins watching. Returns null when
 * live reload is disabled.
 */
export function createLiveReload({ root, enabled = liveReloadEnabled() }) {
  if (!enabled) return null;
  const clients = new Set();
  let stopWatching = () => {};
  let timer;

  const broadcast = () => {
    for (const res of clients) {
      try { res.write('data: reload\n\n'); } catch { clients.delete(res); }
    }
  };
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(broadcast, DEBOUNCE_MS); // one save = many fs events
  };

  const start = () => {
    const disposers = [];
    const serverDir = path.join('src', 'server');
    disposers.push(watchTree(path.join(root, 'src'), onChange, (p) => p.endsWith(serverDir)));
    disposers.push(watchTree(path.join(root, 'assets'), onChange));
    try {
      const w = fs.watch(path.join(root, 'index.html'), onChange);
      disposers.push(() => w.close());
    } catch { /* no index.html */ }
    stopWatching = () => { for (const d of disposers) d(); };
  };

  return { clients, start, broadcast };
}
