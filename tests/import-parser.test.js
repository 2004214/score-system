'use strict';

process.env.TZ = 'Asia/Shanghai';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('../lib/xlsx.full.min.js');
const parser = require('../import-parser.js');
const RULES = require('../rules.json');

function parseWorkbook(workbook) {
  const serialized = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const importedWorkbook = XLSX.read(serialized, { type: 'buffer', cellDates: false });
  return parser.parseWorkbook(importedWorkbook, XLSX, {
    academicCompetitions: RULES.block5.academicCompetitions
  });
}

function createDevelopmentWorkbook() {
  const headers = [
    '序号', '班级（单位）', '姓名', '性别', '民族', '出生年月日', '积极分子期数',
    '曾担任职务情况（包括班委团委学生会及各种社团组织）',
    '参加社会实践及获奖情况\n',
    '参加科创及获奖情况（左侧学科竞赛，右侧非学科竞赛）', '',
    '参加志愿活动及获奖情况', '志愿汇在校志愿时长（总时长/近一年时长）',
    '曾参加文体活动及获奖情况', '考察期内不及格门数\n（近一年内）',
    '入校以来不及格总数', 'CET4/CET6/HSK成绩', '上一年综合排名（综测）',
    '组别', '宿舍号', '备注'
  ];
  const rows = [
    headers,
    [
      1, '测试2024级1班', '张同学', '女', '汉族', new Date(2005, 8, 30), '78期',
      '班长、学生会宣传部副部长',
      '2025年塔里木大学暑期“三下乡”社会实践活动校级二等奖',
      'CIMC“西门子杯”中国智能制造挑战赛校级二等奖',
      '全国大学生创新能力大赛一等奖',
      '塔里木大学优秀学生干部\n校级优秀志愿者',
      '120.5/75.5',
      '塔里木大学校园定向赛第二名\n校运会优秀运动员',
      1, 2, 'CET4 428', '3/40', '档案组', '新1-101', ''
    ],
    [],
    [
      2, '测试2024级2班', '李同学', '男', '汉族', '2005年9月3日', '78期',
      '组织委员', '', '', '大学生创新创业训练计划项目国家级立项', '',
      '80/20', '', 0, 0, 449, '5/42', '宣传组', '新1-102', ''
    ]
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  ws['!merges'] = [{ s: { r: 0, c: 9 }, e: { r: 0, c: 10 } }];
  const list = XLSX.utils.aoa_to_sheet([['序号', '竞赛名称'], [1, '示例竞赛']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '情况了解');
  XLSX.utils.book_append_sheet(wb, list, '学科竞赛类比赛');
  return wb;
}

test('normalizes headers and removes invisible formatting', () => {
  assert.equal(parser.normalizeHeader(' 考察期内不及格门数\n（近一年内） '), '考察期内不及格门数近一年内');
  assert.equal(parser.normalizeIdentity(' 测试 2024级1班 '), '测试2024级1班');
});

test('splits multiline and adjacent-year narrative entries', () => {
  assert.deepEqual(
    parser.splitEntries('2024年第一项\n2025年第二项；2026年第三项'),
    ['2024年第一项', '2025年第二项', '2026年第三项']
  );
  assert.deepEqual(
    parser.splitEntries('2024年第一项获奖          2025年第二项获奖、2026年第三项获奖'),
    ['2024年第一项获奖', '2025年第二项获奖', '2026年第三项获奖']
  );
});

test('prefers explicit levels and infers organizer levels', () => {
  assert.deepEqual(parser.inferLevel('全国比赛校级二等奖'), { level: '校级', inferred: false, conflict: false, reason: '明确级别' });
  assert.deepEqual(parser.inferLevel('塔里木大学校园比赛二等奖'), { level: '校级', inferred: true, conflict: false, reason: '学校名称关键词' });
  assert.deepEqual(parser.inferLevel('机械电气化工程学院活动一等奖'), { level: '院级', inferred: true, conflict: false, reason: '学院关键词' });
  assert.equal(parser.inferLevel('国家级项目获校级二等奖').conflict, true);
});

test('counts 三下乡 and 返家乡 once per year', () => {
  assert.equal(
    parser.countAnnualOccurrences('2024年暑期三下乡活动；2024年三下乡获院级优秀团队；2025年寒假三下乡活动', '三下乡'),
    2
  );
  assert.equal(
    parser.countAnnualOccurrences('2024年返家乡实践；2024年返家乡获奖；2026年返家乡实践', '返家乡'),
    2
  );
  assert.equal(parser.countAnnualOccurrences('三下乡、三下乡', '三下乡'), 1);
});

test('matches every official academic competition to its canonical library name', () => {
  const competitions = RULES.block5.academicCompetitions;
  assert.equal(competitions.length, 144);
  competitions.forEach(name => {
    assert.equal(parser.findAcademicCompetition(name + ' 校级二等奖', competitions), name);
  });
  assert.equal(parser.findAcademicCompetition('完全不在目录中的匿名项目校级一等奖', competitions), null);
  assert.equal(parser.findAcademicCompetition('2025大学生创新大赛校级三等奖', competitions), '中国国际大学生创新大赛（2025）');
  assert.equal(parser.findAcademicCompetition('十五届挑战杯兵团大学生创业计划三等奖', competitions), '“挑战杯”中国大学生创业计划大赛');
  assert.equal(parser.findAcademicCompetition('塔里木大学第十五届挑战杯院级三等奖', competitions), '“挑战杯”中国大学生创业计划大赛');
  assert.equal(parser.findAcademicCompetition('塔里木大学第五届智慧农业与智能装备校级二等奖', competitions), '塔里木大学“智慧农业与智能装备”创新设计大赛');
  assert.equal(parser.findAcademicCompetition('2024-12 全国三维数字化创新大赛国家级二等奖', competitions), '全国三维数字化创新设计大赛');
  assert.equal(parser.findAcademicCompetition('2025-08 全国大学生物理实验竞赛西北赛区优秀奖', competitions), '全国大学生物理实验竞赛（创新）');
});

test('keeps conflicting competition levels unscored with a warning', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.J2.v = '国家级项目获校级二等奖';
  ws.J2.w = '国家级项目获校级二等奖';

  const parsed = parser.parseWorkbook(wb, XLSX);
  const first = parsed.rows[0];
  const retained = first.record.b5.competitions.filter(item => item.isAcademic);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].scoreEligible, false);
  assert.ok(first.warnings.some(item => item.field === '学科竞赛' && /不自动计分/.test(item.message)));
});

