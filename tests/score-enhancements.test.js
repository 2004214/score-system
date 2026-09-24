'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const enhancements = require('../score-enhancements.js');

test('scores each specifically named honor once even if imported count is greater than one', () => {
  const result = enhancements.calculate({
    honors: [
      { name: '优秀学生', level: '校级', count: 5 },
      { name: '优秀干部', level: '院级', count: 2 }
    ]
  });
  assert.equal(result.honorScore, 5);
  assert.equal(result.score, 5);
  assert.equal(result.details.length, 2);
  assert.deepEqual(result.data.honors.map(item => item.count), [1, 1]);
});

test('adds multiple custom competition point values', () => {
  const result = enhancements.calculate({
    customCompetitions: [
      { name: '项目甲', level: '省级', points: 6 },
      { name: '项目乙', level: '国家级', points: 2.5 }
    ]
  });
  assert.equal(result.competitionScore, 8.5);
  assert.equal(result.score, 8.5);
});

test('ignores empty names, invalid levels, negative and non-numeric values', () => {
  const result = enhancements.calculate({
    honors: [
      { name: '', level: '校级', count: 3 },
      { name: '未知荣誉', level: '国家级', count: 1 },
      { name: '负数荣誉', level: '校级', count: -2 }
    ],
    customCompetitions: [
      { name: '负数项目', level: '校级', points: -1 },
      { name: '非数字项目', level: '校级', points: 'abc' }
    ]
  });
  assert.equal(result.score, 0);
  assert.deepEqual(result.data, { honors: [], customCompetitions: [] });
});

test('normalization is stable for saved and echoed form data', () => {
  const input = {
    honors: [{ name: '  优秀学生  ', level: '校级', count: '2.9' }],
    customCompetitions: [{ name: '  比赛  ', level: '院级', points: '3.5' }]
  };
  const once = enhancements.normalize(input);
  const twice = enhancements.normalize(once);
  assert.deepEqual(twice, once);
  assert.deepEqual(once, {
    honors: [{ name: '优秀学生', level: '校级', count: 1 }],
    customCompetitions: [{ name: '比赛', level: '院级', points: 3.5 }]
  });
});

test('scores a repeated competition or honor name only once', () => {
  const result = enhancements.calculate({
    customCompetitions: [
      { name: '校园创意赛校级一等奖', level: '校级', points: 6 },
      { name: '校园创意赛', level: '院级', points: 4 }
    ],
    honors: [
      { name: '校园创意赛', level: '校级', count: 1 }
    ]
  });
  assert.equal(result.score, 6);
  assert.equal(result.data.customCompetitions.length, 1);
  assert.equal(result.data.honors.length, 0);
});

test('does not merge the same annual activity from different years', () => {
  const result = enhancements.calculate({
    honors: [
      { name: '2024年校运动会优秀工作者', level: '校级' },
      { name: '2025年校运动会优秀工作者', level: '校级' }
    ]
  });
  assert.equal(result.score, 6);
  assert.equal(result.data.honors.length, 2);
});

test('cadre fallback scoring uses 3 points for any appointed role', () => {
  assert.deepEqual(enhancements.calculateCadreScore(0), { count: 0, points: 0 });
  assert.deepEqual(enhancements.calculateCadreScore(1), { count: 1, points: 3 });
  assert.deepEqual(enhancements.calculateCadreScore(2), { count: 2, points: 3 });
  assert.deepEqual(enhancements.calculateCadreScore(3), { count: 3, points: 3 });
  assert.deepEqual(enhancements.calculateCadreScore(9), { count: 3, points: 3 });
});
