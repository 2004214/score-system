// ===== 全局状态 =====
let RULES = {};
let currentUser = null;
let editingStudentId = null;
let importBuffer = [];
let restoreBuffer = [];
let db = null;
let _formDirty = false;
let _sortState = { col: -1, asc: true };
let _selectedIds = new Set();
const _detailCache = { b1:'', b2:'', b3:'', b4:'', b5a:'', b5n:'', b5d:'', b6:'', zeroed:false };
let _academicCompetitionMatcher = null;
const EMBEDDED_RULES = window.__OFFLINE_RULES__ || {};

// ===== 旧数据迁移 =====
function migrateOldRecord(s) {
  if (!s) return s;
  if (s.b5 && typeof (s.b5.avg) === 'number' && !s.b6) {
    var oldB2 = s.b2 || {};
    var oldB3 = s.b3 || {};
    var oldB4 = s.b4 || {};
    var oldB5 = s.b5 || {};
    s.b6 = oldB5;
    s.b5 = oldB4;
    s.b4 = oldB3;
    s.b3 = {
      volHours: oldB2.volHours || 0, volHoursRecent: oldB2.volHoursRecent || 0,
      commendation: oldB2.commendation || 0, branchActivity: oldB2.branchActivity || 0,
      volunteerHonors: oldB2.volunteerHonors || [], volCompetitions: [],
      honors: [], customCompetitions: []
    };
    s.b2 = {
      sanxia: oldB2.sanxia || 0, fanjia: oldB2.fanjia || 0,
      practices: oldB2.practices || [], competitions: oldB2.competitions || [],
      honors: oldB2.honors || [], customCompetitions: oldB2.customCompetitions || []
    };
    if (s.scores && !s.scores.b6) {
      s.scores = calcScoresForRecord(s);
    }
  }
  return s;
}

// ===== 初始化 =====
async function init() {
  await loadRules();
  initDB();
  checkLoginState();
  initScoreWorkspace();
  initUniqueScoringGuard();
  setTimeout(function() {
    calcBlock1(); calcBlock2(); calcBlock3(); calcBlock4(); calcBlock5(); calcBlock6();
  }, 0);
  document.querySelectorAll('#tabInput input, #tabInput select, #tabInput textarea').forEach(function(el) {
    el.addEventListener('input', markFormDirty);
    el.addEventListener('change', markFormDirty);
  });
}

async function loadRules() {
  try {
    const r = await fetch('rules.json?_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    RULES = await r.json();
  } catch(e) {
    console.error('rules.json 加载失败：', e);
    if (window.__OFFLINE_RULES__) {
      showToast('已切换到离线规则模式', 'warning');
    } else {
      showToast('评分规则加载失败，请检查 rules.json 是否存在', 'danger');
    }
    RULES = JSON.parse(JSON.stringify(EMBEDDED_RULES));
  }
  _academicCompetitionMatcher = null;
  refreshAcademicCompetitionSelects();
}


// ===== IndexedDB =====
function initDB() {
  const req = indexedDB.open('ScoreSystemDB', 1);
  req.onupgradeneeded = e => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains('students')) {
      d.createObjectStore('students', { keyPath: 'id', autoIncrement: true });
    }
  };
  req.onsuccess = e => { db = e.target.result; renderSummary(); };
  req.onerror = () => showToast('数据库初始化失败', 'danger');
}

function dbGetAll() {
  return new Promise((res, rej) => {
    const tx = db.transaction('students', 'readonly');
    const req = tx.objectStore('students').getAll();
    req.onsuccess = () => {
      const records = req.result || [];
      records.forEach(function(record) {
        migrateOldRecord(record);
        if (!record.sourceDetails) return;
        deduplicateRecordScoringItems(record);
        record.scores = calcScoresForRecord(record);
        record.details = buildDetailsForRecord(record);
      });
      res(records);
    };
    req.onerror = () => rej(req.error);
  });
}