test('detects the personnel sheet and ignores the competition reference sheet', () => {
  const found = parser.findWorkbookSheet(createDevelopmentWorkbook(), XLSX);
  assert.equal(found.sheetName, '情况了解');
  assert.equal(found.layout, 'development');
});

test('parses merged J/K competition columns and narrative scoring inputs', () => {
  const parsed = parseWorkbook(createDevelopmentWorkbook());
  assert.equal(parsed.rows.length, 2);

  const first = parsed.rows[0];
  assert.equal(first.sourceRow, 2);
  assert.equal(first.record.name, '张同学');
  assert.equal(first.record.birth, '2005-09-30');
  assert.equal(first.record.b3.volHours, 120.5);
  assert.equal(first.record.b3.volHoursRecent, 75.5);
  assert.equal(first.record.b2.sanxia, 1);
  assert.equal(first.record.b2.practices.length, 1);
  assert.deepEqual(first.record.b3.volunteerHonors.map(item => item.name), [
    '塔里木大学优秀学生干部',
    '校级优秀志愿者'
  ]);
  assert.ok(first.record.b4.cadre >= 2);
  assert.equal(first.record.b4.excellentCadre, 1);
  assert.equal(first.record.b5.cet4, true);
  assert.equal(first.record.b6.fails.length, 1);
  assert.equal(first.record.b5.competitions.length, 2);
  assert.equal(first.record.b5.competitions[0].isAcademic, true);
  assert.equal(first.record.b5.competitions[0].selectedName, 'CIMC“西门子杯”中国智能制造挑战赛');
  assert.equal(first.record.b5.competitions[0].isManual, false);
  assert.equal(first.record.b5.competitions[1].isAcademic, false);
  assert.equal(first.record.b1.competitions[0].rank, '第二名');
  assert.equal(first.record.b1.excellent, undefined);
  assert.deepEqual(first.record.b1.honors, [
    { name: '校运会优秀运动员', level: '校级', count: 1 }
  ]);
});

