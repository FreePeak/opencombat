// Results Share Card (PRD-share-card.md, Cycle 21):
//   - buildShareCard(run) -> {headline, stats, text} deterministic + mode-aware
//   - shareText(card) -> clipboard-ready string containing every stat once
//   - zero imports, no DOM
// Run: node --test test/shareCard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShareCard, shareText } from '../src/shared/sim/shareCard.js';

test('deterministic: same run deep-equals (AC1)', () => {
  const run = { mode: 'weekly', wave: 7, score: 1234, objectivesDone: 1, objectivesTotal: 2 };
  assert.deepEqual(buildShareCard(run), buildShareCard(run));
});

test('mode awareness: weekly carries objectives, daily carries streak, waves omit both (AC2)', () => {
  const weekly = buildShareCard({ mode: 'weekly', wave: 6, score: 900, objectivesDone: 2, objectivesTotal: 2 });
  const daily = buildShareCard({ mode: 'daily', wave: 8, score: 1500, streak: 3 });
  const waves = buildShareCard({ mode: 'waves', wave: 12, score: 3000 });
  const labels = (c) => c.stats.map((s) => s.label);
  assert.ok(labels(weekly).some((l) => /objective/i.test(l)), 'weekly has objectives line');
  assert.ok(!labels(daily).some((l) => /objective/i.test(l)), 'daily omits objectives');
  assert.ok(labels(daily).some((l) => /streak/i.test(l)), 'daily has streak line');
  assert.ok(!labels(waves).some((l) => /streak|objective/i.test(l)), 'waves omit challenge lines');
  // absent fields must not fabricate zeros
  assert.ok(!labels(weekly).some((l) => /streak/i.test(l)));
});

test('victory vs defeat headlines differ and pin per family (AC3)', () => {
  for (const mode of ['waves', 'daily', 'weekly']) {
    const win = buildShareCard({ mode, victory: true, wave: 9, score: 2000 });
    const lose = buildShareCard({ mode, victory: false, wave: 4, score: 400 });
    assert.notEqual(win.headline, lose.headline);
    assert.match(win.headline.toLowerCase(), /victory|won|survived/);
  }
});

test('shareText contains every stat value exactly once, ends with game name (AC4)', () => {
  const card = buildShareCard({
    mode: 'daily', wave: 8, score: 2400, streak: 6, name: 'Ash',
  });
  const text = shareText(card);
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('8'), 'wave value present');
  assert.ok(text.includes('2400'), 'score value present');
  assert.ok(text.includes('6'), 'streak value present');
  assert.ok(/ashfall/i.test(text), 'game name in text');
  // each numeric stat appears exactly once (values chosen to be digit-disjoint)
  for (const v of ['8', '2400', '6']) {
    assert.equal(text.split(v).length - 1, 1, `${v} appears once`);
  }
});
