// ── QA TEST CASES — MAIN APP ──
// Handles: feature registry, nav tabs, filtering, rendering

// ─────────────────────────────────────────
// FEATURE REGISTRY
// Add new features here by referencing their META + CASES objects
// Each feature data file must export:
//   {PREFIX}_META  — feature metadata
//   {PREFIX}_CASES — array of test case objects
// ─────────────────────────────────────────
const FEATURES = [
  { meta: XRAY_META,  cases: XRAY_CASES  },
  { meta: AUTH_META,  cases: AUTH_CASES  },
  // 👉 Add more features here, e.g.:
  // { meta: INVENTORY_META, cases: INVENTORY_CASES },
];

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
let currentFeatureId = 'overview'; // 'overview' | feature id
let activeType   = 'all';
let activeScreen = 'all';

// ─────────────────────────────────────────
// SCREEN TAG COLORS — auto-assigned per feature
// ─────────────────────────────────────────
const SCREEN_PALETTE = [
  { bg:'#F0EFFE', color:'#4A3AB0', border:'#C5BCEF' },
  { bg:'#EAF2FB', color:'#185FA5', border:'#B5D0F0' },
  { bg:'#FFF4EC', color:'#D95F02', border:'#F5C49A' },
  { bg:'#EBF5E8', color:'#276B1F', border:'#A8D49D' },
  { bg:'#FFF8E6', color:'#8A5200', border:'#F5D68A' },
  { bg:'#E6F5F5', color:'#0F6B6B', border:'#8DD4D4' },
];

function getScreenStyle(idx) {
  return SCREEN_PALETTE[idx % SCREEN_PALETTE.length];
}

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────
function init() {
  injectScreenStyles();
  buildNavTabs();
  renderOverview();
  buildTotalStats();
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
// NAV TABS
// ─────────────────────────────────────────
function buildNavTabs() {
  const wrap = document.getElementById('nav-tabs');
  const totalAll = FEATURES.reduce((s, f) => s + f.cases.length, 0);

  wrap.innerHTML = `
    <button class="nav-tab active" id="tab-overview" onclick="switchTab('overview')">
      <span>📋</span> Overview
      <span class="tab-count">${totalAll}</span>
    </button>
    ${FEATURES.map(f => `
      <button class="nav-tab" id="tab-${f.meta.id}" onclick="switchTab('${f.meta.id}')">
        <span>${f.meta.emoji}</span> ${f.meta.name}
        <span class="tab-count">${f.cases.length}</span>
      </button>
    `).join('')}
  `;
}

function switchTab(id) {
  currentFeatureId = id;
  activeType   = 'all';
  activeScreen = 'all';

  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab-${id}`)?.classList.add('active');

  if (id === 'overview') {
    renderOverview();
  } else {
    const feature = FEATURES.find(f => f.meta.id === id);
    if (feature) renderFeature(feature);
  }
}

// ─────────────────────────────────────────
// OVERVIEW PAGE
// ─────────────────────────────────────────
function buildTotalStats() {
  const allCases = FEATURES.flatMap(f => f.cases);
  document.getElementById('ov-total').textContent = allCases.length;
  document.getElementById('ov-features').textContent = FEATURES.length;
  document.getElementById('ov-pos').textContent = allCases.filter(c => c.type === 'positive').length;
  document.getElementById('ov-edge').textContent = allCases.filter(c => c.type === 'edge').length;
  document.getElementById('ov-neg').textContent = allCases.filter(c => c.type === 'negative').length;
}


function renderOverview() {
  const main = document.getElementById('main-content');
  main.innerHTML = `
    <div class="overview-grid" id="overview-grid">
      ${FEATURES.map(f => {
        const pos  = f.cases.filter(c => c.type === 'positive').length;
        const edge = f.cases.filter(c => c.type === 'edge').length;
        const neg  = f.cases.filter(c => c.type === 'negative').length;
        const tags = f.meta.tags.map(t => `<span class="badge ${t.style}">${t.label}</span>`).join('');
        return `
          <div class="feature-card" onclick="switchTab('${f.meta.id}')">
            <div class="feature-card-header">
              <div class="feature-icon" style="background:${f.meta.colorBg};border:1px solid ${f.meta.colorBorder};">${f.meta.emoji}</div>
              <div>
                <div class="feature-card-title">${f.meta.name}</div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px;">${tags}</div>
              </div>
            </div>
            <div class="feature-card-desc">${f.meta.description}</div>
            <div class="feature-card-stats">
              <span class="mini-stat ms-total">${f.cases.length} cases</span>
              <span class="mini-stat ms-pos">✓ ${pos}</span>
              <span class="mini-stat ms-edge">~ ${edge}</span>
              <span class="mini-stat ms-neg">✗ ${neg}</span>
            </div>
          </div>
        `;
      }).join('')}

      <!-- Add Feature Placeholder -->
      <div class="feature-card" style="border-style:dashed;cursor:default;opacity:0.5;" title="เพิ่ม feature ใหม่ใน js/app.js">
        <div class="feature-card-header">
          <div class="feature-icon" style="background:var(--surface2);border:1px solid var(--border);">＋</div>
          <div>
            <div class="feature-card-title" style="color:var(--text2);">Add new feature</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px;">เพิ่มไฟล์ data/ แล้วลงทะเบียนใน FEATURES</div>
          </div>
        </div>
        <div class="feature-card-desc" style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text3);">
          1. สร้าง data/my-feature.js<br>
          2. เพิ่มใน FEATURES[] ใน js/app.js<br>
          3. include &lt;script&gt; ใน index.html
        </div>
      </div>
    </div>
  `;
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
      <div class="feature-info">
        <div class="feature-name">${meta.emoji} ${meta.name}</div>
        <div class="feature-desc">${meta.description}</div>
        <div class="feature-tags">${tags}</div>
      </div>
    </div>

    <!-- Stats -->
    <div class="stats-grid">
      <div class="stat-card"><div class="num num-blue" id="s-total">—</div><div class="lbl">Total cases</div></div>
      <div class="stat-card"><div class="num num-green" id="s-pos">—</div><div class="lbl">Positive</div></div>
      <div class="stat-card"><div class="num num-amber" id="s-edge">—</div><div class="lbl">Edge case</div></div>
      <div class="stat-card"><div class="num num-red" id="s-neg">—</div><div class="lbl">Negative</div></div>
    </div>

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
        <button class="filter-btn" onclick="setTypeFilter('positive',this,'active-green')">Positive</button>
        <button class="filter-btn" onclick="setTypeFilter('edge',this,'active-amber')">Edge case</button>
        <button class="filter-btn" onclick="setTypeFilter('negative',this,'active-red')">Negative</button>
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
        </tr>
      </thead>
      <tbody id="tc-tbody"></tbody>
    </table>

    <div class="empty-state" id="empty-state" style="display:none;">
      <div class="emoji">🔍</div>
      <p>ไม่พบ test case ที่ตรงกับเงื่อนไข</p>
    </div>
  `;

  updateStats(cases);
  applyFilters();
}

