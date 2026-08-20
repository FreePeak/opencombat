// Phase 4 TDD: leveling + upgrade cards.
// Covers progression.js pure math: xp curve, seeded rollUpgrades, upgrade pool,
// aggregate bonuses, effective stat/skill helpers.
// Run: node test/progression.test.mjs  or  npm test
import assert from 'node:assert/strict';
import {
  UPGRADES, getUpgrade, xpForLevel, levelForXp, xpToNextLevel,
  rollUpgrades, countOwned, aggregateBonuses,
  effectiveMaxHp, effectiveSpeedMult, effectiveAttackCdMult, effectiveSkillCdMult,
  effectiveSkill, effectiveMeleeDamage, effectiveRangedDamage, effectiveXp, effectivePickupMult,
  AUTO_PICK_MS
} from '../src/shared/progression.js';
import { SERVER } from '../src/server/config.js';
import { classStats, SKILLS } from '../src/shared/skills.js';

// ---------------------------------------------------------------------------
// 1. XP curve
// ---------------------------------------------------------------------------
{
  assert.equal(xpForLevel(1), 0, 'level 1 needs 0 xp');
  assert.equal(xpForLevel(2), 100, 'level 2 needs 100');
  assert.equal(xpForLevel(3), 250, 'level 3 needs 250');
  assert.equal(xpForLevel(4), 450, 'level 4 needs 450');
  assert.equal(xpForLevel(5), 700, 'level 5 needs 700');
  assert.equal(xpForLevel(6), 1000, 'level 6 needs 1000');
  // monotonic
  for (let l = 1; l < 15; l++) assert.ok(xpForLevel(l + 1) > xpForLevel(l), `xpForLevel monotonic at ${l}`);
  // negative / 0 clamp
  assert.equal(xpForLevel(0), 0, 'level 0 clamped to 1');
  assert.equal(xpForLevel(-5), 0, 'negative level clamped');
}

{
  assert.equal(levelForXp(0), 1, '0 xp -> level 1');
  assert.equal(levelForXp(99), 1, '99 xp -> level 1');
  assert.equal(levelForXp(100), 2, '100 xp -> level 2');
  assert.equal(levelForXp(249), 2, '249 xp -> level 2');
  assert.equal(levelForXp(250), 3, '250 xp -> level 3');
  assert.equal(levelForXp(449), 3, '449 -> level 3');
  assert.equal(levelForXp(450), 4, '450 -> level 4');
  assert.equal(levelForXp(10000), levelForXp(10000), 'large xp computes');
}

{
  assert.equal(xpToNextLevel(0), 100, '0 xp needs 100 to next');
  assert.equal(xpToNextLevel(50), 50, '50 xp needs 50 to next');
  assert.equal(xpToNextLevel(100), 150, '100 xp (level 2) needs 150 to level 3');
}

