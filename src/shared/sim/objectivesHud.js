// Objective HUD evaluator (PRD-objective-hud.md, Cycle 23): client-side live
// progress for challenge objectives. Mirrors the server-side inclusive >=
// semantics of evaluateDailyRun/evaluateWeeklyRun but consumes only the
// machine-readable {id, kind, value} targets that /api/daily + /api/weekly
// expose (predicate functions never cross the wire).
//
// Consumers:
//   src/scenes/GameScene.js -> in-match objectives chip + menu subtitle lines
//   test/objectivesHud.test.mjs -> agreement pin vs server evaluators

/**
 * @param targets [{id, kind: 'wave'|'score', value}]
 * @param run {wave, score} — synced state snapshot
 * @returns [{id, done}] — deterministic; same order as input
 */
export function objectiveProgress(targets, run) {
  const wave = run?.wave ?? 0;
  const score = run?.score ?? 0;
  return (targets ?? []).map((t) => ({
    id: t.id,
    done: t.kind === 'wave' ? wave >= t.value
      : t.kind === 'score' ? score >= t.value
      : false,
  }));
}
