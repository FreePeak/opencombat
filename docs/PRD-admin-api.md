# PRD: Admin API + GDPR Rights + Audit Log

Status: ACTIVE · Cycle 13 · 2026-08-22
Owner: hackathon loop (agent-driven)

## Problem
Roadmap 2.3: operators cannot list/export/delete player data, and there is no audit trail — a blocker for any real deployment (GDPR-style rights).

## Solution
Token-guarded admin endpoints over the existing persistence layer + an append-only JSON-lines audit log recording every admin action with actor and timestamp.

## Scope
1. Config: `ADMIN_TOKEN` env; when unset → all /api/admin/* routes return 404 (feature-off, zero surface). Auth via `Authorization: Bearer <token>` constant-time compare (node:crypto timingSafeEqual on sha256 digests).
2. Routes (inside buildHttpApp before catch-all):
   - `GET /api/admin/players` → `{ players: [{name, level, bestWave?, runs?}...] }` scanned from data/players/*.json (tolerate malformed)
   - `GET /api/admin/players/:name` → byte-complete export: full parsed JSON record (GDPR data portability), 404 unknown
   - `DELETE /api/admin/players/:name` → atomic delete of the file (+ in-flight debounced save cancellation via persistence hook if exposed) → `{deleted: name}`; 404 unknown
   - `GET /api/admin/audit` → last N audit lines (tail)
3. Audit log `data/audit.jsonl` via new pure-ish module `src/server/auditLog.js`: `appendAudit(entry)` → {ts, actor:'admin', action, target, outcome} one line JSON; appendFileSync with fsync-less simplicity; `readTail(n)`.
4. Every mutating/read of another user's data writes an audit entry BEFORE responding (delete failure also audited).
5. Tests (`test/adminApi.test.mjs`): feature-off 404s; wrong token 401; list shape; export byte-completeness (export deep-equals the file content); delete removes file AND subsequent loadPlayer returns null; audit lines appended for list(no)/export(yes)/delete(yes incl. failure case); token compare not timing-naive (unit on helper).

## Out of scope
Admin UI page, pagination beyond tail-N, rate limiting beyond global limiter, backup-before-delete.

## Acceptance criteria
- AC1: Unconfigured deployments expose no admin routes.
- AC2: Wrong/missing token → 401 for all three operations.
- AC3: Export is byte-complete vs the stored record.
- AC4: Delete is durable (file gone; debounced writer can't resurrect it).
- AC5: Audit trail records export+delete+failure with ts+action+target.
- AC6: Full gate green; smoke 8/8.

## Fan-out
Single agent (persistence seam cohesion).
