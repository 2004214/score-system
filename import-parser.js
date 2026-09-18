(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScoreImportParser = api;
})(typeof window !== 'undefined' ? window : null, function() {
  'use strict';

  const HEADER_ALIASES = {
    className: ['班级单位', '班级'],
    name: ['姓名'],
    gender: ['性别'],
    nation: ['民族'],
    birth: ['出生年月日', '出生日期'],
    activist: ['积极分子期数'],
    position: ['曾担任职务情况包括班委团委学生会及各种社团组织', '职务描述'],
    practice: ['参加社会实践及获奖情况', '社会实践及获奖情况'],
    volunteerHonor: ['参加志愿活动及获奖情况', '志愿活动及获奖情况'],
    volunteerHours: ['志愿汇在校志愿时长总时长近一年时长', '志愿总时长近一年时长'],
    culture: ['曾参加文体活动及获奖情况', '文体活动及获奖情况'],
    failRecent: ['考察期内不及格门数近一年内', '考察期不及格门数'],
    failTotal: ['入校以来不及格总数'],
    cet: ['CET4CET6HSK成绩', 'CET成绩'],
    rank: ['上一年综合排名综测', '综合排名'],
    group: ['组别'],
    dorm: ['宿舍号'],
    remark: ['备注']
  };

  function cleanText(value) {
    if (value === null || typeof value === 'undefined') return '';
    let text = String(value).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (typeof text.normalize === 'function') text = text.normalize('NFKC');
    return text;
  }

  function normalizeHeader(value) {
    return cleanText(value)
      .toUpperCase()
      .replace(/[\s\n\r\t]/g, '')
      .replace(/[()（）【】\[\]{}<>《》、,，.。;；:：/\\|“”"'`]/g, '');
  }

  function normalizeIdentity(value) {
    return cleanText(value).replace(/\s+/g, '').toLowerCase();
  }

  function splitEntries(value) {
    const text = cleanText(value).replace(/\r\n?/g, '\n');
    if (!text) return [];
    return text
      .replace(/\s{2,}(?=20\d{2}年?)/g, '\n')
      .split(/\n+|[；;]+|(?=20\d{2}年?)/)
      .map(function(item) { return cleanText(item).replace(/^[、,，。\s]+|[、,，。\s]+$/g, ''); })
      .filter(Boolean);
  }

  function addWarning(target, field, message, evidence, severity) {
    target.push({
      field: field,
      message: message,
      evidence: cleanText(evidence),
      severity: severity || 'warning'
    });
  }

  function inferLevel(text) {
    const value = cleanText(text);
    const explicit = [
      { re: /国家级/, level: '国家级' },
      { re: /(?:省部级|省级|兵团级|自治区级)/, level: '省级' },
      { re: /校级/, level: '校级' },
      { re: /(?:院校级|院级)/, level: '院级' }
    ];
    const explicitMatches = explicit.filter(function(item) { return item.re.test(value); });
    const explicitLevels = Array.from(new Set(explicitMatches.map(function(item) { return item.level; })));
    if (explicitLevels.length > 1) {
      return { level: '', inferred: false, conflict: true, reason: '同时出现多个明确级别：' + explicitLevels.join('、') };
    }
    if (explicitLevels.length === 1) return { level: explicitLevels[0], inferred: false, conflict: false, reason: '明确级别' };

    const inferred = [
      { re: /(?:全国|国家|中国)/, level: '国家级', reason: '全国/国家/中国关键词' },
      { re: /(?:兵团|自治区|省)/, level: '省级', reason: '省/兵团/自治区关键词' },
      { re: /(?:塔里木大学|校运会|校运动会)/, level: '校级', reason: '学校名称关键词' },
      { re: /学院/, level: '院级', reason: '学院关键词' }
    ];
    const inferredMatches = inferred.filter(function(item) { return item.re.test(value); });
    const inferredLevels = Array.from(new Set(inferredMatches.map(function(item) { return item.level; })));
    if (inferredLevels.length > 1) {
      return { level: '', inferred: false, conflict: true, reason: '主办单位同时指向多个级别：' + inferredLevels.join('、') };
    }
    if (inferredMatches.length) {
      return { level: inferredMatches[0].level, inferred: true, conflict: false, reason: inferredMatches[0].reason };
    }
    return { level: '', inferred: false, conflict: false, reason: '' };
  }

  function detectAward(text) {
    const value = cleanText(text);
    const match = value.match(/特等奖|一等奖|二等奖|三等奖|优秀奖/);
    if (match) return match[0];
    if (/(?:成功参赛|成功奖|参与奖|参加过|参加比赛|入围)/.test(value)) return '参加过';
    return '';
  }

  function normalizeCompetitionName(value) {
    return cleanText(value)
      .toUpperCase()
      .replace(/20\d{2}(?:年|赛季)?/g, '')
      .replace(/[“”"‘’'`]/g, '')
      .replace(/[（()）【】\[\]{}<>《》]/g, '')
      .replace(/[—\-‐‑‒–―·•,，.。;；:：/\\|]/g, '')
      .replace(/\s+/g, '');
  }

  function getCompetitionCoreName(value) {
    return normalizeCompetitionName(value)
      .replace(/全国|中国|国际|高校|高等学校|大学生|本科院校|职业院校|院校|学校/g, '')
      .replace(/挑战赛|选拔赛|竞赛|大赛|比赛|论坛|作品展|年会展示/g, '');
  }

  function findAcademicCompetition(value, competitions) {
    const input = normalizeCompetitionName(value);
    const inputCore = getCompetitionCoreName(value);
    if (!input || !Array.isArray(competitions) || !competitions.length) return null;

    const ranked = competitions.map(function(name) {
      const normalized = normalizeCompetitionName(name);
      const core = getCompetitionCoreName(name);
      let score = 0;
      if (input === normalized) score = 100000 + normalized.length;
      else if (normalized.length >= 4 && input.indexOf(normalized) >= 0) score = 80000 + normalized.length;
      else if (input.length >= 4 && normalized.indexOf(input) >= 0) score = 70000 + input.length;
      else if (core.length >= 4 && inputCore.indexOf(core) >= 0) score = 60000 + core.length;
      else if (inputCore.length >= 4 && core.indexOf(inputCore) >= 0) score = 50000 + inputCore.length;

      const cups = cleanText(name).match(/[\u4e00-\u9fa5A-Za-z0-9·•]+杯/g) || [];
      cups.forEach(function(cup) {
        const alias = normalizeCompetitionName(cup);
        if (alias.length >= 3 && input.indexOf(alias) >= 0) score = Math.max(score, 40000 + alias.length);
      });
      const abbreviations = cleanText(name).toUpperCase().match(/[A-Z][A-Z0-9-]{1,}/g) || [];
      abbreviations.forEach(function(abbreviation) {
        const alias = normalizeCompetitionName(abbreviation);
        if (alias.length >= 2 && input.indexOf(alias) >= 0) score = Math.max(score, 30000 + alias.length);
      });
      return { name: name, score: score };
    }).filter(function(item) { return item.score > 0; })
      .sort(function(a, b) { return b.score - a.score; });

    if (!ranked.length) return null;
    if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
    return ranked[0].name;
  }

  function detectCultureRank(text) {
    const value = cleanText(text);
    if (/(?:第一名|冠军|一等奖)/.test(value)) return { rank: '第一名', inferred: /一等奖/.test(value) };
    if (/(?:第二名|亚军|二等奖)/.test(value)) return { rank: '第二名', inferred: /二等奖/.test(value) };
    if (/(?:第三名|季军|三等奖)/.test(value)) return { rank: '第三名', inferred: /三等奖/.test(value) };
    if (/(?:参加过|参加比赛|参赛|方阵)/.test(value)) return { rank: '参加过', inferred: false };
    return { rank: '', inferred: false };
  }

  function mapBlock1Level(level) {
    return level === '省级' ? '省部级' : level;
  }

  function parseNumber(value) {
    const match = cleanText(value).match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : 0;
  }

  function countMatches(text, regex) {
    const matches = cleanText(text).match(regex);
    return matches ? matches.length : 0;
  }

  function parseVolunteerHours(value, warnings, evidence) {
    const text = cleanText(value);
    if (!text) return { total: 0, recent: 0 };
    const numbers = text.match(/\d+(?:\.\d+)?/g) || [];
    if (numbers.length >= 2) {
      evidence.push('志愿时长：总' + numbers[0] + '小时，近一年' + numbers[1] + '小时');
      return { total: Number(numbers[0]), recent: Number(numbers[1]) };
    }
    if (numbers.length === 1) {
      addWarning(warnings, '志愿时长', '只识别到一个时长，按总时长保存，近一年时长按0处理', text);
      return { total: Number(numbers[0]), recent: 0 };
    }
    addWarning(warnings, '志愿时长', '未识别到数字时长', text);
    return { total: 0, recent: 0 };
  }

  function parseCadre(text, warnings, evidence) {
    const value = cleanText(text);
    if (!value) return 0;
    const rolePattern = /副班主任|团支书|副?书记|副?部长|副?主任|副?主席|班长|委员|干事|教官|队员|会长|副?社长/g;
    const roles = value.match(rolePattern) || [];
    if (!roles.length) {
      addWarning(warnings, '职务', '有职务描述，但未匹配到可计数的职务关键词', value);
      return 0;
    }
    evidence.push('职务关键词：' + roles.join('、'));
    return roles.length;
  }

  function parsePractice(text, warnings, evidence) {
    const entries = splitEntries(text);
    const practices = [];
    entries.forEach(function(entry) {
      const levelInfo = inferLevel(entry);
      const award = detectAward(entry);
      if (levelInfo.conflict) addWarning(warnings, '社会实践', levelInfo.reason + '，该条不自动计分', entry);
      if (levelInfo.inferred) {
        addWarning(warnings, '社会实践', '按' + levelInfo.reason + '推断为' + levelInfo.level, entry);
      }
      if (award && levelInfo.level) {
        practices.push({ name: entry, level: levelInfo.level, award: award });
        evidence.push('社会实践：' + levelInfo.level + award);
      } else {
        practices.push({ desc: entry });
        if (/获|奖|优秀|表彰/.test(entry) && (!award || !levelInfo.level)) {
          addWarning(warnings, '社会实践', '奖项或级别信息不完整，该条仅保留原文', entry);
        }
      }
    });
    return practices;
  }

  function parseCompetitions(text, isAcademic, warnings, evidence, field, academicCompetitions) {
    const entries = splitEntries(text);
    const competitions = [];
    const innovations = [];
    entries.forEach(function(entry) {
      const levelInfo = inferLevel(entry);
      const award = detectAward(entry);
      if (levelInfo.conflict) addWarning(warnings, field, levelInfo.reason + '，该条不自动计分', entry);

      if (/(?:创新创业训练计划|大创)/.test(entry) && /(?:立项|结项)/.test(entry)) {
        const innovation = { establish: '', complete: '' };
        if (/立项/.test(entry)) {
          if (levelInfo.level === '国家级') innovation.establish = 'nationalEstablish';
          if (levelInfo.level === '校级') innovation.establish = 'schoolEstablish';
        }
        if (/结项/.test(entry)) {
          const passed = /(?:合格|通过)/.test(entry);
          const excellent = /优秀/.test(entry);
          if (levelInfo.level === '国家级') innovation.complete = excellent ? 'nationalCompleteExcellent' : (passed ? 'nationalCompletePass' : '');
          if (levelInfo.level === '校级') innovation.complete = excellent ? 'schoolCompleteExcellent' : (passed ? 'schoolCompletePass' : '');
        }
        if (innovation.establish || innovation.complete) {
          innovations.push(innovation);
          evidence.push('大创项目：' + entry);
          if (levelInfo.inferred) addWarning(warnings, field, '按' + levelInfo.reason + '推断大创级别', entry);
          return;
        }
      }

      if (levelInfo.inferred) addWarning(warnings, field, '按' + levelInfo.reason + '推断为' + levelInfo.level, entry);
      if (!award || !levelInfo.level) {
        if (entry) addWarning(warnings, field, '未完整识别奖项和级别，该条不计分', entry);
        return;
      }
      const matchedAcademicName = findAcademicCompetition(entry, academicCompetitions);
      if (isAcademic && !matchedAcademicName) {
        addWarning(warnings, field, '未能在144项学科竞赛库中唯一匹配，该条不自动计分', entry);
        return;
      }
      const effectiveAcademic = !!matchedAcademicName;
      competitions.push({
        name: matchedAcademicName || entry,
        selectedName: matchedAcademicName || '',
        isManual: !effectiveAcademic,
        level: levelInfo.level,
        award: award,
        isAcademic: effectiveAcademic
      });
      evidence.push((effectiveAcademic ? '匹配144项学科竞赛：' + matchedAcademicName + '，' : '非学科竞赛：') + levelInfo.level + award);
    });
    return { competitions: competitions, innovations: innovations };
  }

  function parseCulture(text, warnings, evidence) {
    const entries = splitEntries(text);
    const competitions = [];
    let excellent = 0;
    entries.forEach(function(entry) {
      if (/优秀(?:演员|运动员|工作者|组织者|个人)/.test(entry)) {
        excellent += countMatches(entry, /优秀(?:演员|运动员|工作者|组织者|个人)/g);
        evidence.push('文体优秀个人：' + entry);
      }
      const levelInfo = inferLevel(entry);
      const rankInfo = detectCultureRank(entry);
      if (levelInfo.conflict) addWarning(warnings, '文体活动', levelInfo.reason + '，该条不自动计分', entry);
      if (!rankInfo.rank) {
        if (/获|奖|名|参赛|方阵/.test(entry) && !/优秀(?:演员|运动员|工作者|组织者|个人)/.test(entry)) {
          addWarning(warnings, '文体活动', '未识别到前三名或参与信息，该条不计竞赛分', entry);
        }
        return;
      }
      if (!levelInfo.level) {
        addWarning(warnings, '文体活动', '未识别活动级别，该条不计竞赛分', entry);
        return;
      }
      if (levelInfo.inferred) addWarning(warnings, '文体活动', '按' + levelInfo.reason + '推断为' + levelInfo.level, entry);
      if (rankInfo.inferred) addWarning(warnings, '文体活动', '将奖项等次换算为对应名次', entry);
      competitions.push({ name: entry, level: mapBlock1Level(levelInfo.level), rank: rankInfo.rank });
      evidence.push('文体活动：' + mapBlock1Level(levelInfo.level) + rankInfo.rank);
    });
    return { competitions: competitions, excellent: excellent };
  }

  function parseVolunteerHonors(text, practices, warnings, evidence) {
    const entries = splitEntries(text);
    const result = { excellentStudent: 0, excellentCadre: 0, excellentLeague: 0 };
    entries.forEach(function(entry) {
      if (/优秀学生干部/.test(entry)) result.excellentCadre += countMatches(entry, /优秀学生干部/g);
      else if (/优秀学生(?!干部)/.test(entry)) result.excellentStudent += countMatches(entry, /优秀学生(?!干部)/g);
      if (/优秀共青团员/.test(entry)) result.excellentLeague += countMatches(entry, /优秀共青团员/g);
      if (/优秀志愿者|星级志愿者/.test(entry)) practices.push({ desc: entry });
      if (/优秀共青团干部/.test(entry)) addWarning(warnings, '志愿荣誉', '评分规则未定义“优秀共青团干部”，已保留原文但不自动加分', entry);
    });
    if (result.excellentStudent) evidence.push('优秀学生' + result.excellentStudent + '次');
    if (result.excellentCadre) evidence.push('优秀学生干部' + result.excellentCadre + '次');
    if (result.excellentLeague) evidence.push('优秀共青团员' + result.excellentLeague + '次');
    return result;
  }

  function parseCet(text, warnings, evidence) {
    const value = cleanText(text);
    const result = { cet4: false, cet6: false };
    if (!value) return result;

    const cet6 = value.match(/(?:CET\s*6|六级|CET6)[^0-9]*(\d{3})/i);
    const cet4 = value.match(/(?:CET\s*4|四级|CET4)[^0-9]*(\d{3})/i);
    if (cet6 && Number(cet6[1]) >= 425) {
      result.cet6 = true;
      evidence.push('CET6 ' + cet6[1] + '，达到425分');
    }
    if (cet4 && Number(cet4[1]) >= 425) {
      result.cet4 = true;
      evidence.push('CET4 ' + cet4[1] + '，达到425分');
    }
    if (!cet4 && !cet6 && /^\d{3}$/.test(value)) {
      const score = Number(value);
      if (score >= 425) {
        result.cet4 = true;
        evidence.push('数字成绩' + score + '，暂按CET4处理');
        addWarning(warnings, '英语成绩', '仅有数字，暂按CET4成绩推断', value);
      }
    }
    if (/HSK/i.test(value)) addWarning(warnings, '语言成绩', '现有评分规则没有HSK自动加分项，仅保留原文', value);
    return result;
  }

  function formatDate(value, xlsx, warnings) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
    }
    if (typeof value === 'number' && xlsx && xlsx.SSF && xlsx.SSF.parse_date_code) {
      const parsed = xlsx.SSF.parse_date_code(value);
      if (parsed) return [parsed.y, String(parsed.m).padStart(2, '0'), String(parsed.d).padStart(2, '0')].join('-');
    }
    const text = cleanText(value);
    const match = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (match) return [match[1], match[2].padStart(2, '0'), match[3].padStart(2, '0')].join('-');
    addWarning(warnings, '出生日期', '日期格式未识别，已保留原值', text);
    return text;
  }

  function findHeaderIndex(headers, aliases) {
    for (let i = 0; i < headers.length; i++) {
      if (aliases.indexOf(headers[i]) >= 0) return i;
    }
    return -1;
  }

  function findWorkbookSheet(workbook, xlsx) {
    let fallback = null;
    for (let s = 0; s < workbook.SheetNames.length; s++) {
      const sheetName = workbook.SheetNames[s];
      const sheet = workbook.Sheets[sheetName];
      const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
      const scanLimit = Math.min(matrix.length, 8);
      for (let r = 0; r < scanLimit; r++) {
        const headers = (matrix[r] || []).map(normalizeHeader);
        const hasName = findHeaderIndex(headers, HEADER_ALIASES.name) >= 0;
        const hasClass = findHeaderIndex(headers, HEADER_ALIASES.className) >= 0;
        if (!hasName || !hasClass) continue;
        const joined = headers.join('|');
        const layout = /参加社会实践及获奖情况|志愿汇在校志愿时长/.test(joined) ? 'development' : 'simple';
        const candidate = { sheetName: sheetName, sheet: sheet, matrix: matrix, headerRow: r, headers: headers, layout: layout };
        if (sheetName === '情况了解' || layout === 'development') return candidate;
        if (!fallback) fallback = candidate;
      }
    }

    const firstName = workbook.SheetNames[0];
    const firstSheet = workbook.Sheets[firstName];
    const firstMatrix = xlsx.utils.sheet_to_json(firstSheet, { header: 1, defval: '', raw: true });
    const firstTwoRows = (firstMatrix[0] || []).concat(firstMatrix[1] || []).map(normalizeHeader).join('|');
    if (/评分结果|板块一得分|总分/.test(firstTwoRows)) {
      return { sheetName: firstName, sheet: firstSheet, matrix: firstMatrix, headerRow: 0, headers: [], layout: 'standard' };
    }
    return fallback;
  }

  function buildLegacyObjects(found) {
    const matrix = found.matrix;
    const row1 = matrix[0] || [];
    const row2 = matrix[1] || [];
    const standard = found.layout === 'standard' ||
      row1.indexOf('评分结果') >= 0 || row2.indexOf('板块一得分') >= 0 || row2.indexOf('总分') >= 0;
    const headerRow = standard ? 1 : found.headerRow;
    const firstHeader = standard ? row1 : [];
    const secondHeader = matrix[headerRow] || [];
    const maxLen = Math.max(firstHeader.length, secondHeader.length);
    const headers = [];
    for (let i = 0; i < maxLen; i++) headers.push(cleanText(secondHeader[i] || firstHeader[i] || ''));
    return matrix.slice(headerRow + 1).map(function(row, index) {
      const raw = {};
      headers.forEach(function(header, column) {
        if (header) raw[header] = row[column] || '';
      });
      raw.__scoreSystemTemplate = standard ? 'standard' : 'simple';
      return { sourceRow: headerRow + index + 2, raw: raw, record: null, warnings: [], evidence: [], status: 'ready', selected: true };
    }).filter(function(item) {
      return Object.keys(item.raw).some(function(key) { return cleanText(item.raw[key]) !== ''; });
    });
  }

  function parseDevelopmentRow(row, sourceRow, headers, xlsx, options) {
    const warnings = [];
    const evidence = [];
    const index = {};
    Object.keys(HEADER_ALIASES).forEach(function(key) {
      index[key] = findHeaderIndex(headers, HEADER_ALIASES[key]);
    });
    function cell(key) { return index[key] >= 0 ? row[index[key]] : ''; }

    const practices = parsePractice(cell('practice'), warnings, evidence);
    const volunteerHonors = parseVolunteerHonors(cell('volunteerHonor'), practices, warnings, evidence);
    const hours = parseVolunteerHours(cell('volunteerHours'), warnings, evidence);
    const culture = parseCulture(cell('culture'), warnings, evidence);

    // This form defines J as academic and K as non-academic under one merged header.
    const academicText = row[9] || '';
    const nonAcademicText = row[10] || '';
    const academicCompetitions = (options && options.academicCompetitions) || [];
    const academic = parseCompetitions(academicText, true, warnings, evidence, '学科竞赛', academicCompetitions);
    const nonAcademic = parseCompetitions(nonAcademicText, false, warnings, evidence, '非学科竞赛', academicCompetitions);
    const cet = parseCet(cell('cet'), warnings, evidence);
    const failRecent = Math.max(0, Math.trunc(parseNumber(cell('failRecent'))));
    const failTotal = Math.max(0, Math.trunc(parseNumber(cell('failTotal'))));
    const practiceText = cleanText(cell('practice'));
    const positionText = cleanText(cell('position'));
    const name = cleanText(cell('name'));
    const className = cleanText(cell('className'));

    const record = {
      name: name,
      className: className,
      group: cleanText(cell('group')),
      dorm: cleanText(cell('dorm')),
      gender: cleanText(cell('gender')),
      nation: cleanText(cell('nation')),
      birth: formatDate(cell('birth'), xlsx, warnings),
      activist: cleanText(cell('activist')),
      failRecent: failRecent,
      failTotal: failTotal,
      cet: cleanText(cell('cet')),
      rank: cleanText(cell('rank')),
      remark: cleanText(cell('remark')),
      b1: { noViolation: false, club: 0, excellent: culture.excellent, competitions: culture.competitions, publications: [] },
      b2: {
        volHours: hours.total,
        volHoursRecent: hours.recent,
        sanxia: countMatches(practiceText, /三下乡/g),
        fanjia: countMatches(practiceText, /返家乡/g),
        practices: practices,
        competitions: []
      },
      b3: {
        cadre: parseCadre(positionText, warnings, evidence),
        positionDesc: positionText,
        excellentStudent: volunteerHonors.excellentStudent,
        excellentCadre: volunteerHonors.excellentCadre,
        excellentLeague: volunteerHonors.excellentLeague
      },
      b4: {
        competitions: academic.competitions.concat(nonAcademic.competitions),
        innovations: academic.innovations.concat(nonAcademic.innovations),
        academicWorks: [],
        academicPapers: [],
        patents: [],
        professionalCerts: [],
        cet4: cet.cet4,
        cet6: cet.cet6
      },
      b5: {
        avg: 70,
        fails: Array.from({ length: failRecent }, function(_, i) {
          return { name: '未提供课程名' + (i + 1), type: 'fail' };
        })
      },
      sourceDetails: {
        practice: practiceText,
        volunteerHonor: cleanText(cell('volunteerHonor')),
        academicCompetition: cleanText(academicText),
        nonAcademicCompetition: cleanText(nonAcademicText),
        culture: cleanText(cell('culture'))
      }
    };

    if (!name) addWarning(warnings, '姓名', '缺少姓名，不能导入该行', '', 'error');
    if (!className) addWarning(warnings, '班级', '缺少班级，无法自动匹配重复人员', '', 'warning');
    if (failRecent > 0) evidence.push('近一年不及格' + failRecent + '门，每门按普通挂科扣分');
    if (record.b2.sanxia) evidence.push('三下乡' + record.b2.sanxia + '次');
    if (record.b2.fanjia) evidence.push('返家乡' + record.b2.fanjia + '次');

    const hasError = warnings.some(function(item) { return item.severity === 'error'; });
    return {
      sourceRow: sourceRow,
      raw: null,
      record: record,
      warnings: warnings,
      evidence: evidence,
      status: hasError ? 'invalid' : (warnings.length ? 'warning' : 'ready'),
      selected: !hasError
    };
  }

  function parseWorkbook(workbook, xlsx, options) {
    if (!workbook || !xlsx || !xlsx.utils) throw new Error('工作簿解析器不可用');
    const found = findWorkbookSheet(workbook, xlsx);
    if (!found) throw new Error('未找到同时包含“姓名”和“班级”的人员数据表');
    if (found.layout !== 'development') {
      return { sheetName: found.sheetName, layout: found.layout, rows: buildLegacyObjects(found) };
    }

    const rows = [];
    for (let r = found.headerRow + 1; r < found.matrix.length; r++) {
      const row = found.matrix[r] || [];
      if (!row.some(function(cell) { return cleanText(cell) !== ''; })) continue;
      rows.push(parseDevelopmentRow(row, r + 1, found.headers, xlsx, options || {}));
    }
    return { sheetName: found.sheetName, layout: found.layout, rows: rows };
  }

  return {
    cleanText: cleanText,
    normalizeHeader: normalizeHeader,
    normalizeIdentity: normalizeIdentity,
    splitEntries: splitEntries,
    inferLevel: inferLevel,
    detectAward: detectAward,
    findAcademicCompetition: findAcademicCompetition,
    findWorkbookSheet: findWorkbookSheet,
    parseWorkbook: parseWorkbook
  };
});
