// ── QA TEST CASES — MAIN APP ──
// Features: overview list view, per-case status, localStorage persistence

// ─────────────────────────────────────────
// FEATURE REGISTRY
// ─────────────────────────────────────────
const FEATURES = [
  { meta: XRAY_META, cases: XRAY_CASES },
  { meta: AUTH_META, cases: AUTH_CASES },
  // 👉 { meta: MY_META, cases: MY_CASES },
];

// ─────────────────────────────────────────
// STATUS CONFIG
// ─────────────────────────────────────────
const STATUSES = [
  { key: 'no-run',    label: 'No Run',    icon: '○', cssClass: 'ss-norun',     filterClass: 'active-st-norun' },
  { key: 'executing', label: 'Executing', icon: '⟳', cssClass: 'ss-executing', filterClass: 'active-st-executing' },
  { key: 'passed',    label: 'Passed',    icon: '✓', cssClass: 'ss-passed',    filterClass: 'active-st-passed' },
  { key: 'failed',    label: 'Failed',    icon: '✗', cssClass: 'ss-failed',    filterClass: 'active-st-failed' },
  { key: 'blocked',   label: 'Blocked',   icon: '⊘', cssClass: 'ss-blocked',   filterClass: 'active-st-blocked' },
  { key: 'cancelled', label: 'Cancelled', icon: '↩', cssClass: 'ss-cancelled', filterClass: 'active-st-cancelled' },
];

// Progress bar segment colors (CSS var names mapped)
const STATUS_COLORS = {
  'no-run':    '#D5D3CE',
  'executing': '#B5D0F0',
  'passed':    '#A8D49D',
  'failed':    '#F5AAAA',
  'blocked':   '#F5D68A',
  'cancelled': '#C5BCEF',
};

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
let currentFeatureId = 'overview';
let activeType       = 'all';
let activeScreen     = 'all';
let activeStatusFilt = 'all';

// ─────────────────────────────────────────
// LOCALSTORAGE STATUS
// ─────────────────────────────────────────
const LS_KEY = 'qa_tc_status_v1';

function loadStatuses() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function saveStatuses(map) {
  localStorage.setItem(LS_KEY, JSON.stringify(map));
}
function getStatus(caseId) {
  return loadStatuses()[caseId] || 'no-run';
}
function setStatus(caseId, status) {
  const map = loadStatuses();
  map[caseId] = status;
  saveStatuses(map);
}

// ─────────────────────────────────────────
// SCREEN PALETTE
// ─────────────────────────────────────────
const SCREEN_PALETTE = [
  { bg:'#F0EFFE', color:'#4A3AB0', border:'#C5BCEF' },
  { bg:'#EAF2FB', color:'#185FA5', border:'#B5D0F0' },
  { bg:'#FFF4EC', color:'#D95F02', border:'#F5C49A' },
  { bg:'#EBF5E8', color:'#276B1F', border:'#A8D49D' },
  { bg:'#FFF8E6', color:'#8A5200', border:'#F5D68A' },
  { bg:'#E6F5F5', color:'#0F6B6B', border:'#8DD4D4' },
];
function getScreenStyle(idx) { return SCREEN_PALETTE[idx % SCREEN_PALETTE.length]; }

// ─────────────────────────────────────────
// STATUS COUNTS HELPER
// ─────────────────────────────────────────
function getStatusCounts(cases) {
  const counts = {};
  STATUSES.forEach(s => counts[s.key] = 0);
  cases.forEach(c => {
    const st = getStatus(c.id);
    counts[st] = (counts[st] || 0) + 1;
  });
  return counts;
}

function buildProgressBar(counts, total, trackClass, segClass) {
  return STATUSES.map(s => {
    const pct = total ? (counts[s.key] / total * 100).toFixed(1) : 0;
    if (!counts[s.key]) return '';
    return `<div class="${segClass}" style="width:${pct}%;background:${STATUS_COLORS[s.key]};"></div>`;
  }).join('');
}

