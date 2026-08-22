# Research: Vampire Survivors & the Bullet-Heaven Genre

Status: ACTIVE · Research cycle R3 · 2026-08-22
Owner: hackathon loop (agent-driven)
Feeds: ranked idea backlog below + next gameplay PRDs. Companion to
docs/COMPETITORS.md (B2B/OSS positioning) — this file owns GAMEPLAY-genre
research only.

## Why this research

Ashfall already has the arena-survival skeleton (waves, XP levels, shop,
power-ups, daily challenge) but every enemy is an identical chaser and kills
grant XP abstractly. Vampire Survivors is the reference implementation of the
genre's retention loop; studying it + its imitators tells us which mechanics
buy the most engagement per unit of engineering.

## 1. VS core loop (reference mechanics)

| Mechanic | What it does | Why it works |
|---|---|---|
| Auto-attack weapons | Player steers, weapons fire | Removes aim skill-gate; spectacle without input load |
| XP gems drop on kill | Every kill spawns a pickup; magnet radius pulls them | Converts each kill into a physical reward event; creates risk/reward (walk into the swarm to collect) |
| Level-up choice screen | Pause, pick 1 of 3–4 upgrades | Agency beat every ~30–60s early game; cadence slows naturally as curve flattens |
| Weapon evolution | Max-level weapon + specific passive → evolved weapon at chest/opening | Long-run goal inside every run; build planning |
| 30-min timeline | Scripted spawn waves per minute, boss at minute 25, Death at 30 | Fixed arc guarantees climax; run length respects session size |
| Gold + PowerUp shop | Meta currency buys permanent stat bumps | Between-run progression hooks retention |
| Character/chance unlocks | New characters/weapons/secrets unlock via achievements | Dozens of "one more run" triggers |
| Treasure chests | Reward burst moments with anticipation animation | Variable-ratio reinforcement |

## 2. Game-feel lessons (ranked by leverage for Ashfall)

1. **Reward every kill physically** — a dropped orb/gem at the corpse turns
   score into spatial play. Ashfall's orb pickup system exists but orbs never
   drop from kills (pre-seeded only). Highest-leverage single change.
2. **Enemy identity > enemy count** — shooters/tanks/swarmers force target
   prioritization; pure chaser waves stay background noise regardless of HP
   scaling. (Audit gap: HIGH.)
3. **Spike moments every ~60–90s** — elites/chests/bosses punctuate the loop.
   Elite Affixes (cycle 2.6) delivers exactly this; keep the cadence contract.
4. **Upgrade cadence shapes pacing** — early level-ups every 30–60s feel
   generative; verify our XP curve front-loads choices.
5. **Deterministic seeds make content shareable** — Daily Gauntlet already
   ships this; extend the same seed discipline to any new spawner.
6. **Screen-fill spectacle needs perf headroom** — clones die at high entity
   counts; our fixed pool (10) is safe but caps spectacle. Object-pool +
   spatial-hash patterns are the escape hatch if we raise density.
7. **Meta-progression multiplies runs** — waves mode resets fully today;
   even a small persistent per-account unlock track (WorldRoom persistence
   pattern) would hook repeat play.
8. **Agency beats auto-battle for multiplayer** — competitors that kept
   aiming/dodging (Brotato, 20MTD) retain better; our manual J/K identity is
   a differentiator, not a gap. Do not add auto-attack.
9. **Risk/reward pickups** (magnet, chests in danger) create stories; magnet
   upgrades exist (`looter`), extend toward pull-on-demand or burst drops.
10. **Readability at scale** — silhouettes/tints must read at distance;
    elite scale+tint render follows this rule.
11. **Failure states should be legible** — telegraphs (Volatile fuse ring,
    shooter windups) keep deaths fair; reuse SkillFx.ring for any new
    dangerous behavior.
12. **Session-length honesty** — 30-min VS runs vs our endless waves: an
    explicit "run end" (score target exists; consider wave-based finale)
    makes wins shareable like dailies.

## 3. Architecture patterns worth copying

- **Data-driven tables**: weapons/enemies as plain data arrays (our
  `ELITE_AFFIXES`, `UPGRADES`, `CLASS_STATS` pattern) — keep all new enemy
  behaviors table-driven in shared/sim so both rooms consume one source.