// ─────────────────────────────────────────
// FILTERS
// ─────────────────────────────────────────
function setTypeFilter(val, btn, activeClass) {
  document.querySelectorAll('#type-filters .filter-btn').forEach(b =>
    b.classList.remove('active','active-orange','active-green','active-amber','active-red','active-blue','active-purple','active-teal'));
  btn.classList.add(activeClass);
  activeType = val;
  applyFilters();
}

function setScreenFilter(val, btn, activeClass) {
  document.querySelectorAll('#screen-filters .filter-btn').forEach(b =>
    b.classList.remove('active','active-orange','active-green','active-amber','active-red','active-blue','active-purple','active-teal'));
  btn.classList.add(activeClass);
  activeScreen = val;
  applyFilters();
}

function applyFilters() {
  const feature = FEATURES.find(f => f.meta.id === currentFeatureId);
  if (!feature) return;

  const q = (document.getElementById('search-input')?.value || '').toLowerCase();
  const filtered = feature.cases.filter(c => {
    const typeOk   = activeType   === 'all' || c.type   === activeType;
    const screenOk = activeScreen === 'all' || c.screen === activeScreen;
    const searchOk = !q || c.title.toLowerCase().includes(q)
                       || c.sub.toLowerCase().includes(q)
                       || c.id.toLowerCase().includes(q)
                       || c.steps.some(s => s.toLowerCase().includes(q))
                       || c.expect.some(e => e.toLowerCase().includes(q));
    return typeOk && screenOk && searchOk;
  });
  renderTable(filtered, feature);
}

// ─────────────────────────────────────────
// TABLE RENDER
// ─────────────────────────────────────────
function renderTable(list, feature) {
  const tbody = document.getElementById('tc-tbody');
  const countEl = document.getElementById('showing-count');
  const emptyEl = document.getElementById('empty-state');
  if (!tbody) return;

  countEl.textContent = `${list.length} / ${feature.cases.length}`;
  emptyEl.style.display = list.length ? 'none' : 'block';
  if (!list.length) { tbody.innerHTML = ''; return; }

  tbody.innerHTML = list.map(c => {
    const sc = feature.meta.screens[c.screen];
    const typePill = `<span class="type-pill tp-${c.type}">${
      c.type === 'positive' ? 'Positive' : c.type === 'edge' ? 'Edge' : 'Negative'
    }</span>`;
    const screenTag = sc
      ? `<span class="screen-tag ${sc.cssClass}">${sc.label}<br><small style="font-weight:400;opacity:0.75;">${sc.name}</small></span>`
      : `<span class="screen-tag">${c.screen}</span>`;

    return `
    <tr class="tc-row" id="row-${c.id}" onclick="toggleDetail('${c.id}')">
      <td class="col-id"><span class="tc-id">${c.id}</span></td>
      <td class="col-screen hide-sm">${screenTag}</td>
      <td class="col-title">
        <div class="tc-title-text">${c.title}</div>
        <div class="tc-sub-text">${c.sub}</div>
      </td>
      <td class="col-type hide-sm">${typePill}</td>
    </tr>
    <tr class="detail-row" id="detail-${c.id}">
      <td colspan="4" style="padding:0 0 8px 0;">
        <div class="detail-inner">
          <div>
            <div class="detail-section-title">Steps</div>
            <ol class="detail-list steps-list">
              ${c.steps.map((s,i) => `<li><strong style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text3);margin-right:6px;">${i+1}.</strong>${s}</li>`).join('')}
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

function updateStats(cases) {
  document.getElementById('s-total').textContent = cases.length;
  document.getElementById('s-pos').textContent   = cases.filter(c => c.type === 'positive').length;
  document.getElementById('s-edge').textContent  = cases.filter(c => c.type === 'edge').length;
  document.getElementById('s-neg').textContent   = cases.filter(c => c.type === 'negative').length;
}

// ─────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