// ─────────────────────────────────────────
// STATUS SELECT HTML
// ─────────────────────────────────────────
function statusSelectHtml(caseId, featureId) {
  const cur = getStatus(caseId);
  const curDef = STATUSES.find(s => s.key === cur) || STATUSES[0];
  const options = STATUSES.map(s =>
    `<option value="${s.key}" ${s.key === cur ? 'selected' : ''}>${s.icon} ${s.label}</option>`
  ).join('');
  return `<select
    class="status-select ${curDef.cssClass}"
    onclick="event.stopPropagation()"
    onchange="onStatusChange('${caseId}','${featureId}',this)"
  >${options}</select>`;
}

function onStatusChange(caseId, featureId, selectEl) {
  const newStatus = selectEl.value;
  setStatus(caseId, newStatus);
  // update select styling
  STATUSES.forEach(s => selectEl.classList.remove(s.cssClass));
  const def = STATUSES.find(s => s.key === newStatus);
  selectEl.classList.add(def.cssClass);
  // update header + overview stats
  updateHeaderStrip();
  // if we're in overview update the feature's progress bar
  if (currentFeatureId === 'overview') {
    const feature = FEATURES.find(f => f.meta.id === featureId);
    if (feature) refreshFeatureRowStats(featureId, feature.cases);
  } else {
    refreshStatusStatsBar(featureId);
  }
}

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────
function init() {
  injectScreenStyles();
  buildNavTabs();
  renderOverview();
  updateHeaderStrip();
}

function injectScreenStyles() {
  const style = document.createElement('style');
  FEATURES.forEach(f => {
    Object.entries(f.meta.screens).forEach(([key, sc], idx) => {
      const p = getScreenStyle(idx);
      style.textContent += `.${sc.cssClass}{background:${p.bg};color:${p.color};border:1px solid ${p.border};}`;
    });
  });
  document.head.appendChild(style);
}

// ─────────────────────────────────────────
// HEADER STRIP (global status summary)
// ─────────────────────────────────────────
function updateHeaderStrip() {
  const allCases = FEATURES.flatMap(f => f.cases);
  const counts = getStatusCounts(allCases);
  const total  = allCases.length;

  const colors = {
    'no-run': { bg: 'var(--st-norun-bg)', color: 'var(--st-norun)', dot: STATUS_COLORS['no-run'] },
    'executing': { bg: 'var(--st-executing-bg)', color: 'var(--st-executing)', dot: STATUS_COLORS['executing'] },
    'passed': { bg: 'var(--st-passed-bg)', color: 'var(--st-passed)', dot: STATUS_COLORS['passed'] },
    'failed': { bg: 'var(--st-failed-bg)', color: 'var(--st-failed)', dot: STATUS_COLORS['failed'] },
    'blocked': { bg: 'var(--st-blocked-bg)', color: 'var(--st-blocked)', dot: STATUS_COLORS['blocked'] },
    'cancelled': { bg: 'var(--st-cancelled-bg)', color: 'var(--st-cancelled)', dot: STATUS_COLORS['cancelled'] },
  };

  const el = document.getElementById('hdr-status-strip');
  if (!el) return;
  el.innerHTML = STATUSES
    .filter(s => counts[s.key] > 0)
    .map(s => {
      const c = colors[s.key];
      return `<span class="hdr-stat" style="background:${c.bg};color:${c.color};border-color:${STATUS_COLORS[s.key]};">
        <span class="dot" style="background:${c.dot};"></span>
        ${s.label} <strong>${counts[s.key]}</strong>
      </span>`;
    }).join('') +
    `<span style="font-size:11px;color:var(--text3);margin-left:2px;">${total} total</span>`;
}

// ─────────────────────────────────────────
// NAV TABS
// ─────────────────────────────────────────
function buildNavTabs() {
  const wrap = document.getElementById('nav-tabs');
  const totalAll = FEATURES.reduce((s, f) => s + f.cases.length, 0);
  wrap.innerHTML = `
    <button class="nav-tab active" id="tab-overview" onclick="switchTab('overview')">
      📋 Overview <span class="tab-count">${totalAll}</span>
    </button>
    ${FEATURES.map(f => `
      <button class="nav-tab" id="tab-${f.meta.id}" onclick="switchTab('${f.meta.id}')">
        ${f.meta.emoji} ${f.meta.name} <span class="tab-count">${f.cases.length}</span>
      </button>
    `).join('')}
  `;
}

