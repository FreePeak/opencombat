// Share card image rendering (PRD-share-card.md "Cycle: image rendering"):
//   - layoutShareCard(card) -> deterministic 800x450 geometry+colors, pure
//   - chooseShareMode({canShareFiles, clipboardImage}) -> capability ladder
// Run: node --test test/shareCardImage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildShareCard, layoutShareCard, chooseShareMode } from '../src/shared/sim/shareCard.js';

const RUN = { mode: 'daily', victory: true, wave: 9, score: 4210, name: 'Ash', streak: 3 };
const CARD = buildShareCard(RUN);

test('AC1 layoutShareCard is deterministic (same card -> deep-equal layout)', () => {
  assert.deepEqual(layoutShareCard(CARD), layoutShareCard(buildShareCard(RUN)));
});

test('AC1 every stat appears as a row inside canvas bounds with distinct y', () => {
  const L = layoutShareCard(CARD);
  assert.equal(L.w, 800);
  assert.equal(L.h, 450);
  assert.equal(L.rows.length, CARD.stats.length);
  const ys = new Set();
  for (let i = 0; i < L.rows.length; i++) {
    const row = L.rows[i];
    assert.equal(row.label, CARD.stats[i].label);
    assert.equal(String(row.value), String(CARD.stats[i].value));
    assert.ok(row.y > 0 && row.y < L.h, `row ${i} inside vertical bounds`);
    assert.ok(row.labelX > 0 && row.labelX < L.w);
    ys.add(row.y);
  }
  assert.equal(ys.size, L.rows.length, 'baselines distinct');
});

test('AC1 title carries headline text within bounds; footer names the game', () => {
  const L = layoutShareCard(CARD);
  assert.equal(L.title.text, CARD.headline);
  assert.ok(L.title.x > 0 && L.title.x < L.w);
  assert.ok(L.title.y > 0 && L.title.y < L.h);
  assert.match(L.footer.text, /Ashfall/);
});

test('AC2 chooser: native wins when files shareable', () => {
  assert.equal(chooseShareMode({ canShareFiles: true, clipboardImage: true }), 'native');
  assert.equal(chooseShareMode({ canShareFiles: true, clipboardImage: false }), 'native');
});

test('AC2 chooser: image copy when ClipboardItem exists but no file share', () => {
  assert.equal(chooseShareMode({ canShareFiles: false, clipboardImage: true }), 'image');
});

test('AC2 chooser: text fallback when neither capability exists', () => {
  assert.equal(chooseShareMode({ canShareFiles: false, clipboardImage: false }), 'text');
});

test('FR-GAME-03/RET-03 regression: max-width cards keep every row inside the canvas and clear of the footer', () => {
  // Worst realistic cards after the Kills + Time rows shipped:
  const waves = layoutShareCard(buildShareCard({
    mode: 'waves', victory: true, wave: 12, score: 9999, kills: 87, timeSec: 754, name: 'Ash',
  })); // 6 rows
  const weekly = layoutShareCard(buildShareCard({
    mode: 'weekly', victory: false, wave: 12, score: 9999, kills: 87, timeSec: 754,
    objectivesDone: 3, objectivesTotal: 4, name: 'Ash',
  })); // 7 rows
  const footerTop = waves.h - 32 - 16; // footer baseline minus its size
  for (const [label, L] of [['waves', waves], ['weekly', weekly]]) {
    assert.ok(L.rows.length >= 6, `${label} card has ${L.rows.length} rows`);
    for (const row of L.rows) {
      assert.ok(row.y < L.h, `${label} row "${row.label}" baseline ${row.y} off-canvas`);
      assert.ok(row.y <= 382,
        `${label} row "${row.label}" baseline ${row.y} collides with footer glyphs (~${footerTop})`);
    }
    // monotone spacing preserved when compressed
    for (let i = 1; i < L.rows.length; i++) {
      assert.ok(L.rows[i].y > L.rows[i - 1].y, `${label} rows must stay strictly descending in y`);
    }
  }
});
