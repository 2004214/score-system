'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../rules.json');

test('applies the revised academic and volunteer baselines', () => {
  assert.equal(rules.block3.volunteerBaseHours, 28.88);
  assert.equal(rules.block6.platformBaseBonus, 10);
});

test('defines the revised cadre tiers and branch activity limits', () => {
  assert.deepEqual(rules.block4.cadreRolePoints, { tier10: 10, tier8: 8, tier5: 5, tier3: 3 });
  assert.equal(rules.block4.groupActivityMax, 10);
  assert.equal(rules.block4.bigGroupActivityPerTime, 1);
});

test('defines separate practice brand and case bonuses', () => {
  assert.deepEqual(rules.block2.practiceBrand, { 院级: 3, 校级: 3, 兵团省级: 5, 国家级: 8 });
});