function switchTab(id) {
  currentFeatureId = id;
  activeType   = 'all';
  activeScreen = 'all';
  activeStatusFilt = 'all';
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab-${id}`)?.classList.add('active');
  if (id === 'overview') renderOverview();
  else {
    const feature = FEATURES.find(f => f.meta.id === id);
    if (feature) renderFeature(feature);
  }
}

// ─────────────────────────────────────────
// OVERVIEW PAGE
// ─────────────────────────────────────────
function renderOverview() {
  const allCases  = FEATURES.flatMap(f => f.cases);
  const total     = allCases.length;
  const allCounts = getStatusCounts(allCases);

  const main = document.getElementById('main-content');
  main.innerHTML = `
    <!-- Global summary bar -->
    <div class="ov-summary-bar">
      <div class="ov-summary-item">
        <span class="ov-summary-num" style="color:var(--blue);">${total}</span>
        <span class="ov-summary-lbl">Total cases</span>
      </div>
      <div class="ov-divider"></div>
      <div class="ov-summary-item">
        <span class="ov-summary-num" style="color:var(--text2);">${FEATURES.length}</span>
        <span class="ov-summary-lbl">Features</span>
      </div>
      <div class="ov-divider"></div>
      ${STATUSES.map(s => `
        <div class="ov-summary-item">
          <span class="ov-summary-num" style="color:${s.key === 'passed' ? 'var(--green)' : s.key === 'failed' ? 'var(--red)' : s.key === 'executing' ? 'var(--blue)' : s.key === 'blocked' ? 'var(--amber)' : s.key === 'cancelled' ? 'var(--purple)' : 'var(--text3)'};">${allCounts[s.key]}</span>
          <span class="ov-summary-lbl">${s.label}</span>
        </div>
      `).join('')}
      <div class="ov-divider"></div>
      <div class="ov-progress-wrap">
        <div class="ov-progress-label">Overall progress</div>
        <div class="ov-progress-bar" id="ov-global-progress">
          ${buildProgressBar(allCounts, total, 'ov-progress-bar', 'ov-pb-seg')}
        </div>
      </div>
    </div>

    <!-- Feature list -->
    <div class="section-sep">
      <span>Features</span>
      <span class="count-pill">${FEATURES.length} features · ${total} cases</span>
    </div>

    <div class="ov-list" id="ov-list">
      ${FEATURES.map(f => buildFeatureRow(f)).join('')}
    </div>
  `;
}

function buildFeatureRow(f) {
  const counts = getStatusCounts(f.cases);
  const total  = f.cases.length;
  const tags   = f.meta.tags.map(t => `<span class="badge ${t.style}">${t.label}</span>`).join('');
  const progressSegs = buildProgressBar(counts, total, 'ov-progress-track', 'ov-pt-seg');

  const miniStats = STATUSES
    .filter(s => counts[s.key] > 0)
    .map(s => {
      const style = `background:${STATUS_COLORS[s.key]}22;color:var(--st-${s.key});border-color:${STATUS_COLORS[s.key]};`;
      return `<span class="ov-mini-stat" style="${style}">${s.icon} ${s.label} ${counts[s.key]}</span>`;
    }).join('');

  return `
    <div class="ov-feature-row" onclick="switchTab('${f.meta.id}')">
      <div class="ov-feature-icon" style="background:${f.meta.colorBg};border-color:${f.meta.colorBorder};">${f.meta.emoji}</div>
      <div class="ov-feature-info">
        <div class="ov-feature-name">${f.meta.name}</div>
        <div class="ov-feature-desc">${f.meta.description}</div>
        <div class="ov-feature-tags">${tags}</div>
      </div>
      <div class="ov-feature-stats" id="ov-row-stats-${f.meta.id}">
        <div class="ov-stat-row">${miniStats || '<span style="font-size:11px;color:var(--text3);">No Run</span>'}</div>
        <div class="ov-progress-track" style="width:180px;">${progressSegs}</div>
        <div style="font-size:11px;color:var(--text3);">${total} cases</div>
      </div>
    </div>
  `;
}

function refreshFeatureRowStats(featureId, cases) {
  const el = document.getElementById(`ov-row-stats-${featureId}`);
  if (!el) return;
  const counts = getStatusCounts(cases);
  const total  = cases.length;
  const progressSegs = buildProgressBar(counts, total, 'ov-progress-track', 'ov-pt-seg');
  const miniStats = STATUSES
    .filter(s => counts[s.key] > 0)
    .map(s => {
      const style = `background:${STATUS_COLORS[s.key]}22;color:var(--st-${s.key});border-color:${STATUS_COLORS[s.key]};`;
      return `<span class="ov-mini-stat" style="${style}">${s.icon} ${s.label} ${counts[s.key]}</span>`;
    }).join('');
  el.innerHTML = `
    <div class="ov-stat-row">${miniStats || '<span style="font-size:11px;color:var(--text3);">No Run</span>'}</div>
    <div class="ov-progress-track" style="width:180px;">${progressSegs}</div>
    <div style="font-size:11px;color:var(--text3);">${total} cases</div>
  `;
  // also refresh global progress
  const allCases  = FEATURES.flatMap(f => f.cases);
  const allCounts = getStatusCounts(allCases);
  const gp = document.getElementById('ov-global-progress');
  if (gp) gp.innerHTML = buildProgressBar(allCounts, allCases.length, 'ov-progress-bar', 'ov-pb-seg');
}

// ─────────────────────────────────────────
// FEATURE VIEW
// ─────────────────────────────────────────
function renderFeature(feature) {
  const { meta, cases } = feature;
  const tags = meta.tags.map(t => `<span class="badge ${t.style}">${t.label}</span>`).join('');
  const screenFilterBtns = Object.entries(meta.screens).map(([key, sc], idx) => {
    const colorMap = ['active-purple','active-blue','active-orange','active-green','active-amber','active-teal'];
    const cls = colorMap[idx % colorMap.length];
    return `<button class="filter-btn" data-screen="${key}" onclick="setScreenFilter('${key}',this,'${cls}')">${sc.label} – ${sc.name}</button>`;
  }).join('');

  const main = document.getElementById('main-content');
  main.innerHTML = `
    <!-- Feature Header -->
    <div class="feature-header">
      <div style="font-size:24px;">${meta.emoji}</div>
      <div class="feature-info">
        <div class="feature-name">${meta.name}</div>
        <div class="feature-desc">${meta.description}</div>
        <div class="feature-tags">${tags}</div>
      </div>
    </div>

    <!-- Type stats -->
    <div class="stats-grid">
      <div class="stat-card"><div class="num num-blue" id="s-total">—</div><div class="lbl">Total</div></div>
      <div class="stat-card"><div class="num num-green" id="s-pos">—</div><div class="lbl">Positive</div></div>
      <div class="stat-card"><div class="num num-amber" id="s-edge">—</div><div class="lbl">Edge</div></div>
      <div class="stat-card"><div class="num num-red" id="s-neg">—</div><div class="lbl">Negative</div></div>
    </div>

    <!-- Status stats bar -->
    <div class="status-stats-grid" id="status-stats-bar"></div>

    <!-- Search -->
    <div class="search-wrap">
      <svg class="search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l3 3"/>
      </svg>
      <input type="text" id="search-input" placeholder="ค้นหา test case..." oninput="applyFilters()" />
    </div>

    <!-- Type Filter -->
    <div class="filter-section">
      <div class="filter-label">Type</div>
      <div class="filter-group" id="type-filters">
        <button class="filter-btn active" onclick="setTypeFilter('all',this,'active')">All types</button>
        <button class="filter-btn" onclick="setTypeFilter('positive',this,'active-green')">✓ Positive</button>
        <button class="filter-btn" onclick="setTypeFilter('edge',this,'active-amber')">~ Edge case</button>
        <button class="filter-btn" onclick="setTypeFilter('negative',this,'active-red')">✗ Negative</button>
      </div>
    </div>

    <!-- Screen Filter -->
    <div class="filter-section">
      <div class="filter-label">Screen</div>
      <div class="filter-group" id="screen-filters">
        <button class="filter-btn active" onclick="setScreenFilter('all',this,'active')">All screens</button>
        ${screenFilterBtns}
      </div>
    </div>

    <!-- Status Filter -->
    <div class="filter-section">
      <div class="filter-label">Status</div>
      <div class="filter-group" id="status-filters">
        <button class="filter-btn active" onclick="setStatusFilter('all',this,'active')">All status</button>
        ${STATUSES.map(s =>
          `<button class="filter-btn" onclick="setStatusFilter('${s.key}',this,'${s.filterClass}')">${s.icon} ${s.label}</button>`
        ).join('')}
      </div>
    </div>

    <!-- Table -->
    <div class="section-sep">
      <span>Test cases — ${meta.name}</span>
      <span class="count-pill" id="showing-count">— / ${cases.length}</span>
    </div>

    <table class="tc-table">
      <thead>
        <tr>
          <th class="col-id">ID</th>
          <th class="col-screen hide-sm">Screen</th>
          <th class="col-title">Test case</th>
          <th class="col-type hide-sm">Type</th>
          <th class="col-status">Status</th>
        </tr>
      </thead>
      <tbody id="tc-tbody"></tbody>
    </table>

    <div class="empty-state" id="empty-state" style="display:none;">
      <div class="emoji">🔍</div>
      <p>ไม่พบ test case ที่ตรงกับเงื่อนไข</p>
    </div>
  `;

  updateTypeStats(cases);
  refreshStatusStatsBar(meta.id);
  applyFilters();
}

// ─────────────────────────────────────────
// STATUS STATS BAR (in feature view)
// ─────────────────────────────────────────
function refreshStatusStatsBar(featureId) {
  const el = document.getElementById('status-stats-bar');
  if (!el) return;
  const feature = FEATURES.find(f => f.meta.id === featureId);
  if (!feature) return;
  const cases  = feature.cases;
  const counts = getStatusCounts(cases);
  const total  = cases.length;
  const progressSegs = buildProgressBar(counts, total, '', 'ssg-pt-seg');

  el.innerHTML = `
    <span class="ssg-label">Test Run</span>
    ${STATUSES.map(s => {
      const style = `background:${STATUS_COLORS[s.key]}22;color:var(--st-${s.key});border-color:${STATUS_COLORS[s.key]};`;
      return `<span class="ssg-item" style="${style}">${s.icon} ${s.label} <strong>${counts[s.key]}</strong></span>`;
    }).join('')}
    <div class="ssg-progress">${progressSegs}</div>
  `;
}

// ─────────────────────────────────────────
// FILTERS
// ─────────────────────────────────────────
function clearGroupActive(groupId) {
  document.querySelectorAll(`#${groupId} .filter-btn`).forEach(b =>
    b.classList.remove('active','active-orange','active-green','active-amber','active-red',
      'active-blue','active-purple','active-teal',
      'active-st-norun','active-st-executing','active-st-passed',
      'active-st-failed','active-st-blocked','active-st-cancelled')
  );
}
function setTypeFilter(val, btn, cls) {
  clearGroupActive('type-filters');
  btn.classList.add(cls);
  activeType = val;
  applyFilters();
}
function setScreenFilter(val, btn, cls) {
  clearGroupActive('screen-filters');
  btn.classList.add(cls);
  activeScreen = val;
  applyFilters();
}
function setStatusFilter(val, btn, cls) {
  clearGroupActive('status-filters');
  btn.classList.add(cls);
  activeStatusFilt = val;
  applyFilters();
}