test('retains all five competition rows and the separate innovation project from the reported layout', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.J2.v = [
    '“挑战杯”中国大学生创业计划大赛   院级三等奖',
    '“挑战杯”中国大学生创业计划大赛   院级优秀奖'
  ].join('\n');
  ws.J2.w = ws.J2.v;
  ws.K2.v = [
    '大学生创新创业训练计划项目   国家级立项',
    '塔里木大学大学生创新大赛   校级三等奖',
    '塔里木大学大学生创新大赛   校级二等奖',
    '塔里木大学数智化企业经济沙盘大赛   校级三等奖'
  ].join('\n');
  ws.K2.w = ws.K2.v;

  const first = parseWorkbook(wb).rows[0];
  assert.equal(first.record.b5.competitions.length, 5);
  assert.equal(first.record.b5.innovations.length, 1);
  assert.equal(first.record.b5.innovations[0].establish, 'nationalEstablish');
  assert.equal(first.record.b5.competitions.filter(item => item.scoreEligible !== false).length, 5);
  assert.deepEqual(first.record.sourceDetails.audit.J, { source: 2, saved: 2 });
  assert.deepEqual(first.record.sourceDetails.audit.K, { source: 4, saved: 4 });
});

test('keeps a full excellent activity name and scores it only as one honor', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.N2.v = '塔里木大学校运会优秀运动员一等奖';
  ws.N2.w = '塔里木大学校运会优秀运动员一等奖';

  const first = parseWorkbook(wb).rows[0];
  assert.equal(first.record.b1.competitions.length, 0);
  assert.deepEqual(first.record.b1.honors, [
    { name: '塔里木大学校运会优秀运动员一等奖', level: '校级', count: 1 }
  ]);
});

test('scores every competition occurrence even when names repeat across J and K', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.K2.v = 'CIMC“西门子杯”中国智能制造挑战赛校级二等奖';
  ws.K2.w = 'CIMC“西门子杯”中国智能制造挑战赛校级二等奖';

  const first = parseWorkbook(wb).rows[0];
  const matches = first.record.b5.competitions.filter(item => /西门子杯/.test(item.name));
  assert.equal(matches.length, 2);
  assert.ok(matches.every(item => item.scoreEligible !== false));
  assert.equal(first.warnings.some(item => /重复|同一项目/.test(item.message)), false);
});

test('keeps every named practice award and all thirteen excellent culture entries', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.I2.v = [
    '塔里木大学机械电气化工程学院2024年暑假“三下乡”社会实践活动 院级优秀团队/优秀个人',
    '塔里木大学纺织服装学院2025年寒假“返家乡”社会实践活动 院级一等奖',
    '塔里木大学机械电气化工程学院2026年暑假“三下乡”社会实践活动 院级三等奖'
  ].join('\n');
  ws.I2.w = ws.I2.v;
  ws.L2.v = '';
  ws.L2.w = '';
  ws.N2.v = Array.from({ length: 13 }, function(_, index) {
    const title = index === 5 ? '优秀筹备工作者' : '优秀工作者';
    return (2023 + index) + '年机械电气化工程学院匿名文体活动' + (index + 1) + ' ' + title;
  }).join('\n');
  ws.N2.w = ws.N2.v;

  const first = parseWorkbook(wb).rows[0];
  assert.equal(first.record.b2.practices.length, 4);
  assert.deepEqual(first.record.b2.practices.map(item => item.award), ['优秀', '优秀', '一等奖', '三等奖']);
  assert.ok(first.record.b2.practices.some(item => /优秀团队/.test(item.name)));
  assert.ok(first.record.b2.practices.some(item => /优秀个人/.test(item.name)));
  assert.ok(first.record.b2.practices.every(item => item.name && !item.desc));
  assert.equal(first.record.b1.honors.length, 13);
  assert.ok(first.record.b1.honors.some(item => /优秀筹备工作者/.test(item.name)));
});

test('scores both J and K entries when the same competition name appears in both columns', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.J2.v = '全国大学生电子设计竞赛校级三等奖';
  ws.J2.w = ws.J2.v;
  ws.K2.v = '全国大学生电子设计竞赛校级二等奖';
  ws.K2.w = ws.K2.v;

  const first = parseWorkbook(wb).rows[0];
  const matches = first.record.b5.competitions.filter(item => /全国大学生电子设计竞赛/.test(item.name));
  assert.equal(matches.length, 2);
  const scored = matches.filter(item => item.scoreEligible !== false);
  assert.equal(scored.length, 2);
  assert.deepEqual(scored.map(item => item.award), ['三等奖', '二等奖']);
  assert.equal(scored[0].isAcademic, true);
  assert.equal(scored[1].isAcademic, false);
});

