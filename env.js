// Static boot config for GitHub Pages hosting. The Node server generates
// this file dynamically (src/server/http.js, PUBLIC_URL env var) and takes
// precedence when it serves the client itself — this copy only answers on
// static hosting, where the server's route does not exist.
//
// Set wsUrl to your Cloudflare tunnel hostname so the Pages client joins
// YOUR server by default, e.g.:
//   window.__OPENGAME__ = { wsUrl: 'wss://game.yourdomain.com' };
// null = fall back to the ?server= share link / same-origin / localhost
// chain in src/config.js (and, when nothing is reachable, the browser-local
// single-player mode).
window.__OPENGAME__ = { wsUrl: null, bloom: false };