function applyFilters() {
  const feature = FEATURES.find(f => f.meta.id === currentFeatureId);
  if (!feature) return;

  const q = (document.getElementById('search-input')?.value || '').toLowerCase();
  const filtered = feature.cases.filter(c => {
    const typeOk   = activeType   === 'all' || c.type   === activeType;
    const screenOk = activeScreen === 'all' || c.screen === activeScreen;
    const statusOk = activeStatusFilt === 'all' || getStatus(c.id) === activeStatusFilt;
    const searchOk = !q
      || c.title.toLowerCase().includes(q)
      || c.sub.toLowerCase().includes(q)
      || c.id.toLowerCase().includes(q)
      || c.steps.some(s => s.toLowerCase().includes(q))
      || c.expect.some(e => e.toLowerCase().includes(q));
    return typeOk && screenOk && statusOk && searchOk;
  });
  renderTable(filtered, feature);
}

// ─────────────────────────────────────────
// TABLE RENDER
// ─────────────────────────────────────────
function renderTable(list, feature) {
  const tbody   = document.getElementById('tc-tbody');
  const countEl = document.getElementById('showing-count');
  const emptyEl = document.getElementById('empty-state');
  if (!tbody) return;

  countEl.textContent = `${list.length} / ${feature.cases.length}`;
  emptyEl.style.display = list.length ? 'none' : 'block';
  if (!list.length) { tbody.innerHTML = ''; return; }

  tbody.innerHTML = list.map(c => {
    const sc = feature.meta.screens[c.screen];
    const typePill = `<span class="type-pill tp-${c.type}">${
      c.type === 'positive' ? '✓ Positive' : c.type === 'edge' ? '~ Edge' : '✗ Negative'
    }</span>`;
    const screenTag = sc
      ? `<span class="screen-tag ${sc.cssClass}">${sc.label}<br><small style="font-weight:400;opacity:.75;">${sc.name}</small></span>`
      : `<span class="screen-tag">${c.screen}</span>`;
    const statusSel = statusSelectHtml(c.id, feature.meta.id);

    return `
    <tr class="tc-row" id="row-${c.id}" onclick="toggleDetail('${c.id}')">
      <td class="col-id"><span class="tc-id">${c.id}</span></td>
      <td class="col-screen hide-sm">${screenTag}</td>
      <td class="col-title">
        <div class="tc-title-text">${c.title}</div>
        <div class="tc-sub-text">${c.sub}</div>
      </td>
      <td class="col-type hide-sm">${typePill}</td>
      <td class="col-status">${statusSel}</td>
    </tr>
    <tr class="detail-row" id="detail-${c.id}">
      <td colspan="5" style="padding:0 0 8px 0;">
        <div class="detail-inner">
          <div>
            <div class="detail-section-title">Steps to reproduce</div>
            <ol class="detail-list steps-list">
              ${c.steps.map((s,i) => `<li><strong style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text3);margin-right:5px;">${i+1}.</strong>${s}</li>`).join('')}
            </ol>
          </div>
          <div>
            <div class="detail-section-title">Expected behavior</div>
            <ul class="detail-list expect-list">
              ${c.expect.map(e => `<li>${e}</li>`).join('')}
            </ul>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function toggleDetail(id) {
  const detailRow = document.getElementById(`detail-${id}`);
  const mainRow   = document.getElementById(`row-${id}`);
  const isOpen    = detailRow.classList.contains('open');
  document.querySelectorAll('.detail-row.open').forEach(r => r.classList.remove('open'));
  document.querySelectorAll('.tc-row.expanded').forEach(r => r.classList.remove('expanded'));
  if (!isOpen) {
    detailRow.classList.add('open');
    mainRow.classList.add('expanded');
    detailRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function updateTypeStats(cases) {
  document.getElementById('s-total').textContent = cases.length;
  document.getElementById('s-pos').textContent   = cases.filter(c => c.type === 'positive').length;
  document.getElementById('s-edge').textContent  = cases.filter(c => c.type === 'edge').length;
  document.getElementById('s-neg').textContent   = cases.filter(c => c.type === 'negative').length;
}

// ─────────────────────────────────────────
// RESET ALL
// ─────────────────────────────────────────
function resetAllStatus() {
  if (!confirm('Reset ทุก status กลับเป็น No Run?')) return;
  localStorage.removeItem(LS_KEY);
  updateHeaderStrip();
  if (currentFeatureId === 'overview') {
    renderOverview();
  } else {
    const feature = FEATURES.find(f => f.meta.id === currentFeatureId);
    if (feature) renderFeature(feature);
  }
}

// ─────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