function dbPut(record) {
  return new Promise((res, rej) => {
    const tx = db.transaction('students', 'readwrite');
    const req = tx.objectStore('students').put(record);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function dbDelete(id) {
  return new Promise((res, rej) => {
    const tx = db.transaction('students', 'readwrite');
    const req = tx.objectStore('students').delete(id);
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}

function dbClear() {
  return new Promise((res, rej) => {
    const tx = db.transaction('students', 'readwrite');
    const req = tx.objectStore('students').clear();
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}

// ===== 权限 =====
function checkLoginState() {
  const saved = localStorage.getItem('currentUser');
  if (saved) { currentUser = JSON.parse(saved); showApp(); }
}

function doLogin() {
  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value;
  const accounts = getAccounts();
  const found = accounts.find(a => a.name === user && a.pass === pass);
  if (!found) { document.getElementById('loginError').classList.remove('d-none'); return; }
  currentUser = { name: found.name, role: found.role };
  localStorage.setItem('currentUser', JSON.stringify(currentUser));
  showApp();
}

function doLogout() {
  currentUser = null;
  localStorage.removeItem('currentUser');
  document.getElementById('loginOverlay').style.display = 'flex';
  document.getElementById('loginError').classList.add('d-none');
}

function showApp() {
  document.getElementById('loginOverlay').style.display = 'none';
  document.getElementById('navUserInfo').textContent =
    currentUser.name + ' (' + (currentUser.role === 'admin' ? '管理员' : '访客') + ')';
  const isAdmin = currentUser.role === 'admin';
  ['btnImport','btnExport','btnTemplate','btnChangePwd','btnBackup','btnRestore','btnBatchDelete'].forEach(id => {
    document.getElementById(id).classList.toggle('d-none', !isAdmin);
  });
  document.getElementById('btnClearSummary').classList.toggle('d-none', !isAdmin);
  document.getElementById('btnSave').disabled = !isAdmin;
  renderSummary();
}

function getAccounts() {
  const def = [
    { name: 'admin', pass: 'admin123', role: 'admin' },
    { name: 'guest', pass: 'guest', role: 'guest' }
  ];
  const saved = localStorage.getItem('accounts');
  return saved ? JSON.parse(saved) : def;
}

function saveAccounts(accounts) { localStorage.setItem('accounts', JSON.stringify(accounts)); }

function showChangePwd() { new bootstrap.Modal(document.getElementById('changePwdModal')).show(); }

function doChangePwd() {
  const p1 = document.getElementById('newPwd1').value;
  const p2 = document.getElementById('newPwd2').value;
  const errEl = document.getElementById('pwdError');
  if (!p1) { errEl.textContent = '密码不能为空'; errEl.classList.remove('d-none'); return; }
  if (p1 !== p2) { errEl.textContent = '两次密码不一致'; errEl.classList.remove('d-none'); return; }
  const accounts = getAccounts();
  const idx = accounts.findIndex(a => a.name === currentUser.name);
  if (idx >= 0) accounts[idx].pass = p1;
  saveAccounts(accounts);
  bootstrap.Modal.getInstance(document.getElementById('changePwdModal')).hide();
  showToast('密码修改成功', 'success');
}

// ===== UI 工具 =====
function showToast(msg, type) {
  type = type || 'success';
  const id = 'toast_' + Date.now();
  const colors = { success:'bg-success', danger:'bg-danger', warning:'bg-warning text-dark', info:'bg-info text-dark' };
  const cls = colors[type] || 'bg-secondary';
  const html = '<div id="' + id + '" class="toast align-items-center text-white ' + cls + ' border-0 show" role="alert">' +
    '<div class="d-flex"><div class="toast-body">' + msg + '</div>' +
    '<button type="button" class="btn-close btn-close-white me-2 m-auto" onclick="document.getElementById(\'' + id + '\').remove()"></button>' +
    '</div></div>';
  document.getElementById('toastContainer').insertAdjacentHTML('beforeend', html);
  setTimeout(function() { const el = document.getElementById(id); if(el) el.remove(); }, 3000);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAcademicCompetitionSelectOptions(selectedName) {
  let competitions = (RULES.block5 && RULES.block5.academicCompetitions) || [];
  if (!competitions.length) {
    try {
      competitions = getDefaultRules().block5.academicCompetitions || [];
    } catch (e) {
      competitions = [];
    }
  }
  const current = String(selectedName || '').trim();
  return ['<option value="">从 144 项竞赛中选择</option>'].concat(
    competitions.map(function(name) {
      return '<option value="' + escapeHtml(name) + '"' + (current === name ? ' selected' : '') + '>' + escapeHtml(name) + '</option>';
    })
  ).join('');
}

function bindCompSearchFilter(wrap) {
  const input = wrap.querySelector('.comp-search-input');
  const select = wrap.querySelector('.comp-select-filtered');
  if (!input || !select) return;
  input.addEventListener('input', function() {
    const kw = this.value.trim().toLowerCase();
    Array.from(select.options).forEach(function(opt, i) {
      if (i === 0) { opt.style.display = ''; return; }
      opt.style.display = (!kw || opt.text.toLowerCase().includes(kw)) ? '' : 'none';
    });
  });
}

function addB5Innovation(data) {
  data = data || {};
  const container = document.getElementById('b5_innovations');
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-5"><label class="form-label small">立项情况</label>' +
    '<select class="form-select form-select-sm b5-innov-establish" onchange="calcBlock5()">' +
    '<option value="">未立项</option>' +
    '<option value="nationalEstablish"' + (data.establish === 'nationalEstablish' ? ' selected' : '') + '>国家级立项</option>' +
    '<option value="schoolEstablish"' + (data.establish === 'schoolEstablish' ? ' selected' : '') + '>校级立项</option>' +
    '</select></div>' +
    '<div class="col-md-5"><label class="form-label small">结项情况</label>' +
    '<select class="form-select form-select-sm b5-innov-complete" onchange="calcBlock5()">' +
    '<option value="">未结项</option>' +
    '<option value="nationalCompleteExcellent"' + (data.complete === 'nationalCompleteExcellent' ? ' selected' : '') + '>国家级结项优秀</option>' +
    '<option value="nationalCompletePass"' + (data.complete === 'nationalCompletePass' ? ' selected' : '') + '>国家级结项合格</option>' +
    '<option value="schoolCompleteExcellent"' + (data.complete === 'schoolCompleteExcellent' ? ' selected' : '') + '>校级结项优秀</option>' +
    '<option value="schoolCompletePass"' + (data.complete === 'schoolCompletePass' ? ' selected' : '') + '>校级结项合格</option>' +
    '</select></div>' +
    '</div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="this.parentElement.remove();calcBlock5()">×</button>';
  container.appendChild(div);
  calcBlock5();
}

function refreshAcademicCompetitionSelects() {
  document.querySelectorAll('.b5-name-select').forEach(function(selectEl) {
    const current = selectEl.value;
    selectEl.innerHTML = renderAcademicCompetitionSelectOptions(current);
    if (current) selectEl.value = current;
  });
}

function switchTab(tabId, link) {
  ['tabInput','tabSummary'].forEach(function(id) { document.getElementById(id).classList.add('d-none'); });
  document.getElementById(tabId).classList.remove('d-none');
  document.querySelectorAll('#mainTabs .nav-link').forEach(function(l) { l.classList.remove('active'); });
  link.classList.add('active');
  if (tabId === 'tabSummary') renderSummary();
}

// ===== 三栏工作区与板块导航 =====
function setActiveFormSection(sectionId) {
  document.querySelectorAll('.entry-nav-link').forEach(function(button) {
    const active = button.dataset.section === sectionId;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  });
}

function scrollToFormSection(sectionId, trigger) {
  const section = document.getElementById(sectionId);
  const scroller = document.getElementById('scoreFormScroll');
  if (!section || !scroller) return;
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  setActiveFormSection(sectionId);
  if (window.matchMedia('(min-width: 1200px)').matches) {
    const targetTop = scroller.scrollTop + section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top: Math.max(targetTop, 0), behavior: behavior });
  } else {
    section.scrollIntoView({ behavior: behavior, block: 'start' });
  }
  if (trigger) trigger.focus({ preventScroll: true });
}

function updateSectionNavigation() {
  const scroller = document.getElementById('scoreFormScroll');
  const sections = Array.from(document.querySelectorAll('#scoreFormScroll .form-section'));
  if (!scroller || !sections.length || document.getElementById('tabInput').classList.contains('d-none')) return;
  const desktop = window.matchMedia('(min-width: 1200px)').matches;
  const anchor = desktop ? scroller.getBoundingClientRect().top + 28 : 132;
  let active = sections[0];
  if (desktop && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
    setActiveFormSection(sections[sections.length - 1].id);
    return;
  }
  sections.forEach(function(section) {
    if (section.getBoundingClientRect().top <= anchor) active = section;
  });
  setActiveFormSection(active.id);
}

function initScoreWorkspace() {
  const scroller = document.getElementById('scoreFormScroll');
  if (!scroller || scroller.dataset.scrollSpyReady === 'true') return;
  scroller.dataset.scrollSpyReady = 'true';
  let scheduled = false;
  const scheduleUpdate = function() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(function() {
      scheduled = false;
      updateSectionNavigation();
    });
  };
  scroller.addEventListener('scroll', scheduleUpdate, { passive: true });
  window.addEventListener('scroll', scheduleUpdate, { passive: true });
  window.addEventListener('resize', scheduleUpdate);
  updateSectionNavigation();
}

// ===== 荣誉记录与自定义比赛 =====
function recalculateBlock(block) {
  const calculators = { b1: calcBlock1, b2: calcBlock2, b3: calcBlock3, b4: calcBlock4, b6: calcBlock6 };
  if (calculators[block]) calculators[block]();
}

function formatEnhancementPoints(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
}

function handleEnhancementChange(control, block, type) {
  const row = control.closest('.enhancement-row');
  if (!row) return;
  const data = type === 'honor' ? {
    honors: [{
      name: row.querySelector('.honor-name').value,
      level: row.querySelector('.honor-level').value,
      count: 1
    }]
  } : {
    customCompetitions: [{
      name: row.querySelector('.custom-competition-name').value,
      level: row.querySelector('.custom-competition-level').value,
      points: row.querySelector('.custom-competition-points').value
    }]
  };
  const result = ScoreEnhancements.calculate(data);
  row.querySelector('.enhancement-subtotal').textContent = formatEnhancementPoints(result.score) + '分';
  markFormDirty();
  recalculateBlock(block);
}

function removeEnhancementRow(button, block) {
  const row = button.closest('.enhancement-row');
  const container = row && row.parentElement;
  if (row) row.remove();
  if (container) refreshNumberedRows(container, container.dataset.rowLabel || '荣誉记录');
  markFormDirty();
  recalculateBlock(block);
}

function refreshNumberedRows(container, label) {
  if (!container) return;
  Array.from(container.children).forEach(function(row, index) {
    const target = row.querySelector('.record-sequence');
    if (target) target.textContent = label + ' ' + (index + 1);
  });
}

function removeNumberedRecord(button, label, calculator) {
  const row = button.closest('.record-item');
  const container = row && row.parentElement;
  if (row) row.remove();
  refreshNumberedRows(container, label);
  if (calculator) calculator();
}

function addHonorRecord(block, data, silent) {
  data = data || {};
  const container = document.getElementById(block + '_honors');
  if (!container) return;
  const level = data.level === '院级' ? '院级' : '校级';
  const honorLabels = { b1: '文体荣誉', b2: '社会实践荣誉', b3: '志愿服务荣誉', b4: '社会工作荣誉', b6: '学业荣誉' };
  const rowLabel = honorLabels[block] || '荣誉记录';
  container.dataset.rowLabel = rowLabel;
  const row = document.createElement('div');
  row.className = 'enhancement-row honor-row';
  row.innerHTML =
    '<div class="enhancement-field"><label class="record-sequence">' + rowLabel + '</label><input type="text" class="form-control form-control-sm honor-name" placeholder="填写完整活动及荣誉名称" value="' + escapeHtml(data.name || '') + '"></div>' +
    '<div class="enhancement-field"><label>级别</label><select class="form-select form-select-sm honor-level"><option value="院级"' + (level === '院级' ? ' selected' : '') + '>院级</option><option value="校级"' + (level === '校级' ? ' selected' : '') + '>校级</option></select></div>' +
    '<div class="enhancement-subtotal">0分</div>' +
    '<button type="button" class="btn btn-sm btn-outline-danger enhancement-remove" title="删除该荣誉" aria-label="删除该荣誉">&times;</button>';
  row.querySelectorAll('input,select').forEach(function(control) {
    control.addEventListener('input', function() { handleEnhancementChange(control, block, 'honor'); });
    control.addEventListener('change', function() { handleEnhancementChange(control, block, 'honor'); });
  });
  row.querySelector('.enhancement-remove').addEventListener('click', function() { removeEnhancementRow(this, block); });
  container.appendChild(row);
  refreshNumberedRows(container, rowLabel);
  handleEnhancementChange(row.querySelector('.honor-name'), block, 'honor');
  if (silent) markFormClean();
}

function addCustomCompetition(block, data, silent) {
  data = data || {};
  const container = document.getElementById(block + '_customCompetitions');
  if (!container) return;
  const allowedLevels = ['院级', '校级', '省级', '国家级'];
  const level = allowedLevels.indexOf(data.level) >= 0 ? data.level : '院级';
  const row = document.createElement('div');
  row.className = 'enhancement-row custom-competition-row';
  row.innerHTML =
    '<div class="enhancement-field"><label>比赛名称</label><input type="text" class="form-control form-control-sm custom-competition-name" placeholder="输入比赛名称" value="' + escapeHtml(data.name || '') + '"></div>' +
    '<div class="enhancement-field"><label>比赛级别</label><select class="form-select form-select-sm custom-competition-level">' + allowedLevels.map(function(item) { return '<option value="' + item + '"' + (item === level ? ' selected' : '') + '>' + item + '</option>'; }).join('') + '</select></div>' +
    '<div class="enhancement-field"><label>加分值</label><input type="number" class="form-control form-control-sm custom-competition-points" min="0" step="0.1" value="' + escapeHtml(data.points == null ? 0 : data.points) + '"></div>' +
    '<div class="enhancement-subtotal">0分</div>' +
    '<button type="button" class="btn btn-sm btn-outline-danger enhancement-remove" title="删除该比赛" aria-label="删除该比赛">&times;</button>';
  row.querySelectorAll('input,select').forEach(function(control) {
    control.addEventListener('input', function() { handleEnhancementChange(control, block, 'competition'); });
    control.addEventListener('change', function() { handleEnhancementChange(control, block, 'competition'); });
  });
  row.querySelector('.enhancement-remove').addEventListener('click', function() { removeEnhancementRow(this, block); });
  container.appendChild(row);
  handleEnhancementChange(row.querySelector('.custom-competition-name'), block, 'competition');
  if (silent) markFormClean();
}

function collectEnhancementData(block) {
  const data = { honors: [], customCompetitions: [] };
  const owners = refreshDuplicateScoringState();
  document.querySelectorAll('#' + block + '_honors .honor-row').forEach(function(row) {
    const nameInput = row.querySelector('.honor-name');
    if (!isUniqueScoringInput(nameInput, owners)) return;
    data.honors.push({
      name: nameInput.value,
      level: row.querySelector('.honor-level').value,
      count: 1
    });
  });
  document.querySelectorAll('#' + block + '_customCompetitions .custom-competition-row').forEach(function(row) {
    const nameInput = row.querySelector('.custom-competition-name');
    if (!isUniqueScoringInput(nameInput, owners)) return;
    data.customCompetitions.push({
      name: nameInput.value,
      level: row.querySelector('.custom-competition-level').value,
      points: row.querySelector('.custom-competition-points').value
    });
  });
  return ScoreEnhancements.normalize(data);
}

function renderEnhancements(block, data) {
  const normalized = ScoreEnhancements.normalize(data || {});
  var honorsEl = document.getElementById(block + '_honors');
  var compEl = document.getElementById(block + '_customCompetitions');
  if (honorsEl) honorsEl.innerHTML = '';
  if (compEl) compEl.innerHTML = '';
  normalized.honors.forEach(function(item) { addHonorRecord(block, item, true); });
  normalized.customCompetitions.forEach(function(item) { addCustomCompetition(block, item, true); });
}

function addEnhancementScore(score, details, block) {
  const extra = ScoreEnhancements.calculate(block || {});
  extra.details.forEach(function(detail) { details.push(detail); });
  return score + extra.score;
}

const UNIQUE_SCORING_INPUT_SELECTORS = [
  '#b5_competitions .b5-name-select',
  '#b5_competitions .b5-name-manual',
  '#b1_competitions .b1-name',
  '#b2_competitions .b2-competition-name',
  '#b2_practices .b2-name',
  '#b3_volunteerHonors .b3-volunteer-name',
  '#b3_volCompetitions .b3-vol-competition-name',
  '#b4_collectiveAwards .b4-collective-name',
  '.custom-competition-name',
  '.honor-name'
];

function getScoringInputKey(input) {
  return input ? ScoreEnhancements.normalizeScoringName(input.value) : '';
}

function getScoringNameOwners() {
  const owners = new Map();
  UNIQUE_SCORING_INPUT_SELECTORS.forEach(function(selector) {
    document.querySelectorAll(selector).forEach(function(input) {
      const key = getScoringInputKey(input);
      if (key && !owners.has(key)) owners.set(key, input);
    });
  });
  return owners;
}

function isUniqueScoringInput(input, owners) {
  const key = getScoringInputKey(input);
  return !!key && (owners || getScoringNameOwners()).get(key) === input;
}

function refreshDuplicateScoringState() {
  const owners = getScoringNameOwners();
  UNIQUE_SCORING_INPUT_SELECTORS.forEach(function(selector) {
    document.querySelectorAll(selector).forEach(function(input) {
      const key = getScoringInputKey(input);
      const duplicate = !!key && owners.get(key) !== input;
      input.classList.toggle('is-invalid', duplicate);
      input.setAttribute('aria-invalid', duplicate ? 'true' : 'false');
      const row = input.closest('.record-item, .enhancement-row');
      if (!row) return;
      let warning = row.querySelector('.duplicate-scoring-warning');
      if (duplicate && !warning) {
        warning = document.createElement('div');
        warning.className = 'duplicate-scoring-warning';
        warning.textContent = '与已有项目重复，本条不计分';
        row.appendChild(warning);
      } else if (!duplicate && warning && !row.querySelector('.is-invalid')) {
        warning.remove();
      }
      if (duplicate && row.classList.contains('enhancement-row')) {
        const subtotal = row.querySelector('.enhancement-subtotal');
        if (subtotal) subtotal.textContent = '重复，不计分';
      }
    });
  });
  return owners;
}

function recalculateAllScoringBlocks() {
  calcBlock1();
  calcBlock2();
  calcBlock3();
  calcBlock4();
  calcBlock5();
  calcBlock6();
}

function initUniqueScoringGuard() {
  const inputRoot = document.getElementById('tabInput');
  if (!inputRoot || inputRoot.dataset.uniqueScoringReady === 'true') return;
  inputRoot.dataset.uniqueScoringReady = 'true';
  let scheduled = false;
  const schedule = function(event) {
    if (event && event.type !== 'click' && !event.target.matches(UNIQUE_SCORING_INPUT_SELECTORS.join(','))) return;
    if (event && event.type === 'click' && !event.target.closest('.btn-remove, .enhancement-remove')) return;
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(function() {
      scheduled = false;
      refreshDuplicateScoringState();
      recalculateAllScoringBlocks();
    });
  };
  inputRoot.addEventListener('input', schedule);
  inputRoot.addEventListener('change', schedule);
  inputRoot.addEventListener('click', schedule);
}

// ===== 动态表单 =====
function addB1Competition(data) {
  data = data || {};
  const container = document.getElementById('b1_competitions');
  const levels = ['院级','校级','省部级','国家级'];
  const ranks = ['第一名','第二名','第三名','参加过'];
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-4"><label class="form-label small record-sequence">文体比赛</label>' +
    '<input type="text" class="form-control form-control-sm b1-name" placeholder="竞赛名称" value="' + (data.name||'') + '" oninput="calcBlock1()"></div>' +
    '<div class="col-md-3"><label class="form-label small">级别</label>' +
    '<select class="form-select form-select-sm b1-level" onchange="calcBlock1()">' +
    levels.map(function(l){ return '<option' + (data.level===l?' selected':'') + '>' + l + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="col-md-3"><label class="form-label small">名次</label>' +
    '<select class="form-select form-select-sm b1-rank" onchange="calcBlock1()">' +
    ranks.map(function(r){ return '<option' + (data.rank===r?' selected':'') + '>' + r + '</option>'; }).join('') +
    '</select></div></div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="removeNumberedRecord(this,\'文体比赛\',calcBlock1)">×</button>';
  container.appendChild(div);
  refreshNumberedRows(container, '文体比赛');
  calcBlock1();
}

function addB1Publication(data) {
  data = data || {};
  const container = document.getElementById('b1_publications');
  const types = ['国家级权威报刊或媒体','省级重要报刊或媒体','其他公开发行的报刊或地方媒体','学校各职能部门主办的其它报刊、媒体','学院主办的内部刊物、媒体'];
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-5"><label class="form-label small">作品名称</label>' +
    '<input type="text" class="form-control form-control-sm b1-publication-name" placeholder="作品名称" value="' + escapeHtml(data.name || '') + '" oninput="calcBlock1()"></div>' +
    '<div class="col-md-5"><label class="form-label small">发表类别</label>' +
    '<select class="form-select form-select-sm b1-publication-type" onchange="calcBlock1()">' +
    types.map(function(type){ return '<option' + (data.type===type?' selected':'') + '>' + type + '</option>'; }).join('') +
    '</select></div>' +
    '</div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="this.parentElement.remove();calcBlock1()">×</button>';
  container.appendChild(div);
  calcBlock1();
}

function addB2Practice(data) {
  data = data || {};
  const container = document.getElementById('b2_practices');
  const levels = ['院级','院校级','校级','省级','国家级','兵团省级'];
  const awards = ['优秀','一等奖','二等奖','三等奖'];
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-5"><label class="form-label small record-sequence">社会实践奖项</label>' +
    '<input type="text" class="form-control form-control-sm b2-name" placeholder="如：暑期三下乡社会实践" value="' + escapeHtml(data.name || data.desc || '') + '" oninput="calcBlock2()"></div>' +
    '<div class="col-md-3"><label class="form-label small">级别</label>' +
    '<select class="form-select form-select-sm b2-level" onchange="calcBlock2()">' +
    levels.map(function(level){ return '<option' + (data.level===level?' selected':'') + '>' + level + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="col-md-3"><label class="form-label small">奖项/荣誉</label>' +
    '<select class="form-select form-select-sm b2-award" onchange="calcBlock2()">' +
    awards.map(function(award){ return '<option' + (data.award===award?' selected':'') + '>' + award + '</option>'; }).join('') +
    '</select></div>' +
    '</div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="removeNumberedRecord(this,\'社会实践奖项\',calcBlock2)">×</button>';
  container.appendChild(div);
  refreshNumberedRows(container, '社会实践奖项');
  calcBlock2();
}

function addB3VolunteerHonor(data) {
  data = data || {};
  const container = document.getElementById('b3_volunteerHonors');
  const types = ['优秀志愿者', '星级志愿者', '其他（不计分）'];
  const type = types.indexOf(data.type) >= 0 ? data.type : '其他（不计分）';
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-8"><label class="form-label small record-sequence">志愿荣誉</label>' +
    '<input type="text" class="form-control form-control-sm b3-volunteer-name" placeholder="填写完整志愿活动及荣誉名称" value="' + escapeHtml(data.name || '') + '" oninput="calcBlock3()"></div>' +
    '<div class="col-md-3"><label class="form-label small">荣誉类型</label>' +
    '<select class="form-select form-select-sm b3-volunteer-type" onchange="calcBlock3()">' +
    types.map(function(item) { return '<option value="' + item + '"' + (item === type ? ' selected' : '') + '>' + item + '</option>'; }).join('') +
    '</select></div></div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="removeNumberedRecord(this,\'志愿荣誉\',calcBlock3)">×</button>';
  container.appendChild(div);
  refreshNumberedRows(container, '志愿荣誉');
  calcBlock3();
}

function addB2Competition(data) {
  data = data || {};
  const container = document.getElementById('b2_competitions');
  const levels = ['国家级','省级','校级','院级'];
  const awards = ['一等奖','二等奖','三等奖','优秀奖','参加过'];
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-4"><label class="form-label small">成果/项目名称</label>' +
    '<input type="text" class="form-control form-control-sm b2-competition-name" placeholder="如：调研报告、实践故事、提案项目" value="' + escapeHtml(data.name || '') + '" oninput="calcBlock2()"></div>' +
    '<div class="col-md-3"><label class="form-label small">级别</label>' +
    '<select class="form-select form-select-sm b2-competition-level" onchange="calcBlock2()">' +
    levels.map(function(level){ return '<option' + (data.level===level?' selected':'') + '>' + level + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="col-md-3"><label class="form-label small">奖项</label>' +
    '<select class="form-select form-select-sm b2-competition-award" onchange="calcBlock2()">' +
    awards.map(function(award){ return '<option' + (data.award===award?' selected':'') + '>' + award + '</option>'; }).join('') +
    '</select></div>' +
    '</div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="this.parentElement.remove();calcBlock2()">×</button>';
  container.appendChild(div);
  calcBlock2();
}

function addB3VolCompetition(data) {
  data = data || {};
  const container = document.getElementById('b3_volCompetitions');
  const levels = ['国家级','省级','校级','院级'];
  const awards = ['一等奖','二等奖','三等奖','优秀奖','参加过'];
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-4"><label class="form-label small">志愿项目名称</label>' +
    '<input type="text" class="form-control form-control-sm b3-vol-competition-name" placeholder="如：志愿服务项目大赛" value="' + escapeHtml(data.name || '') + '" oninput="calcBlock3()"></div>' +
    '<div class="col-md-3"><label class="form-label small">级别</label>' +
    '<select class="form-select form-select-sm b3-vol-competition-level" onchange="calcBlock3()">' +
    levels.map(function(level){ return '<option' + (data.level===level?' selected':'') + '>' + level + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="col-md-3"><label class="form-label small">奖项</label>' +
    '<select class="form-select form-select-sm b3-vol-competition-award" onchange="calcBlock3()">' +
    awards.map(function(award){ return '<option' + (data.award===award?' selected':'') + '>' + award + '</option>'; }).join('') +
    '</select></div>' +
    '</div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="this.parentElement.remove();calcBlock3()">×</button>';
  container.appendChild(div);
  calcBlock3();
}

function addB4CollectiveAward(data) {
  data = data || {};
  const container = document.getElementById('b4_collectiveAwards');
  const levels = ['国家表彰','省级表彰','校级表彰','院级表彰'];
  const roles = ['主要组织者','成员'];
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-4"><label class="form-label small">表彰事项</label>' +
    '<input type="text" class="form-control form-control-sm b4-collective-name" placeholder="如：先进集体、先进个人" value="' + escapeHtml(data.name || '') + '" oninput="calcBlock4()"></div>' +
    '<div class="col-md-3"><label class="form-label small">表彰级别</label>' +
    '<select class="form-select form-select-sm b4-collective-level" onchange="calcBlock4()">' +
    levels.map(function(level){ return '<option' + (data.level===level?' selected':'') + '>' + level + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="col-md-3"><label class="form-label small">身份</label>' +
    '<select class="form-select form-select-sm b4-collective-role" onchange="calcBlock4()">' +
    roles.map(function(role){ return '<option' + (data.role===role?' selected':'') + '>' + role + '</option>'; }).join('') +
    '</select></div>' +
    '</div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="this.parentElement.remove();calcBlock4()">×</button>';
  container.appendChild(div);
  calcBlock4();
}

function addB5Competition(data) {
  data = data || {};
  const container = document.getElementById('b5_competitions');
  const levels = ['院级','校级','省级','国家级'];
  const awards = ['特等奖','一等奖','二等奖','三等奖','优秀奖','参加过'];
  const academicName = data.selectedName || (data.isAcademic ? (data.name || '') : '');
  const manualName = data.isAcademic ? '' : (data.name || '');
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-4"><label class="form-label small">学科竞赛名称（144 项中选择）</label>' +
    '<div class="comp-search-wrap">' +
    '<input type="text" class="comp-search-input" placeholder="输入关键词搜索...">' +
    '<select class="form-select form-select-sm b5-name-select comp-select-filtered" onchange="calcBlock5()">' +
    renderAcademicCompetitionSelectOptions(academicName) +
    '</select>' +
    '</div>' +
    '</div>' +
    '<div class="col-md-4"><label class="form-label small">手动输入（按×0.4）</label>' +
    '<input type="text" class="form-control form-control-sm b5-name-manual" placeholder="手动输入竞赛名称" value="' + escapeHtml(manualName) + '" oninput="calcBlock5()"></div>' +
    '<div class="col-md-2"><label class="form-label small">级别</label>' +
    '<select class="form-select form-select-sm b5-level" onchange="calcBlock5()">' +
    levels.map(function(l){ return '<option' + (data.level===l?' selected':'') + '>' + l + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="col-md-2"><label class="form-label small">奖项</label>' +
    '<select class="form-select form-select-sm b5-award" onchange="calcBlock5()">' +
    awards.map(function(a){ return '<option' + (data.award===a?' selected':'') + '>' + a + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="col-md-3 d-flex align-items-end"><span class="b5-type-badge badge bg-secondary small"></span></div>' +
    '</div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="this.parentElement.remove();calcBlock5()">×</button>';
  container.appendChild(div);
  bindCompSearchFilter(div);
  calcBlock5();
}

function addB5AcademicWork(data) {
  data = data || {};
  const container = document.getElementById('b5_academicWorks');
  const workTypeMap = {
    independent: 'independentAuthor',
    first: 'firstAuthor',
    second: 'secondAuthor',
    third: 'thirdAuthor'
  };
  const workType = workTypeMap[data.type] || data.type || 'independentAuthor';
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-5"><label class="form-label small">著作名称</label>' +
    '<input type="text" class="form-control form-control-sm b5-work-name" placeholder="著作名称" value="' + escapeHtml(data.name || '') + '" oninput="calcBlock5()"></div>' +
    '<div class="col-md-4"><label class="form-label small">作者类型</label>' +
    '<select class="form-select form-select-sm b5-work-type" onchange="calcBlock5()">' +
    '<option value="independentAuthor"' + (workType === 'independentAuthor' ? ' selected' : '') + '>独立撰写</option>' +
    '<option value="firstAuthor"' + (workType === 'firstAuthor' ? ' selected' : '') + '>第一作者</option>' +
    '<option value="secondAuthor"' + (workType === 'secondAuthor' ? ' selected' : '') + '>第二作者</option>' +
    '<option value="thirdAuthor"' + (workType === 'thirdAuthor' ? ' selected' : '') + '>第三作者</option>' +
    '<option value="participant"' + (workType === 'participant' ? ' selected' : '') + '>参与编写者</option>' +
    '</select></div>' +
    '</div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="this.parentElement.remove();calcBlock5()">×</button>';
  container.appendChild(div);
  calcBlock5();
}

function addB5AcademicPaper(data) {
  data = data || {};
  const container = document.getElementById('b5_academicPapers');
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-4"><label class="form-label small">论文名称</label>' +
    '<input type="text" class="form-control form-control-sm b5-paper-name" placeholder="论文名称" value="' + escapeHtml(data.name || '') + '" oninput="calcBlock5()"></div>' +
    '<div class="col-md-4"><label class="form-label small">期刊类型</label>' +
    '<select class="form-select form-select-sm b5-paper-type" onchange="calcBlock5()">' +
    '<option value="general"' + (data.type === 'general' ? ' selected' : '') + '>一般期刊（CNKI/万方）</option>' +
    '<option value="pkucore"' + (data.type === 'pkucore' ? ' selected' : '') + '>北大核心期刊</option>' +
    '<option value="cssci"' + (data.type === 'cssci' ? ' selected' : '') + '>CSSCI来源期刊</option>' +
    '<option value="sciHigh"' + (data.type === 'sciHigh' ? ' selected' : '') + '>SCI IF≥5.0</option>' +
    '<option value="sciMedium"' + (data.type === 'sciMedium' ? ' selected' : '') + '>SCI IF≥3.0</option>' +
    '<option value="sciLow"' + (data.type === 'sciLow' ? ' selected' : '') + '>SCI IF≥1.0</option>' +
    '<option value="sciVeryLow"' + (data.type === 'sciVeryLow' ? ' selected' : '') + '>SCI IF＜1.0</option>' +
    '<option value="ei"' + (data.type === 'ei' ? ' selected' : '') + '>EI收录期刊（非会议）</option>' +
    '<option value="istp"' + (data.type === 'istp' ? ' selected' : '') + '>ISTP</option>' +
    '</select></div>' +
    '</div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="this.parentElement.remove();calcBlock5()">×</button>';
  container.appendChild(div);
  calcBlock5();
}

function addB5Patent(data) {
  data = data || {};
  const container = document.getElementById('b5_patents');
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-5"><label class="form-label small">专利/著作权名称</label>' +
    '<input type="text" class="form-control form-control-sm b5-patent-name" placeholder="专利/著作权名称" value="' + escapeHtml(data.name || '') + '" oninput="calcBlock5()"></div>' +
    '<div class="col-md-4"><label class="form-label small">类型</label>' +
    '<select class="form-select form-select-sm b5-patent-type" onchange="calcBlock5()">' +
    '<option value="invention"' + (data.type === 'invention' ? ' selected' : '') + '>发明专利</option>' +
    '<option value="utilityModel"' + (data.type === 'utilityModel' ? ' selected' : '') + '>实用新型专利</option>' +
    '<option value="design"' + (data.type === 'design' ? ' selected' : '') + '>外观设计专利</option>' +
    '<option value="softwareCopyright"' + (data.type === 'softwareCopyright' ? ' selected' : '') + '>软件著作权</option>' +
    '</select></div>' +
    '</div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="this.parentElement.remove();calcBlock5()">×</button>';
  container.appendChild(div);
  calcBlock5();
}

function addB5ProfessionalCert(data) {
  data = data || {};
  const container = document.getElementById('b5_professionalCerts');
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-8"><label class="form-label small">证书名称</label>' +
    '<input type="text" class="form-control form-control-sm b5-prof-cert-name" placeholder="如：高压电工证、教师资格证" value="' + escapeHtml(data.name || '') + '" oninput="calcBlock5()"></div>' +
    '</div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="this.parentElement.remove();calcBlock5()">×</button>';
  container.appendChild(div);
  calcBlock5();
}

function addB6Fail(data) {
  data = data || {};
  const container = document.getElementById('b6_fails');
  const div = document.createElement('div');
  div.className = 'record-item';
  div.innerHTML =
    '<div class="row g-2">' +
    '<div class="col-md-4"><label class="form-label small">课程名称</label>' +
    '<input type="text" class="form-control form-control-sm b6-fail-name" placeholder="课程名称" value="' + escapeHtml(data.name || '') + '" oninput="calcBlock6()"></div>' +
    '<div class="col-md-4"><label class="form-label small">挂科情况</label>' +
    '<select class="form-select form-select-sm b6-fail-type" onchange="calcBlock6()">' +
    '<option value="fail"' + (data.type === 'fail' ? ' selected' : '') + '>挂科</option>' +
    '<option value="failRetakePass"' + (data.type === 'failRetakePass' ? ' selected' : '') + '>挂科且重修通过</option>' +
    '<option value="failRetakeFail"' + (data.type === 'failRetakeFail' ? ' selected' : '') + '>挂科且重修不通过</option>' +
    '<option value="failRetakePending"' + (data.type === 'failRetakePending' ? ' selected' : '') + '>挂科且重修未出成绩</option>' +
    '</select></div>' +
    '</div>' +
    '<button class="btn btn-sm btn-outline-danger btn-remove" onclick="this.parentElement.remove();calcBlock6()">×</button>';
  container.appendChild(div);
  calcBlock6();
}

// ===== 纯函数计分引擎（与 DOM 无关）=====

function scoreBlock1(b1, rules) {
  const r = rules.block1 || {};
  const base = rules.base || {};
  const details = [];
  let score = (b1.club||0)*(r.clubPerSeason||1);
  if (b1.noViolation) { const pts = base.noViolationBonus || 10; score += pts; details.push('无违规+' + pts); }
  if (b1.club > 0) details.push('社团' + b1.club + '季度×' + (r.clubPerSeason||1) + '=' + ((b1.club)*(r.clubPerSeason||1)));
  const matrix = r.competition || {};
  (b1.competitions||[]).forEach(function(c) {
    if (!c.name) return;
    const pts = (matrix[c.level] && matrix[c.level][c.rank]) || 0;
    score += pts;
    if (pts) details.push(c.name + '[' + c.level + c.rank + ']+' + pts);
  });
  const pubRules = r.publication || {};
  (b1.publications||[]).forEach(function(item) {
    const pts = pubRules[item.type] || 0;
    score += pts;
    if (pts) details.push('作品《' + item.name + '》[' + item.type + ']+' + pts);
  });
  score = addEnhancementScore(score, details, b1);
  return { score: Math.round(score), detail: details.join('；') };
}

function scoreBlock2(b2, rules) {
  const r = rules.block2 || {};
  let score = 0;
  const details = [];
  const sanxia = b2.sanxia || 0, fanjia = b2.fanjia || 0;
  score += sanxia * (r.sanxiaxiang||3);
  if (sanxia > 0) details.push('三下乡' + sanxia + '次+' + (sanxia*(r.sanxiaxiang||3)));
  score += fanjia * (r.fanjiaxiang||2);
  if (fanjia > 0) details.push('返家乡' + fanjia + '次+' + (fanjia*(r.fanjiaxiang||2)));
  const practiceItems = b2.practices || [];
  const legacyDescs = practiceItems.filter(function(i) { return !!i.desc; }).map(getPracticeDisplayText).filter(Boolean);
  const autoBonuses = detectVolunteerBonuses(legacyDescs, {})
    .concat(calculateStructuredPracticeBonuses(practiceItems, {}))
    .filter(function(item) { return item.type === 'practice'; });
  autoBonuses.forEach(function(item) { score += item.pts; details.push(item.label + '+' + item.pts + '(自动识别)'); });
  const compRules = r.competition || {};
  (b2.competitions||[]).forEach(function(item) {
    const pts = (compRules[item.level] && compRules[item.level][item.award]) || 0;
    score += pts;
    if (pts) details.push(item.name + '[' + item.level + item.award + ']+' + pts);
  });
  score = addEnhancementScore(score, details, b2);
  const practiceDescs = practiceItems.map(getPracticeDisplayText).filter(Boolean);
  return {
    score: Math.round(score),
    detail: details.join('；'),
    practiceText: practiceDescs.join('；')
  };
}

function scoreBlock3(b3, rules) {
  const r = rules.block3 || {};
  const base = typeof r.volunteerBaseHours === 'number' ? r.volunteerBaseHours : 60;
  const stepHours = r.volunteerStepHours || 5;
  const pointsPerStep = r.volunteerPointsPerStep || 1;
  const maxBonus = typeof r.volunteerMaxBonus === 'number' ? r.volunteerMaxBonus : 10;
  const rawVolBonus = Math.max(Math.floor(Math.max((b3.volHoursRecent||0) - base, 0) / stepHours), 0) * pointsPerStep;
  const volBonus = Math.min(rawVolBonus, maxBonus);
  let score = volBonus;
  const details = [];
  if (volBonus > 0) details.push('志愿时长加分+' + volBonus);
  const volunteerHonorItems = b3.volunteerHonors || [];
  const honorBonuses = calculateVolunteerHonorBonuses(volunteerHonorItems);
  honorBonuses.forEach(function(item) { score += item.pts; details.push(item.label + '+' + item.pts); });
  const commendation = b3.commendation || 0, branchActivity = b3.branchActivity || 0;
  if (commendation > 0) { const pts = commendation*(r.commendationPerTime||1); score += pts; details.push('校院通报表扬' + commendation + '次+' + pts); }
  if (branchActivity > 0) { const pts = branchActivity*(r.branchActivityPerTime||1); score += pts; details.push('支部活动参与' + branchActivity + '次+' + pts); }
  const compRules = r.competition || {};
  (b3.volCompetitions||[]).forEach(function(item) {
    const pts = (compRules[item.level] && compRules[item.level][item.award]) || 0;
    score += pts;
    if (pts) details.push(item.name + '[' + item.level + item.award + ']+' + pts);
  });
  score = addEnhancementScore(score, details, b3);
  const volunteerHonorNames = volunteerHonorItems.map(function(item) { return item && item.name; }).filter(Boolean);
  return {
    score: Math.round(score),
    detail: details.join('；'),
    volText: '总' + (b3.volHours||0) + 'h/近一年' + (b3.volHoursRecent||0) + 'h',
    volHonorText: volunteerHonorNames.join('；')
  };
}

function scoreBlock4(b4, rules) {
  const r = rules.block4 || {};
  let score = 0;
  const details = [];
  const cadreCount = Math.min(Math.max(Math.floor(Number(b4.cadre) || 0), 0), 3);
  if (cadreCount > 0) {
    const cadrePoints = cadreCount === 1 ? (r.cadreOne ?? 3) : (r.cadreTwo ?? 5);
    score += cadrePoints;
    details.push('担任' + cadreCount + '个职务+' + cadrePoints);
  }
  if (b4.cadreExcellent) { score += (r.cadreExcellent||5); details.push('学生干部优秀等级+' + (r.cadreExcellent||5)); }
  const exStudent = parseInt(b4.excellentStudent) || (b4.excellentStudent === true ? 1 : 0);
  const exCadre   = parseInt(b4.excellentCadre)   || (b4.excellentCadre   === true ? 1 : 0);
  const exLeague  = parseInt(b4.excellentLeague)  || (b4.excellentLeague  === true ? 1 : 0);
  if (exStudent > 0) { const pts = exStudent*(r.excellentStudent||2); score += pts; details.push('优秀学生' + exStudent + '次+' + pts); }
  if (exCadre > 0) { const pts = exCadre*(r.excellentCadre||2); score += pts; details.push('优秀学生干部' + exCadre + '次+' + pts); }
  if (exLeague > 0) { const pts = exLeague*(r.excellentLeague||2); score += pts; details.push('优秀共青团员' + exLeague + '次+' + pts); }
  const studyHelp = b4.studyHelpQuarter || 0, ethnicHelp = b4.ethnicHelpQuarter || 0;
  if (studyHelp > 0) { const pts = studyHelp*(r.studyHelpPerQuarter||4); score += pts; details.push('学习帮扶' + studyHelp + '季度+' + pts); }
  if (ethnicHelp > 0) { const pts = ethnicHelp*(r.ethnicHelpPerQuarter||8); score += pts; details.push('民族班级互助' + ethnicHelp + '季度+' + pts); }
  const branchAct = b4.branchActivity || 0, answerQ = b4.answerQuestion || 0;
  if (branchAct > 0) { const pts = branchAct*(r.branchActivityPerTime||1); score += pts; details.push('支部活动' + branchAct + '次+' + pts); }
  if (answerQ > 0) { const pts = answerQ*(r.answerQuestionPerTime||1); score += pts; details.push('回答问题' + answerQ + '次+' + pts); }
  if (b4.advancedDeed && r.advancedDeeds && r.advancedDeeds[b4.advancedDeed]) {
    score += r.advancedDeeds[b4.advancedDeed];
    details.push((b4.advancedDeed === 'righteous' ? '见义勇为/舍己救人' : '扶残助弱/拾金不昧') + '+' + r.advancedDeeds[b4.advancedDeed]);
  }
  if ((b4.absenceCount||0) > 0) {
    const penalties = r.absencePenalty || [2,4];
    let penalty = 0;
    for (let i = 1; i <= b4.absenceCount; i++) penalty += penalties[i-1] || penalties[penalties.length-1] || 0;
    score -= penalty;
    details.push('无故缺席' + b4.absenceCount + '次-' + penalty);
  }
  const collectiveRules = r.collectiveAwards || {};
  (b4.collectiveAwards||[]).forEach(function(item) {
    const pts = (collectiveRules[item.level] && collectiveRules[item.level][item.role]) || 0;
    score += pts;
    if (pts) details.push(item.name + '[' + item.level + '-' + item.role + ']+' + pts);
  });
  score = addEnhancementScore(score, details, b4);
  return { score: Math.round(score), detail: details.join('；'), positionDesc: b4.positionDesc || '' };
}

function scoreBlock5(b5, rules) {
  const r = rules.block5 || {};
  const matrix = r.scoreMatrix || {};
  let academicRaw = 0, nonAcademicRaw = 0;
  const academicDetails = [], nonAcademicDetails = [], directBonusDetails = [];
  const aw = r.academicWeight||0.6, naw = r.nonAcademicWeight||0.4;
  (b5.competitions||[]).forEach(function(c) {
    const pts = (matrix[c.level] && matrix[c.level][c.award]) || 0;
    if (c.isAcademic) {
      academicRaw += pts;
      academicDetails.push((c.name||'竞赛') + '[' + c.level + c.award + ']原始+' + pts + '，折算+' + (pts * aw));
    }
    else {
      nonAcademicRaw += pts;
      nonAcademicDetails.push((c.name||'竞赛') + '[' + c.level + c.award + ']原始+' + pts + '，折算+' + (pts * naw));
    }
  });
  let directBonus = 0;
  if (b5.techTeam) { directBonus += r.techTeam||3; directBonusDetails.push('科技创新团队+' + (r.techTeam||3)); }
  const innovations = b5.innovations && b5.innovations.length ? b5.innovations
    : (b5.innovationEstablish || b5.innovationComplete ? [{ establish: b5.innovationEstablish || '', complete: b5.innovationComplete || '' }] : []);
  innovations.forEach(function(item) {
    if (item.establish && r.innovationTraining && r.innovationTraining[item.establish]) {
      directBonus += r.innovationTraining[item.establish];
      directBonusDetails.push('大创立项+' + r.innovationTraining[item.establish]);
    }
    if (item.complete && r.innovationTraining && r.innovationTraining[item.complete]) {
      directBonus += r.innovationTraining[item.complete];
      directBonusDetails.push('大创结项+' + r.innovationTraining[item.complete]);
    }
  });
  (b5.academicWorks||[]).forEach(function(item) {
    if (item.name && r.academicWorks && r.academicWorks[item.type]) { directBonus += r.academicWorks[item.type]; directBonusDetails.push('著作《' + item.name + '》+' + r.academicWorks[item.type]); }
  });
  (b5.academicPapers||[]).forEach(function(item) {
    if (item.name && r.academicPapers && r.academicPapers[item.type]) { directBonus += r.academicPapers[item.type]; directBonusDetails.push('论文《' + item.name + '》+' + r.academicPapers[item.type]); }
  });
  (b5.patents||[]).forEach(function(item) {
    if (item.name && r.patents && r.patents[item.type]) { directBonus += r.patents[item.type]; directBonusDetails.push('专利《' + item.name + '》+' + r.patents[item.type]); }
  });
  const certs = r.certificates || {};
  if (b5.cet6) { directBonus += certs.cet6||10; directBonusDetails.push('英语六级+' + (certs.cet6||10)); }
  else if (b5.cet4) { directBonus += certs.cet4||5; directBonusDetails.push('英语四级+' + (certs.cet4||5)); }
  if (b5.mandarin) { directBonus += certs.mandarinLevel2B||5; directBonusDetails.push('普通话+' + (certs.mandarinLevel2B||5)); }
  if (b5.ncre && certs[b5.ncre]) { directBonus += certs[b5.ncre]; directBonusDetails.push('计算机等级+' + certs[b5.ncre]); }
  (b5.professionalCerts||[]).forEach(function(item) {
    if (item && item.name) { directBonus += certs.professionalCertificate||5; directBonusDetails.push('专业证书《' + item.name + '》+' + (certs.professionalCertificate||5)); }
  });
  if ((!b5.professionalCerts || !b5.professionalCerts.length) && b5.professionalCert) {
    directBonus += certs.professionalCertificate||5;
  }
  const score = Math.round(academicRaw*aw + nonAcademicRaw*naw + directBonus);
  return {
    score: score,
    academicDetail: academicDetails.join('；'),
    nonAcademicDetail: nonAcademicDetails.join('；'),
    directBonusDetail: directBonusDetails.join('；'),
    academicRaw: academicRaw, nonAcademicRaw: nonAcademicRaw, directBonusTotal: directBonus
  };
}

function scoreBlock6(b6, rules) {
  const r = rules.block6 || {};
  const roundedAvg = Math.round(b6.avg||0);
  let avgBonus = Math.max((roundedAvg - (r.baseScore||70)) * (r.bonusPerPoint||1), 0);
  const failDeductions = r.failDeduction || {};
  let failPenalty = 0;
  const failDetails = [];
  (b6.fails||[]).forEach(function(fail) {
    if (fail.name && failDeductions[fail.type] !== undefined) {
      failPenalty += failDeductions[fail.type];
      failDetails.push(fail.name + failDeductions[fail.type] + '分');
    }
  });
  const details = ['平均分' + (b6.avg||0) + '（四舍五入后' + roundedAvg + '），加分' + Math.round(avgBonus)];
  if (failDetails.length > 0) details.push('挂科扣分：' + failDetails.join('、'));
  const score = addEnhancementScore(avgBonus + failPenalty, details, b6);
  return { score: Math.round(score), detail: details.join('；') };
}

// ===== 计分逻辑 =====
function normalizeCompetitionName(name) {
  let value = String(name || '').trim();
  if (!value) return '';
  if (typeof value.normalize === 'function') value = value.normalize('NFKC');
  return value
    .toUpperCase()
    .replace(/20\d{2}(?:年|赛季)?/g, '')
    .replace(/["""'''`]/g, '')
    .replace(/[（()）【】\[\]{}<>《》]/g, '')
    .replace(/[—\-‐‑‒–―·•,，.。;；:：\/\\|]/g, '')
    .replace(/\s+/g, '');
}

function getCompetitionCoreName(name) {
  return normalizeCompetitionName(name)
    .replace(/全国|中国|国际|高校|高等学校|大学生|本科院校|职业院校|院校|学校/g, '')
    .replace(/挑战赛|选拔赛|竞赛|大赛|比赛|论坛|作品展|年会展示/g, '');
}

function extractCompetitionAliases(name) {
  const aliases = new Set();
  const normalized = normalizeCompetitionName(name);
  if (!normalized) return aliases;
  aliases.add(normalized);
  const coreName = getCompetitionCoreName(name);
  if (coreName && coreName.length >= 4) aliases.add(coreName);
  const cups = String(name).match(/[一-龥A-Za-z0-9·•]+杯/g) || [];
  cups.forEach(function(cup) {
    const normalizedCup = normalizeCompetitionName(cup);
    if (normalizedCup) aliases.add(normalizedCup);
  });
  const abbrs = String(name).toUpperCase().match(/[A-Z][A-Z0-9\-]{1,}/g) || [];
  abbrs.forEach(function(abbr) {
    const normalizedAbbr = normalizeCompetitionName(abbr);
    if (normalizedAbbr) aliases.add(normalizedAbbr);
  });
  return aliases;
}

function buildAcademicCompetitionMatcher() {
  const list = (RULES.block5 && RULES.block5.academicCompetitions) || [];
  const aliases = new Set();
  const items = list.map(function(name) {
    extractCompetitionAliases(name).forEach(function(alias) { aliases.add(alias); });
    return {
      normalized: normalizeCompetitionName(name),
      coreName: getCompetitionCoreName(name)
    };
  });
  return { aliases: aliases, items: items };
}

function isAcademicCompetition(name) {
  const normalized = normalizeCompetitionName(name);
  if (!normalized) return false;
  if (!_academicCompetitionMatcher) _academicCompetitionMatcher = buildAcademicCompetitionMatcher();
  const inputAliases = Array.from(extractCompetitionAliases(name));
  if (inputAliases.some(function(alias) { return _academicCompetitionMatcher.aliases.has(alias); })) {
    return true;
  }
  const inputCoreName = getCompetitionCoreName(name);
  return _academicCompetitionMatcher.items.some(function(item) {
    if (!item.normalized) return false;
    if (item.normalized.indexOf(normalized) >= 0 || normalized.indexOf(item.normalized) >= 0) return true;
    if (!inputCoreName || inputCoreName.length < 4 || !item.coreName || item.coreName.length < 4) return false;
    return item.coreName.indexOf(inputCoreName) >= 0 || inputCoreName.indexOf(item.coreName) >= 0;
  });
}

function calcBlock1() {
  const enhancement = collectEnhancementData('b1');
  const b1Data = {
    noViolation: document.getElementById('b1_noViolation').checked,
    club: parseInt(document.getElementById('b1_club').value) || 0,
    competitions: (function() {
      const comps = [];
      const owners = refreshDuplicateScoringState();
      document.querySelectorAll('#b1_competitions .record-item').forEach(function(item) {
        const nameInput = item.querySelector('.b1-name');
        const name = nameInput.value.trim();
        if (!name || !isUniqueScoringInput(nameInput, owners)) return;
        comps.push({ name: name, level: item.querySelector('.b1-level').value, rank: item.querySelector('.b1-rank').value });
      });
      return comps;
    })(),
    publications: collectB1PublicationsFromDom(),
    honors: enhancement.honors,
    customCompetitions: enhancement.customCompetitions
  };
  const result = scoreBlock1(b1Data, RULES);
  document.getElementById('score1').textContent = result.score + '分';
  document.getElementById('preview1').textContent = result.score;
  _detailCache.b1 = result.detail;
  updateTotal();
  return { score: result.score, detail: result.detail };
}

function detectPracticeLevelFromText(text) {
  const normalized = String(text || '').replace(/\s+/g, '');
  if (!normalized || !/(优秀|表彰|先进)/.test(normalized)) return '';
  if (/(兵团|省级|省部级)/.test(normalized)) return '兵团省级';
  if (/校级/.test(normalized)) return '校级';
  if (/(院级|院校级)/.test(normalized)) return '院级';
  return '';
}

function detectVolunteerBonuses(practiceDescs, explicitState) {
  const r = RULES.block2 || {};
  const bonuses = [];
  let bestPractice = null;
  (practiceDescs || []).forEach(function(desc) {
    const text = String(desc || '').trim();
    if (!text) return;
    const practiceLevel = normalizePracticeLevel(detectPracticeLevelFromText(text));
    if (practiceLevel) {
      const pts = (r.practiceExcellent && r.practiceExcellent[practiceLevel]) || 0;
      if (pts && (!bestPractice || pts > bestPractice.pts)) {
        bestPractice = { type: 'practice', label: '实践评优[' + practiceLevel + ']', pts: pts };
      }
    }
  });
  if (bestPractice) bonuses.push(bestPractice);
  return bonuses;
}

function normalizePracticeLevel(level) {
  const value = String(level || '').trim();
  if (value === '省级' || value === '兵团级' || value === '兵团（省级）' || value === '兵团省级') return '兵团省级';
  return value;
}

function normalizePracticeCompetitionLevel(level) {
  const value = normalizePracticeLevel(level);
  if (value === '院校级') return '院级';
  if (value === '兵团省级' || value === '省部级') return '省级';
  return value;
}

function calculateStructuredPracticeBonuses(practices, explicitState) {
  const r = RULES.block2 || {};
  const bonuses = [];
  (practices || []).forEach(function(practice) {
    if (!practice || practice.desc) return;
    const rawLevel = String(practice.level || '').trim();
    const level = normalizePracticeLevel(rawLevel);
    const competitionLevel = normalizePracticeCompetitionLevel(rawLevel);
    const award = String(practice.award || '').trim();
    if (award === '优秀') {
      const pts = (r.practiceExcellent && r.practiceExcellent[level]) || 0;
      if (pts) {
        bonuses.push({
          type: 'practice',
          label: '实践评优[' + (String(practice.name || '').trim() || level) + (rawLevel ? '-' + rawLevel : '') + ']',
          pts: pts
        });
      }
    }
    if (award === '一等奖' || award === '二等奖' || award === '三等奖' || award === '优秀奖') {
      const pts = ((r.competition || {})[competitionLevel] || {})[award] || 0;
      if (pts) {
        bonuses.push({
          type: 'practice',
          label: '实践获奖[' + (rawLevel || competitionLevel) + award + ']',
          pts: pts
        });
      }
    }
  });
  return bonuses;
}

function calculateVolunteerHonorBonuses(items) {
  const r = RULES.block3 || {};
  const bonuses = [];
  (items || []).forEach(function(item) {
    const name = String(item && item.name || '').trim();
    const type = String(item && item.type || '').trim();
    if (!name) return;
    if (type === '优秀志愿者') {
      bonuses.push({ type: 'honor', label: name, pts: r.excellentVolunteer || 2 });
    } else if (type === '星级志愿者') {
      bonuses.push({ type: 'honor', label: name, pts: r.starVolunteer || 2 });
    }
  });
  return bonuses;
}

function getPracticeDisplayText(practice) {
  if (!practice) return '';
  if (practice.desc) return String(practice.desc).trim();
  const name = String(practice.name || '').trim();
  const level = String(practice.level || '').trim();
  const award = String(practice.award || '').trim();
  return [name, level, award].filter(Boolean).join('[').replace(/\[([^\[]*)\[([^\[]*)$/, '[$1$2]');
}

function collectPracticeItemsFromDom() {
  const practices = [];
  const owners = refreshDuplicateScoringState();
  document.querySelectorAll('#b2_practices .record-item').forEach(function(item) {
    const nameEl = item.querySelector('.b2-name');
    const levelEl = item.querySelector('.b2-level');
    const awardEl = item.querySelector('.b2-award');
    const descEl = item.querySelector('.b2-desc');
    if (nameEl) {
      const name = nameEl.value.trim();
      if (!name || !isUniqueScoringInput(nameEl, owners)) return;
      practices.push({ name: name, level: levelEl ? levelEl.value : '', award: awardEl ? awardEl.value : '' });
      return;
    }
    if (descEl && descEl.value.trim()) practices.push({ desc: descEl.value.trim() });
  });
  return practices;
}

function collectVolunteerHonorsFromDom() {
  const honors = [];
  const owners = refreshDuplicateScoringState();
  document.querySelectorAll('#b3_volunteerHonors .record-item').forEach(function(item) {
    const nameInput = item.querySelector('.b3-volunteer-name');
    const name = nameInput.value.trim();
    if (!name || !isUniqueScoringInput(nameInput, owners)) return;
    honors.push({ name: name, type: item.querySelector('.b3-volunteer-type').value });
  });
  return honors;
}

function collectB1PublicationsFromDom() {
  const publications = [];
  document.querySelectorAll('#b1_publications .record-item').forEach(function(item) {
    const name = item.querySelector('.b1-publication-name').value.trim();
    const type = item.querySelector('.b1-publication-type').value;
    if (name) publications.push({ name: name, type: type });
  });
  return publications;
}

function collectB2CompetitionsFromDom() {
  const competitions = [];
  const owners = refreshDuplicateScoringState();
  document.querySelectorAll('#b2_competitions .record-item').forEach(function(item) {
    const nameInput = item.querySelector('.b2-competition-name');
    const name = nameInput.value.trim();
    const level = item.querySelector('.b2-competition-level').value;
    const award = item.querySelector('.b2-competition-award').value;
    if (name && isUniqueScoringInput(nameInput, owners)) competitions.push({ name: name, level: level, award: award });
  });
  return competitions;
}

function collectB3VolCompetitionsFromDom() {
  const competitions = [];
  const owners = refreshDuplicateScoringState();
  document.querySelectorAll('#b3_volCompetitions .record-item').forEach(function(item) {
    const nameInput = item.querySelector('.b3-vol-competition-name');
    const name = nameInput.value.trim();
    const level = item.querySelector('.b3-vol-competition-level').value;
    const award = item.querySelector('.b3-vol-competition-award').value;
    if (name && isUniqueScoringInput(nameInput, owners)) competitions.push({ name: name, level: level, award: award });
  });
  return competitions;
}

function collectB4CollectiveAwardsFromDom() {
  const awards = [];
  const owners = refreshDuplicateScoringState();
  document.querySelectorAll('#b4_collectiveAwards .record-item').forEach(function(item) {
    const nameInput = item.querySelector('.b4-collective-name');
    const name = nameInput.value.trim();
    const level = item.querySelector('.b4-collective-level').value;
    const role = item.querySelector('.b4-collective-role').value;
    if (name && isUniqueScoringInput(nameInput, owners)) awards.push({ name: name, level: level, role: role });
  });
  return awards;
}

function calcBlock2() {
  const enhancement = collectEnhancementData('b2');
  const b2Data = {
    sanxia: parseInt(document.getElementById('b2_sanxia').value) || 0,
    fanjia: parseInt(document.getElementById('b2_fanjia').value) || 0,
    practices: collectPracticeItemsFromDom(),
    competitions: collectB2CompetitionsFromDom(),
    honors: enhancement.honors,
    customCompetitions: enhancement.customCompetitions
  };
  const result = scoreBlock2(b2Data, RULES);
  document.getElementById('score2').textContent = result.score + '分';
  document.getElementById('preview2').textContent = result.score;
  _detailCache.b2 = result.detail;
  updateTotal();
  return result;
}

function calcBlock3() {
  const enhancement = collectEnhancementData('b3');
  const b3Data = {
    volHours: parseFloat(document.getElementById('b3_volHours').value) || 0,
    volHoursRecent: parseFloat(document.getElementById('b3_volHoursRecent').value) || 0,
    commendation: parseInt(document.getElementById('b3_commendation').value) || 0,
    branchActivity: parseInt(document.getElementById('b3_branchActivity').value) || 0,
    volunteerHonors: collectVolunteerHonorsFromDom(),
    volCompetitions: collectB3VolCompetitionsFromDom(),
    honors: enhancement.honors,
    customCompetitions: enhancement.customCompetitions
  };
  const result = scoreBlock3(b3Data, RULES);
  document.getElementById('score3').textContent = result.score + '分';
  document.getElementById('preview3').textContent = result.score;
  _detailCache.b3 = result.detail;
  updateTotal();
  return result;
}

function calcBlock4() {
  const b4CollectiveAwards = collectB4CollectiveAwardsFromDom();
  const enhancement = collectEnhancementData('b4');
  const b4Data = {
    cadre: Math.min(parseInt(document.getElementById('b4_cadre').value) || 0, 3),
    cadreExcellent: document.getElementById('b4_cadreExcellent').checked,
    excellentStudent: parseInt(document.getElementById('b4_excellentStudent').value) || 0,
    excellentCadre: parseInt(document.getElementById('b4_excellentCadre').value) || 0,
    excellentLeague: parseInt(document.getElementById('b4_excellentLeague').value) || 0,
    absenceCount: parseInt(document.getElementById('b4_absenceCount').value) || 0,
    studyHelpQuarter: parseInt(document.getElementById('b4_studyHelpQuarter').value) || 0,
    ethnicHelpQuarter: parseInt(document.getElementById('b4_ethnicHelpQuarter').value) || 0,
    branchActivity: parseInt(document.getElementById('b4_branchActivity').value) || 0,
    answerQuestion: parseInt(document.getElementById('b4_answerQuestion').value) || 0,
    advancedDeed: document.getElementById('b4_advancedDeed').value,
    collectiveAwards: b4CollectiveAwards,
    positionDesc: document.getElementById('b4_positionDesc').value.trim(),
    honors: enhancement.honors,
    customCompetitions: enhancement.customCompetitions
  };
  const result = scoreBlock4(b4Data, RULES);
  document.getElementById('score4').textContent = result.score + '分';
  document.getElementById('preview4').textContent = result.score;
  _detailCache.b4 = result.detail;
  updateTotal();
  return result;
}

function calcBlock5() {
  const b5Comps = [];
  document.querySelectorAll('#b5_competitions .record-item').forEach(function(item) {
    const owners = refreshDuplicateScoringState();
    const academicInput = item.querySelector('.b5-name-select');
    const manualInput = item.querySelector('.b5-name-manual');
    const academicName = academicInput.value.trim();
    const manualName = manualInput.value.trim();
    const level = item.querySelector('.b5-level').value;
    const award = item.querySelector('.b5-award').value;
    const badge = item.querySelector('.b5-type-badge');
    if (!academicName && !manualName) {
      badge.textContent = '';
      badge.className = 'b5-type-badge badge bg-secondary small';
      return;
    }
    if (academicName && isUniqueScoringInput(academicInput, owners)) {
      badge.textContent = '学科竞赛';
      badge.className = 'b5-type-badge badge bg-primary small';
      b5Comps.push({ name: academicName, level: level, award: award, isAcademic: true });
    }
    if (manualName && isUniqueScoringInput(manualInput, owners)) {
      badge.textContent = '非学科竞赛';
      badge.className = 'b5-type-badge badge bg-success small';
      b5Comps.push({ name: manualName, level: level, award: award, isAcademic: false });
    }
  });
  const b5AcademicWorks = [];
  document.querySelectorAll('#b5_academicWorks .record-item').forEach(function(item) {
    const name = item.querySelector('.b5-work-name').value.trim();
    if (name) b5AcademicWorks.push({ name: name, type: item.querySelector('.b5-work-type').value });
  });
  const b5AcademicPapers = [];
  document.querySelectorAll('#b5_academicPapers .record-item').forEach(function(item) {
    const name = item.querySelector('.b5-paper-name').value.trim();
    if (name) b5AcademicPapers.push({ name: name, type: item.querySelector('.b5-paper-type').value });
  });
  const b5Patents = [];
  document.querySelectorAll('#b5_patents .record-item').forEach(function(item) {
    const name = item.querySelector('.b5-patent-name').value.trim();
    if (name) b5Patents.push({ name: name, type: item.querySelector('.b5-patent-type').value });
  });
  const b5ProfessionalCerts = [];
  document.querySelectorAll('#b5_professionalCerts .record-item').forEach(function(item) {
    const name = item.querySelector('.b5-prof-cert-name').value.trim();
    if (name) b5ProfessionalCerts.push({ name: name });
  });
  const b5Innovations = [];
  document.querySelectorAll('#b5_innovations .record-item').forEach(function(item) {
    b5Innovations.push({
      establish: item.querySelector('.b5-innov-establish').value,
      complete: item.querySelector('.b5-innov-complete').value
    });
  });
  const b5Data = {
    competitions: b5Comps,
    techTeam: document.getElementById('b5_techTeam').checked,
    innovations: b5Innovations,
    academicWorks: b5AcademicWorks,
    academicPapers: b5AcademicPapers,
    patents: b5Patents,
    cet4: document.getElementById('b5_cet4').checked,
    cet6: document.getElementById('b5_cet6').checked,
    mandarin: document.getElementById('b5_mandarin').checked,
    ncre: document.getElementById('b5_ncre').value,
    professionalCerts: b5ProfessionalCerts
  };
  const result = scoreBlock5(b5Data, RULES);
  document.getElementById('score5').textContent = result.score + '分';
  document.getElementById('preview5').textContent = result.score;
  _detailCache.b5a = result.academicDetail;
  _detailCache.b5n = result.nonAcademicDetail;
  _detailCache.b5d = result.directBonusDetail;
  updateTotal();
  return result;
}

function calcBlock6() {
  const enhancement = collectEnhancementData('b6');
  const b6Fails = [];
  document.querySelectorAll('#b6_fails .record-item').forEach(function(item) {
    const name = item.querySelector('.b6-fail-name').value.trim();
    const type = item.querySelector('.b6-fail-type').value;
    if (name) b6Fails.push({ name: name, type: type });
  });
  const b6Data = {
    avg: parseFloat(document.getElementById('b6_avg').value) || 0,
    fails: b6Fails,
    honors: enhancement.honors,
    customCompetitions: enhancement.customCompetitions
  };
  const result = scoreBlock6(b6Data, RULES);
  document.getElementById('score6').textContent = result.score + '分';
  document.getElementById('preview6').textContent = result.score;
  _detailCache.b6 = result.detail;
  updateTotal();
  return result;
}

function updateTotal() {
  const vals = ['preview1','preview2','preview3','preview4','preview5','preview6']
    .map(function(id) { return parseFloat(document.getElementById(id).textContent) || 0; });
  const total = _detailCache.zeroed ? 0 : Math.round(vals.reduce(function(a,b){ return a+b; }, 0));
  document.getElementById('previewTotal').textContent = total;
  const lines = [
    _detailCache.b1 ? '板块一：' + _detailCache.b1 : '',
    _detailCache.b2 ? '板块二：' + _detailCache.b2 : '',
    _detailCache.b3 ? '板块三：' + _detailCache.b3 : '',
    _detailCache.b4 ? '板块四：' + _detailCache.b4 : '',
    (_detailCache.b5a || _detailCache.b5n) ? '板块五-竞赛：学科[' + _detailCache.b5a + '] 非学科[' + _detailCache.b5n + ']' : '',
    _detailCache.b5d ? '板块五-直接加分：' + _detailCache.b5d : '',
    _detailCache.b6 ? '板块六：' + _detailCache.b6 : '',
    _detailCache.zeroed ? '总分已清零：仅记录参与情况' : ''
  ].filter(Boolean);
  document.getElementById('previewDetail').innerHTML =
    lines.map(function(l){ return '<div class="mb-1">' + l + '</div>'; }).join('');
}

function updatePreviewDetail() { /* 已合并到 updateTotal */ }

// ===== 收集表单数据 =====
function collectFormData() {
  const r1 = calcBlock1(), r2 = calcBlock2(), r3 = calcBlock3(), r4 = calcBlock4(), r5 = calcBlock5(), r6 = calcBlock6();
  const total = parseFloat(document.getElementById('previewTotal').textContent) || 0;

  const b1Comps = [];
  const scoringOwners = refreshDuplicateScoringState();
  document.querySelectorAll('#b1_competitions .record-item').forEach(function(item) {
    const nameInput = item.querySelector('.b1-name');
    if (!isUniqueScoringInput(nameInput, scoringOwners)) return;
    b1Comps.push({ name: nameInput.value.trim(), level: item.querySelector('.b1-level').value, rank: item.querySelector('.b1-rank').value });
  });

  const b2Practices = collectPracticeItemsFromDom();
  const b3VolunteerHonors = collectVolunteerHonorsFromDom();
  const b1Publications = collectB1PublicationsFromDom();
  const b2Competitions = collectB2CompetitionsFromDom();
  const b3VolCompetitions = collectB3VolCompetitionsFromDom();
  const b4CollectiveAwards = collectB4CollectiveAwardsFromDom();
  const b1Enhancement = collectEnhancementData('b1');
  const b2Enhancement = collectEnhancementData('b2');
  const b3Enhancement = collectEnhancementData('b3');
  const b4Enhancement = collectEnhancementData('b4');
  const b6Enhancement = collectEnhancementData('b6');

  const b5Comps = [];
  document.querySelectorAll('#b5_competitions .record-item').forEach(function(item) {
    const academicInput = item.querySelector('.b5-name-select');
    const manualInput = item.querySelector('.b5-name-manual');
    const academicName = academicInput.value.trim();
    const manualName = manualInput.value.trim();
    const level = item.querySelector('.b5-level').value;
    const award = item.querySelector('.b5-award').value;
    if (academicName && isUniqueScoringInput(academicInput, scoringOwners)) {
      b5Comps.push({ name: academicName, selectedName: academicName, isManual: false, level: level, award: award, isAcademic: true });
    }
    if (manualName && isUniqueScoringInput(manualInput, scoringOwners)) {
      b5Comps.push({ name: manualName, selectedName: '', isManual: true, level: level, award: award, isAcademic: false });
    }
  });

  const b5AcademicWorks = [];
  document.querySelectorAll('#b5_academicWorks .record-item').forEach(function(item) {
    const workName = item.querySelector('.b5-work-name').value.trim();
    if (workName) b5AcademicWorks.push({ name: workName, type: item.querySelector('.b5-work-type').value });
  });
  const b5AcademicPapers = [];
  document.querySelectorAll('#b5_academicPapers .record-item').forEach(function(item) {
    const paperName = item.querySelector('.b5-paper-name').value.trim();
    if (paperName) b5AcademicPapers.push({ name: paperName, type: item.querySelector('.b5-paper-type').value });
  });
  const b5Patents = [];
  document.querySelectorAll('#b5_patents .record-item').forEach(function(item) {
    const patentName = item.querySelector('.b5-patent-name').value.trim();
    if (patentName) b5Patents.push({ name: patentName, type: item.querySelector('.b5-patent-type').value });
  });
  const b5ProfessionalCerts = [];
  document.querySelectorAll('#b5_professionalCerts .record-item').forEach(function(item) {
    const certName = item.querySelector('.b5-prof-cert-name').value.trim();
    if (certName) b5ProfessionalCerts.push({ name: certName });
  });

  return {
    name: document.getElementById('f_name').value.trim(),
    className: document.getElementById('f_class').value.trim(),
    group: document.getElementById('f_group').value.trim(),
    dorm: document.getElementById('f_dorm').value.trim(),
    gender: document.getElementById('f_gender').value,
    nation: document.getElementById('f_nation').value.trim(),
    birth: document.getElementById('f_birth').value,
    activist: document.getElementById('f_activist').value.trim(),
    failRecent: document.getElementById('f_failRecent').value,
    failTotal: document.getElementById('f_failTotal').value,
    cet: document.getElementById('f_cet').value.trim(),
    rank: document.getElementById('f_rank').value.trim(),
    remark: document.getElementById('f_remark').value.trim(),
    b1: { noViolation: document.getElementById('b1_noViolation').checked, club: parseInt(document.getElementById('b1_club').value)||0, competitions: b1Comps, publications: b1Publications, honors: b1Enhancement.honors, customCompetitions: b1Enhancement.customCompetitions },
    b2: {
      sanxia: parseInt(document.getElementById('b2_sanxia').value)||0,
      fanjia: parseInt(document.getElementById('b2_fanjia').value)||0,
      practices: b2Practices,
      competitions: b2Competitions,
      honors: b2Enhancement.honors,
      customCompetitions: b2Enhancement.customCompetitions
    },
    b3: {
      volHours: parseFloat(document.getElementById('b3_volHours').value)||0,
      volHoursRecent: parseFloat(document.getElementById('b3_volHoursRecent').value)||0,
      commendation: parseInt(document.getElementById('b3_commendation').value)||0,
      branchActivity: parseInt(document.getElementById('b3_branchActivity').value)||0,
      volunteerHonors: b3VolunteerHonors,
      volCompetitions: b3VolCompetitions,
      honors: b3Enhancement.honors,
      customCompetitions: b3Enhancement.customCompetitions
    },
    b4: {
      cadre: Math.min(parseInt(document.getElementById('b4_cadre').value)||0, 3),
      cadreExcellent: document.getElementById('b4_cadreExcellent').checked,
      excellentStudent: parseInt(document.getElementById('b4_excellentStudent').value)||0,
      excellentCadre: parseInt(document.getElementById('b4_excellentCadre').value)||0,
      excellentLeague: parseInt(document.getElementById('b4_excellentLeague').value)||0,
      absenceCount: parseInt(document.getElementById('b4_absenceCount').value)||0,
      studyHelpQuarter: parseInt(document.getElementById('b4_studyHelpQuarter').value)||0,
      ethnicHelpQuarter: parseInt(document.getElementById('b4_ethnicHelpQuarter').value)||0,
      branchActivity: parseInt(document.getElementById('b4_branchActivity').value)||0,
      answerQuestion: parseInt(document.getElementById('b4_answerQuestion').value)||0,
      advancedDeed: document.getElementById('b4_advancedDeed').value,
      collectiveAwards: b4CollectiveAwards,
      positionDesc: document.getElementById('b4_positionDesc').value.trim(),
      honors: b4Enhancement.honors,
      customCompetitions: b4Enhancement.customCompetitions
    },
    b5: {
      competitions: b5Comps,
      techTeam: document.getElementById('b5_techTeam').checked,
      innovations: (function() {
        var arr = [];
        document.querySelectorAll('#b5_innovations .record-item').forEach(function(item) {
          arr.push({ establish: item.querySelector('.b5-innov-establish').value, complete: item.querySelector('.b5-innov-complete').value });
        });
        return arr;
      })(),
      academicWorks: b5AcademicWorks,
      academicPapers: b5AcademicPapers,
      patents: b5Patents,
      cet4: document.getElementById('b5_cet4').checked,
      cet6: document.getElementById('b5_cet6').checked,
      mandarin: document.getElementById('b5_mandarin').checked,
      ncre: document.getElementById('b5_ncre').value,
      professionalCerts: b5ProfessionalCerts
    },
    b6: {
      avg: parseFloat(document.getElementById('b6_avg').value)||0,
      fails: (function() {
        var fails = [];
        document.querySelectorAll('#b6_fails .record-item').forEach(function(item) {
          var failName = item.querySelector('.b6-fail-name').value.trim();
          var failType = item.querySelector('.b6-fail-type').value;
          if (failName) fails.push({ name: failName, type: failType });
        });
        return fails;
      })(),
      honors: b6Enhancement.honors,
      customCompetitions: b6Enhancement.customCompetitions
    },
    scores: { b1: r1.score, b2: r2.score, b3: r3.score, b4: r4.score, b5: r5.score, b6: r6.score, total: total, zeroed: false },
    details: {
      b1: r1.detail, b2: r2.detail, b3: r3.detail, b4: r4.detail,
      b5Academic: r5.academicDetail, b5NonAcademic: r5.nonAcademicDetail,
      b6: r6.detail,
      volText: r3.volText, practiceText: r2.practiceText, volHonorText: r3.volHonorText,
      positionDesc: r4.positionDesc
    }
  };
}

// ===== 填充表单 =====
function fillForm(s) {
  migrateOldRecord(s);

  document.getElementById('f_name').value = s.name || '';
  document.getElementById('f_class').value = s.className || '';
  document.getElementById('f_group').value = s.group || '';
  document.getElementById('f_dorm').value = s.dorm || '';
  document.getElementById('f_gender').value = s.gender || '';
  document.getElementById('f_nation').value = s.nation || '';
  document.getElementById('f_birth').value = s.birth || '';
  document.getElementById('f_activist').value = s.activist || '';
  document.getElementById('f_failRecent').value = s.failRecent || 0;
  document.getElementById('f_failTotal').value = s.failTotal || 0;
  document.getElementById('f_cet').value = s.cet || '';
  document.getElementById('f_rank').value = s.rank || '';
  document.getElementById('f_remark').value = s.remark || '';

  const b1 = s.b1 || {};
  document.getElementById('b1_noViolation').checked = !!b1.noViolation;
  document.getElementById('b1_club').value = b1.club || 0;
  document.getElementById('b1_competitions').innerHTML = '';
  (b1.competitions || []).forEach(function(c) { addB1Competition(c); });
  document.getElementById('b1_publications').innerHTML = '';
  (b1.publications || []).forEach(function(p) { addB1Publication(p); });
  renderEnhancements('b1', b1);

  const b2 = s.b2 || {};
  document.getElementById('b2_sanxia').value = b2.sanxia || 0;
  document.getElementById('b2_fanjia').value = b2.fanjia || 0;
  document.getElementById('b2_practices').innerHTML = '';
  (b2.practices || []).forEach(function(p) { addB2Practice(p); });
  document.getElementById('b2_competitions').innerHTML = '';
  (b2.competitions || []).forEach(function(c) { addB2Competition(c); });
  renderEnhancements('b2', b2);

  const b3 = s.b3 || {};
  document.getElementById('b3_volHours').value = b3.volHours || 0;
  document.getElementById('b3_volHoursRecent').value = b3.volHoursRecent || 0;
  document.getElementById('b3_commendation').value = b3.commendation || 0;
  document.getElementById('b3_branchActivity').value = b3.branchActivity || 0;
  document.getElementById('b3_volunteerHonors').innerHTML = '';
  (b3.volunteerHonors || []).forEach(function(item) { addB3VolunteerHonor(item); });
  document.getElementById('b3_volCompetitions').innerHTML = '';
  (b3.volCompetitions || []).forEach(function(c) { addB3VolCompetition(c); });
  renderEnhancements('b3', b3);

  const b4 = s.b4 || {};
  document.getElementById('b4_cadre').value = Math.min(parseInt(b4.cadre) || 0, 3);
  document.getElementById('b4_cadreExcellent').checked = !!b4.cadreExcellent;
  document.getElementById('b4_excellentStudent').value = parseInt(b4.excellentStudent) || (b4.excellentStudent === true ? 1 : 0);
  document.getElementById('b4_excellentCadre').value   = parseInt(b4.excellentCadre)   || (b4.excellentCadre   === true ? 1 : 0);
  document.getElementById('b4_excellentLeague').value  = parseInt(b4.excellentLeague)  || (b4.excellentLeague  === true ? 1 : 0);
  document.getElementById('b4_absenceCount').value = b4.absenceCount || 0;
  document.getElementById('b4_studyHelpQuarter').value = b4.studyHelpQuarter || 0;
  document.getElementById('b4_ethnicHelpQuarter').value = b4.ethnicHelpQuarter || 0;
  document.getElementById('b4_branchActivity').value = b4.branchActivity || 0;
  document.getElementById('b4_answerQuestion').value = b4.answerQuestion || 0;
  document.getElementById('b4_advancedDeed').value = b4.advancedDeed || '';
  document.getElementById('b4_positionDesc').value = b4.positionDesc || '';
  document.getElementById('b4_collectiveAwards').innerHTML = '';
  (b4.collectiveAwards || []).forEach(function(a) { addB4CollectiveAward(a); });
  renderEnhancements('b4', b4);

  const b5 = s.b5 || {};
  document.getElementById('b5_competitions').innerHTML = '';
  (b5.competitions || []).forEach(function(c) { addB5Competition(c); });
  document.getElementById('b5_techTeam').checked = !!b5.techTeam;
  document.getElementById('b5_innovations').innerHTML = '';
  if (b5.innovations && b5.innovations.length) {
    b5.innovations.forEach(function(item) { addB5Innovation(item); });
  } else if (b5.innovationEstablish || b5.innovationComplete) {
    addB5Innovation({ establish: b5.innovationEstablish || '', complete: b5.innovationComplete || '' });
  }
  document.getElementById('b5_academicWorks').innerHTML = '';
  (b5.academicWorks || []).forEach(function(w) { addB5AcademicWork(w); });
  document.getElementById('b5_academicPapers').innerHTML = '';
  (b5.academicPapers || []).forEach(function(p) { addB5AcademicPaper(p); });
  document.getElementById('b5_patents').innerHTML = '';
  (b5.patents || []).forEach(function(p) { addB5Patent(p); });
  document.getElementById('b5_cet4').checked = !!b5.cet4;
  document.getElementById('b5_cet6').checked = !!b5.cet6;
  document.getElementById('b5_mandarin').checked = !!b5.mandarin;
  document.getElementById('b5_ncre').value = b5.ncre || '';
  document.getElementById('b5_professionalCerts').innerHTML = '';
  if (Array.isArray(b5.professionalCerts) && b5.professionalCerts.length) {
    b5.professionalCerts.forEach(function(cert) { addB5ProfessionalCert(cert); });
  } else if (b5.professionalCert) {
    addB5ProfessionalCert({ name: '专业相关资格证书' });
  }

  const b6 = s.b6 || {};
  document.getElementById('b6_avg').value = b6.avg || 70;
  document.getElementById('b6_fails').innerHTML = '';
  (b6.fails || []).forEach(function(f) { addB6Fail(f); });
  renderEnhancements('b6', b6);

  calcBlock1(); calcBlock2(); calcBlock3(); calcBlock4(); calcBlock5(); calcBlock6();
}

// ===== 保存学生 =====
async function saveStudent() {
  const data = collectFormData();
  if (!data.name) { showToast('请填写姓名', 'warning'); return; }
  if (editingStudentId !== null) data.id = editingStudentId;
  try {
    await dbPut(data);
    showToast(editingStudentId !== null ? '更新成功' : '保存成功', 'success');
    markFormClean();
    clearForm();
    renderSummary();
  } catch(e) {
    showToast('保存失败：' + e.message, 'danger');
  }
}

function clearForm() {
  editingStudentId = null;
  markFormClean();
  document.getElementById('editingHint').classList.add('d-none');
  ['f_name','f_class','f_group','f_dorm','f_gender','f_nation','f_birth','f_activist',
   'f_failRecent','f_failTotal','f_cet','f_rank','f_remark'].forEach(function(id) {
    const el = document.getElementById(id);
    if (el.tagName === 'SELECT') el.value = '';
    else if (el.type === 'number') el.value = 0;
    else el.value = '';
  });
  document.getElementById('b1_noViolation').checked = false;
  document.getElementById('b1_club').value = 0;
  document.getElementById('b1_competitions').innerHTML = '';
  document.getElementById('b1_publications').innerHTML = '';
  document.getElementById('b1_honors').innerHTML = '';
  document.getElementById('b1_customCompetitions').innerHTML = '';
  document.getElementById('b2_sanxia').value = 0;
  document.getElementById('b2_fanjia').value = 0;
  document.getElementById('b2_practices').innerHTML = '';
  document.getElementById('b2_competitions').innerHTML = '';
  document.getElementById('b2_honors').innerHTML = '';
  document.getElementById('b2_customCompetitions').innerHTML = '';
  document.getElementById('b3_volHours').value = 0;
  document.getElementById('b3_volHoursRecent').value = 0;
  document.getElementById('b3_commendation').value = 0;
  document.getElementById('b3_branchActivity').value = 0;
  document.getElementById('b3_volunteerHonors').innerHTML = '';
  document.getElementById('b3_volCompetitions').innerHTML = '';
  document.getElementById('b3_honors').innerHTML = '';
  document.getElementById('b3_customCompetitions').innerHTML = '';
  document.getElementById('b4_cadre').value = 0;
  document.getElementById('b4_cadreExcellent').checked = false;
  document.getElementById('b4_excellentStudent').value = 0;
  document.getElementById('b4_excellentCadre').value = 0;
  document.getElementById('b4_excellentLeague').value = 0;
  document.getElementById('b4_absenceCount').value = 0;
  document.getElementById('b4_studyHelpQuarter').value = 0;
  document.getElementById('b4_ethnicHelpQuarter').value = 0;
  document.getElementById('b4_branchActivity').value = 0;
  document.getElementById('b4_answerQuestion').value = 0;
  document.getElementById('b4_advancedDeed').value = '';
  document.getElementById('b4_positionDesc').value = '';
  document.getElementById('b4_collectiveAwards').innerHTML = '';
  document.getElementById('b4_honors').innerHTML = '';
  document.getElementById('b4_customCompetitions').innerHTML = '';
  document.getElementById('b5_competitions').innerHTML = '';
  document.getElementById('b5_techTeam').checked = false;
  document.getElementById('b5_innovations').innerHTML = '';
  document.getElementById('b5_academicWorks').innerHTML = '';
  document.getElementById('b5_academicPapers').innerHTML = '';
  document.getElementById('b5_patents').innerHTML = '';
  document.getElementById('b5_cet4').checked = false;
  document.getElementById('b5_cet6').checked = false;
  document.getElementById('b5_mandarin').checked = false;
  document.getElementById('b5_ncre').value = '';
  document.getElementById('b5_professionalCerts').innerHTML = '';
  document.getElementById('b6_avg').value = 70;
  document.getElementById('b6_fails').innerHTML = '';
  document.getElementById('b6_honors').innerHTML = '';
  document.getElementById('b6_customCompetitions').innerHTML = '';
  calcBlock1(); calcBlock2(); calcBlock3(); calcBlock4(); calcBlock5(); calcBlock6();
}

async function editStudent(id) {
  const all = await dbGetAll();
  const s = all.find(function(x){ return x.id === id; });
  if (!s) return;
  switchTab('tabInput', document.querySelector('#mainTabs .nav-link'));
  fillForm(s);
  editingStudentId = id;
  document.getElementById('editingHint').classList.remove('d-none');
  document.getElementById('editingId').textContent = id;
  const formScroller = document.getElementById('scoreFormScroll');
  if (formScroller) formScroller.scrollTop = 0;
  setActiveFormSection('section-basic');
  window.scrollTo(0, 0);
}

async function deleteStudent(id) {
  if (!confirm('确认删除该学生记录？')) return;
  await dbDelete(id);
  showToast('已删除', 'info');
  renderSummary();
}

async function clearAllStudents() {
  if (!(currentUser && currentUser.role === 'admin')) {
    showToast('仅管理员可执行该操作', 'warning');
    return;
  }
  const all = await dbGetAll();
  if (!all.length) {
    showToast('当前没有可清除的数据', 'warning');
    return;
  }
  if (!confirm('将清空所有已保存的学生数据，且无法撤销。是否继续？')) return;
  try {
    await dbClear();
    clearForm();
    const searchEl = document.getElementById('searchInput');
    if (searchEl) searchEl.value = '';
    await renderSummary();
    showToast('已清空全部汇总数据', 'success');
  } catch (e) {
    showToast('清空失败：' + e.message, 'danger');
  }
}

// ===== 汇总表格 =====
async function renderSummary() {
  if (!db) return;
  const all = await dbGetAll();
  const searchEl = document.getElementById('searchInput');
  const search = searchEl ? searchEl.value.trim() : '';
  const filterGroupEl = document.getElementById('filterGroup');
  const filterGroup = filterGroupEl ? filterGroupEl.value : '';

  if (filterGroupEl) {
    const groups = [...new Set(all.map(function(s){ return s.group||''; }).filter(Boolean))].sort();
    const current = filterGroupEl.value;
    filterGroupEl.innerHTML = '<option value="">全部组别</option>' +
      groups.map(function(g){ return '<option value="' + escapeHtml(g) + '"' + (g===current?' selected':'') + '>' + escapeHtml(g) + '</option>'; }).join('');
  }

  const filtered = all.filter(function(s) {
    const matchSearch = !search || (s.name||'').indexOf(search) >= 0 || (s.className||'').indexOf(search) >= 0 || (s.group||'').indexOf(search) >= 0;
    const matchGroup = !filterGroup || (s.group||'') === filterGroup;
    return matchSearch && matchGroup;
  });

  if (_sortState.col >= 0) {
    const colKeys = ['_index','className','name','b1','b2','b3','b4','b5','b6','total'];
    const key = colKeys[_sortState.col];
    filtered.sort(function(a, b) {
      let va, vb;
      if (key === '_index') { va = a.id; vb = b.id; }
      else if (key === 'className' || key === 'name') { va = (a[key]||'').toString(); vb = (b[key]||'').toString(); }
      else { va = ((a.scores||{})[key])||0; vb = ((b.scores||{})[key])||0; }
      if (typeof va === 'string') {
        const cmp = va.localeCompare(vb, 'zh-CN');
        return _sortState.asc ? cmp : -cmp;
      }
      return _sortState.asc ? (va - vb) : (vb - va);
    });
  }

  document.getElementById('summaryCount').textContent = '共 ' + filtered.length + ' 条';
  renderStats(calcStats(filtered));

  const isAdmin = currentUser && currentUser.role === 'admin';
  const head = document.getElementById('summaryHead');
  const body = document.getElementById('summaryBody');

  const sortable = ' style="cursor:pointer;user-select:none;" onclick="sortSummary(';
  head.innerHTML = '<tr>' +
    (isAdmin ? '<th><input type="checkbox" onchange="toggleSelectAll(this)"></th>' : '') +
    '<th' + sortable + '0)">序号' + getSortIcon(0) + '</th>' +
    '<th' + sortable + '1)">班级' + getSortIcon(1) + '</th>' +
    '<th' + sortable + '2)">姓名' + getSortIcon(2) + '</th>' +
    '<th' + sortable + '3)">板块一<br>文体模块' + getSortIcon(3) + '</th>' +
    '<th' + sortable + '4)">板块二<br>社会实践' + getSortIcon(4) + '</th>' +
    '<th' + sortable + '5)">板块三<br>志愿服务' + getSortIcon(5) + '</th>' +
    '<th' + sortable + '6)">板块四<br>社会工作' + getSortIcon(6) + '</th>' +
    '<th' + sortable + '7)">板块五<br>学科竞赛' + getSortIcon(7) + '</th>' +
    '<th' + sortable + '8)">板块六<br>学业成绩' + getSortIcon(8) + '</th>' +
    '<th' + sortable + '9)">总分' + getSortIcon(9) + '</th>' +
    (isAdmin ? '<th>操作</th>' : '') + '</tr>';

  body.innerHTML = filtered.map(function(s, i) {
    const sc = s.scores || {};
    const checked = _selectedIds.has(s.id) ? ' checked' : '';
    const cb = isAdmin ? '<td><input type="checkbox" class="row-select" data-id="' + s.id + '"' + checked + ' onchange="toggleSelectOne(this)"></td>' : '';
    const ops = isAdmin ?
      '<td><button class="btn btn-xs btn-outline-primary btn-sm me-1" onclick="editStudent(' + s.id + ')">编辑</button>' +
      '<button class="btn btn-xs btn-outline-danger btn-sm" onclick="deleteStudent(' + s.id + ')">删除</button></td>' : '';
    return '<tr>' +
      cb +
      '<td>' + (i+1) + '</td>' +
      '<td>' + (s.className||'') + '</td>' +
      '<td><strong>' + (s.name||'') + '</strong></td>' +
      '<td class="text-center">' + (sc.b1||0) + '</td>' +
      '<td class="text-center">' + (sc.b2||0) + '</td>' +
      '<td class="text-center">' + (sc.b3||0) + '</td>' +
      '<td class="text-center">' + (sc.b4||0) + '</td>' +
      '<td class="text-center">' + (sc.b5||0) + '</td>' +
      '<td class="text-center">' + (sc.b6||0) + '</td>' +
      '<td class="text-center"><strong class="text-danger">' + (sc.total||0) + '</strong></td>' +
      ops + '</tr>';
  }).join('');
}

function joinExportParts(parts) {
  return (parts || []).map(function(item) {
    return String(item || '').trim();
  }).filter(Boolean).join('；');
}

function formatLevelAward(level, awardOrRank) {
  return [level, awardOrRank].filter(Boolean).join('/');
}

function getInnovationLabel(value) {
  const labels = { nationalEstablish: '国家级立项', schoolEstablish: '校级立项', nationalCompleteExcellent: '国家级结项优秀', nationalCompletePass: '国家级结项合格', schoolCompleteExcellent: '校级结项优秀', schoolCompletePass: '校级结项合格' };
  return labels[value] || value || '';
}

function getAcademicWorkTypeLabel(value) {
  const labels = { independentAuthor: '独立撰写', firstAuthor: '第一作者', secondAuthor: '第二作者', thirdAuthor: '第三作者', participant: '参与编写者' };
  return labels[value] || value || '';
}

function getAcademicPaperTypeLabel(value) {
  const labels = { general: '一般期刊（CNKI/万方）', pkucore: '北大核心期刊', cssci: 'CSSCI来源期刊', sciHigh: 'SCI IF≥5.0', sciMedium: 'SCI IF≥3.0', sciLow: 'SCI IF≥1.0', sciVeryLow: 'SCI IF＜1.0', ei: 'EI收录期刊（非会议）', istp: 'ISTP' };
  return labels[value] || value || '';
}

function getPatentTypeLabel(value) {
  const labels = { invention: '发明专利', utilityModel: '实用新型专利', design: '外观设计专利', softwareCopyright: '软件著作权' };
  return labels[value] || value || '';
}

function getNcreLabel(value) {
  const labels = { ncre4Excellent: '全国计算机等级考试四级优秀', ncre4Pass: '全国计算机等级考试四级合格', ncre3Excellent: '全国计算机等级考试三级优秀', ncre3Pass: '全国计算机等级考试三级合格', ncre2Excellent: '全国计算机等级考试二级优秀', ncre2Pass: '全国计算机等级考试二级合格' };
  return labels[value] || value || '';
}

function getB6FailTypeLabel(value) {
  const labels = { fail: '挂科', failRetakePass: '挂科且重修通过', failRetakeFail: '挂科且重修不通过', failRetakePending: '挂科且重修未出成绩' };
  return labels[value] || value || '';
}

function appendEnhancementExportParts(parts, block) {
  (block.honors || []).forEach(function(item) {
    if (!item || !item.name) return;
    parts.push('荣誉《' + item.name + '》[' + item.level + ']×' + item.count);
  });
  (block.customCompetitions || []).forEach(function(item) {
    if (!item || !item.name) return;
    parts.push('比赛《' + item.name + '》[' + item.level + ']加分' + item.points);
  });
}

function formatBlock1ExportText(s) {
  const b1 = s.b1 || {};
  const parts = [];
  if (b1.noViolation) parts.push('无违规+10');
  if (b1.club) parts.push('文体/社团活动参与' + b1.club + '季度');
  (b1.competitions || []).forEach(function(item) { if (item && item.name) parts.push(item.name + '[' + formatLevelAward(item.level, item.rank) + ']'); });
  (b1.publications || []).forEach(function(item) { if (item && item.name) parts.push('作品《' + item.name + '》[' + item.type + ']'); });
  appendEnhancementExportParts(parts, b1);
  return joinExportParts(parts) || ((s.details || {}).b1 || '');
}

function formatBlock2PracticeExportText(s) {
  const b2 = s.b2 || {};
  const parts = [];
  if (b2.sanxia) parts.push('三下乡' + b2.sanxia + '次');
  if (b2.fanjia) parts.push('返家乡' + b2.fanjia + '次');
  (b2.practices || []).forEach(function(item) { const text = getPracticeDisplayText(item); if (text) parts.push(text); });
  (b2.competitions || []).forEach(function(item) { if (item && item.name) parts.push(item.name + '[' + formatLevelAward(item.level, item.award) + ']'); });
  appendEnhancementExportParts(parts, b2);
  return joinExportParts(parts) || ((s.details || {}).practiceText || (s.details || {}).b2 || '');
}

function formatBlock3VolunteerExportText(s) {
  const b3 = s.b3 || {};
  const details = s.details || {};
  const parts = [];
  const hoursText = details.volText || ((b3.volHours || 0) + 'h/' + (b3.volHoursRecent || 0) + 'h');
  if (hoursText) parts.push('志愿时长' + hoursText);
  if (b3.commendation) parts.push('校院通报表扬' + b3.commendation + '次');
  if (b3.branchActivity) parts.push('支部活动参与' + b3.branchActivity + '次');
  (b3.volunteerHonors || []).forEach(function(item) { if (item && item.name) parts.push(item.name); });
  (b3.volCompetitions || []).forEach(function(item) { if (item && item.name) parts.push(item.name + '[' + formatLevelAward(item.level, item.award) + ']'); });
  appendEnhancementExportParts(parts, b3);
  if (!parts.length && details.volHonorText) parts.push(details.volHonorText);
  return joinExportParts(parts);
}

function formatBlock4ExportText(s) {
  const b4 = s.b4 || {};
  const parts = [];
  if (b4.cadre) parts.push('担任学生干部职务' + b4.cadre + '个');
  if (b4.cadreExcellent) parts.push('学生干部优秀等级');
  const _exS = parseInt(b4.excellentStudent) || (b4.excellentStudent === true ? 1 : 0);
  const _exC = parseInt(b4.excellentCadre)   || (b4.excellentCadre   === true ? 1 : 0);
  const _exL = parseInt(b4.excellentLeague)  || (b4.excellentLeague  === true ? 1 : 0);
  if (_exS) parts.push('优秀学生' + _exS + '次');
  if (_exC) parts.push('优秀学生干部' + _exC + '次');
  if (_exL) parts.push('优秀共青团员' + _exL + '次');
  if (b4.studyHelpQuarter) parts.push('帮扶学习困难同学' + b4.studyHelpQuarter + '季度');
  if (b4.ethnicHelpQuarter) parts.push('帮助民族班级' + b4.ethnicHelpQuarter + '季度');
  if (b4.branchActivity) parts.push('支部活动参与' + b4.branchActivity + '次');
  if (b4.answerQuestion) parts.push('课堂回答问题' + b4.answerQuestion + '次');
  if (b4.advancedDeed === 'righteous') parts.push('先进事迹：见义勇为、舍己救人');
  if (b4.advancedDeed === 'helpful') parts.push('先进事迹：扶残助弱、拾金不昧');
  if (b4.absenceCount) parts.push('无故缺席活动/会议' + b4.absenceCount + '次');
  (b4.collectiveAwards || []).forEach(function(item) { if (item && item.name) parts.push(item.name + '[' + formatLevelAward(item.level, item.role) + ']'); });
  appendEnhancementExportParts(parts, b4);
  return joinExportParts(parts) || ((s.details || {}).b4 || '');
}

function formatBlock5AcademicExportText(s) {
  const b5 = s.b5 || {};
  const parts = [];
  (b5.competitions || []).forEach(function(item) { if (item && item.name && item.isAcademic) parts.push(item.name + '[' + formatLevelAward(item.level, item.award) + ']'); });
  return joinExportParts(parts) || ((s.details || {}).b5Academic || '');
}

function formatBlock5OtherExportText(s) {
  const b5 = s.b5 || {};
  const parts = [];
  (b5.competitions || []).forEach(function(item) { if (item && item.name && !item.isAcademic) parts.push(item.name + '[' + formatLevelAward(item.level, item.award) + ']'); });
  if (b5.techTeam) parts.push('参加学校学院科技创新团队');
  const innovations = b5.innovations && b5.innovations.length ? b5.innovations
    : (b5.innovationEstablish || b5.innovationComplete ? [{ establish: b5.innovationEstablish || '', complete: b5.innovationComplete || '' }] : []);
  innovations.forEach(function(item) {
    if (item.establish) parts.push('大学生创新创业训练计划立项[' + getInnovationLabel(item.establish) + ']');
    if (item.complete) parts.push('大学生创新创业训练计划结项[' + getInnovationLabel(item.complete) + ']');
  });
  (b5.academicWorks || []).forEach(function(item) { if (item && item.name) parts.push('学术著作《' + item.name + '》[' + getAcademicWorkTypeLabel(item.type) + ']'); });
  (b5.academicPapers || []).forEach(function(item) { if (item && item.name) parts.push('学术论文《' + item.name + '》[' + getAcademicPaperTypeLabel(item.type) + ']'); });
  (b5.patents || []).forEach(function(item) { if (item && item.name) parts.push('专利/著作权《' + item.name + '》[' + getPatentTypeLabel(item.type) + ']'); });
  if (b5.cet4) parts.push('英语四级（≥425分）');
  if (b5.cet6) parts.push('英语六级（≥425分）');
  if (b5.mandarin) parts.push('普通话二级乙等及以上');
  if (b5.ncre) parts.push(getNcreLabel(b5.ncre));
  (b5.professionalCerts || []).forEach(function(item) { if (item && item.name) parts.push('专业资格证书《' + item.name + '》'); });
  return joinExportParts(parts) || ((s.details || {}).b5NonAcademic || '');
}

function formatBlock6ExportText(s) {
  const b6 = s.b6 || {};
  const parts = [];
  if (typeof b6.avg !== 'undefined' && b6.avg !== '') parts.push('平均分' + b6.avg);
  (b6.fails || []).forEach(function(item) { if (item && item.name) parts.push(item.name + '[' + getB6FailTypeLabel(item.type) + ']'); });
  appendEnhancementExportParts(parts, b6);
  return joinExportParts(parts) || ((s.details || {}).b6 || '');
}

function buildExportHeaderRows() {
  const row1 = [
    '序号','班级（单位）','姓名','性别','民族','出生年月日','积极分子期数',
    '曾担任职务情况（包括班委团委学生会及各种社团组织）',
    '板块一、文体模块（素质拓展与全面发展）',
    '板块二、社会实践',
    '板块三、志愿服务',
    '板块四、社会工作与党员义务',
    '板块五、学科/科技竞赛','',
    '板块六、学业成绩',
    '其他信息','','','','','','','',
    '评分结果','','','','','',''
  ];
  const row2 = [
    '','','','','','','','',
    '',
    '',
    '',
    '',
    '学科竞赛','其他竞赛',
    '',
    '志愿汇在校志愿时长（总时长/近一年时长）','考察期内不及格门数（近一年内）','入校以来不及格总数',
    'CET4/CET6/HSK成绩','上一年综合排名（综测）','组别','宿舍号','备注',
    '板块一得分','板块二得分','板块三得分','板块四得分','板块五得分','板块六得分','总分'
  ];
  const merges = [
    { s:{r:0,c:0}, e:{r:1,c:0} },
    { s:{r:0,c:1}, e:{r:1,c:1} },
    { s:{r:0,c:2}, e:{r:1,c:2} },
    { s:{r:0,c:3}, e:{r:1,c:3} },
    { s:{r:0,c:4}, e:{r:1,c:4} },
    { s:{r:0,c:5}, e:{r:1,c:5} },
    { s:{r:0,c:6}, e:{r:1,c:6} },
    { s:{r:0,c:7}, e:{r:1,c:7} },
    { s:{r:0,c:8}, e:{r:1,c:8} },
    { s:{r:0,c:9}, e:{r:1,c:9} },
    { s:{r:0,c:10}, e:{r:1,c:10} },
    { s:{r:0,c:11}, e:{r:1,c:11} },
    { s:{r:0,c:12}, e:{r:0,c:13} },
    { s:{r:0,c:14}, e:{r:1,c:14} },
    { s:{r:0,c:15}, e:{r:0,c:22} },
    { s:{r:0,c:23}, e:{r:0,c:29} }
  ];
  return { row1: row1, row2: row2, merges: merges };
}

function applyExportHeaderStyle(ws, totalCols) {
  ws['!rows'] = ws['!rows'] || [];
  ws['!rows'][0] = { hpx: 27 };
  ws['!rows'][1] = { hpx: 27 };
  const style = { font: { sz: 18, bold: true }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } };
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c < totalCols; c++) {
      const ref = XLSX.utils.encode_cell({ r: r, c: c });
      if (ws[ref]) ws[ref].s = style;
    }
  }
}

const EMBEDDED_EXPORT_TEMPLATE_BASE64 = 'UEsDBAoAAAAAAIdO4kAAAAAAAAAAAAAAAAAJAAAAZG9jUHJvcHMvUEsDBBQAAAAIAIdO4kAe7e9LQgEAAEACAAAQAAAAZG9jUHJvcHMvYXBwLnhtbJ2RwUoDMRCG74LvsOTeZltEpOymCCLixUKr95idbQO7SUjGpfUs0qMP4EEPQm9eCh7Ut7G0j2F2F3QrPXmbmf/nn2+SqD/Ns6AA66RWMem0QxKAEjqRahyTy9Fp64gEDrlKeKYVxGQGjvTZ/l40sNqARQku8BHKxWSCaHqUOjGBnLu2l5VXUm1zjr61Y6rTVAo40eImB4W0G4aHFKYIKoGkZX4CSZ3YK/C/oYkWJZ+7Gs2MB2bRsTGZFBz9lWw4AcDzYUSbw+gMeHn0gEvrWFRgrwCB2gZO3vqzuyS45g7KuJgU3Equ0MeWtrqp6sw4tGz19vL1+bh5XkTU6/WsKpvWZi0PWKcy+GLbWAbUHF7YJhxJzMBdpANucQdwpwlcMdS4Nc76/WP1MF8vnzbLxeb1bjW/34VbPYBf/GcV/f169g1QSwMEFAAAAAgAh07iQGXBdqI1AQAAOwIAABEAAABkb2NQcm9wcy9jb3JlLnhtbA==';

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function loadWorkbookFromUrl(url) {
  try {
    const res = await fetch(url + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('模板加载失败：' + res.status);
    const buf = await res.arrayBuffer();
    return XLSX.read(buf, { type: 'array' });
  } catch (e) {
    return XLSX.read(base64ToUint8Array(EMBEDDED_EXPORT_TEMPLATE_BASE64), { type: 'array' });
  }
}

// ===== 导出Excel =====
async function exportExcel() {
  const all = await dbGetAll();
  if (!all.length) { showToast('暂无数据', 'warning'); return; }

  const header = buildExportHeaderRows();
  const rows = [];
  all.forEach(function(s, i) {
    const sc = s.scores || {};
    const b3 = s.b3 || {};
    const det = s.details || {};
    rows.push([
      i+1,
      s.className||'', s.name||'', s.gender||'', s.nation||'', s.birth||'', s.activist||'',
      det.positionDesc || (s.b4 && s.b4.positionDesc) || '',
      formatBlock1ExportText(s),
      formatBlock2PracticeExportText(s),
      formatBlock3VolunteerExportText(s),
      formatBlock4ExportText(s),
      formatBlock5AcademicExportText(s),
      formatBlock5OtherExportText(s),
      formatBlock6ExportText(s),
      det.volText || ((b3.volHours||0) + 'h/' + (b3.volHoursRecent||0) + 'h'),
      s.failRecent||0, s.failTotal||0,
      s.cet||'', s.rank||'',
      s.group||'', s.dorm||'', s.remark||'',
      sc.b1||0, sc.b2||0, sc.b3||0, sc.b4||0, sc.b5||0, sc.b6||0, sc.total||0
    ]);
  });

  const wb = XLSX.utils.book_new();
  const wsData = [header.row1, header.row2].concat(rows);
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!merges'] = header.merges;
  ws['!cols'] = [
    {wch:6},{wch:14},{wch:8},{wch:5},{wch:6},{wch:12},{wch:10},
    {wch:28},{wch:32},{wch:32},{wch:20},{wch:32},{wch:32},{wch:32},{wch:20},
    {wch:22},{wch:10},{wch:10},{wch:14},{wch:14},{wch:8},{wch:8},{wch:12},
    {wch:8},{wch:8},{wch:8},{wch:8},{wch:8},{wch:8},{wch:8}
  ];
  ws['!rows'] = [{hpx:27},{hpx:27}];
  applyExportHeaderStyle(ws, header.row1.length);
  XLSX.utils.book_append_sheet(wb, ws, '综合素质评分');
  const date = new Date();
  const dateStr = date.getFullYear() + pad(date.getMonth()+1) + pad(date.getDate());
  XLSX.writeFile(wb, '综合素质评分表_' + dateStr + '.xlsx');
  showToast('导出成功', 'success');
}

function pad(n) { return n < 10 ? '0'+n : ''+n; }

function sheetToObjects(ws) {
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!matrix.length) return [];
  const row1 = matrix[0] || [];
  const row2 = matrix[1] || [];
  const isStandardTemplate =
    row1.indexOf('评分结果') >= 0 ||
    row1.indexOf('其他信息') >= 0 ||
    row2.indexOf('板块一得分') >= 0 ||
    row2.indexOf('总分') >= 0;
  if (!isStandardTemplate) {
    return XLSX.utils.sheet_to_json(ws, { defval: '' });
  }
  const maxLen = Math.max(row1.length, row2.length);
  const headers = [];
  for (let i = 0; i < maxLen; i++) {
    headers.push(String(row2[i] || row1[i] || '').trim());
  }
  return matrix.slice(2).filter(function(row) {
    return (row || []).some(function(cell) { return String(cell || '').trim() !== ''; });
  }).map(function(row) {
    const obj = {};
    headers.forEach(function(key, idx) { if (!key) return; obj[key] = row[idx] || ''; });
    return obj;
  });
}

function downloadTemplate() {
  const link = document.createElement('a');
  link.href = 'export-template.xlsx?_=' + Date.now();
  link.download = '综合素质评分导入模板.xlsx';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('模板下载成功', 'success');
}

// ===== 导入 =====
function handleImport(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      if (!window.ScoreImportParser) throw new Error('智能导入模块未加载');
      const wb = XLSX.read(e.target.result, { type: 'array', cellDates: false });
      const academicCompetitions = (RULES.block5 && RULES.block5.academicCompetitions) || [];
      const parsed = window.ScoreImportParser.parseWorkbook(wb, XLSX, {
        academicCompetitions: academicCompetitions
      });
      const existing = await dbGetAll();
      importBuffer = prepareImportRows(parsed, existing);
      if (!importBuffer.length) throw new Error('未找到可导入的人员记录');
      showImportPreview(parsed.sheetName, file.name);
    } catch(err) {
      showToast('文件解析失败：' + err.message, 'danger');
    }
  };
  reader.readAsArrayBuffer(file);
  input.value = '';
}

function getImportIdentity(record) {
  if (!record || !window.ScoreImportParser) return '';
  const normalize = window.ScoreImportParser.normalizeIdentity;
  const name = normalize(record.name);
  const className = normalize(record.className);
  return name ? className + '|' + name : '';
}

function deduplicateRecordScoringItems(record) {
  migrateOldRecord(record);
  const seen = new Set();
  function unique(items, getName) {
    return (Array.isArray(items) ? items : []).filter(function(item) {
      const key = ScoreEnhancements.normalizeScoringName(getName(item));
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const blocks = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
  blocks.forEach(function(block) { record[block] = record[block] || {}; });

  record.b5.competitions = unique(record.b5.competitions, function(item) { return item && item.name; });
  record.b1.competitions = unique(record.b1.competitions, function(item) { return item && item.name; });
  record.b2.competitions = unique(record.b2.competitions, function(item) { return item && item.name; });
  record.b2.practices = unique(record.b2.practices, function(item) { return item && (item.name || item.desc); });
  record.b3.volunteerHonors = unique(record.b3.volunteerHonors, function(item) { return item && item.name; });
  record.b3.volCompetitions = unique(record.b3.volCompetitions, function(item) { return item && item.name; });
  record.b4.collectiveAwards = unique(record.b4.collectiveAwards, function(item) { return item && item.name; });

  ['b1', 'b2', 'b3', 'b4', 'b6'].forEach(function(block) {
    record[block].customCompetitions = unique(record[block].customCompetitions, function(item) { return item && item.name; });
  });
  ['b1', 'b2', 'b3', 'b4', 'b6'].forEach(function(block) {
    record[block].honors = unique(record[block].honors, function(item) { return item && item.name; });
  });
  record.b1.excellent = 0;
  return record;
}

function prepareImportRows(parsed, existing) {
  const existingByIdentity = new Map();
  (existing || []).forEach(function(record) {
    const key = getImportIdentity(record);
    if (key) existingByIdentity.set(key, record);
  });

  return (parsed.rows || []).map(function(item) {
    const record = item.record || parseImportRow(item.raw || {});
    migrateOldRecord(record);
    deduplicateRecordScoringItems(record);
    const warnings = (item.warnings || []).slice();
    const evidence = (item.evidence || []).slice();

    if (!record.name) {
      warnings.push({ field: '姓名', message: '缺少姓名，不能导入该行', evidence: '', severity: 'error' });
    }

    if (item.record) {
      record.scores = calcScoresForRecord(record);
      record.details = buildDetailsForRecord(record);
      const source = record.sourceDetails || {};
      if (source.practice) record.details.practiceText = source.practice;
      if (source.volunteerHonor) record.details.volHonorText = source.volunteerHonor;
      if (source.academicCompetition) record.details.b5Academic = source.academicCompetition;
      if (source.nonAcademicCompetition) record.details.b5NonAcademic = source.nonAcademicCompetition;
      if (source.culture) record.details.b1 = source.culture;
    }

    const identity = getImportIdentity(record);
    const matched = identity ? existingByIdentity.get(identity) : null;
    const invalid = warnings.some(function(warning) { return warning.severity === 'error'; });
    return {
      sourceRow: item.sourceRow,
      record: record,
      warnings: warnings,
      evidence: evidence,
      status: invalid ? 'invalid' : (warnings.length ? 'warning' : 'ready'),
      selected: invalid ? false : item.selected !== false,
      existingId: matched ? matched.id : null,
      matchType: matched ? 'update' : 'new'
    };
  });
}

function parseImportRow(row) {
  function v(key) { return (row[key] || '').toString().trim(); }
  function n(key) { return parseFloat(v(key)) || 0; }
  function bool(key) { return v(key) === '是' || v(key) === 'true' || v(key) === '1'; }
  function firstValue(keys) {
    for (let i = 0; i < keys.length; i++) { const value = v(keys[i]); if (value) return value; }
    return '';
  }

  const isStandardScoreSheet =
    row.__scoreSystemTemplate === 'standard' ||
    !!v('板块一得分') ||
    !!v('总分') ||
    !!v('学科竞赛') ||
    !!v('其他竞赛') ||
    !!v('板块一、文体模块（素质拓展与全面发展）');

  if (isStandardScoreSheet) {
    const avgMatch = firstValue(['板块六、学业成绩', '板块五、学业成绩']).match(/平均分\s*([0-9.]+)/);
    const avgValue = avgMatch ? parseFloat(avgMatch[1]) || 0 : 0;
    return {
      name: v('姓名'),
      className: v('班级（单位）'),
      group: v('组别'),
      dorm: v('宿舍号'),
      gender: v('性别'),
      nation: v('民族'),
      birth: v('出生年月日'),
      activist: v('积极分子期数'),
      failRecent: n('考察期内不及格门数（近一年内）'),
      failTotal: n('入校以来不及格总数'),
      cet: v('CET4/CET6/HSK成绩'),
      rank: v('上一年综合排名（综测）') || v('综合排名'),
      remark: v('备注'),
      b1: { club: 0, competitions: [], publications: [], honors: [], customCompetitions: [] },
      b2: { sanxia: 0, fanjia: 0, practices: [], competitions: [], honors: [], customCompetitions: [] },
      b3: { volHours: 0, volHoursRecent: 0, commendation: 0, branchActivity: 0, volunteerHonors: [], volCompetitions: [], honors: [], customCompetitions: [] },
      b4: { cadre: 0, positionDesc: v('曾担任职务情况（包括班委团委学生会及各种社团组织）'), honors: [], customCompetitions: [] },
      b5: { competitions: [], academicWorks: [], academicPapers: [], patents: [], professionalCerts: [] },
      b6: { avg: avgValue, fails: [], honors: [], customCompetitions: [] },
      scores: {
        b1: n('板块一得分'),
        b2: n('板块二得分'),
        b3: n('板块三得分'),
        b4: n('板块四得分'),
        b5: n('板块五得分'),
        b6: n('板块六得分'),
        total: n('总分'),
        zeroed: false
      },
      details: {
        b1: v('板块一、文体模块（素质拓展与全面发展）'),
        b2: firstValue(['板块二、社会实践', '社会实践及获奖情况']),
        b3: firstValue(['板块三、志愿服务', '志愿活动及获奖情况']),
        b4: firstValue(['板块四、社会工作与党员义务', '板块三、社会工作与党员义务']),
        b5Academic: firstValue(['学科竞赛', '学科竞赛及获奖情况']),
        b5NonAcademic: firstValue(['其他竞赛', '非学科竞赛及获奖情况']),
        b6: firstValue(['板块六、学业成绩', '板块五、学业成绩']),
        volText: v('志愿汇在校志愿时长（总时长/近一年时长）'),
        practiceText: firstValue(['社会实践及获奖情况', '参加社会实践及获奖情况']),
        volHonorText: firstValue(['志愿活动及获奖情况', '参加志愿活动及获奖情况']),
        positionDesc: v('曾担任职务情况（包括班委团委学生会及各种社团组织）')
      }
    };
  }

  const b1Comps = [];
  for (let i = 1; i <= 5; i++) {
    const name = firstValue(['文体获奖' + i + '名称', '文体竞赛' + i + '名称']);
    const level = firstValue(['文体获奖' + i + '级别', '文体竞赛' + i + '级别']) || '院级';
    const rank = firstValue(['文体获奖' + i + '名次', '文体竞赛' + i + '名次']) || '第一名';
    if (name) b1Comps.push({ name: name, level: level, rank: rank });
  }
  const b5Comps = [];
  for (let i = 1; i <= 10; i++) {
    const name = v('竞赛' + i + '名称');
    const level = v('竞赛' + i + '级别') || '院级';
    const award = v('竞赛' + i + '奖项') || '一等奖';
    if (name) b5Comps.push({ name: name, selectedName: '', isManual: true, level: level, award: award, isAcademic: false });
  }
  const practices = [];
  const practiceName = v('社会实践项目1名称');
  if (practiceName) {
    practices.push({ name: practiceName, level: v('社会实践项目1级别') || '院级', award: v('社会实践项目1奖项') || '优秀' });
  } else {
    const practiceDesc = v('社会实践描述');
    if (practiceDesc) practices.push({ desc: practiceDesc });
  }

  const s = {
    name: v('姓名'), className: v('班级（单位）'), group: v('组别'), dorm: v('宿舍号'),
    gender: v('性别'), nation: v('民族'), birth: v('出生年月日'), activist: v('积极分子期数'),
    failRecent: n('考察期不及格门数'), failTotal: n('入校以来不及格总数'),
    cet: v('CET成绩'), rank: v('综合排名'), remark: v('备注'),
    b1: { club: n('文体活动参与季度数') || n('社团参与季度数'), competitions: b1Comps, honors: [], customCompetitions: [] },
    b2: { sanxia: n('三下乡次数'), fanjia: n('返家乡次数'), practices: practices, competitions: [], honors: [], customCompetitions: [] },
    b3: {
      volHours: n('志愿总时长(小时)'), volHoursRecent: n('近一年志愿时长(小时)'),
      commendation: 0, branchActivity: 0, volunteerHonors: [], volCompetitions: [], honors: [], customCompetitions: []
    },
    b4: {
      cadre: n('干部职务数量'),
      excellentStudent: bool('优秀学生(是/否)'),
      excellentCadre: bool('优秀学生干部(是/否)'),
      excellentLeague: bool('优秀共青团员(是/否)'),
      positionDesc: v('职务描述'),
      honors: [], customCompetitions: []
    },
    b5: { competitions: b5Comps },
    b6: { avg: n('平均分') || 70, fails: [], honors: [], customCompetitions: [] }
  };

  s.scores = calcScoresForRecord(s);
  s.details = buildDetailsForRecord(s);
  return s;
}

function calcScoresForRecord(s) {
  migrateOldRecord(s);
  const r1 = scoreBlock1(s.b1 || {}, RULES);
  const r2 = scoreBlock2(s.b2 || {}, RULES);
  const r3 = scoreBlock3(s.b3 || {}, RULES);
  const r4 = scoreBlock4(s.b4 || {}, RULES);
  const r5 = scoreBlock5(s.b5 || {}, RULES);
  const r6 = scoreBlock6(s.b6 || {}, RULES);
  const total = Math.round(r1.score + r2.score + r3.score + r4.score + r5.score + r6.score);
  return { b1: r1.score, b2: r2.score, b3: r3.score, b4: r4.score, b5: r5.score, b6: r6.score, total: total, zeroed: false };
}

function buildDetailsForRecord(s) {
  migrateOldRecord(s);
  const b2 = s.b2 || {};
  const b3 = s.b3 || {};
  const b4 = s.b4 || {};
  const b5r = RULES.block5 || {};
  const matrix = b5r.scoreMatrix || {};
  const aw = b5r.academicWeight || 0.6;
  const naw = b5r.nonAcademicWeight || 0.4;
  const acDets = [], nonAcDets = [];
  ((s.b5 || {}).competitions||[]).forEach(function(c) {
    const pts = (matrix[c.level] && matrix[c.level][c.award]) || 0;
    const str = c.isAcademic
      ? (c.name||'竞赛') + '[' + c.level + c.award + ']原始+' + pts + '，折算+' + (pts * aw)
      : (c.name||'竞赛') + '[' + c.level + c.award + ']原始+' + pts + '，折算+' + (pts * naw);
    if (c.isAcademic) acDets.push(str); else nonAcDets.push(str);
  });
  const practiceItems = b2.practices || [];
  const practiceDets = practiceItems.map(getPracticeDisplayText).filter(Boolean);
  const legacyPracticeDets = practiceItems.filter(function(item) { return !!item.desc; }).map(getPracticeDisplayText).filter(Boolean);
  const autoVolunteerBonuses = detectVolunteerBonuses(legacyPracticeDets, {}).concat(calculateStructuredPracticeBonuses(practiceItems, {}));
  return {
    b1: '社团' + ((s.b1 || {}).club||0) + '季度',
    b2: practiceDets.join('；'),
    b3: '志愿时长' + (b3.volHours||0) + 'h/' + (b3.volHoursRecent||0) + 'h',
    b4: b4.positionDesc || '',
    b5Academic: acDets.join('；'),
    b5NonAcademic: nonAcDets.join('；'),
    b6: '平均分' + ((s.b6 || {}).avg||0),
    volText: '总' + (b3.volHours||0) + 'h/近一年' + (b3.volHoursRecent||0) + 'h',
    practiceText: practiceDets.concat(
      autoVolunteerBonuses
        .filter(function(item) { return item.type === 'practice'; })
        .map(function(item) { return item.label + '+' + item.pts + '(自动识别)'; })
    ).join('；'),
    volHonorText: (b3.volunteerHonors || []).map(function(item) { return item && item.name; }).filter(Boolean).join('；'),
    positionDesc: b4.positionDesc || ''
  };
}

function showImportPreview(sheetName, fileName) {
  const modal = new bootstrap.Modal(document.getElementById('importModal'));
  document.getElementById('importSourceInfo').textContent =
    (fileName ? fileName + ' · ' : '') + '数据表：' + (sheetName || '未知');
  const table = '<div class="table-responsive"><table class="table table-sm table-bordered align-middle import-preview-table">' +
    '<thead><tr><th class="text-center">导入</th><th>源行</th><th>姓名</th><th>班级</th>' +
    '<th>板块一</th><th>板块二</th><th>板块三</th><th>板块四</th><th>板块五</th><th>板块六</th><th>总分</th><th>状态与依据</th></tr></thead><tbody>' +
    importBuffer.map(function(item, index) {
      const record = item.record || {};
      const scores = record.scores || {};
      const rowClass = item.status === 'invalid' ? 'table-danger' : (item.status === 'warning' ? 'table-warning' : '');
      const statusLabel = item.status === 'invalid' ? '不可导入' : (item.matchType === 'update' ? '将更新' : '新增');
      const statusClass = item.status === 'invalid' ? 'bg-danger' : (item.matchType === 'update' ? 'bg-info text-dark' : 'bg-success');
      const warningItems = (item.warnings || []).map(function(warning) {
        const evidence = warning.evidence ? '：' + warning.evidence : '';
        return '<li><strong>' + escapeHtml(warning.field || '识别') + '</strong> ' +
          escapeHtml(warning.message || '') + escapeHtml(evidence) + '</li>';
      }).join('');
      const evidenceItems = (item.evidence || []).map(function(text) {
        return '<li>' + escapeHtml(text) + '</li>';
      }).join('');
      const detail = warningItems || evidenceItems
        ? '<details><summary>' + ((item.warnings || []).length ? '查看警告与识别依据' : '查看识别依据') +
          '</summary><ul class="mb-0 ps-3">' + warningItems + evidenceItems + '</ul></details>'
        : '<span class="text-muted">已按明确字段识别</span>';
      return '<tr class="' + rowClass + '">' +
        '<td class="text-center"><input class="form-check-input import-row-check" type="checkbox" ' +
          (item.selected ? 'checked ' : '') + (item.status === 'invalid' ? 'disabled ' : '') +
          'aria-label="选择第' + escapeHtml(String(item.sourceRow || '')) + '行" onchange="setImportSelection(' + index + ', this.checked)"></td>' +
        '<td>' + escapeHtml(String(item.sourceRow || '')) + '</td>' +
        '<td>' + escapeHtml(record.name || '') + '</td>' +
        '<td>' + escapeHtml(record.className || '') + '</td>' +
        '<td>' + escapeHtml(String(scores.b1 || 0)) + '</td>' +
        '<td>' + escapeHtml(String(scores.b2 || 0)) + '</td>' +
        '<td>' + escapeHtml(String(scores.b3 || 0)) + '</td>' +
        '<td>' + escapeHtml(String(scores.b4 || 0)) + '</td>' +
        '<td>' + escapeHtml(String(scores.b5 || 0)) + '</td>' +
        '<td>' + escapeHtml(String(scores.b6 || 0)) + '</td>' +
        '<td><strong>' + escapeHtml(String(scores.total || 0)) + '</strong></td>' +
        '<td><span class="badge ' + statusClass + ' me-1">' + statusLabel + '</span>' + detail + '</td>' +
        '</tr>';
    }).join('') + '</tbody></table></div>';
  document.getElementById('importPreview').innerHTML = table;
  updateImportSelectionCount();
  modal.show();
}

function setImportSelection(index, checked) {
  if (!importBuffer[index] || importBuffer[index].status === 'invalid') return;
  importBuffer[index].selected = !!checked;
  updateImportSelectionCount();
}

function updateImportSelectionCount() {
  const selected = importBuffer.filter(function(item) { return item.selected && item.status !== 'invalid'; }).length;
  const warningCount = importBuffer.filter(function(item) { return item.status === 'warning'; }).length;
  const updateCount = importBuffer.filter(function(item) { return item.selected && item.matchType === 'update'; }).length;
  const invalidCount = importBuffer.filter(function(item) { return item.status === 'invalid'; }).length;
  document.getElementById('importCount').textContent =
    '共' + importBuffer.length + '行，已选' + selected + '条，警告' + warningCount + '条，将更新' + updateCount + '条，不可导入' + invalidCount + '条';
  const button = document.getElementById('btnConfirmImport');
  if (button) button.disabled = selected === 0;
}

async function confirmImport() {
  const mode = document.querySelector('input[name="importMode"]:checked').value;
  const selectedItems = importBuffer.filter(function(item) { return item.selected && item.status !== 'invalid'; });
  if (!selectedItems.length) {
    showToast('请至少选择一条可导入记录', 'warning');
    return;
  }
  if (mode === 'overwrite') {
    if (!confirm('覆盖导入将清空所有现有数据，确认继续？')) return;
    await dbClear();
  }
  for (const item of selectedItems) {
    const record = Object.assign({}, item.record);
    if (mode === 'append' && item.existingId) record.id = item.existingId;
    else delete record.id;
    await dbPut(record);
  }
  bootstrap.Modal.getInstance(document.getElementById('importModal')).hide();
  showToast('导入成功，共 ' + selectedItems.length + ' 条', 'success');
  importBuffer = [];
  renderSummary();
}

// ===== 数据备份/恢复 =====
async function exportJSON() {
  if (!(currentUser && currentUser.role === 'admin')) {
    showToast('仅管理员可执行该操作', 'warning');
    return;
  }
  const all = await dbGetAll();
  if (!all.length) { showToast('暂无数据可备份', 'warning'); return; }
  const backup = {
    version: 2,
    exportTime: new Date().toISOString(),
    count: all.length,
    data: all
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const date = new Date();
  const dateStr = date.getFullYear() + pad(date.getMonth()+1) + pad(date.getDate()) + pad(date.getHours()) + pad(date.getMinutes());
  link.download = '综合素质评分备份_' + dateStr + '.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast('备份成功，共 ' + all.length + ' 条记录', 'success');
}

function handleRestore(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const backup = JSON.parse(e.target.result);
      if (!backup.data || !Array.isArray(backup.data)) {
        showToast('无效的备份文件', 'danger');
        return;
      }
      restoreBuffer = backup.data;
      document.getElementById('restorePreview').innerHTML =
        '<div class="alert alert-info py-2 mb-2">' +
        '备份时间：' + (backup.exportTime || '未知') + '<br>' +
        '记录数量：' + backup.data.length + ' 条' +
        '</div>';
      new bootstrap.Modal(document.getElementById('restoreModal')).show();
    } catch(err) {
      showToast('文件解析失败：' + err.message, 'danger');
    }
  };
  reader.readAsText(file);
  input.value = '';
}

async function confirmRestore() {
  if (!restoreBuffer.length) { showToast('无数据可恢复', 'warning'); return; }
  const mode = document.querySelector('input[name="restoreMode"]:checked').value;
  if (mode === 'overwrite') {
    if (!confirm('覆盖恢复将清空所有现有数据，确认继续？')) return;
    await dbClear();
  }
  for (const s of restoreBuffer) {
    const record = Object.assign({}, s);
    migrateOldRecord(record);
    delete record.id;
    await dbPut(record);
  }
  bootstrap.Modal.getInstance(document.getElementById('restoreModal')).hide();
  showToast('恢复成功，共 ' + restoreBuffer.length + ' 条', 'success');
  restoreBuffer = [];
  renderSummary();
}

// ===== 汇总统计 =====
function calcStats(all) {
  if (!all.length) return null;
  const stats = { count: all.length, b1: [], b2: [], b3: [], b4: [], b5: [], b6: [], total: [] };
  all.forEach(function(s) {
    const sc = s.scores || {};
    stats.b1.push(sc.b1 || 0);
    stats.b2.push(sc.b2 || 0);
    stats.b3.push(sc.b3 || 0);
    stats.b4.push(sc.b4 || 0);
    stats.b5.push(sc.b5 || 0);
    stats.b6.push(sc.b6 || 0);
    stats.total.push(sc.total || 0);
  });
  function avg(arr) { return arr.length ? Math.round(arr.reduce(function(a,b){return a+b;},0) / arr.length * 10) / 10 : 0; }
  function min(arr) { return arr.length ? Math.min.apply(null, arr) : 0; }
  function max(arr) { return arr.length ? Math.max.apply(null, arr) : 0; }
  return {
    count: stats.count,
    b1: { avg: avg(stats.b1), min: min(stats.b1), max: max(stats.b1) },
    b2: { avg: avg(stats.b2), min: min(stats.b2), max: max(stats.b2) },
    b3: { avg: avg(stats.b3), min: min(stats.b3), max: max(stats.b3) },
    b4: { avg: avg(stats.b4), min: min(stats.b4), max: max(stats.b4) },
    b5: { avg: avg(stats.b5), min: min(stats.b5), max: max(stats.b5) },
    b6: { avg: avg(stats.b6), min: min(stats.b6), max: max(stats.b6) },
    total: { avg: avg(stats.total), min: min(stats.total), max: max(stats.total) }
  };
}

function renderStats(stats) {
  const panel = document.getElementById('statsPanel');
  const row = document.getElementById('statsRow');
  if (!stats) { panel.classList.add('d-none'); return; }
  panel.classList.remove('d-none');
  const items = [
    { label: '总人数', value: stats.count, color: 'primary' },
    { label: '总分均值', value: stats.total.avg, color: 'success' },
    { label: '总分最高', value: stats.total.max, color: 'danger' },
    { label: '总分最低', value: stats.total.min, color: 'warning' }
  ];
  row.innerHTML = items.map(function(item) {
    return '<div class="col-md-3 col-6">' +
      '<div class="card border-' + item.color + '">' +
      '<div class="card-body text-center py-2">' +
      '<div class="small text-muted">' + item.label + '</div>' +
      '<div class="fw-bold text-' + item.color + ' fs-5">' + item.value + '</div>' +
      '</div></div></div>';
  }).join('');
}

// ===== 表格排序 =====
function sortSummary(col) {
  if (_sortState.col === col) {
    _sortState.asc = !_sortState.asc;
  } else {
    _sortState.col = col;
    _sortState.asc = true;
  }
  renderSummary();
}

function getSortIcon(col) {
  if (_sortState.col !== col) return ' ↕';
  return _sortState.asc ? ' ↑' : ' ↓';
}

// ===== 批量删除 =====
function toggleSelectAll(cb) {
  const checkboxes = document.querySelectorAll('.row-select');
  checkboxes.forEach(function(checkbox) {
    const id = parseInt(checkbox.dataset.id);
    checkbox.checked = cb.checked;
    if (cb.checked) _selectedIds.add(id);
    else _selectedIds.delete(id);
  });
  updateBatchDeleteBtn();
}

function toggleSelectOne(cb) {
  const id = parseInt(cb.dataset.id);
  if (cb.checked) _selectedIds.add(id);
  else _selectedIds.delete(id);
  updateBatchDeleteBtn();
}

function updateBatchDeleteBtn() {
  const btn = document.getElementById('btnBatchDelete');
  if (_selectedIds.size > 0) {
    btn.textContent = '🗑️ 批量删除(' + _selectedIds.size + ')';
    btn.classList.remove('d-none');
  } else {
    btn.classList.add('d-none');
  }
}

async function batchDelete() {
  if (!(currentUser && currentUser.role === 'admin')) {
    showToast('仅管理员可执行该操作', 'warning');
    return;
  }
  if (!_selectedIds.size) { showToast('未选择任何记录', 'warning'); return; }
  if (!confirm('确认删除选中的 ' + _selectedIds.size + ' 条记录？')) return;
  for (const id of _selectedIds) {
    await dbDelete(id);
  }
  showToast('已删除 ' + _selectedIds.size + ' 条记录', 'success');
  _selectedIds.clear();
  renderSummary();
}

// ===== 未保存提示 =====
function markFormDirty() {
  _formDirty = true;
}

function markFormClean() {
  _formDirty = false;
}

// ===== 启动 =====
window.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', function(e) {
  if (_formDirty) {
    e.preventDefault();
    e.returnValue = '您有未保存的修改，确定要离开吗？';
    return e.returnValue;
  }
});
