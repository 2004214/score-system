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
    academicCompetitions: RULES.block4.academicCompetitions
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
});

test('prefers explicit levels and infers organizer levels', () => {
  assert.deepEqual(parser.inferLevel('全国比赛校级二等奖'), { level: '校级', inferred: false, conflict: false, reason: '明确级别' });
  assert.deepEqual(parser.inferLevel('塔里木大学校园比赛二等奖'), { level: '校级', inferred: true, conflict: false, reason: '学校名称关键词' });
  assert.deepEqual(parser.inferLevel('机械电气化工程学院活动一等奖'), { level: '院级', inferred: true, conflict: false, reason: '学院关键词' });
  assert.equal(parser.inferLevel('国家级项目获校级二等奖').conflict, true);
});

test('matches every official academic competition to its canonical library name', () => {
  const competitions = RULES.block4.academicCompetitions;
  assert.equal(competitions.length, 144);
  competitions.forEach(name => {
    assert.equal(parser.findAcademicCompetition(name + ' 校级二等奖', competitions), name);
  });
  assert.equal(parser.findAcademicCompetition('完全不在目录中的匿名项目校级一等奖', competitions), null);
});

test('keeps conflicting competition levels unscored with a warning', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.J2.v = '国家级项目获校级二等奖';
  ws.J2.w = '国家级项目获校级二等奖';

  const parsed = parser.parseWorkbook(wb, XLSX);
  const first = parsed.rows[0];
  assert.equal(first.record.b4.competitions.filter(item => item.isAcademic).length, 0);
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
  assert.equal(first.record.b2.volHours, 120.5);
  assert.equal(first.record.b2.volHoursRecent, 75.5);
  assert.equal(first.record.b2.sanxia, 1);
  assert.ok(first.record.b3.cadre >= 2);
  assert.equal(first.record.b3.excellentCadre, 1);
  assert.equal(first.record.b4.cet4, true);
  assert.equal(first.record.b5.fails.length, 1);
  assert.equal(first.record.b4.competitions.length, 2);
  assert.equal(first.record.b4.competitions[0].isAcademic, true);
  assert.equal(first.record.b4.competitions[0].selectedName, 'CIMC“西门子杯”中国智能制造挑战赛');
  assert.equal(first.record.b4.competitions[0].isManual, false);
  assert.equal(first.record.b4.competitions[1].isAcademic, false);
  assert.equal(first.record.b1.competitions[0].rank, '第二名');
  assert.equal(first.record.b1.excellent, 1);
});

test('marks inferred levels and numeric CET4 assumptions as warnings', () => {
  const parsed = parseWorkbook(createDevelopmentWorkbook());
  const second = parsed.rows[1];
  assert.equal(second.record.b4.cet4, true);
  assert.ok(second.record.b4.innovations.some(item => item.establish === 'nationalEstablish'));
  assert.ok(second.warnings.some(item => item.field === '英语成绩'));
});

test('does not score unmatched J-column entries as academic competitions', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.J2.v = '完全不在目录中的匿名项目校级一等奖';
  ws.J2.w = '完全不在目录中的匿名项目校级一等奖';

  const first = parseWorkbook(wb).rows[0];
  assert.equal(first.record.b4.competitions.filter(item => item.isAcademic).length, 0);
  assert.ok(first.warnings.some(item => item.field === '学科竞赛' && /144项/.test(item.message)));
});

test('matches official academic competitions from either competition column', () => {
  const wb = createDevelopmentWorkbook();
  const ws = wb.Sheets['情况了解'];
  ws.K2.v = '全国大学生电子设计竞赛国家级一等奖';
  ws.K2.w = '全国大学生电子设计竞赛国家级一等奖';

  const first = parseWorkbook(wb).rows[0];
  const matched = first.record.b4.competitions.find(item => item.name === '全国大学生电子设计竞赛');
  assert.ok(matched);
  assert.equal(matched.selectedName, '全国大学生电子设计竞赛');
  assert.equal(matched.isAcademic, true);
  assert.equal(matched.isManual, false);
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