test('caps imported cadre count at three roles', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.H2.v = '班长、团支书、委员、干事';
  ws.H2.w = '班长、团支书、委员、干事';

  const first = parseWorkbook(wb).rows[0];
  assert.equal(first.record.b4.cadre, 3);
  assert.ok(first.evidence.some(item => /最多3个/.test(item)));
});

test('marks inferred levels and numeric CET4 assumptions as warnings', () => {
  const parsed = parseWorkbook(createDevelopmentWorkbook());
  const second = parsed.rows[1];
  assert.equal(second.record.b5.cet4, true);
  assert.ok(second.record.b5.innovations.some(item => item.establish === 'nationalEstablish'));
  assert.ok(second.warnings.some(item => item.field === '英语成绩'));
});

test('does not score unmatched J-column entries as academic competitions', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.J2.v = '完全不在目录中的匿名项目校级一等奖';
  ws.J2.w = '完全不在目录中的匿名项目校级一等奖';

  const first = parseWorkbook(wb).rows[0];
  const retained = first.record.b5.competitions.filter(item => item.isAcademic);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].unresolved, true);
  assert.equal(retained[0].scoreEligible, false);
  assert.equal(retained[0].name, '完全不在目录中的匿名项目校级一等奖');
  assert.ok(first.warnings.some(item => item.field === '学科竞赛' && /144项/.test(item.message)));
});

test('inherits grouped levels, recognizes regional levels and splits malformed adjacent years', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.J2.v = [
    '国家级奖项：',
    '2026-01 数维杯数学建模竞赛二等奖',
    '省级奖项：',
    '2026-07 机械工程创新创意大赛(过程装备实践与创新大赛)西北赛区二等奖',
    '2026-06 全国大学生电子设计竞赛校级一等奖      22026-07 全国大学生电子设计竞赛校级二等奖'
  ].join('\n');
  ws.J2.w = ws.J2.v;

  const first = parseWorkbook(wb).rows[0];
  const competitions = first.record.b5.competitions;
  assert.ok(competitions.some(item => item.name === '全国大学生数学建模大赛' && item.level === '国家级'));
  assert.ok(competitions.some(item => item.name === '中国大学生机械工程创新创意大赛' && item.level === '省级'));
  assert.equal(first.record.sourceDetails.audit.J.source, 4);
  assert.equal(first.record.sourceDetails.audit.J.saved, 4);
});

test('retains official J-column names with missing award as zero-point rows', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.J2.v = '“外教社.词达人杯”全国大学生英语词汇能力';
  ws.J2.w = ws.J2.v;

  const first = parseWorkbook(wb).rows[0];
  const retained = first.record.b5.competitions[0];
  assert.equal(retained.selectedName, '“外教社•词达人杯”全国大学生英语词汇能力');
  assert.equal(retained.award, '');
  assert.equal(retained.scoreEligible, false);
  assert.equal(first.record.sourceDetails.audit.J.source, first.record.sourceDetails.audit.J.saved);
});

test('keeps K-column entries as non-academic even when the name exists in the 144-item list', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.K2.v = '全国大学生电子设计竞赛国家级一等奖';
  ws.K2.w = '全国大学生电子设计竞赛国家级一等奖';

  const first = parseWorkbook(wb).rows[0];
  const matched = first.record.b5.competitions.find(item => /全国大学生电子设计竞赛/.test(item.name));
  assert.ok(matched);
  assert.equal(matched.name, '全国大学生电子设计竞赛国家级一等奖');
  assert.equal(matched.selectedName, '');
  assert.equal(matched.isAcademic, false);
  assert.equal(matched.isManual, true);
});

test('keeps the existing two-row score template importable', () => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['序号', '班级（单位）', '姓名', '评分结果', ''],
    ['', '', '', '板块一得分', '总分'],
    [1, '测试班', '王同学', 8, 20]
  ]);
  XLSX.utils.book_append_sheet(wb, ws, '综合素质评分');
  const parsed = parser.parseWorkbook(wb, XLSX);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].raw['姓名'], '王同学');
  assert.equal(parsed.rows[0].raw['板块一得分'], 8);
  assert.equal(parsed.rows[0].raw['总分'], 20);
  assert.equal(parsed.rows[0].raw.__scoreSystemTemplate, 'standard');
});

test('rejects workbooks without a recognizable personnel sheet', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['序号', '竞赛名称'],
    [1, '匿名竞赛']
  ]), '竞赛目录');

  assert.throws(
    () => parser.parseWorkbook(wb, XLSX),
    /未找到同时包含“姓名”和“班级”的人员数据表/
  );
});