// ---------------------------------------------------------------------------
// 2. Upgrade pool — ~16 entries, passives + skill-specific
// ---------------------------------------------------------------------------
{
  assert.equal(UPGRADES.length, 16, 'UPGRADES has 16 entries');
  const passives = UPGRADES.filter(u => u.kind === 'passive');
  const skills = UPGRADES.filter(u => u.kind === 'skill');
  assert.equal(passives.length, 8, '8 passives');
  assert.equal(skills.length, 8, '8 skill-specific');
  // 2 per class
  for (let c = 0; c < 4; c++) {
    const count = skills.filter(u => u.forClass === c).length;
    assert.equal(count, 2, `class ${c} has 2 skill upgrades`);
  }
  // every upgrade has required fields
  for (const u of UPGRADES) {
    assert.ok(typeof u.id === 'string' && u.id.length > 0, `upgrade ${u.id} has id`);
    assert.ok(typeof u.name === 'string' && u.name.length > 0, `${u.id} has name`);
    assert.ok(typeof u.desc === 'string' && u.desc.length > 0, `${u.id} has desc`);
    assert.ok(typeof u.maxStacks === 'number' && u.maxStacks >= 1, `${u.id} has maxStacks`);
    assert.ok(u.bonuses && typeof u.bonuses === 'object', `${u.id} has bonuses`);
  }
  // ids unique
  const ids = UPGRADES.map(u => u.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
  assert.ok(getUpgrade('vitality'), 'getUpgrade finds vitality');
  assert.equal(getUpgrade('nope'), null, 'getUpgrade misses unknown');
}

// ---------------------------------------------------------------------------
// 3. countOwned helper (Map / Array / plain)
// ---------------------------------------------------------------------------
{
  const m = new Map([['vitality', 2], ['swift', 1]]);
  assert.equal(countOwned(m, 'vitality'), 2, 'Map count');
  assert.equal(countOwned(m, 'missing'), 0, 'Map missing -> 0');
  assert.equal(countOwned(['vitality', 'vitality', 'swift'], 'vitality'), 2, 'Array count');
  assert.equal(countOwned(['vitality'], 'swift'), 0, 'Array missing');
  assert.equal(countOwned({ vitality: 3 }, 'vitality'), 3, 'Object count');
  assert.equal(countOwned(null, 'vitality'), 0, 'null -> 0');
  assert.equal(countOwned(undefined, 'vitality'), 0, 'undefined -> 0');
}

// ---------------------------------------------------------------------------
// 4. rollUpgrades: seeded, deterministic, distinct, class-filtered, maxStacks
// ---------------------------------------------------------------------------
{
  const a = rollUpgrades(123, 0, new Map());
  const b = rollUpgrades(123, 0, new Map());
  assert.deepEqual(a, b, 'same seed + character -> same rollout');
  assert.equal(a.length, 3, 'rolls 3 choices');
  assert.equal(new Set(a).size, 3, 'choices distinct');

  const c = rollUpgrades(456, 0, new Map());
  assert.notDeepEqual(a, c, 'different seed -> different rollout');

  // class filtering
  const knightPicks = rollUpgrades(42, 0, new Map());
  const archerPicks = rollUpgrades(42, 1, new Map());
  // knight picks should never contain archer-only upgrades
  const archerOnly = UPGRADES.filter(u => u.forClass === 1).map(u => u.id);
  const knightOnly = UPGRADES.filter(u => u.forClass === 0).map(u => u.id);
  for (const id of knightPicks) assert.ok(!archerOnly.includes(id), `knight rollout ${id} not archer-only`);
  for (const id of archerPicks) assert.ok(!knightOnly.includes(id), `archer rollout ${id} not knight-only`);

  // maxStacks filtering: at max, never offered
  const ownedMax = new Map([['vitality', 5]]); // vitality maxStacks 5
  const picks = rollUpgrades(99, 0, ownedMax);
  assert.ok(!picks.includes('vitality'), 'maxed vitality not rolled');

  // string seed also deterministic
  const s1 = rollUpgrades('hello', 2, new Map());
  const s2 = rollUpgrades('hello', 2, new Map());
  assert.deepEqual(s1, s2, 'string seed deterministic');

  // owned as Array
  const picksArr = rollUpgrades(77, 0, ['vitality', 'vitality', 'vitality', 'vitality', 'vitality']);
  assert.ok(!picksArr.includes('vitality'), 'Array owned at max not rolled');

  // If everything filtered, returns fewer than 3 (not crash)
  const allMax = new Map(UPGRADES.filter(u => u.forClass === undefined || u.forClass === 0).map(u => [u.id, 99]));
  const few = rollUpgrades(1, 0, allMax);
  assert.ok(few.length <= 3, 'exhausted pool returns <=3');
}

{
  // seeded stability: 100 different seeds all give 3 distinct picks
  for (let seed = 0; seed < 100; seed++) {
    const picks = rollUpgrades(seed, 2, new Map());
    assert.equal(picks.length, 3, `seed ${seed} gives 3`);
    assert.equal(new Set(picks).size, 3, `seed ${seed} distinct`);
  }
}

// ---------------------------------------------------------------------------
// 5. aggregateBonuses
// ---------------------------------------------------------------------------
{
  const m = new Map([['vitality', 2], ['swift', 1]]);
  const b = aggregateBonuses(m);
  assert.equal(b.hp, 60, '2 vitality = 60 hp');
  assert.equal(b.speedMult, 0.12, '1 swift = 0.12');

  // Array variant counts same
  const b2 = aggregateBonuses(['vitality', 'vitality', 'swift']);
  assert.deepEqual(b, b2, 'Array aggregate matches Map');

  // plain object
  const b3 = aggregateBonuses({ vitality: 2, swift: 1 });
  assert.deepEqual(b, b3, 'Object aggregate matches');

  // unknown id ignored
  const b4 = aggregateBonuses(new Map([['nope', 5]]));
  assert.equal(b4.hp, 0, 'unknown id ignored');

  // empty / null
  assert.equal(aggregateBonuses(null).hp, 0, 'null gives zeros');
  assert.equal(aggregateBonuses(new Map()).hp, 0, 'empty map zeros');
}

// ---------------------------------------------------------------------------
// 6. effective stat helpers
// ---------------------------------------------------------------------------
{
  // effectiveMaxHp
  const baseKnight = classStats(0).hp; // 150
  assert.equal(effectiveMaxHp(0, new Map()), baseKnight, 'no vitality = base hp');
  assert.equal(effectiveMaxHp(0, new Map([['vitality', 1]])), baseKnight + 30, '1 vitality');
  assert.equal(effectiveMaxHp(0, new Map([['vitality', 3]])), baseKnight + 90, '3 vitality');
  // array form
  assert.equal(effectiveMaxHp(0, ['vitality', 'vitality']), baseKnight + 60, 'array vitality');

  // effectiveSpeedMult
  assert.equal(effectiveSpeedMult(new Map()), 1, 'no swift = 1x');
  assert.equal(effectiveSpeedMult(new Map([['swift', 1]])), 1.12, '1 swift 1.12');
  assert.equal(effectiveSpeedMult(new Map([['swift', 2]])), 1.24, '2 swift 1.24');

  // effectiveAttackCdMult / skillCd
  assert.equal(effectiveAttackCdMult(new Map()), 1, 'no quick_draw = 1');
  assert.equal(effectiveAttackCdMult(new Map([['quick_draw', 1]])), 0.85, '1 quick_draw 0.85');
  assert.equal(effectiveAttackCdMult(new Map([['quick_draw', 3]])), 0.55, '3 quick_draw 0.55');
  // clamp at 0.4 (even if more stacks would go lower, but maxStacks 3 caps it to 0.55)
  assert.ok(effectiveAttackCdMult(new Map([['quick_draw', 10]])) >= 0.4, 'clamped >=0.4');

  assert.equal(effectiveSkillCdMult(new Map()), 1, 'no focused =1');
  assert.equal(effectiveSkillCdMult(new Map([['focused', 1]])), 0.8, '1 focused 0.8');
  assert.equal(effectiveSkillCdMult(new Map([['focused', 2]])), 0.6, '2 focused 0.6');

  // effectiveMeleeDamage
  const baseMelee = classStats(0).meleeDamage; // 2
  assert.equal(effectiveMeleeDamage(0, new Map()), baseMelee, 'no heavy_hand');
  assert.equal(effectiveMeleeDamage(0, new Map([['heavy_hand', 1]])), baseMelee + 1, '1 heavy_hand');
  assert.equal(effectiveMeleeDamage(0, ['heavy_hand', 'heavy_hand']), baseMelee + 2, 'array 2');

  // effectiveRangedDamage
  const baseRanged = classStats(1).rangedDamage; // 1
  assert.equal(effectiveRangedDamage(1, new Map()), baseRanged, 'no sharpshooter');
  assert.equal(effectiveRangedDamage(1, new Map([['sharpshooter', 2]])), baseRanged + 2, '2 sharpshooter');

  // effectiveXp
  assert.equal(effectiveXp(20, new Map()), 20, 'no scholar');
  assert.equal(effectiveXp(20, new Map([['scholar', 1]])), 24, '1 scholar 20*1.2=24');
  assert.equal(effectiveXp(20, new Map([['scholar', 2]])), 28, '2 scholar 20*1.4=28');
  assert.equal(effectiveXp(20, ['scholar', 'scholar', 'scholar']), 32, '3 scholar 20*1.6=32 floored');

  // effectivePickupMult
  assert.equal(effectivePickupMult(new Map()), 1, 'no looter');
  assert.equal(effectivePickupMult(new Map([['looter', 1]])), 1.4, '1 looter');
  assert.equal(effectivePickupMult(new Map([['looter', 2]])), 1.8, '2 looter');
}

// ---------------------------------------------------------------------------
// 7. effectiveSkill (bash/multishot/firewave/chainlight)
// ---------------------------------------------------------------------------
{
  const bash = SKILLS[0]; // bash
  assert.equal(effectiveSkill(bash, new Map()).damage, bash.damage, 'bash no upgrades');
  assert.equal(effectiveSkill(bash, new Map()).stunDurationMs, bash.stunDurationMs, 'bash stun no upgrades');
  assert.equal(effectiveSkill(bash, new Map([['bash_damage', 1]])).damage, bash.damage + 1, 'bash +damage');
  assert.equal(effectiveSkill(bash, new Map([['bash_damage', 2]])).damage, bash.damage + 2, 'bash +2 damage');
  assert.equal(effectiveSkill(bash, new Map([['bash_stun', 1]])).stunDurationMs, bash.stunDurationMs + 500, 'bash +stun');
  assert.equal(effectiveSkill(bash, new Map([['bash_stun', 2]])).stunDurationMs, bash.stunDurationMs + 1000, 'bash +2 stun');
  // combined
  const comb = effectiveSkill(bash, new Map([['bash_damage', 1], ['bash_stun', 1]]));
  assert.equal(comb.damage, bash.damage + 1, 'bash combined damage');
  assert.equal(comb.stunDurationMs, bash.stunDurationMs + 500, 'bash combined stun');

  const ms = SKILLS[1]; // multishot
  assert.equal(effectiveSkill(ms, new Map()).arrowCount, ms.arrowCount, 'ms no upgrade');
  assert.equal(effectiveSkill(ms, new Map([['multishot_extra', 1]])).arrowCount, ms.arrowCount + 2, 'Volley +2');
  assert.equal(effectiveSkill(ms, new Map([['multishot_extra', 2]])).arrowCount, ms.arrowCount + 4, 'Volley +4');
  assert.equal(effectiveSkill(ms, new Map([['multishot_dmg', 1]])).damage, ms.damage + 1, 'Piercing +1');

  const fw = SKILLS[2]; // firewave
  assert.equal(effectiveSkill(fw, new Map()).fireballCount, fw.fireballCount, 'fw no upgrade');
  assert.equal(effectiveSkill(fw, new Map([['firewave_extra', 1]])).fireballCount, fw.fireballCount + 1, 'Inferno +1');
  assert.equal(effectiveSkill(fw, new Map([['firewave_burn', 2]])).burnDamage, fw.burnDamage + 2, 'Sear +2');

  const cl = SKILLS[3]; // chainlight
  assert.equal(effectiveSkill(cl, new Map()).maxTargets, cl.maxTargets, 'cl no upgrade');
  assert.equal(effectiveSkill(cl, new Map([['chain_extra', 1]])).maxTargets, cl.maxTargets + 1, 'Overcharge +1');
  assert.equal(effectiveSkill(cl, new Map([['chain_damage', 1]])).damage, cl.damage + 0.5, 'Chain Power +0.5');
  assert.equal(effectiveSkill(cl, new Map([['chain_damage', 2]])).damage, cl.damage + 1.0, 'Chain Power +1');
}

// ---------------------------------------------------------------------------
// 8. AUTO_PICK_MS constant + non-circular import contract
// ---------------------------------------------------------------------------
{
  assert.equal(AUTO_PICK_MS, 10000, 'auto-pick is 10s');
  // classStats must still work — no circular import breakage
  assert.ok(classStats(0).hp > 0, 'classStats still loads');
}

console.log('ok — progression.test.mjs: xp curve, rollUpgrades seeded/class/maxStacks, bonuses, effective skill/stat helpers verified');
process.exit(0);