- **Deterministic selection over RNG coordination**: `affixForWave(n)`
  style index math keeps online/offline parity structural. Reuse for
  archetype assignment.
- **Fixed pool + slot revival**: ids stay stable; new behaviors must ride
  existing slots (no dynamic entity creation mid-match).
- **Pure sim modules with injected clock/ctx**: combatBook ctx pattern
  (volatilePending map, damagePlayer routing) is how AoE/DoT behaviors stay
  testable — copy for any new delayed/splash mechanic.
- **Server-authoritative everything; client renders state** — EnemyState
  carries a string tag (`elite`) and client derives visuals; archetype tags
  follow identically.

## 4. Competitor snapshot (gameplay lens)

| Game | Differentiator we can steal | Not applicable |
|---|---|---|
| Vampire Survivors | Gem-drop economy; evolution recipes | Solo-only pacing, auto-attack |
| Brotato | Tight 20-min runs; item-shop build identity between waves | Arena format (we have it) |
| HoloCure | Free-to-play generosity; character variety; minimap events | IP-driven content |
| 20 Minutes Till Dawn | Active aim + reload risk/reward; elite modifiers similar to ours | Twin-stick controls |
| Death Must Die | Genre blend (roguelite blessings) | Scope |
| Soulstone Survivors | Skill-tree depth, many simultaneous projectiles | Perf budget mismatch |
| Nomad Survival / OSS clones | Cautionary: perf collapse past few hundred entities, shallow meta | — |

## 5. Open-source clone failure modes (avoid)

1. Per-frame O(n²) collision without spatial hashing → death spiral at high
   counts (we are pool-capped at 10; fine).
2. Non-deterministic spawners breaking replay/shareability (dailies pin us).
3. Client-side authority drift between offline/local modes (parity tests
   pin us — extend to every new behavior).
4. No meta layer → churn after novelty (roadmap Q2+ candidate).

## 6. Ranked idea backlog (effort × impact, current codebase)

| # | Idea | Impact | Effort | Plug-in points | Status |
|---|---|---|---|---|---|
| 1 | Kill-drop XP orbs (burst at corpse, magnet pull) | High | S–M | combatBook kill branch, orb charge system, magnet power-up | SHIPPED (charged orbs b40264f; magnet 3d42bff) |
| 2 | Enemy archetypes (Shooter/Rusher/Tank) via deterministic per-wave tags | High | M | shared/sim/archetypes.js (new), chase loops both rooms, StateSchema tag, client tint/scale | SHIPPED all three (750844e Rusher/Tank; Shooter cycle landed with projectileLoop enemy-owned branch) |
| 3 | Wave-finale run end + results share card | Med | S–M | matchPhases win conditions, GameScene banner | SHIPPED core (finale+surge+boss 761d5c8/8268a8a); share card backlog |
| 4 | Persistent waves-mode meta (unlock track) | Med | M | persistence.js + PlayerStore shape from daily finalize | backlog |
| 5 | Trickle spawns during intermission tail | Low–Med | S | matchPhases/updatePlaying spawner | backlog |
| 6 | Magnet power-up (pull all orbs) | Low–Med | S | SERVER.powerUps + pickup loop | backlog |

## 7. Decision for this cycle

Implement **#2 Enemy Archetypes** (docs/PRD-enemy-archetypes.md): it attacks
the audit's highest-severity gameplay gap (behavioral variety), composes with
Elite Affixes (an archetype can also be an elite), and its diff surface avoids
the concurrently-contested combatBook/index.html paths once 2.6 lands.
#1 stays queued as the immediate follow-on because it touches the same
kill-path code 2.6 just modified.

## Sources

- poncle dev interviews/postmortems (Steam blog, GDC-style retrospectives)
- Steam reviews/community threads for VS + listed competitors (pain points)
- GitHub survey of OSS survivors-like clones (Godot/Unity/js stacks)
- Web-scout pass was dispatched for 2026-era competitor freshness; findings pending — mechanics/lessons above are stable reference knowledge (VS 2022-era design is fully documented).
