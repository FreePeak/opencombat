// Structured logging: one JSON object per line with a stable event name and
// a sessionId/roomId when available. Plain JSON lines — no dependency — so
// any log shipper (docker logs, loki, ELK, ...) can ingest them directly.
const emit = (level, event, fields = {}) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'warn') console.warn(line);
  else if (level === 'error') console.error(line);
  else console.log(line);
};

export const log = (event, fields = {}) => emit('info', event, fields);
export const warn = (event, fields = {}) => emit('warn', event, fields);
export const error = (event, fields = {}) => emit('error', event, fields);
