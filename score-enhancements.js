(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScoreEnhancements = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const HONOR_LEVELS = ['院级', '校级'];
  const COMPETITION_LEVELS = ['院级', '校级', '省级', '国家级'];

  function cleanName(value) {
    return String(value == null ? '' : value).trim();
  }

  function nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function normalizeScoringName(value) {
    let text = cleanName(value);
    if (typeof text.normalize === 'function') text = text.normalize('NFKC');
    return text
      .toUpperCase()
      .replace(/国家级|省部级|省级|兵团级|自治区级|校级|院校级|院级/g, '')
      .replace(/特等奖|一等奖|二等奖|三等奖|优秀奖|第一名|第二名|第三名|冠军|亚军|季军|参加过|成功参赛/g, '')
      .replace(/[“”"‘’'`（()）【】\[\]{}<>《》—\-‐‑‒–―·•,，.。;；:：/\\|\s]/g, '');
  }

  function normalizeEnhancementData(block) {
    const source = block || {};
    const honors = (Array.isArray(source.honors) ? source.honors : []).map(function(item) {
      const level = HONOR_LEVELS.indexOf(item && item.level) >= 0 ? item.level : '';
      const rawCount = item && item.count;
      return {
        name: cleanName(item && item.name),
        level: level,
        count: rawCount == null ? 1 : (nonNegativeNumber(rawCount) > 0 ? 1 : 0)
      };
    }).filter(function(item) {
      return item.name && item.level && item.count > 0;
    });

    const customCompetitions = (Array.isArray(source.customCompetitions) ? source.customCompetitions : []).map(function(item) {
      const level = COMPETITION_LEVELS.indexOf(item && item.level) >= 0 ? item.level : '';
      return {
        name: cleanName(item && item.name),
        level: level,
        points: nonNegativeNumber(item && item.points)
      };
    }).filter(function(item) {
      return item.name && item.level && item.points > 0;
    });

    const seen = new Set();
    const uniqueCompetitions = customCompetitions.filter(function(item) {
      const key = normalizeScoringName(item.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const uniqueHonors = honors.filter(function(item) {
      const key = normalizeScoringName(item.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { honors: uniqueHonors, customCompetitions: uniqueCompetitions };
  }

  function calculateEnhancementScore(block) {
    const normalized = normalizeEnhancementData(block);
    let honorScore = 0;
    let competitionScore = 0;
    const details = [];

    normalized.honors.forEach(function(item) {
      const unit = item.level === '校级' ? 3 : 2;
      const subtotal = item.count * unit;
      honorScore += subtotal;
      details.push('荣誉《' + item.name + '》[' + item.level + ']' + item.count + '次+' + subtotal);
    });

    normalized.customCompetitions.forEach(function(item) {
      competitionScore += item.points;
      details.push('自定义比赛《' + item.name + '》[' + item.level + ']+' + item.points);
    });

    return {
      score: honorScore + competitionScore,
      honorScore: honorScore,
      competitionScore: competitionScore,
      details: details,
      data: normalized
    };
  }

  function calculateCadreScore(count) {
    const normalizedCount = Math.min(Math.max(Math.floor(nonNegativeNumber(count)), 0), 3);
    const points = normalizedCount > 0 ? 3 : 0;
    return { count: normalizedCount, points: points };
  }

  return {
    normalize: normalizeEnhancementData,
    calculate: calculateEnhancementScore,
    calculateCadreScore: calculateCadreScore,
    normalizeScoringName: normalizeScoringName
  };
});
