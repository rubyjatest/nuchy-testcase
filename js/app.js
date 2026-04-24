// ── QA TEST CASES — v8 ──
// Auth : Supabase (email/password)
// Data : Google Drive only ผ่าน Supabase Edge Function proxy
//        - status.json
//        - features/<featureId>.json
//        - images/<caseId>/<filename>

// ══════════════════════════════════════════
//  🔧 CONFIG
// ══════════════════════════════════════════
const SUPABASE_URL      = 'https://kgwuakgtnvcvnybipqyz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtnd3Vha2d0bnZjdm55YmlwcXl6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MTYxMDQsImV4cCI6MjA5MTk5MjEwNH0.pgkW0qdi4EDz5h5lju_eoNY7oWIvw6fpvTBzO7YQB_E';
const DRIVE_PROXY_URL   = `${SUPABASE_URL}/functions/v1/drive-proxy`;
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'qa-supabase-auth',
  },
});

const APP_MODE = {
  DRIVE: 'drive',
  FALLBACK: 'fallback',
};

let currentAppMode = APP_MODE.DRIVE;
let lastDriveError = null;
let lastDriveDiagnostic = null;
let gWriteQueue = {};
let DB = { features: {}, status: {}, deletedCases: [], executions: {} };
let DB_READY = false;
let currentTheme = 'light';
let DRIVE_STATE = {
  rootFolderId: null,
  rootFolderName: '',
  featuresFolderId: null,
  imagesFolderId: null,
  statusFileId: null,
};

const APP_RUNTIME = {
  bootstrapping: false,
  connecting: false,
  resetting: false,
  initialized: false,
  activeRequestId: 0,
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildErrorMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  return err.payload?.error || err.message || 'Unknown error';
}

function isValidHexColor(value) {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value || '').trim());
}

function hexToRgba(hexColor, alpha = 1) {
  const hex = String(hexColor || '').trim().replace('#', '');
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(hex)) return '';
  const full = hex.length === 3 ? hex.split('').map(ch => ch + ch).join('') : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parseFeatureTagsInput(rawText, defaultBadgeClass) {
  const lines = String(rawText || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  return lines.map(line => {
    const [labelPart, colorPartRaw] = line.split('|');
    const label = (labelPart || '').trim();
    const colorPart = (colorPartRaw || '').trim();
    if (!label) return null;
    if (isValidHexColor(colorPart)) {
      return {
        label,
        style: 'badge-custom',
        color: colorPart,
        bg: hexToRgba(colorPart, 0.13),
        border: hexToRgba(colorPart, 0.36),
      };
    }
    return { label, style: defaultBadgeClass };
  }).filter(Boolean);
}

function renderFeatureTag(tag) {
  const label = escapeHtml(tag?.label || '');
  if (!label) return '';
  if (tag?.style === 'badge-custom' && tag?.color && tag?.bg && tag?.border) {
    return `<span class="badge badge-custom" style="color:${escapeHtml(tag.color)};background:${escapeHtml(tag.bg)};border-color:${escapeHtml(tag.border)};">${label}</span>`;
  }
  const styleClass = /^badge-[a-z0-9-]+$/.test(tag?.style || '') ? tag.style : 'badge-gray';
  return `<span class="badge ${styleClass}">${label}</span>`;
}

function parseScreenLineInput(line) {
  const [namePart, colorPartRaw] = String(line || '').split('|');
  const name = (namePart || '').trim();
  const colorToken = (colorPartRaw || '').trim().toLowerCase();
  return { name, colorToken };
}

function buildScreenStyleFromToken(colorToken) {
  if (!colorToken) return null;
  if (SCREEN_THEME_COLORS[colorToken]) return SCREEN_THEME_COLORS[colorToken];
  if (isValidHexColor(colorToken)) {
    return {
      color: colorToken,
      bg: hexToRgba(colorToken, 0.12),
      border: hexToRgba(colorToken, 0.34),
    };
  }
  return null;
}

const DEFAULT_PROJECT_ID = 'project-default';
const DEFAULT_PROJECT_NAME = 'Project';
const PROJECT_SIDEBAR_KEY = 'qa-project-sidebar-open';
let selectedProjectId = ''; // set from available projects
let isProjectSidebarOpen = localStorage.getItem(PROJECT_SIDEBAR_KEY) === '1';
let _projectImportRows = [];

function sanitizeProjectId(value, fallback = '') {
  const normalized = String(value || fallback || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_PROJECT_ID;
}

function ensureProjectRegistry() {
  if (!isPlainObject(DB.projects)) DB.projects = {};

  // clean legacy placeholder project if it no longer has features
  const legacyMobileProject = DB.projects['mobile-app'];
  if (legacyMobileProject) {
    const hasLegacyFeatures = Object.values(DB.features || {}).some(store =>
      sanitizeProjectId(store?.meta?.projectId || store?.meta?.projectName || '', '') === 'mobile-app'
    );
    if (!hasLegacyFeatures) delete DB.projects['mobile-app'];
  }

  Object.values(DB.features || {}).forEach(store => {
    if (!store?.meta) return;
    const meta = store.meta;
    const projectId = sanitizeProjectId(meta.projectId || meta.projectName || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID);
    meta.projectId = projectId;
    meta.projectName = meta.projectName || DB.projects[projectId]?.name || DEFAULT_PROJECT_NAME;
    meta.projectOverview = meta.projectOverview || DB.projects[projectId]?.overview || '';
    if (!DB.projects[projectId]) {
      DB.projects[projectId] = {
        id: projectId,
        name: meta.projectName,
        overview: meta.projectOverview || '',
        iconEmoji: '🗂️',
        iconImage: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  });
}


function syncProjectRegistryToStatus() {
  if (!isPlainObject(DB.status)) DB.status = {};
  ensureProjectRegistry();
  DB.status.projects = JSON.parse(JSON.stringify(DB.projects || {}));
}

function getProjectsList() {
  ensureProjectRegistry();
  const byId = {};
  Object.values(DB.projects || {}).forEach(project => {
    if (!project?.id) return;
    byId[project.id] = { ...project, features: [] };
  });
  Object.values(DB.features || {}).forEach(store => {
    const pid = sanitizeProjectId(store?.meta?.projectId || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID);
    if (!byId[pid]) byId[pid] = { id: pid, name: store?.meta?.projectName || DEFAULT_PROJECT_NAME, overview: store?.meta?.projectOverview || '', features: [] };
    byId[pid].features.push(store?.meta?.id || '');
  });
  const list = Object.values(byId).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
  if (!list.find(item => item.id === selectedProjectId)) selectedProjectId = list[0]?.id || '';
  return list.filter(item => !(item.id === 'mobile-app' && !item.features?.length));
}

function getProjectAvatarHtml(project, extraClass = '') {
  const cls = `project-avatar ${extraClass}`.trim();
  const image = String(project?.iconImage || '').trim();
  const emoji = String(project?.iconEmoji || '').trim() || '🗂️';
  if (image) return `<span class=\"${cls}\"><img src=\"${escapeHtml(image)}\" alt=\"${escapeHtml(project?.name || 'Project')}\" /></span>`;
  return `<span class=\"${cls} project-avatar-emoji\">${escapeHtml(emoji)}</span>`;
}

function getProjectFeatureStores(projectId) {
  const pid = sanitizeProjectId(projectId || selectedProjectId || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID);
  return Object.values(DB.features || {}).filter(store => sanitizeProjectId(store?.meta?.projectId || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID) === pid);
}

function getProjectStats(projectId) {
  const stores = getProjectFeatureStores(projectId);
  let qa = 0, dev = 0, defects = 0, passed = 0, total = 0;
  stores.forEach(store => {
    const cases = (store.cases || []).filter(c => !getDeletedSet().has(c.id));
    qa += cases.length;
    dev += Array.isArray(store.devCases) ? store.devCases.length : 0;
    defects += Array.isArray(store.defects) ? store.defects.length : 0;
    total += cases.length;
    cases.forEach(tc => { if (getStatus(tc.id) === 'passed') passed += 1; });
  });
  return { features: stores.length, qa, dev, defects, progress: total ? Math.round((passed / total) * 100) : 0, passed, total };
}

function setSelectedProject(projectId) {
  selectedProjectId = sanitizeProjectId(projectId || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID);
}

function renderProjectSidebarDrawer() {
  const backdrop = document.getElementById('project-sidebar-backdrop');
  const drawer = document.getElementById('project-sidebar-drawer');
  const list = document.getElementById('project-drawer-list');
  if (!backdrop || !drawer || !list) return;
  const projects = getProjectsList();
  const overviewButton = `
    <button class="project-nav-link ${currentFeatureId === 'overview' ? 'active' : ''}" onclick="closeProjectSidebar(); switchTab('overview')">
      <span class="project-nav-icon">📋</span>
      <span>Overview</span>
    </button>`;
  const projectItems = projects.map(item => {
    const itemStats = getProjectStats(item.id);
    return `
      <button class="project-list-item ${item.id === selectedProjectId && currentFeatureId !== 'overview' ? 'active' : ''}" onclick="selectProjectFromSidebar('${item.id}')" title="${escapeHtml(item.name)}">
        ${getProjectAvatarHtml(item, 'project-list-avatar')}
        <span class="project-list-name">${escapeHtml(item.name)}</span>
        <span class="project-list-count">${itemStats.qa}</span>
      </button>`;
  }).join('') || `<div class="empty-state compact"><div class="emoji">📁</div><p>ยังไม่มี project</p></div>`;
  list.innerHTML = `<div class="project-nav-group">${overviewButton}</div><div class="project-drawer-section-label">Projects</div>${projectItems}`;
  backdrop.hidden = !isProjectSidebarOpen;
  drawer.classList.toggle('open', isProjectSidebarOpen);
  drawer.setAttribute('aria-hidden', isProjectSidebarOpen ? 'false' : 'true');
  document.body.classList.toggle('project-sidebar-open', isProjectSidebarOpen);
}

function openProjectSidebar() {
  isProjectSidebarOpen = true;
  localStorage.setItem(PROJECT_SIDEBAR_KEY, '1');
  renderProjectSidebarDrawer();
}

function closeProjectSidebar() {
  isProjectSidebarOpen = false;
  localStorage.setItem(PROJECT_SIDEBAR_KEY, '0');
  renderProjectSidebarDrawer();
}

function toggleProjectSidebar() {
  if (isProjectSidebarOpen) closeProjectSidebar();
  else openProjectSidebar();
}

function selectProjectFromSidebar(projectId) {
  setSelectedProject(projectId);
  currentFeatureId = 'projects';
  closeProjectSidebar();
  rebuildNav();
  renderProjectsPage();
}

function openProjectCreateModal() {
  if (!ensureWritable()) return;
  openModal('add-project-modal', `
    <div class="modal-header"><span class="modal-title">＋ Add Project</span><span class="modal-sub">สร้าง project ใหม่</span></div>
    <div class="modal-body">
      <div class="form-row2">
        <div class="form-group"><label>Project name</label><input class="form-input" id="pj-name" placeholder="เช่น Zeen Audit" /></div>
        <div class="form-group"><label>Emoji</label><input class="form-input" id="pj-emoji" placeholder="🗂️" maxlength="4" /></div>
      </div>
      <div class="form-group"><label>Project image URL <span class="form-hint">วางลิงก์รูปแทน emoji ได้</span></label><input class="form-input" id="pj-image" placeholder="https://..." /></div>
      <div class="form-group"><label>Overview</label><textarea class="form-textarea" id="pj-overview" rows="5" placeholder="อธิบาย project โดยรวม"></textarea></div>
    </div>
    <div class="modal-footer">
      <button class="btn-modal-cancel" onclick="closeModal()">ยกเลิก</button>
      <button class="btn-modal-ok" onclick="submitCreateProject()">สร้าง Project</button>
    </div>`);
}

async function submitCreateProject() {
  const name = document.getElementById('pj-name').value.trim();
  const overview = document.getElementById('pj-overview').value.trim();
  const iconEmoji = document.getElementById('pj-emoji').value.trim();
  const iconImage = document.getElementById('pj-image').value.trim();
  if (!name) { showFormError('กรุณากรอกชื่อ Project'); return; }
  ensureProjectRegistry();
  const id = sanitizeProjectId(name, 'project-' + Date.now());
  if (DB.projects[id]) { showFormError('Project นี้มีอยู่แล้ว'); return; }
  const okBtn = document.querySelector('.btn-modal-ok');
  if (okBtn) { okBtn.disabled = true; okBtn.textContent = 'กำลังสร้าง...'; }
  showLoadingOverlay('กำลังสร้าง Project...');
  DB.projects[id] = { id, name, overview, iconEmoji, iconImage, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  selectedProjectId = id;
  try {
    await writeStatusFile();
    closeModal();
    syncAppView();
    switchTab('projects');
  } finally {
    hideLoadingOverlay();
  }
}

function openEditProjectModal(projectId = selectedProjectId) {
  if (!ensureWritable()) return;
  ensureProjectRegistry();
  const project = DB.projects[sanitizeProjectId(projectId || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID)];
  if (!project) return;
  openModal('edit-project-modal', `
    <div class="modal-header"><span class="modal-title">✏️ Edit Project</span><span class="modal-sub">${escapeHtml(project.id)}</span></div>
    <div class="modal-body">
      <div class="form-row2">
        <div class="form-group"><label>Project name</label><input class="form-input" id="epj-name" value="${escapeHtml(project.name || '')}" /></div>
        <div class="form-group"><label>Emoji</label><input class="form-input" id="epj-emoji" value="${escapeHtml(project.iconEmoji || '')}" placeholder="🗂️" maxlength="4" /></div>
      </div>
      <div class="form-group"><label>Project image URL <span class="form-hint">วางลิงก์รูปแทน emoji ได้</span></label><input class="form-input" id="epj-image" value="${escapeHtml(project.iconImage || '')}" placeholder="https://..." /></div>
      <div class="form-group"><label>Overview</label><textarea class="form-textarea" id="epj-overview" rows="6">${escapeHtml(project.overview || '')}</textarea></div>
    </div>
    <div class="modal-footer project-edit-footer">
      <button class="btn-modal-danger btn-modal-danger-soft" onclick="confirmDeleteProject('${project.id}')">ลบ Project</button>
      <span class="project-edit-actions">
        <button class="btn-modal-cancel" onclick="closeModal()">ยกเลิก</button>
        <button class="btn-modal-ok" onclick="submitEditProject('${project.id}')">บันทึก Project</button>
      </span>
    </div>`);
}

async function submitEditProject(projectId) {
  ensureProjectRegistry();
  const project = DB.projects[projectId];
  if (!project) return;
  project.name = document.getElementById('epj-name').value.trim() || project.name;
  project.iconEmoji = document.getElementById('epj-emoji').value.trim();
  project.iconImage = document.getElementById('epj-image').value.trim();
  project.overview = document.getElementById('epj-overview').value.trim();
  project.updatedAt = new Date().toISOString();
  Object.values(DB.features || {}).forEach(store => {
    if (sanitizeProjectId(store?.meta?.projectId || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID) === projectId) {
      store.meta.projectName = project.name;
      store.meta.projectOverview = project.overview;
      scheduleFeatureWrite(store.meta.id);
    }
  });
  const okBtn = document.querySelector('.btn-modal-ok');
  if (okBtn) { okBtn.disabled = true; okBtn.textContent = 'กำลังบันทึก...'; }
  showLoadingOverlay('กำลังบันทึก Project...');
  try {
    await writeStatusFile();
    closeModal();
    syncAppView();
    switchTab('projects');
  } finally {
    hideLoadingOverlay();
  }
}

function confirmDeleteProject(projectId) {
  ensureProjectRegistry();
  const project = DB.projects[projectId];
  if (!project) return;
  openConfirmModal('ลบ Project', `ลบ project <strong>${escapeHtml(project.name)}</strong> และ feature ทั้งหมดใน project นี้หรือไม่?`, async () => {
    await deleteProjectCascade(projectId);
  });
}

async function deleteProjectCascade(projectId) {
  ensureProjectRegistry();
  showLoadingOverlay('กำลังลบ Project...');
  try {
    const related = Object.values(DB.features || {})
      .filter(store => sanitizeProjectId(store?.meta?.projectId || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID) === projectId)
      .map(store => store.meta.id);

    for (const featureId of related) {
      await deleteFeatureData(featureId);
    }

    delete DB.projects[projectId];

    FEATURES = buildFeatures();
    const remaining = getProjectsList().filter(item => item.id !== projectId);
    selectedProjectId = remaining[0]?.id || '';
    currentFeatureId = 'overview';

    injectScreenStyles();
    closeProjectSidebar();
    closeModal();
    rebuildNav();
    renderProjectSidebarDrawer();
    renderOverview();
    updateHeaderStrip();
  } finally {
    hideLoadingOverlay();
  }
}

function renderProjectsPage() {
  const projects = getProjectsList();
  const project = projects.find(item => item.id === selectedProjectId) || projects[0];
  if (project) selectedProjectId = project.id;
  renderProjectSidebarDrawer();
  const stats = project ? getProjectStats(project.id) : { features: 0, qa: 0, dev: 0, defects: 0, progress: 0 };
  const projectStores = project ? getProjectFeatureStores(project.id) : [];
  const projectCards = projectStores.map(store => {
    const feature = { meta: store.meta, cases: (store.cases || []).filter(c => !getDeletedSet().has(c.id)), devCases: store.devCases || [], defects: store.defects || [] };
    const counts = getStatusCounts(feature.cases);
    const passed = counts.passed || 0;
    const total = feature.cases.length;
    const progress = total ? Math.round((passed / total) * 100) : 0;
    const tags = (feature.meta.tags || []).slice(0, 2).map(renderFeatureTag).join('');
    return `
      <div class="project-feature-card" onclick="switchTab('${feature.meta.id}')">
        <div class="project-feature-main">
          <div class="project-feature-icon" style="background:${feature.meta.colorBg};border-color:${feature.meta.colorBorder};">${feature.meta.emoji || '📋'}</div>
          <div>
            <div class="project-feature-title">${escapeHtml(feature.meta.name)}</div>
            <div class="project-feature-desc">${escapeHtml(feature.meta.description || '')}</div>
            <div class="project-feature-tags">${tags}</div>
          </div>
        </div>
        <div class="project-feature-side">
          <div class="project-feature-status"><span class="status-badge status-no-run">No Run ${counts['no-run'] || 0}</span><span class="status-badge status-passed">Passed ${passed}</span></div>
          <div class="progress-line"><span style="width:${progress}%;"></span></div>
          <div class="project-feature-count">${total} cases</div>
        </div>
      </div>`;
  }).join('');
  document.getElementById('main-content').innerHTML = project ? `
    <section class="projects-main standalone projects-focus-page">
      <div class="project-shell-card">
        <div class="project-shell-head">
          <div class="project-shell-head-main">
            ${getProjectAvatarHtml(project, 'project-shell-avatar')}
            <div>
              <div class="project-shell-title">${escapeHtml(project.name)}</div>
              <div class="project-shell-sub">Project overview</div>
              <div class="project-shell-text">${escapeHtml(project.overview || 'ยังไม่มี Project Overview')}</div>
            </div>
          </div>
          <div class="project-overview-actions">
            <button class="icon-btn icon-btn-neutral" onclick="openEditProjectModal('${project.id}')">✏️ แก้ไข Project</button>
            <button class="btn-import-csv" onclick="openProjectImportModal('${project.id}')">📦 Project Sheet Import</button>
            <button class="btn-add-case" onclick="openAddFeatureModal('${project.id}')">＋ Add Feature</button>
          </div>
        </div>
        <div class="project-overview-pills compact">
          <span class="project-pill blue">${stats.features} Features</span>
          <span class="project-pill green">${stats.qa} QA Cases</span>
          <span class="project-pill purple">${stats.dev} Dev Cases</span>
          <span class="project-pill orange">${stats.defects} Defects</span>
        </div>
      </div>
      <div class="project-dashboard-card compact-grid">
        <div class="project-stat"><strong>${stats.features}</strong><span>Features</span></div>
        <div class="project-stat"><strong>${stats.qa}</strong><span>QA Cases</span></div>
        <div class="project-stat"><strong>${stats.dev}</strong><span>Dev Cases</span></div>
        <div class="project-stat"><strong>${stats.defects}</strong><span>Defects</span></div>
        <div class="project-progress-wrap"><label>Project QA progress</label><div class="progress-line full"><span style="width:${stats.progress}%;"></span></div></div>
      </div>
      <div class="section-sep"><span>Features in ${escapeHtml(project.name)}</span><span class="count-pill">${projectStores.length} features</span></div>
      <div class="project-feature-list">${projectCards || `<div class="empty-state"><div class="emoji">📁</div><p>ยังไม่มี feature ใน project นี้</p></div>`}</div>
    </section>`
    : `<div class="empty-state"><div class="emoji">📁</div><p>ยังไม่มี project — กด <strong>☰</strong> เพื่อเปิด sidebar แล้วสร้าง project</p></div>`;
}

function switchProjectView(projectId) {
  selectProjectFromSidebar(projectId);
}

function openProjectImportModal(projectId = selectedProjectId) {
  if (!ensureWritable()) return;
  openModal('project-import-modal', `
    <div class="modal-header"><span class="modal-title">📦 Project Sheet Import</span><span class="modal-sub">CSV เดียวสร้าง feature และ test case ได้</span></div>
    <div class="modal-body">
      <div class="notice" style="margin-bottom:12px;">คอลัมน์ที่รองรับ: feature_id, feature_name, screen, case_id, type, title, sub, steps, expect</div>
      <input type="file" id="project-import-file" accept=".csv" onchange="previewProjectImport('${projectId}')" />
      <div id="project-import-preview" class="csv-preview" style="display:none;margin-top:12px;">
        <div id="project-import-stats" class="csv-stats"></div>
        <div id="project-import-content"></div>
      </div>
      <div id="project-import-error" class="form-error" style="display:none;"></div>
    </div>
    <div class="modal-footer">
      <button class="btn-modal-cancel" onclick="closeModal()">ยกเลิก</button>
      <button class="btn-modal-ok" id="btn-project-import" onclick="submitProjectImport('${projectId}')" disabled>Import</button>
    </div>`);
}

function previewProjectImport(projectId) {
  const file = document.getElementById('project-import-file')?.files?.[0];
  const errEl = document.getElementById('project-import-error');
  if (!file) return;
  errEl.style.display = 'none';
  file.text().then(text => {
    try {
      _projectImportRows = parseProjectSheetCsv(text, projectId);
      document.getElementById('project-import-preview').style.display = 'block';
      document.getElementById('project-import-stats').textContent = `รวม ${_projectImportRows.length} แถว`;
      document.getElementById('project-import-content').innerHTML = _projectImportRows.slice(0, 8).map(row => `<div style="padding:4px 0;border-bottom:1px solid var(--border);"><strong>${escapeHtml(row.featureId)}</strong> — ${escapeHtml(row.case.title)}</div>`).join('');
      document.getElementById('btn-project-import').disabled = false;
    } catch (err) {
      errEl.textContent = buildErrorMessage(err);
      errEl.style.display = 'block';
      document.getElementById('btn-project-import').disabled = true;
    }
  });
}

function buildFeatureMetaFromImport(projectId, projectName, row, screenNames) {
  const theme = THEME_COLORS.orange;
  const screens = {};
  screenNames.forEach((screenName, idx) => {
    screens[`S${idx + 1}`] = { label: `Screen ${idx + 1}`, name: screenName, cssClass: `sc-${row.featureId}-s${idx + 1}` };
  });
  return { id: row.featureId, name: row.featureName || row.featureId, emoji: row.emoji || '📋', color: theme.color, colorBg: theme.colorBg, colorBorder: theme.colorBorder, tags: [{ label: projectName, style: 'badge-gray' }], description: row.featureName || row.featureId, screens, projectId, projectName, projectOverview: DB.projects?.[projectId]?.overview || '' };
}

function parseProjectSheetCsv(text, projectId) {
  const rows = parseCsvText(text);
  const header = rows.shift() || [];
  const map = Object.fromEntries(header.map((key, idx) => [String(key || '').trim().toLowerCase(), idx]));
  ['feature_id', 'feature_name', 'screen', 'case_id', 'type', 'title'].forEach(key => { if (!(key in map)) throw new Error(`ไม่พบคอลัมน์ ${key}`); });
  return rows.filter(row => row.some(Boolean)).map(row => ({
    projectId,
    featureId: inferFeatureIdFromFilename(row[map['feature_id']] || ''),
    featureName: row[map['feature_name']] || '',
    emoji: map['feature_emoji'] != null ? row[map['feature_emoji']] : '',
    screenName: row[map['screen']] || 'Main',
    case: {
      id: row[map['case_id']] || `TC-${Date.now()}`,
      type: (row[map['type']] || 'positive').toLowerCase(),
      title: row[map['title']] || '',
      sub: map['sub'] != null ? (row[map['sub']] || '') : '',
      steps: map['steps'] != null ? String(row[map['steps']] || '').split('|').map(v => v.trim()).filter(Boolean) : ['-'],
      expect: map['expect'] != null ? String(row[map['expect']] || '').split('|').map(v => v.trim()).filter(Boolean) : ['-'],
    },
  }));
}

async function submitProjectImport(projectId) {
  if (!_projectImportRows.length) return;
  const okBtn = document.getElementById('btn-project-import');
  if (okBtn) { okBtn.disabled = true; okBtn.textContent = 'กำลัง Import...'; }
  showLoadingOverlay('กำลัง import project sheet...');
  ensureProjectRegistry();
  const project = DB.projects[projectId] || { id: projectId, name: DEFAULT_PROJECT_NAME, overview: '', iconEmoji: '🗂️', iconImage: '' };
  const grouped = {};
  _projectImportRows.forEach(row => {
    if (!grouped[row.featureId]) grouped[row.featureId] = [];
    grouped[row.featureId].push(row);
  });
  try {
    for (const [featureId, rows] of Object.entries(grouped)) {
      let store = DB.features[featureId];
      const uniqueScreens = [...new Set(rows.map(item => item.screenName).filter(Boolean))];
      const screenMap = Object.fromEntries(uniqueScreens.map((name, idx) => [name, `S${idx + 1}`]));
      if (!store) {
        store = DB.features[featureId] = { meta: buildFeatureMetaFromImport(projectId, project.name, rows[0], uniqueScreens), cases: [], devCases: [], defects: [], fileId: null };
      } else {
        store.meta.projectId = projectId;
        store.meta.projectName = project.name;
        store.meta.projectOverview = project.overview || '';
        store.meta.screens = {};
        uniqueScreens.forEach((name, idx) => { store.meta.screens[`S${idx + 1}`] = { label: `Screen ${idx + 1}`, name, cssClass: `sc-${featureId}-s${idx + 1}` }; });
      }
      const byCase = Object.fromEntries((store.cases || []).map(item => [item.id, item]));
      rows.forEach(row => {
        byCase[row.case.id] = { ...(byCase[row.case.id] || {}), ...row.case, screen: screenMap[row.screenName] || 'S1' };
      });
      store.cases = Object.values(byCase);
      await persistFeatureFile(featureId);
    }
    await writeStatusFile();
    closeModal();
    syncAppView();
    switchTab('projects');
  } finally {
    hideLoadingOverlay();
  }
}


function getBundledFeatureTemplates() {
  const features = [];
  if (typeof XRAY_META !== 'undefined' && typeof XRAY_CASES !== 'undefined') {
    features.push({ meta: XRAY_META, cases: XRAY_CASES });
  }
  if (typeof AUTH_META !== 'undefined' && typeof AUTH_CASES !== 'undefined') {
    features.push({ meta: AUTH_META, cases: AUTH_CASES });
  }
  return features;
}

function seedBundledData() {
  DB = { features: {}, status: {}, deletedCases: [], executions: {} };
  getBundledFeatureTemplates().forEach(feature => {
    DB.features[feature.meta.id] = {
      meta: cloneJson(feature.meta),
      cases: cloneJson(feature.cases),
      fileId: null,
    };
  });
}

function decodeJwtPayload(token) {
  try {
    const base64Url = String(token || '').split('.')[1] || '';
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

async function getValidAccessToken(forceRefresh = false) {
  let sessionResponse = await supabaseClient.auth.getSession();
  let session = sessionResponse?.data?.session || null;

  if (forceRefresh && session?.refresh_token) {
    const refreshed = await supabaseClient.auth.refreshSession({ refresh_token: session.refresh_token });
    if (refreshed.error) throw refreshed.error;
    session = refreshed.data.session || null;
  }

  if (!session) {
    const legacyToken = localStorage.getItem('qa_access_token') || '';
    if (legacyToken) {
      const payload = decodeJwtPayload(legacyToken);
      const isExpired = !payload?.exp || (payload.exp * 1000) <= (Date.now() + 60_000);
      if (!isExpired) return legacyToken;
      localStorage.removeItem('qa_access_token');
    }
    return '';
  }

  if (!forceRefresh && session.expires_at && (session.expires_at * 1000) <= (Date.now() + 60_000)) {
    const refreshed = await supabaseClient.auth.refreshSession({ refresh_token: session.refresh_token });
    if (refreshed.error) throw refreshed.error;
    session = refreshed.data.session || null;
  }

  const token = session?.access_token || '';
  if (token) localStorage.setItem('qa_access_token', token);
  return token;
}

async function buildAuthHeaders(extra = {}) {
  const headers = new Headers(extra);
  headers.set('apikey', SUPABASE_ANON_KEY);
  const token = await getValidAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

function getSettingsMenuElements() {
  return {
    wrap: document.querySelector('.settings-menu-wrap'),
    button: document.getElementById('settings-menu-btn'),
    menu: document.getElementById('settings-menu-list'),
  };
}

function closeSettingsMenu() {
  const { button, menu } = getSettingsMenuElements();
  if (!menu) return;
  menu.hidden = true;
  if (button) button.setAttribute('aria-expanded', 'false');
}

function openSettingsMenu() {
  const { button, menu } = getSettingsMenuElements();
  if (!menu) return;
  menu.hidden = false;
  if (button) button.setAttribute('aria-expanded', 'true');
}

function toggleSettingsMenu(event) {
  if (event) event.stopPropagation();
  const { menu } = getSettingsMenuElements();
  if (!menu) return;
  if (menu.hidden) openSettingsMenu();
  else closeSettingsMenu();
}

function handleSettingsAction(action) {
  closeSettingsMenu();
  if (typeof action === 'function') action();
}

document.addEventListener('click', (event) => {
  const { wrap, menu } = getSettingsMenuElements();
  if (!wrap || !menu || menu.hidden) return;
  if (!wrap.contains(event.target)) closeSettingsMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSettingsMenu();
});

function updateThemeToggleButton() {
  const btn = document.getElementById('theme-toggle-btn');
  if (!btn) return;
  if (currentTheme === 'dark') {
    btn.textContent = '☀️ Light';
    btn.title = 'Switch to light mode';
  } else {
    btn.textContent = '🌙 Dark';
    btn.title = 'Switch to dark mode';
  }
}

function setTheme(mode, persist = true) {
  const next = mode === 'dark' ? 'dark' : 'light';
  currentTheme = next;
  document.body.setAttribute('data-theme', next);
  if (persist) localStorage.setItem('qa_theme', next);
  updateThemeToggleButton();
}

function initTheme() {
  const saved = (localStorage.getItem('qa_theme') || '').trim();
  if (saved === 'dark' || saved === 'light') {
    setTheme(saved, false);
    return;
  }
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(prefersDark ? 'dark' : 'light', false);
}

function toggleTheme() {
  setTheme(currentTheme === 'dark' ? 'light' : 'dark');
}


initTheme();
activeSortMode = '';

async function driveProxyRequest(action, {
  method = 'GET',
  body,
  query = {},
  formData,
} = {}) {
  const url = new URL(DRIVE_PROXY_URL);
  if (action) url.searchParams.set('action', action);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const sendRequest = async (forceRefresh = false) => {
    const headers = await buildAuthHeaders();
    if (forceRefresh) {
      const token = await getValidAccessToken(true);
      headers.set('apikey', SUPABASE_ANON_KEY);
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }

    const options = { method, headers };

    if (formData) {
      options.body = formData;
    } else if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url.toString(), options);
    const contentType = res.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await res.json().catch(() => ({}))
      : await res.text().catch(() => '');

    return { res, payload };
  };

  let { res, payload } = await sendRequest(false);
  if (res.status === 401) {
    ({ res, payload } = await sendRequest(true));
  }

  if (!res.ok) {
    const err = new Error(payload?.error || payload?.message || `Drive proxy failed (${res.status})`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

function normalizeDiagnosticsPayload(payload) {
  if (isPlainObject(payload) && Array.isArray(payload.checks)) {
    const recommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
    return {
      ...payload,
      recommendations,
      rawPayload: payload,
    };
  }

  const checks = [];
  const looksLikeLegacyPayload = isPlainObject(payload) &&
    ('version' in payload || 'customFeatures' in payload || 'customCases' in payload);

  if (looksLikeLegacyPayload) {
    checks.push({
      key: 'diagnostics.payload_shape',
      ok: false,
      detail: 'Drive proxy ตอบกลับเป็น payload รูปแบบเก่า (version/customFeatures/customCases) ไม่ใช่ diagnostics',
    });
  } else if (isPlainObject(payload)) {
    checks.push({
      key: 'diagnostics.payload_shape',
      ok: false,
      detail: 'Drive proxy ตอบกลับมา แต่รูปแบบข้อมูลไม่ตรงกับ diagnostics ที่หน้าเว็บต้องใช้',
    });
  } else {
    checks.push({
      key: 'diagnostics.payload_shape',
      ok: false,
      detail: 'Drive proxy ไม่ได้ส่ง JSON diagnostics กลับมา',
    });
  }

  if (DRIVE_STATE.rootFolderId) {
    checks.push({
      key: 'drive.bootstrap_state',
      ok: true,
      detail: `โหลด bootstrap สำเร็จ: root folder ${DRIVE_STATE.rootFolderId}`,
    });
  }

  return {
    ok: false,
    authMode: 'unknown',
    rootFolderId: DRIVE_STATE.rootFolderId || null,
    serviceAccountEmail: null,
    checks,
    recommendations: [
      'ตรวจสอบว่า deploy ฟังก์ชัน drive-proxy เวอร์ชันล่าสุดแล้ว',
      'ถ้ายังเป็นเวอร์ชันเก่า ให้ deploy ใหม่ แล้วลองกด Drive Debug อีกครั้ง',
    ],
    rawPayload: payload,
  };
}

async function fetchDriveDiagnostics(writeCheck = false) {
  const payload = await driveProxyRequest('diagnostics', {
    query: { writeCheck: writeCheck ? '1' : '0' },
  });
  const diag = normalizeDiagnosticsPayload(payload);
  lastDriveDiagnostic = diag;
  return diag;
}

function renderDiagnosticsHtml(diagnostics, errorMessage = '') {
  const checks = Array.isArray(diagnostics?.checks) ? diagnostics.checks : [];
  const recs = diagnostics?.recommendations || [];
  const rawSource = diagnostics?.rawPayload ?? diagnostics;
  const raw = rawSource ? JSON.stringify(rawSource, null, 2) : '';
  const rootFolderLabel = diagnostics?.rootFolderId || DRIVE_STATE.rootFolderId || 'ไม่พบ';
  const checksHtml = checks.length
    ? checks.map(check => `
            <div style="padding:10px 12px;border:1px solid ${check.ok ? 'var(--green-border)' : 'var(--red-border)'};background:${check.ok ? 'var(--green-bg)' : 'var(--red-bg)'};border-radius:8px;">
              <div style="font-size:12px;font-weight:600;color:${check.ok ? 'var(--green)' : 'var(--red)'};">${check.ok ? '✓' : '✗'} ${escapeHtml(check.key)}</div>
              <div style="font-size:12px;color:var(--text2);margin-top:2px;line-height:1.6;">${escapeHtml(check.detail)}</div>
            </div>`).join('')
    : `<div style="padding:10px 12px;border:1px dashed var(--border);background:var(--surface2);border-radius:8px;font-size:12px;color:var(--text3);">
         ไม่พบรายการตรวจสอบจาก backend
       </div>`;
  return `
    <div class="modal-header">
      <span class="modal-title">🧪 Drive Diagnostics</span>
      <span class="modal-sub">${escapeHtml(diagnostics?.authMode || 'unknown')}</span>
    </div>
    <div class="modal-body">
      ${errorMessage ? `<div class="form-error" style="display:block;">${escapeHtml(errorMessage)}</div>` : ''}
      <div style="font-size:12px;color:var(--text2);line-height:1.8;background:var(--surface2);border:1px solid var(--border);padding:12px;border-radius:8px;">
        <div><strong>Root folder:</strong> ${escapeHtml(rootFolderLabel)}</div>
        <div><strong>Service account:</strong> ${escapeHtml(diagnostics?.serviceAccountEmail || '-')}</div>
      </div>
      <div>
        <div class="detail-section-title" style="margin-bottom:8px;">Checks</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${checksHtml}
        </div>
      </div>
      ${recs.length ? `
        <div>
          <div class="detail-section-title" style="margin-bottom:8px;">Recommendations</div>
          <ul class="detail-list expect-list">${recs.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </div>` : ''}
      <div>
        <div class="detail-section-title" style="margin-bottom:8px;">Raw JSON</div>
        <textarea class="form-textarea" readonly style="min-height:220px;font-family:'IBM Plex Mono',monospace;">${escapeHtml(raw)}</textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn-modal-cancel" onclick="closeModal()">ปิด</button>
      <button class="btn-modal-ok" onclick="copyDriveDiagnostics()">คัดลอก JSON</button>
    </div>`;
}

async function copyDriveDiagnostics() {
  if (!lastDriveDiagnostic) return;
  await navigator.clipboard.writeText(JSON.stringify(lastDriveDiagnostic, null, 2));
  alert('คัดลอก diagnostics แล้ว');
}

async function openDriveDiagnostics() {
  showLoadingOverlay('กำลังตรวจสอบ Google Drive...');
  let errorMessage = '';
  try {
    await fetchDriveDiagnostics(true);
  } catch (err) {
    errorMessage = buildErrorMessage(err);
    if (err.payload?.diagnostics) {
      lastDriveDiagnostic = err.payload.diagnostics;
    }
  } finally {
    hideLoadingOverlay();
  }

  openModal('drive-diagnostics-modal', renderDiagnosticsHtml(lastDriveDiagnostic, errorMessage));
}

function showFallbackBanner(message) {
  let el = document.getElementById('storage-mode-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'storage-mode-banner';
    el.style.cssText = 'position:sticky;top:112px;z-index:85;background:#FFF8E6;border-bottom:1px solid #F5D68A;padding:10px 16px;font-size:12px;color:#8A5200;display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;';
    document.body.insertBefore(el, document.querySelector('.main'));
  }
  el.innerHTML = `
    <span>กำลังแสดงข้อมูลสำรองแบบอ่านอย่างเดียว เพราะ Google Drive เชื่อมต่อไม่ได้${message ? `: <strong>${escapeHtml(message)}</strong>` : ''}</span>
    <button onclick="retryDriveConnect()" style="padding:5px 12px;background:#FFF;border:1px solid #F5D68A;border-radius:8px;cursor:pointer;color:#8A5200;font:inherit;">ลองเชื่อมต่อใหม่</button>`;
  el.style.display = 'flex';
}

function hideFallbackBanner() {
  const el = document.getElementById('storage-mode-banner');
  if (el) el.style.display = 'none';
}

async function useBundledFallback(err) {
  currentAppMode = APP_MODE.FALLBACK;
  lastDriveError = err;
  if (err?.payload?.diagnostics) {
    lastDriveDiagnostic = err.payload.diagnostics;
  } else {
    try {
      await fetchDriveDiagnostics(true);
    } catch {}
  }
  seedBundledData();
  DB_READY = false;
  resetUiState({ keepDiagnostic: true });
  showFallbackBanner(buildErrorMessage(err));
  syncAppView();
}

function ensureWritable() {
  if (currentAppMode === APP_MODE.DRIVE && DB_READY) return true;
  alert('Google Drive ยังเชื่อมต่อไม่ได้ ตอนนี้จึงเปิดได้เฉพาะโหมดดูข้อมูลชั่วคราว');
  return false;
}

function getStatus(id)       { return DB.status[id] || 'no-run'; }
function getDeletedSet()     { return new Set(DB.deletedCases); }
function getExecutionMeta(id){ return DB.executions?.[id] || null; }

function getExecutorNameList() {
  const fromDb = Object.values(DB.executions || {})
    .map(item => String(item?.executor || '').trim())
    .filter(Boolean);
  let fromLocal = [];
  try {
    const parsed = JSON.parse(localStorage.getItem('qa_executor_name_list') || '[]');
    if (Array.isArray(parsed)) {
      fromLocal = parsed.map(name => String(name || '').trim()).filter(Boolean);
    }
  } catch {}
  return [...new Set([...fromLocal, ...fromDb])];
}

function rememberExecutorName(name) {
  const normalized = String(name || '').trim();
  if (!normalized) return;
  const current = getExecutorNameList().filter(item => item !== normalized);
  const next = [normalized, ...current].slice(0, 30);
  localStorage.setItem('qa_executor_name_list', JSON.stringify(next));
}

function clearPendingWrites() {
  Object.values(gWriteQueue).forEach(handle => clearTimeout(handle));
  gWriteQueue = {};
}

function resetUiState({ keepDiagnostic = false } = {}) {
  clearPendingWrites();
  hideLoadingOverlay();
  hideSavingIndicator();
  hideFallbackBanner();
  document.getElementById('drive-expired-banner').style.display = 'none';
  document.getElementById('drive-status-badge').style.display = 'none';
  if (!keepDiagnostic) lastDriveDiagnostic = null;
  lastDriveError = null;
}

function applyDrivePayload(payload) {
  DRIVE_STATE = {
    rootFolderId: payload.rootFolderId || null,
    rootFolderName: payload.rootFolderName || '',
    featuresFolderId: payload.featuresFolderId || null,
    imagesFolderId: payload.imagesFolderId || null,
    statusFileId: payload.statusFileId || null,
  };

  DB = {
    features: {},
    status: payload.status || {},
    projects: (payload.status && payload.status.projects && typeof payload.status.projects === 'object') ? payload.status.projects : {},
    deletedCases: payload.deletedCases || [],
    executions: payload.executions || {},
  };

  (payload.features || []).forEach(feature => {
    const featureId = feature.featureId || feature.meta?.id;
    if (!featureId) return;
    DB.features[featureId] = {
      meta: feature.meta,
      cases: feature.cases || [],
      devCases: feature.devCases || [],
      defects: feature.defects || [],
      fileId: feature.fileId || null,
    };
  });
}

function renderAppShell() {
  document.getElementById('login-overlay').style.display = 'none';
  document.getElementById('drive-expired-banner').style.display = 'none';
  document.getElementById('drive-status-badge').style.display = currentAppMode === APP_MODE.DRIVE ? 'inline-flex' : 'none';
  init();
  APP_RUNTIME.initialized = true;
}

function syncAppView() {
  if (!APP_RUNTIME.initialized) {
    renderAppShell();
    return;
  }
  FEATURES = buildFeatures();
  rebuildNav();
  updateHeaderStrip();
  if (currentFeatureId === 'overview') {
    renderOverview();
    return;
  }
  const feature = FEATURES.find(item => item.meta.id === currentFeatureId);
  if (feature) {
    renderFeature(feature);
  } else {
    currentFeatureId = 'overview';
    renderOverview();
  }
}

function beginAsyncFlow(flowName) {
  const requestId = ++APP_RUNTIME.activeRequestId;
  APP_RUNTIME[flowName] = true;
  return requestId;
}

function endAsyncFlow(flowName, requestId) {
  if (APP_RUNTIME.activeRequestId === requestId) {
    APP_RUNTIME[flowName] = false;
  }
}

async function handleLogin() {
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('btn-login');
  errEl.style.display = 'none';
  if (!email || !password) {
    errEl.textContent = 'กรุณากรอก Email และ Password';
    errEl.style.display = 'block';
    return;
  }
  btn.textContent = 'กำลังเข้าสู่ระบบ...';
  btn.disabled = true;
  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const token = data?.session?.access_token || '';
    if (!token) throw new Error('Login failed: session not found');
    localStorage.setItem('qa_access_token', token);
    localStorage.setItem('qa_user_email', data?.user?.email || email);
    await connectDriveWithServiceAccount();
  } catch (err) {
    errEl.textContent = err.message === 'Invalid login credentials' ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : err.message;
    errEl.style.display = 'block';
    btn.textContent = 'เข้าสู่ระบบ';
    btn.disabled = false;
  }
}

async function handleLogout() {
  try {
    await supabaseClient.auth.signOut();
  } catch {}
  localStorage.removeItem('qa_access_token');
  localStorage.removeItem('qa_user_email');
  currentAppMode = APP_MODE.DRIVE;
  lastDriveError = null;
  lastDriveDiagnostic = null;
  DB_READY = false;
  location.reload();
}

async function retryDriveConnect() {
  document.getElementById('drive-expired-banner').style.display = 'none';
  await connectDriveWithServiceAccount({ reason: 'retry' });
}

async function connectDriveWithServiceAccount({ reason = 'manual', silent = false } = {}) {
  if (APP_RUNTIME.resetting) return false;
  if (APP_RUNTIME.connecting) return false;

  const requestId = beginAsyncFlow('connecting');
  if (!silent) showLoadingOverlay('กำลังโหลดข้อมูล');

  try {
    await loadAllData({ reason });
    return true;
  } catch (err) {
    await useBundledFallback(err);
    return false;
  } finally {
    if (!silent) hideLoadingOverlay();
    endAsyncFlow('connecting', requestId);
  }
}

async function bootstrapApp() {
  if (APP_RUNTIME.bootstrapping) return;
  const requestId = beginAsyncFlow('bootstrapping');
  try {
    const token = await getValidAccessToken();
    if (!token) return;
    document.getElementById('login-overlay').style.display = 'flex';
    await connectDriveWithServiceAccount({ reason: 'bootstrap' });
  } catch (err) {
    console.warn('Unable to restore session', err);
    localStorage.removeItem('qa_access_token');
    document.getElementById('login-overlay').style.display = 'flex';
  } finally {
    endAsyncFlow('bootstrapping', requestId);
  }
}

bootstrapApp();

supabaseClient.auth.onAuthStateChange((_event, session) => {
  if (session?.access_token) {
    localStorage.setItem('qa_access_token', session.access_token);
    if (session.user?.email) localStorage.setItem('qa_user_email', session.user.email);
  } else {
    localStorage.removeItem('qa_access_token');
    localStorage.removeItem('qa_user_email');
  }
});

async function persistFeatureFile(featureId) {
  const f = DB.features[featureId];
  if (!f) return;
  const result = await driveProxyRequest('feature-upsert', {
    method: 'POST',
    body: {
      featureId,
      meta: f.meta,
      cases: f.cases,
      devCases: f.devCases || [],
      defects: f.defects || [],
      fileId: f.fileId || '',
    },
  });
  f.fileId = result.fileId || f.fileId;
}

async function writeFeatureFile(featureId) {
  await persistFeatureFile(featureId);
  hideSavingIndicator();
}

async function writeStatusFile() {
  syncProjectRegistryToStatus();
  await driveProxyRequest('status-upsert', {
    method: 'POST',
    body: {
      status: DB.status,
      deletedCases: DB.deletedCases,
      executions: DB.executions || {},
    },
  });
  hideSavingIndicator();
}

function handleDriveMutationError(err) {
  lastDriveError = err;
  if (err?.payload?.diagnostics) lastDriveDiagnostic = err.payload.diagnostics;
  hideSavingIndicator();
  document.getElementById('drive-expired-banner').style.display = 'flex';
  console.error('Drive mutation error', err);
}

async function seedBundledFeaturesIfNeeded() {
  if (Object.keys(DB.features).length > 0) return;
  const templates = getBundledFeatureTemplates();
  if (!templates.length) return;

  showLoadingOverlay('กำลังโหลด feature เริ่มต้น...');
  for (const template of templates) {
    DB.features[template.meta.id] = {
      meta: cloneJson(template.meta),
      cases: cloneJson(template.cases),
      devCases: [],
      defects: [],
      fileId: null,
    };
    await persistFeatureFile(template.meta.id);
  }
}

async function loadAllData({ reason = 'manual' } = {}) {
  const payload = await driveProxyRequest('bootstrap');
  applyDrivePayload(payload);
  currentAppMode = APP_MODE.DRIVE;
  DB_READY = true;
  await seedBundledFeaturesIfNeeded();
  resetUiState({ keepDiagnostic: true });
  if (reason !== 'reset') {
    syncAppView();
  }
}

function scheduleFeatureWrite(featureId) {
  showSavingIndicator();
  clearTimeout(gWriteQueue[featureId]);
  gWriteQueue[featureId] = setTimeout(() => {
    writeFeatureFile(featureId).catch(handleDriveMutationError);
  }, 800);
}

function scheduleStatusWrite() {
  showSavingIndicator();
  clearTimeout(gWriteQueue.__status__);
  gWriteQueue.__status__ = setTimeout(() => {
    writeStatusFile().catch(handleDriveMutationError);
  }, 800);
}

async function setStatus(id, st, executionMeta = null) {
  DB.status[id] = st;
  if (!DB.executions) DB.executions = {};
  if (executionMeta) {
    DB.executions[id] = executionMeta;
  }
  scheduleStatusWrite();
}

async function saveNewFeature(meta) {
  DB.features[meta.id] = { meta, cases: [], devCases: [], defects: [], fileId: null };
  await writeFeatureFile(meta.id);
}

async function deleteFeatureData(featureId) {
  const f = DB.features[featureId];
  await driveProxyRequest('feature-delete', {
    method: 'DELETE',
    query: { featureId, fileId: f?.fileId || '' },
  });
  delete DB.features[featureId];
}

async function saveCase(featureId, c) {
  const f = DB.features[featureId];
  if (!f) return;
  const idx = f.cases.findIndex(x => x.id === c.id);
  if (idx >= 0) f.cases[idx] = c;
  else f.cases.push(c);
  scheduleFeatureWrite(featureId);
}

async function deleteCaseData(featureId, caseId) {
  const f = DB.features[featureId];
  if (f) f.cases = f.cases.filter(c => c.id !== caseId);
  if (!DB.deletedCases.includes(caseId)) DB.deletedCases.push(caseId);
  if (DB.executions?.[caseId]) delete DB.executions[caseId];
  scheduleFeatureWrite(featureId);
  scheduleStatusWrite();
}

async function resetAllStatusDB() {
  DB.status = {};
  DB.executions = {};
  scheduleStatusWrite();
}

async function driveUploadImages(files, caseId) {
  const form = new FormData();
  form.append('caseId', caseId);
  files.forEach(file => form.append('files', file));
  const result = await driveProxyRequest('image-upload', {
    method: 'POST',
    formData: form,
  });
  return result.images || [];
}


async function driveUploadAttachments(files, folderKey) {
  const form = new FormData();
  form.append('folderKey', folderKey);
  files.forEach(file => form.append('files', file));
  const result = await driveProxyRequest('attachment-upload', {
    method: 'POST',
    formData: form,
  });
  return result.files || result.images || [];
}

async function driveDeleteFile(fileId) {
  await driveProxyRequest('file-delete', {
    method: 'DELETE',
    query: { fileId },
  });
}

function showLoadingOverlay(msg = 'Loading...') {
  let el = document.getElementById('db-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'db-loading';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,.9);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;gap:14px;font-family:inherit;';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div style="width:36px;height:36px;border:3px solid #e0e0e0;border-top-color:#4A3AB0;border-radius:50%;animation:spin .7s linear infinite;"></div>
    <div style="font-size:14px;color:#555;">${escapeHtml(msg)}</div>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>`;
  el.style.display = 'flex';
}

function hideLoadingOverlay() {
  const el = document.getElementById('db-loading');
  if (el) el.style.display = 'none';
}

function showDBError(err) {
  void useBundledFallback(err);
}

function showSavingIndicator() {
  const el = document.getElementById('saving-indicator');
  if (el) el.style.display = 'flex';
}

function hideSavingIndicator() {
  const el = document.getElementById('saving-indicator');
  if (el) el.style.display = 'none';
}

// ══════════════════════════════════════════
//  APP CORE
// ══════════════════════════════════════════
const STATUSES = [
  { key:'no-run',    label:'No Run',    icon:'○', cssClass:'ss-norun',     filterClass:'active-st-norun'    },
  { key:'executing', label:'Executing', icon:'⟳', cssClass:'ss-executing', filterClass:'active-st-executing'},
  { key:'passed',    label:'Passed',    icon:'✓', cssClass:'ss-passed',    filterClass:'active-st-passed'   },
  { key:'failed',    label:'Failed',    icon:'✗', cssClass:'ss-failed',    filterClass:'active-st-failed'   },
  { key:'blocked',   label:'Blocked',   icon:'⊘', cssClass:'ss-blocked',   filterClass:'active-st-blocked'  },
  { key:'cancelled', label:'Cancelled', icon:'↩', cssClass:'ss-cancelled', filterClass:'active-st-cancelled'},
];
const STATUS_COLORS = {
  'no-run':'#D5D3CE','executing':'#B5D0F0','passed':'#A8D49D',
  'failed':'#F5AAAA','blocked':'#F5D68A','cancelled':'#C5BCEF',
};
const THEME_COLORS = {
  orange:{color:'#D95F02',colorBg:'#FFF4EC',colorBorder:'#F5C49A',badge:'badge-orange'},
  blue:  {color:'#185FA5',colorBg:'#EAF2FB',colorBorder:'#B5D0F0',badge:'badge-blue'},
  green: {color:'#276B1F',colorBg:'#EBF5E8',colorBorder:'#A8D49D',badge:'badge-green'},
  purple:{color:'#4A3AB0',colorBg:'#F0EFFE',colorBorder:'#C5BCEF',badge:'badge-purple'},
  teal:  {color:'#0F6B6B',colorBg:'#E6F5F5',colorBorder:'#8DD4D4',badge:'badge-teal'},
  amber: {color:'#8A5200',colorBg:'#FFF8E6',colorBorder:'#F5D68A',badge:'badge-gray'},
};
const SCREEN_THEME_COLORS = {
  purple:{bg:'#F0EFFE',color:'#4A3AB0',border:'#C5BCEF'},
  blue:  {bg:'#EAF2FB',color:'#185FA5',border:'#B5D0F0'},
  orange:{bg:'#FFF4EC',color:'#D95F02',border:'#F5C49A'},
  green: {bg:'#EBF5E8',color:'#276B1F',border:'#A8D49D'},
  amber: {bg:'#FFF8E6',color:'#8A5200',border:'#F5D68A'},
  teal:  {bg:'#E6F5F5',color:'#0F6B6B',border:'#8DD4D4'},
};
const SCREEN_PALETTE=[
  SCREEN_THEME_COLORS.purple, SCREEN_THEME_COLORS.blue, SCREEN_THEME_COLORS.orange,
  SCREEN_THEME_COLORS.green, SCREEN_THEME_COLORS.amber, SCREEN_THEME_COLORS.teal,
];
function getScreenStyle(i){return SCREEN_PALETTE[i%SCREEN_PALETTE.length];}

let FEATURES=[], currentFeatureId='overview', activeType='all', activeScreen='all', activeStatusFilt='all', expandedCaseId=null, activeFeatureTab='qa';

function buildFeatures() {
  const deleted = getDeletedSet();
  return Object.values(DB.features).map(f => ({
    meta: f.meta,
    cases: (f.cases || []).filter(c => !deleted.has(c.id)),
    devCases: Array.isArray(f.devCases) ? f.devCases : [],
    defects: Array.isArray(f.defects) ? f.defects : [],
    custom: true,
  }));
}

function getStatusCounts(cases){
  const c={};STATUSES.forEach(s=>c[s.key]=0);
  cases.forEach(tc=>{const st=getStatus(tc.id);c[st]=(c[st]||0)+1;});return c;
}
function buildProgressBar(counts,total,seg){
  return STATUSES.map(s=>{
    if(!counts[s.key])return'';
    const pct=total?(counts[s.key]/total*100).toFixed(1):0;
    return`<div class="${seg}" style="width:${pct}%;background:${STATUS_COLORS[s.key]};"></div>`;
  }).join('');
}

function statusSelectHtml(caseId,featureId){
  const cur=getStatus(caseId);
  const def=STATUSES.find(s=>s.key===cur)||STATUSES[0];
  const opts=STATUSES.map(s=>`<option value="${s.key}"${s.key===cur?' selected':''}>${s.icon} ${s.label}</option>`).join('');
  return`<select class="status-select ${def.cssClass}" onclick="event.stopPropagation()" onchange="onStatusChange('${caseId}','${featureId}',this)">${opts}</select>`;
}

function applyStatusSelectClass(sel, statusKey) {
  STATUSES.forEach(s => sel.classList.remove(s.cssClass));
  sel.classList.add((STATUSES.find(s=>s.key===statusKey)||STATUSES[0]).cssClass);
}

function getStatusLabel(statusKey) {
  return (STATUSES.find(s => s.key === statusKey)?.label) || statusKey || '-';
}

function formatExecTimestamp(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat('th-TH', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function openExecutionNoteModal(featureId, caseId, nextStatus = '', options = {}) {
  const mergedOptions = { reRender: true, ...options };
  const targetStatus = nextStatus || getStatus(caseId) || 'no-run';
  const existing = getExecutionMeta(caseId) || {};
  const executorOptions = getExecutorNameList();
  const executorOptionHtml = executorOptions
    .map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    .join('');

  return new Promise(resolve => {
    openModal('execution-note-modal', `
      <div class="modal-header">
        <span class="modal-title">📝 Execute / Remark</span>
        <span class="modal-sub">${escapeHtml(caseId)}</span>
      </div>
      <div class="modal-body">
        <div style="font-size:12px;color:var(--text2);background:var(--surface2);border:1px solid var(--border);padding:10px 12px;border-radius:8px;line-height:1.7;">
          <div><strong>Status:</strong> ${escapeHtml(getStatusLabel(targetStatus))}</div>
          <div><strong>Last update:</strong> ${escapeHtml(formatExecTimestamp(existing.updatedAt))}</div>
        </div>
        <div class="form-group" style="margin-top:10px;">
          <label>Execute by <span class="form-hint" style="color:var(--red);">* required</span></label>
          <select class="form-select" id="exec-name-preset" style="margin-bottom:8px;">
            <option value="">เลือกรายชื่อที่เคยใช้...</option>
            ${executorOptionHtml}
          </select>
          <input class="form-input" id="exec-name" list="exec-name-list" value="${escapeHtml(existing.executor || '')}" placeholder="ชื่อคน execute" />
          <datalist id="exec-name-list">
            ${executorOptionHtml}
          </datalist>
        </div>
        <div class="form-group">
          <label>Remark</label>
          <textarea class="form-textarea" id="exec-remark" rows="4" placeholder="หมายเหตุการทดสอบ (ถ้ามี)">${escapeHtml(existing.remark || '')}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-modal-cancel" id="exec-cancel-btn">ยกเลิก</button>
        <button class="btn-modal-ok" id="exec-save-btn">บันทึก</button>
      </div>`);

    const cancelBtn = document.getElementById('exec-cancel-btn');
    const saveBtn = document.getElementById('exec-save-btn');
    const presetSelect = document.getElementById('exec-name-preset');
    const nameInput = document.getElementById('exec-name');
    const remarkInput = document.getElementById('exec-remark');

    const closeAndResolve = (ok) => {
      closeModal();
      resolve(ok);
    };

    cancelBtn.onclick = () => closeAndResolve(false);
    if (existing.executor && presetSelect) {
      const hasOption = executorOptions.includes(existing.executor);
      if (hasOption) presetSelect.value = existing.executor;
    }
    if (presetSelect) {
      presetSelect.onchange = () => {
        if (!presetSelect.value) return;
        nameInput.value = presetSelect.value;
        nameInput.focus();
      };
    }

    saveBtn.onclick = async () => {
      const executor = nameInput.value.trim();
      const remark = remarkInput.value.trim();
      if (!executor) {
        showFormError('กรุณากรอกชื่อคน execute');
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'กำลังบันทึก...';
      try {
        rememberExecutorName(executor);
        await setStatus(caseId, targetStatus, {
          executor,
          remark,
          status: targetStatus,
          updatedAt: new Date().toISOString(),
        });
        if (mergedOptions.reRender) {
          FEATURES = buildFeatures();
          updateHeaderStrip();
          if (currentFeatureId === 'overview') {
            refreshFeatureRowStats(featureId);
          } else {
            const feat = FEATURES.find(f => f.meta.id === featureId);
            if (feat) renderFeature(feat);
          }
        }
        closeAndResolve(true);
      } catch (error) {
        showFormError(`บันทึกไม่สำเร็จ: ${error.message}`);
        saveBtn.disabled = false;
        saveBtn.textContent = 'บันทึก';
      }
    };
  });
}

async function onStatusChange(caseId,featureId,sel){
  const prevStatus = getStatus(caseId);
  const nextStatus = sel.value;
  if (!ensureWritable()) {
    sel.value = prevStatus;
    applyStatusSelectClass(sel, prevStatus);
    return;
  }
  if (nextStatus === prevStatus) {
    applyStatusSelectClass(sel, prevStatus);
    return;
  }

  expandedCaseId = caseId;
  const saved = await openExecutionNoteModal(featureId, caseId, nextStatus, { reRender: false });
  if (!saved) {
    sel.value = prevStatus;
    applyStatusSelectClass(sel, prevStatus);
    return;
  }

  applyStatusSelectClass(sel, nextStatus);
  FEATURES = buildFeatures();
  updateHeaderStrip();
  if(currentFeatureId==='overview'){
    refreshFeatureRowStats(featureId);
  }else{
    const feat = FEATURES.find(f=>f.meta.id===featureId);
    if (feat) {
      renderFeature(feat);
      requestAnimationFrame(() => {
        if (expandedCaseId) toggleDetail(expandedCaseId, true);
      });
    } else {
      refreshStatusStatsBar(featureId);
    }
  }
}

function init(){
  initTheme();
  activeSortMode = '';
  FEATURES=buildFeatures();
  injectScreenStyles();buildNavTabs();renderOverview();updateHeaderStrip();renderProjectSidebarDrawer();
}

function injectScreenStyles(){
  let s=document.getElementById('dyn-styles');
  if(!s){s=document.createElement('style');s.id='dyn-styles';document.head.appendChild(s);}
  s.textContent='';
  FEATURES.forEach(f=>Object.entries(f.meta.screens).forEach(([,sc],i)=>{
    const p = (sc?.bg && sc?.color && sc?.border)
      ? { bg: sc.bg, color: sc.color, border: sc.border }
      : (sc?.tone && SCREEN_THEME_COLORS[sc.tone]
        ? SCREEN_THEME_COLORS[sc.tone]
        : getScreenStyle(i));
    s.textContent+=`.${sc.cssClass}{background:${p.bg};color:${p.color};border:1px solid ${p.border};}`;
  }));
}

function updateHeaderStrip(){
  FEATURES=buildFeatures();
  const ac=FEATURES.flatMap(f=>f.cases),counts=getStatusCounts(ac);
  const el=document.getElementById('hdr-status-strip');if(!el)return;
  el.innerHTML=STATUSES.filter(s=>counts[s.key]>0).map(s=>
    `<span class="hdr-stat" style="background:${STATUS_COLORS[s.key]}22;color:var(--st-${s.key});border-color:${STATUS_COLORS[s.key]};">
      <span class="dot" style="background:${STATUS_COLORS[s.key]};"></span>${s.label} <strong>${counts[s.key]}</strong>
    </span>`).join('')+
    `<span style="font-size:11px;color:var(--text3);margin-left:2px;">${ac.length} total</span>`;
}

function buildNavTabs(){
  const wrap = document.getElementById('nav-tabs');
  if (!wrap) return;
  FEATURES = buildFeatures();
  const feature = FEATURES.find(item => item.meta.id === currentFeatureId);
  if (!feature) {
    wrap.innerHTML = '';
    wrap.parentElement?.classList.add('nav-tabs-wrap-hidden');
    return;
  }
  wrap.parentElement?.classList.remove('nav-tabs-wrap-hidden');
  const projectId = sanitizeProjectId(feature.meta.projectId || selectedProjectId || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID);
  const siblings = getProjectFeatureStores(projectId).map(store => store.meta).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
  wrap.innerHTML = siblings.map(meta => `<button class="nav-tab${meta.id===currentFeatureId?' active':''}" onclick="switchTab('${meta.id}')">${escapeHtml(meta.emoji || '📋')} ${escapeHtml(meta.name)}</button>`).join('');
}
function rebuildNav(){
  FEATURES=buildFeatures();
  buildNavTabs();
}
function switchTab(id){
  currentFeatureId=id; expandedCaseId=null; activeType='all'; activeScreen='all'; activeStatusFilt='all';
  if(id==='overview'){ renderOverview(); rebuildNav(); return; }
  if(id==='projects'){ setSelectedProject(selectedProjectId); renderProjectsPage(); rebuildNav(); return; }
  const f=FEATURES.find(f=>f.meta.id===id);
  if(f){
    selectedProjectId = sanitizeProjectId(f.meta.projectId || selectedProjectId || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID);
    renderFeature(f);
    rebuildNav();
  }
}

// ── OVERVIEW ──────────────────────────────
function renderOverview(){
  FEATURES=buildFeatures();
  renderProjectSidebarDrawer();
  const projects = getProjectsList();
  const cards = projects.map(project => {
    const stats = getProjectStats(project.id);
    return `<button class="overview-project-card" type="button" onclick="switchProjectView('${project.id}')"><div class="overview-project-head"><div class="overview-project-main">${getProjectAvatarHtml(project, 'overview-project-avatar')}<div><div class="overview-project-name">${escapeHtml(project.name)}</div><div class="overview-project-text">${escapeHtml(project.overview || 'ยังไม่มี Project Overview')}</div></div></div><div class="overview-project-badges"><span class="project-pill blue">${stats.features} Features</span><span class="project-pill green">${stats.qa} QA</span><span class="project-pill purple">${stats.dev} Dev</span><span class="project-pill orange">${stats.defects} Defects</span></div></div><div class="overview-project-foot"><div class="progress-line full"><span style="width:${stats.progress}%;"></span></div><div class="overview-project-meta">กดเพื่อเปิด project นี้</div></div></button>`;
  }).join('');
  document.getElementById('main-content').innerHTML=`<section class="overview-projects-page"><div class="section-sep"><span>Projects Overview</span><span class="count-pill">${projects.length} projects</span></div><div class="overview-project-list">${cards || `<div class="empty-state"><div class="emoji">📁</div><p>ยังไม่มี project — กด <strong>☰</strong> เพื่อสร้าง</p></div>`}</div></section>`;
}

function buildFeatureRow(f){
  const counts=getStatusCounts(f.cases),total=f.cases.length;
  const tags=(f.meta.tags||[]).map(renderFeatureTag).join('');
  const mini=STATUSES.filter(s=>counts[s.key]>0).map(s=>
    `<span class="ov-mini-stat" style="background:${STATUS_COLORS[s.key]}22;color:var(--st-${s.key});border-color:${STATUS_COLORS[s.key]};">${s.icon} ${s.label} ${counts[s.key]}</span>`
  ).join('')||`<span style="font-size:11px;color:var(--text3);">No Run</span>`;
  return`<div class="ov-feature-row" onclick="switchTab('${f.meta.id}')">
    <div class="ov-feature-icon" style="background:${f.meta.colorBg};border-color:${f.meta.colorBorder};">${f.meta.emoji}</div>
    <div class="ov-feature-info"><div class="ov-feature-name">${f.meta.name}
      <button class="icon-btn icon-btn-danger" onclick="event.stopPropagation();confirmDeleteFeature('${f.meta.id}')" title="ลบ feature">🗑</button>
    </div>
      <div class="ov-feature-desc">${f.meta.description}</div><div class="ov-feature-tags">${tags}</div></div>
    <div class="ov-feature-stats" id="ov-row-stats-${f.meta.id}">
      <div class="ov-stat-row">${mini}</div>
      <div class="ov-progress-track" style="width:180px;">${buildProgressBar(counts,total,'ov-pt-seg')}</div>
      <div style="font-size:11px;color:var(--text3);">${total} cases</div>
    </div>
  </div>`;
}

function refreshFeatureRowStats(fid){
  FEATURES=buildFeatures();const f=FEATURES.find(f=>f.meta.id===fid);if(!f)return;
  const el=document.getElementById(`ov-row-stats-${fid}`);if(!el)return;
  const counts=getStatusCounts(f.cases),total=f.cases.length;
  const mini=STATUSES.filter(s=>counts[s.key]>0).map(s=>
    `<span class="ov-mini-stat" style="background:${STATUS_COLORS[s.key]}22;color:var(--st-${s.key});border-color:${STATUS_COLORS[s.key]};">${s.icon} ${s.label} ${counts[s.key]}</span>`
  ).join('')||`<span style="font-size:11px;color:var(--text3);">No Run</span>`;
  el.innerHTML=`<div class="ov-stat-row">${mini}</div><div class="ov-progress-track" style="width:180px;">${buildProgressBar(counts,total,'ov-pt-seg')}</div><div style="font-size:11px;color:var(--text3);">${total} cases</div>`;
}

// ── FEATURE VIEW ───────────────────────────
function renderFeature(feature){
  const { meta, cases } = feature;
  const tags = (meta.tags || []).map(renderFeatureTag).join('');
  const screenOptionHtml = [`<option value="all">All screens</option>`]
    .concat(Object.entries(meta.screens).map(([k, sc]) => `<option value="${k}"${activeScreen===k?' selected':''}>${escapeHtml(sc.label)} – ${escapeHtml(sc.name)}</option>`))
    .join('');
  const devCount = (feature.devCases || []).length;
  const defectCount = (feature.defects || []).length;
  const isQaTab = activeFeatureTab === 'qa';
  document.getElementById('main-content').innerHTML=`
    <div class="feature-topline">
      <button class="icon-btn icon-btn-neutral" onclick="switchTab('projects')">← กลับไปที่ ${escapeHtml(meta.projectName || 'Project')}</button>
      <span class="count-pill">${getProjectFeatureStores(sanitizeProjectId(meta.projectId || selectedProjectId || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID)).length} features ใน project เดียวกัน</span>
    </div>
    <div class="feature-header">
      <div style="font-size:24px;">${meta.emoji}</div>
      <div class="feature-info" style="flex:1;"><div class="feature-name">${meta.name}</div>
        <div class="feature-desc">${meta.description}</div><div class="feature-tags">${tags}</div></div>
      <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;">
        <button class="icon-btn icon-btn-neutral" onclick="openEditFeatureModal('${meta.id}')">✏️ แก้ไข Feature</button>
        <button class="icon-btn icon-btn-danger" onclick="confirmDeleteFeature('${meta.id}')">🗑 ลบ Feature</button>
        <button class="btn-import-csv" onclick="openImportCsvModal('${meta.id}')">📥 Import CSV</button>
        <button class="btn-export-csv" onclick="exportCsv('${meta.id}')">📤 Export CSV</button>
        <button class="btn-add-case" onclick="openAddCaseModal('${meta.id}')">＋ Add case</button>
      </div>
    </div>
    <div class="feature-subtabs">
      <button class="feature-subtab${activeFeatureTab==='qa'?' active':''}" onclick="switchFeatureSubTab('qa')">QA Cases <span class="count-pill">${cases.length}</span></button>
      <button class="feature-subtab${activeFeatureTab==='dev'?' active':''}" onclick="switchFeatureSubTab('dev')">Dev Cases <span class="count-pill">${devCount}</span></button>
      <button class="feature-subtab${activeFeatureTab==='defect'?' active':''}" onclick="switchFeatureSubTab('defect')">Defects <span class="count-pill">${defectCount}</span></button>
    </div>
    <div id="feature-tab-content">
      ${isQaTab ? renderQaCasesPanel(feature, screenOptionHtml) : ''}
    </div>`;
  if (isQaTab) {
    updateTypeStats(cases);
    refreshStatusStatsBar(meta.id);
    applyFilters();
  } else {
    renderFeatureSubTabContent(feature);
  }
}

function renderQaCasesPanel(feature, screenOptionHtml){
  const { meta, cases } = feature;
  return `
    <div class="stats-grid">
      <div class="stat-card"><div class="num num-blue" id="s-total">—</div><div class="lbl">Total</div></div>
      <div class="stat-card"><div class="num num-green" id="s-pos">—</div><div class="lbl">Positive</div></div>
      <div class="stat-card"><div class="num num-amber" id="s-edge">—</div><div class="lbl">Edge</div></div>
      <div class="stat-card"><div class="num num-red" id="s-neg">—</div><div class="lbl">Negative</div></div>
    </div>
    <div class="status-stats-grid" id="status-stats-bar"></div>
    <div class="search-wrap">
      <svg class="search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l3 3"/></svg>
      <input type="text" id="search-input" placeholder="ค้นหา test case..." oninput="applyFilters()" />
    </div>
    <div class="list-toolbar list-toolbar-single">
      <div class="list-toolbar-item list-toolbar-actions">
        <button class="icon-btn icon-btn-neutral" onclick="toggleFilterPanel()">⚙️ Filter</button>
      </div>
    </div>
    <div class="filter-panel" id="filter-panel" hidden>
      <div class="filter-panel-grid">
        <div class="form-group">
          <label>Type</label>
          <select id="filter-type-select" class="form-select">
            <option value="all"${activeType==='all'?' selected':''}>All types</option>
            <option value="positive"${activeType==='positive'?' selected':''}>Positive</option>
            <option value="edge"${activeType==='edge'?' selected':''}>Edge case</option>
            <option value="negative"${activeType==='negative'?' selected':''}>Negative</option>
          </select>
        </div>
        <div class="form-group">
          <label>Screen</label>
          <select id="filter-screen-select" class="form-select">${screenOptionHtml}</select>
        </div>
        <div class="form-group">
          <label>Status</label>
          <select id="filter-status-select" class="form-select">
            <option value="all"${activeStatusFilt==='all'?' selected':''}>All status</option>
            ${STATUSES.map(s=>`<option value="${s.key}"${activeStatusFilt===s.key?' selected':''}>${s.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="filter-panel-actions">
        <button class="btn-modal-cancel" onclick="clearFilterPanel()">Clear</button>
        <button class="btn-modal-ok" onclick="applyFilterPanel()">Apply</button>
      </div>
      <div class="filter-summary" id="filter-summary"></div>
    </div>
    <div class="section-sep"><span>Test cases — ${meta.name}</span><span class="count-pill" id="showing-count">— / ${cases.length}</span></div>
    <table class="tc-table">
      <thead><tr>
        <th class="col-id">ID</th><th class="col-screen hide-sm">Screen</th>
        <th class="col-title">Test case</th><th class="col-type hide-sm">Type</th>
        <th class="col-status">Status</th><th class="col-actions"></th>
      </tr></thead>
      <tbody id="tc-tbody"></tbody>
    </table>
    <div class="empty-state" id="empty-state" style="display:none;"><div class="emoji">🔍</div><p>ไม่พบ test case</p></div>`;
}

function switchFeatureSubTab(tab){
  activeFeatureTab = tab;
  expandedCaseId = null;
  const feature = FEATURES.find(item => item.meta.id === currentFeatureId);
  if (feature) renderFeature(feature);
}

function getActiveFeatureStore(){
  return DB.features[currentFeatureId] || null;
}

function renderFeatureSubTabContent(feature){
  const host = document.getElementById('feature-tab-content');
  if (!host) return;
  if (activeFeatureTab === 'dev') {
    host.innerHTML = renderDevCasesTab(feature);
  } else if (activeFeatureTab === 'defect') {
    host.innerHTML = renderDefectsTab(feature);
  }
}

function renderDevCasesTab(feature){
  const list = feature.devCases || [];
  return `
    <div class="section-sep"><span>Dev Cases — ${feature.meta.name}</span><span class="count-pill">${list.length} items</span></div>
    <div class="workspace-toolbar"><button class="btn-add-case" onclick="addDevCase('${feature.meta.id}')">＋ Add Dev Case</button></div>
    <div class="workspace-list">
      ${list.length ? list.map((item, idx) => renderDevCaseCard(feature.meta.id, item, idx)).join('') : `<div class="empty-state empty-subtab"><div class="emoji">🧪</div><p>ยังไม่มี Dev case</p></div>`}
    </div>`;
}

function renderDevCaseCard(featureId, item, idx){
  return `
    <div class="workspace-card">
      <div class="workspace-card-head"><strong>DEV-${idx+1}</strong><button class="icon-btn icon-btn-danger icon-btn-compact" onclick="removeDevCase('${featureId}','${item.id}')">🗑</button></div>
      ${renderWorkspaceUpdateMeta(item)}
      <div class="workspace-grid workspace-grid-2">
        <div class="form-group"><label>Title</label><input class="form-input" value="${escapeHtml(item.title || '')}" onchange="updateDevCaseField('${featureId}','${item.id}','title',this.value)" /></div>
        <div class="form-group"><label>Owner</label><input class="form-input" value="${escapeHtml(item.owner || '')}" onchange="updateDevCaseField('${featureId}','${item.id}','owner',this.value)" /></div>
        <div class="form-group"><label>Test Type</label>
          <select class="form-select" onchange="updateDevCaseField('${featureId}','${item.id}','testType',this.value)">
            ${['unit','integration','api','ui','manual'].map(type => `<option value="${type}"${item.testType===type?' selected':''}>${type}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>Status</label>
          <select class="form-select" onchange="updateDevCaseField('${featureId}','${item.id}','status',this.value)">
            ${['draft','ready','tested','blocked'].map(status => `<option value="${status}"${item.status===status?' selected':''}>${status}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="workspace-grid">
        <div class="form-group"><label>Scenario</label><textarea class="form-textarea" onchange="updateDevCaseField('${featureId}','${item.id}','scenario',this.value)">${escapeHtml(item.scenario || '')}</textarea></div>
        <div class="form-group"><label>Steps / Note</label><textarea class="form-textarea" onchange="updateDevCaseField('${featureId}','${item.id}','note',this.value)">${escapeHtml(item.note || '')}</textarea></div>
      </div>
    </div>`;
}

function renderDefectsTab(feature){
  const defects = feature.defects || [];
  const qaCases = feature.cases || [];
  return `
    <div class="section-sep"><span>Defects — ${feature.meta.name}</span><span class="count-pill">${defects.length} items</span></div>
    <div class="workspace-toolbar"><button class="btn-add-case" onclick="addDefect('${feature.meta.id}')">＋ Log Defect</button></div>
    <div class="workspace-list">
      ${defects.length ? defects.map((item, idx) => renderDefectCard(feature.meta.id, item, idx, qaCases)).join('') : `<div class="empty-state empty-subtab"><div class="emoji">🐞</div><p>ยังไม่มี Defect</p></div>`}
    </div>`;
}

function renderDefectCard(featureId, item, idx, qaCases){
  const defect = normalizeDefectRecord(item);
  const attachments = defect.attachments || [];
  const comments = defect.comments || [];
  const history = defect.history || [];
  const linkedSummary = defect.testCaseIds?.length
    ? defect.testCaseIds.map(id => `<span class="mini-chip">${escapeHtml(id)}</span>`).join('')
    : '<span class="workspace-empty-inline">ยังไม่ผูก test case</span>';
  return `
    <div class="workspace-card defect-card">
      <div class="workspace-card-head"><strong>BUG-${idx+1}</strong><button class="icon-btn icon-btn-danger icon-btn-compact" onclick="removeDefect('${featureId}','${defect.id}')">🗑</button></div>
      ${renderWorkspaceUpdateMeta(defect)}
      <div class="workspace-grid workspace-grid-3">
        <div class="form-group"><label>Title</label><input class="form-input" value="${escapeHtml(defect.title || '')}" onchange="updateDefectField('${featureId}','${defect.id}','title',this.value)" /></div>
        <div class="form-group"><label>Build Version</label><input class="form-input" value="${escapeHtml(defect.buildVersion || '')}" onchange="updateDefectField('${featureId}','${defect.id}','buildVersion',this.value)" placeholder="เช่น 2.4.1 (145)" /></div>
        <div class="form-group"><label>Owner</label><input class="form-input" value="${escapeHtml(defect.owner || '')}" onchange="updateDefectField('${featureId}','${defect.id}','owner',this.value)" /></div>
        <div class="form-group"><label>Severity</label><select class="form-select" onchange="updateDefectField('${featureId}','${defect.id}','severity',this.value)">${['low','medium','high','critical'].map(v => `<option value="${v}"${defect.severity===v?' selected':''}>${v}</option>`).join('')}</select></div>
        <div class="form-group"><label>Status</label><select class="form-select" onchange="updateDefectField('${featureId}','${defect.id}','status',this.value)">${['open','in-progress','fixed','retest','closed'].map(v => `<option value="${v}"${defect.status===v?' selected':''}>${v}</option>`).join('')}</select></div>
        <div class="form-group"><label>Linked Test Cases</label>${renderLinkedTestCaseSelector(featureId, defect, qaCases)}</div>
      </div>
      <div class="workspace-linked-summary"><span class="workspace-meta-label">Linked Test Case IDs</span><div class="mini-chip-wrap">${linkedSummary}</div></div>
      <div class="workspace-grid workspace-grid-2">
        <div class="form-group"><label>Description</label><textarea class="form-textarea" onchange="updateDefectField('${featureId}','${defect.id}','description',this.value)">${escapeHtml(defect.description || '')}</textarea></div>
        <div class="form-group"><label>Fix Summary</label><textarea class="form-textarea" onchange="updateDefectField('${featureId}','${defect.id}','fixSummary',this.value)">${escapeHtml(defect.fixSummary || '')}</textarea></div>
      </div>
      <div class="workspace-grid workspace-grid-2">
        <div class="form-group"><label>Upload attachment</label><div class="attachment-upload-row"><label class="btn-modal-ok workspace-upload-btn">Upload file / video<input type="file" multiple accept="image/*,video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" style="display:none" onchange="uploadDefectAttachments(event,'${featureId}','${defect.id}')"></label><div class="workspace-help-text">รองรับรูปภาพและวิดีโอ .mp4 .mov .webm</div></div></div>
        <div class="form-group"><label>Add comment</label><div class="comment-entry"><textarea class="form-textarea" id="comment-input-${defect.id}" placeholder="ใส่ comment เพิ่มเติม"></textarea><label class="btn-modal-secondary workspace-upload-btn comment-upload-btn">แนบไฟล์/วิดีโอ<input id="comment-files-${defect.id}" type="file" multiple accept="image/*,video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" style="display:none"></label><button class="btn-modal-ok" type="button" onclick="addDefectComment('${featureId}','${defect.id}')">Add comment</button></div></div>
      </div>
      <div class="workspace-meta-row workspace-meta-row-stacked">
        <div class="workspace-meta-block"><span class="workspace-meta-label">Attachments</span>
          ${renderAttachmentGallery(attachments, featureId, defect.id)}
        </div>
        <div class="workspace-meta-block"><span class="workspace-meta-label">Comment History</span>
          ${renderDefectComments(comments)}
        </div>
        <div class="workspace-meta-block"><span class="workspace-meta-label">Activity</span>
          ${history.length ? `<ul class="comment-list">${history.map(entry => `<li><div class="comment-meta">${escapeHtml(entry.author || '-')} · ${escapeHtml(formatExecTimestamp(entry.createdAt))}</div><div><strong>${escapeHtml(entry.action || '')}</strong>${entry.detail ? ` — ${escapeHtml(entry.detail)}` : ''}</div></li>`).join('')}</ul>` : `<div class="workspace-empty-inline">ยังไม่มี activity</div>`}
        </div>
      </div>
    </div>`;
}


function getAttachmentKind(att){
  const mime = String(att?.mimeType || att?.type || '').toLowerCase();
  const name = String(att?.name || '').toLowerCase();
  if (mime.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(name)) return 'video';
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return 'image';
  return 'file';
}

function renderAttachmentPreview(att){
  const url = escapeHtml(att.previewUrl || att.url || att.viewUrl || '#');
  const viewUrl = escapeHtml(att.viewUrl || att.url || '#');
  const name = escapeHtml(att.name || 'Attachment');
  const kind = getAttachmentKind(att);
  if (kind === 'video') return `<div class="attachment-preview attachment-video"><video controls preload="metadata" src="${url}"></video><a href="${viewUrl}" target="_blank">${name}</a></div>`;
  if (kind === 'image') return `<div class="attachment-preview attachment-image"><a href="${viewUrl}" target="_blank"><img src="${url}" alt="${name}"></a><a href="${viewUrl}" target="_blank">${name}</a></div>`;
  return `<div class="attachment-preview attachment-file"><a href="${viewUrl}" target="_blank">📎 ${name}</a></div>`;
}

function renderAttachmentGallery(attachments, featureId, defectId){
  if (!attachments || !attachments.length) return `<div class="workspace-empty-inline">ยังไม่มี attachment</div>`;
  return `<div class="attachment-gallery">${attachments.map((att) => `<div class="attachment-item">${renderAttachmentPreview(att)}<div class="attachment-meta">${escapeHtml(att.uploadedBy || '-')} · ${escapeHtml(formatExecTimestamp(att.uploadedAt))}</div><button class="inline-remove-btn" type="button" onclick="removeDefectAttachment('${featureId}','${defectId}','${att.id || ''}')">ลบ</button></div>`).join('')}</div>`;
}

function renderDefectComments(comments){
  if (!comments || !comments.length) return `<div class="workspace-empty-inline">ยังไม่มี comment</div>`;
  return `<ul class="comment-list">${comments.map(comment => `<li><div class="comment-meta">${escapeHtml(comment.author || '-')} · ${escapeHtml(formatExecTimestamp(comment.createdAt))}</div>${comment.text ? `<div>${escapeHtml(comment.text || '')}</div>` : ''}${comment.attachments?.length ? `<div class="comment-attachments">${comment.attachments.map(att => renderAttachmentPreview(att)).join('')}</div>` : ''}</li>`).join('')}</ul>`;
}

function normalizeUploadedAttachment(file){
  return {
    id: file.id,
    name: file.name,
    url: file.url,
    previewUrl: file.previewUrl || file.url,
    viewUrl: file.viewUrl || file.url,
    mimeType: file.mimeType || file.type || '',
    size: file.size || 0,
    uploadedAt: new Date().toISOString(),
    uploadedBy: getCurrentActor(),
  };
}

function makeWorkspaceId(prefix){
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
}

function normalizeWorkspaceCollections(featureId){
  const store = DB.features[featureId];
  if (!store) return null;
  if (!Array.isArray(store.devCases)) store.devCases = [];
  if (!Array.isArray(store.defects)) store.defects = [];
  store.defects = store.defects.map(entry => normalizeDefectRecord(entry));
  return store;
}

function getCurrentActor(){
  const cachedEmail = String(localStorage.getItem('qa_user_email') || '').trim();
  if (cachedEmail) return cachedEmail;
  const names = getExecutorNameList();
  return names[0] || 'unknown';
}

function touchWorkspaceRecord(item){
  if (!item) return;
  item.updatedAt = new Date().toISOString();
  item.updatedBy = getCurrentActor();
}

function normalizeDefectRecord(item){
  if (!item || typeof item !== 'object') return item;
  const linked = Array.isArray(item.testCaseIds)
    ? item.testCaseIds.filter(Boolean)
    : (item.testCaseId ? [item.testCaseId] : []);
  item.testCaseIds = linked;
  if (!Array.isArray(item.attachments)) item.attachments = [];
  if (!Array.isArray(item.comments)) item.comments = [];
  if (!Array.isArray(item.history)) item.history = [];
  return item;
}

function recordDefectHistory(item, action, detail = ''){
  if (!item) return;
  if (!Array.isArray(item.history)) item.history = [];
  item.history.unshift({
    id: makeWorkspaceId('HIS'),
    action,
    detail,
    author: getCurrentActor(),
    createdAt: new Date().toISOString(),
  });
  item.history = item.history.slice(0, 50);
}

function renderLinkedTestCaseSelector(featureId, item, qaCases){
  const selected = new Set(Array.isArray(item.testCaseIds) ? item.testCaseIds : []);
  return `
    <div class="multi-select-list">
      ${qaCases.length ? qaCases.map(tc => `
        <label class="multi-select-option">
          <input type="checkbox" ${selected.has(tc.id) ? 'checked' : ''}
            onchange="toggleDefectTestCaseLink('${featureId}','${item.id}','${tc.id}', this.checked)">
          <span><strong>${escapeHtml(tc.id)}</strong> — ${escapeHtml(tc.title)}</span>
        </label>
      `).join('') : `<div class="workspace-empty-inline">ยังไม่มี QA case ใน feature นี้</div>`}
    </div>`;
}

function renderWorkspaceUpdateMeta(item){
  const updatedBy = escapeHtml(item?.updatedBy || '-');
  const updatedAt = escapeHtml(formatExecTimestamp(item?.updatedAt));
  return `<div class="workspace-update-meta">อัปเดตล่าสุดโดย ${updatedBy} · ${updatedAt}</div>`;
}


function rerenderCurrentFeature(){
  FEATURES = buildFeatures();
  const feat = FEATURES.find(item => item.meta.id === currentFeatureId);
  if (feat) renderFeature(feat);
}

function addDevCase(featureId){
  if (!ensureWritable()) return;
  const store = normalizeWorkspaceCollections(featureId); if (!store) return;
  const devCase = { id: makeWorkspaceId('DEV'), title:'', owner:'', testType:'manual', status:'draft', scenario:'', note:'' };
  touchWorkspaceRecord(devCase);
  store.devCases.unshift(devCase);
  scheduleFeatureWrite(featureId);
  rerenderCurrentFeature();
}

function updateDevCaseField(featureId, itemId, key, value){
  const store = normalizeWorkspaceCollections(featureId); if (!store) return;
  const item = store.devCases.find(entry => entry.id === itemId); if (!item) return;
  item[key] = value;
  touchWorkspaceRecord(item);
  scheduleFeatureWrite(featureId);
}

function removeDevCase(featureId, itemId){
  if (!ensureWritable()) return;
  openConfirmModal('ลบ Dev Case', 'ต้องการลบรายการนี้ใช่ไหม?', () => {
    const store = normalizeWorkspaceCollections(featureId); if (!store) return;
    store.devCases = store.devCases.filter(entry => entry.id !== itemId);
    scheduleFeatureWrite(featureId);
    rerenderCurrentFeature();
  });
}

function addDefect(featureId){
  if (!ensureWritable()) return;
  const store = normalizeWorkspaceCollections(featureId); if (!store) return;
  const defect = {
    id: makeWorkspaceId('BUG'),
    title:'',
    testCaseIds:[],
    buildVersion:'',
    severity:'medium',
    status:'open',
    owner:'',
    description:'',
    fixSummary:'',
    attachments:[],
    comments:[],
    history:[],
  };
  touchWorkspaceRecord(defect);
  recordDefectHistory(defect, 'created', 'สร้าง defect ใหม่');
  store.defects.unshift(defect);
  scheduleFeatureWrite(featureId);
  rerenderCurrentFeature();
}

function updateDefectField(featureId, itemId, key, value){
  const store = normalizeWorkspaceCollections(featureId); if (!store) return;
  const item = store.defects.find(entry => entry.id === itemId); if (!item) return;
  normalizeDefectRecord(item);
  item[key] = value;
  touchWorkspaceRecord(item);
  recordDefectHistory(item, 'updated', `${key} changed`);
  scheduleFeatureWrite(featureId);
}

function toggleDefectTestCaseLink(featureId, itemId, testCaseId, checked){
  const store = normalizeWorkspaceCollections(featureId); if (!store) return;
  const item = store.defects.find(entry => entry.id === itemId); if (!item) return;
  normalizeDefectRecord(item);
  const selected = new Set(item.testCaseIds || []);
  if (checked) selected.add(testCaseId); else selected.delete(testCaseId);
  item.testCaseIds = Array.from(selected);
  item.testCaseId = item.testCaseIds[0] || '';
  touchWorkspaceRecord(item);
  recordDefectHistory(item, checked ? 'linked testcase' : 'unlinked testcase', testCaseId);
  scheduleFeatureWrite(featureId);
  rerenderCurrentFeature();
}

async function uploadDefectAttachments(event, featureId, itemId){
  if (!ensureWritable()) {
    event.target.value = '';
    return;
  }
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  showLoadingOverlay(`กำลังอัปโหลด ${files.length} ไฟล์...`);
  try {
    const store = normalizeWorkspaceCollections(featureId); if (!store) return;
    const item = store.defects.find(entry => entry.id === itemId); if (!item) return;
    normalizeDefectRecord(item);
    const uploaded = await driveUploadAttachments(files, itemId);
    item.attachments.push(...uploaded.map(normalizeUploadedAttachment));
    touchWorkspaceRecord(item);
    recordDefectHistory(item, 'uploaded attachment', `${files.length} file(s)`);
    scheduleFeatureWrite(featureId);
    rerenderCurrentFeature();
  } catch (err) {
    alert('อัปโหลด attachment ไม่สำเร็จ: ' + buildErrorMessage(err));
  } finally {
    hideLoadingOverlay();
    event.target.value = '';
  }
}

function removeDefectAttachment(featureId, itemId, attachmentId){
  if (!ensureWritable()) return;
  const store = normalizeWorkspaceCollections(featureId); if (!store) return;
  const item = store.defects.find(entry => entry.id === itemId); if (!item) return;
  normalizeDefectRecord(item);
  const target = item.attachments.find(att => att.id === attachmentId);
  item.attachments = item.attachments.filter(att => att.id !== attachmentId);
  touchWorkspaceRecord(item);
  recordDefectHistory(item, 'removed attachment', target?.name || attachmentId || 'attachment');
  scheduleFeatureWrite(featureId);
  rerenderCurrentFeature();
  if (attachmentId) driveDeleteFile(attachmentId).catch(() => {});
}

async function addDefectComment(featureId, itemId){
  const input = document.getElementById(`comment-input-${itemId}`);
  const fileInput = document.getElementById(`comment-files-${itemId}`);
  const text = String(input?.value || '').trim();
  const files = Array.from(fileInput?.files || []);
  if (!text && !files.length) return;
  const store = normalizeWorkspaceCollections(featureId); if (!store) return;
  const item = store.defects.find(entry => entry.id === itemId); if (!item) return;
  normalizeDefectRecord(item);
  if (!Array.isArray(item.comments)) item.comments = [];
  showLoadingOverlay(files.length ? `กำลังอัปโหลดไฟล์ comment ${files.length} ไฟล์...` : 'กำลังบันทึก comment...');
  try {
    let attachments = [];
    if (files.length) {
      const uploaded = await driveUploadAttachments(files, `${itemId}-comments`);
      attachments = uploaded.map(normalizeUploadedAttachment);
    }
    const comment = { id: makeWorkspaceId('CMT'), author: getCurrentActor(), text, attachments, createdAt: new Date().toISOString() };
    item.comments.unshift(comment);
    touchWorkspaceRecord(item);
    recordDefectHistory(item, 'commented', text ? text.slice(0, 80) : `${files.length} attachment(s)`);
    scheduleFeatureWrite(featureId);
    rerenderCurrentFeature();
  } catch (err) {
    alert('บันทึก comment ไม่สำเร็จ: ' + buildErrorMessage(err));
  } finally {
    hideLoadingOverlay();
    if (input) input.value = '';
    if (fileInput) fileInput.value = '';
  }
}

function removeDefect(featureId, itemId){
  if (!ensureWritable()) return;
  openConfirmModal('ลบ Defect', 'ต้องการลบ defect นี้ใช่ไหม?', () => {
    const store = normalizeWorkspaceCollections(featureId); if (!store) return;
    const item = store.defects.find(entry => entry.id === itemId);
    (item?.attachments || []).forEach(att => { if (att?.id) driveDeleteFile(att.id).catch(() => {}); });
    store.defects = store.defects.filter(entry => entry.id !== itemId);
    scheduleFeatureWrite(featureId);
    rerenderCurrentFeature();
  });
}

function toggleFilterPanel(forceOpen = null){
  const panel = document.getElementById('filter-panel');
  if(!panel) return;
  const shouldOpen = forceOpen === null ? panel.hidden : !!forceOpen;
  panel.hidden = !shouldOpen;
}

function applyFilterPanel(){
  activeType = document.getElementById('filter-type-select')?.value || 'all';
  activeScreen = document.getElementById('filter-screen-select')?.value || 'all';
  activeStatusFilt = document.getElementById('filter-status-select')?.value || 'all';
  toggleFilterPanel(false);
  applyFilters();
}

function clearFilterPanel(){
  activeType='all';
  activeScreen='all';
  activeStatusFilt='all';
  const typeEl=document.getElementById('filter-type-select');
  const screenEl=document.getElementById('filter-screen-select');
  const statusEl=document.getElementById('filter-status-select');
  if(typeEl) typeEl.value='all';
  if(screenEl) screenEl.value='all';
  if(statusEl) statusEl.value='all';
  applyFilters();
}

function refreshStatusStatsBar(fid){
  const el=document.getElementById('status-stats-bar');if(!el)return;
  const f=FEATURES.find(f=>f.meta.id===fid);if(!f)return;
  const counts=getStatusCounts(f.cases),total=f.cases.length;
  el.innerHTML=`<span class="ssg-label">Test Run</span>
    ${STATUSES.map(s=>`<span class="ssg-item" style="background:${STATUS_COLORS[s.key]}22;color:var(--st-${s.key});border-color:${STATUS_COLORS[s.key]};">${s.icon} ${s.label} <strong>${counts[s.key]}</strong></span>`).join('')}
    <div class="ssg-progress">${buildProgressBar(counts,total,'ssg-pt-seg')}</div>`;
}

function updateFilterSummary(filteredCount,totalCount){
  const summary=document.getElementById('filter-summary');
  if(!summary) return;
  const chips=[];
  if(activeType!=='all') chips.push(`Type: ${activeType}`);
  if(activeScreen!=='all') {
    const feature = FEATURES.find(item=>item.meta.id===currentFeatureId);
    const screenLabel = feature?.meta?.screens?.[activeScreen]?.name || activeScreen;
    chips.push(`Screen: ${screenLabel}`);
  }
  if(activeStatusFilt!=='all') chips.push(`Status: ${getStatusLabel(activeStatusFilt)}`);
  const searchValue=(document.getElementById('search-input')?.value||'').trim();
  if(searchValue) chips.push(`Search: ${searchValue}`);
  const detail = chips.length ? chips.join(' · ') : 'All test cases';
  summary.textContent = `${filteredCount} / ${totalCount} · ${detail}`;
}


function applyFilters(){
  const f=FEATURES.find(f=>f.meta.id===currentFeatureId);if(!f)return;
  const q=(document.getElementById('search-input')?.value||'').toLowerCase();
  const filtered=f.cases.filter(c=>{
    const typeOk=activeType==='all'||c.type===activeType;
    const screenOk=activeScreen==='all'||c.screen===activeScreen;
    const stOk=activeStatusFilt==='all'||getStatus(c.id)===activeStatusFilt;
    const srchOk=!q||[c.title,c.sub,c.id,...(c.steps||[]),...(c.expect||[])].some(s=>s&&String(s).toLowerCase().includes(q));
    return typeOk&&screenOk&&stOk&&srchOk;
  });
  updateFilterSummary(filtered.length, f.cases.length);
  renderTable(filtered,f);
}

function renderTable(list,feature){
  const tbody=document.getElementById('tc-tbody'),countEl=document.getElementById('showing-count'),emptyEl=document.getElementById('empty-state');
  if(!tbody)return;
  countEl.textContent=`${list.length} / ${feature.cases.length}`;
  emptyEl.style.display=list.length?'none':'block';
  if(!list.length){tbody.innerHTML='';return;}
  tbody.innerHTML=list.map(c=>{
    const sc=feature.meta.screens[c.screen];
    const typePill=`<span class="type-pill tp-${c.type}"><span class="type-pill-label">${{positive:'✓ Positive',edge:'~ Edge',negative:'✗ Negative'}[c.type]||c.type}</span></span>`;
    const screenTag=sc
      ? `<span class="screen-tag ${sc.cssClass}"><span class="screen-tag-label">${sc.label}</span><span class="screen-tag-name">${sc.name}</span></span>`
      : `<span class="screen-tag"><span class="screen-tag-label">${c.screen||''}</span></span>`;
    const execMeta = getExecutionMeta(c.id) || {};
    const execBy = execMeta.executor || '-';
    const execRemark = execMeta.remark || '-';
    const execTime = formatExecTimestamp(execMeta.updatedAt);
    const imgCount=c.images?.length||0;
    const attachmentCount=getCaseAttachmentCount(c);
    const attachmentBadge=attachmentCount>0?`<span class="img-badge" onclick="event.stopPropagation();toggleDetail('${c.id}', true)">📎 ${attachmentCount}</span>`:'';
    const imgBadge=imgCount>0?`<span class="img-badge" onclick="event.stopPropagation();openImageViewer('${c.id}','${feature.meta.id}')">🖼 ${imgCount}</span>`:'';
    return`
    <tr class="tc-row" id="row-${c.id}" onclick="toggleDetail('${c.id}')">
      <td class="col-id"><span class="tc-id">${c.id}</span></td>
      <td class="col-screen hide-sm">${screenTag}</td>
      <td class="col-title"><div class="tc-title-text">${c.title} ${imgBadge} ${attachmentBadge}</div><div class="tc-sub-text">${c.sub||''}</div></td>
      <td class="col-type hide-sm">${typePill}</td>
      <td class="col-status">${statusSelectHtml(c.id,feature.meta.id)}</td>
      <td class="col-actions">
        <div class="case-actions">
          <button class="icon-btn icon-btn-compact" onclick="event.stopPropagation();openExecutionNoteModal('${feature.meta.id}','${c.id}')" title="Remark / Execute">📝</button>
          <button class="icon-btn icon-btn-compact" onclick="event.stopPropagation();openEditCaseModal('${feature.meta.id}','${c.id}')" title="แก้ไข">✏️</button>
          <button class="icon-btn icon-btn-danger icon-btn-compact" onclick="event.stopPropagation();confirmDeleteCase('${c.id}','${feature.meta.id}')" title="ลบ">🗑</button>
        </div>
      </td>
    </tr>
    <tr class="detail-row" id="detail-${c.id}">
      <td colspan="6" style="padding:0 0 8px 0;">
        <div class="detail-inner">
          <div><div class="detail-section-title">Steps to reproduce</div>
            <ol class="detail-list steps-list">${(c.steps||[]).map((s,i)=>`<li><strong style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text3);margin-right:5px;">${i+1}.</strong>${s}</li>`).join('')}</ol>
          </div>
          <div><div class="detail-section-title">Expected behavior</div>
            <ul class="detail-list expect-list">${(c.expect||[]).map(e=>`<li>${e}</li>`).join('')}</ul>
          </div>
          <div>
            <div class="detail-section-title">Execution Note</div>
            <ul class="detail-list expect-list">
              <li><strong>Execute by:</strong> ${escapeHtml(execBy)}</li>
              <li><strong>Remark:</strong> ${escapeHtml(execRemark)}</li>
              <li><strong>Updated:</strong> ${escapeHtml(execTime)}</li>
            </ul>
          </div>
          ${imgCount>0?`<div style="grid-column:1/-1;">
            <div class="detail-section-title">รูปภาพ (${imgCount})</div>
            <div class="img-thumb-row">${c.images.map((img,i)=>`
              <div class="img-thumb" onclick="openImageViewer('${c.id}','${feature.meta.id}',${i})">
                <img src="${getImageDisplayUrl(img)}" data-file-id="${escapeHtml(getImageFileId(img))}" alt="${img.name}" onerror="handleImageElementError(this)" />
                <span class="img-thumb-del" onclick="event.stopPropagation();confirmDeleteImage('${c.id}','${feature.meta.id}',${i})" title="ลบรูป">✕</span>
              </div>`).join('')}
              <label class="img-thumb img-thumb-add" title="เพิ่มรูป">
                <input type="file" accept="image/*" multiple style="display:none" onchange="uploadImages(event,'${c.id}','${feature.meta.id}')">
                <span style="font-size:22px;color:var(--text3);">＋</span>
              </label>
            </div>
          </div>`:`<div style="grid-column:1/-1;">
            <label class="btn-add-img" title="แนบรูปภาพ">
              <input type="file" accept="image/*" multiple style="display:none" onchange="uploadImages(event,'${c.id}','${feature.meta.id}')">
              🖼 แนบรูปภาพ
            </label>
          </div>`}
          ${renderCaseAttachmentGallery(c.attachments || [], c.id, feature.meta.id)}
          <div style="grid-column:1/-1;">
            <label class="btn-add-img" title="แนบรูปหรือวิดีโอ">
              <input type="file" accept="image/*,video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" multiple style="display:none" onchange="uploadCaseAttachments(event,'${c.id}','${feature.meta.id}')">
              📎 แนบรูป / วิดีโอ
            </label>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
  if (expandedCaseId) {
    const detailRow = document.getElementById(`detail-${expandedCaseId}`);
    const mainRow = document.getElementById(`row-${expandedCaseId}`);
    if (detailRow && mainRow) {
      detailRow.classList.add('open');
      mainRow.classList.add('expanded');
    }
  }
}

function toggleDetail(id, forceOpen=false){
  const dr=document.getElementById(`detail-${id}`),mr=document.getElementById(`row-${id}`);
  if(!dr||!mr) return;
  const open=dr.classList.contains('open');
  document.querySelectorAll('.detail-row.open').forEach(r=>r.classList.remove('open'));
  document.querySelectorAll('.tc-row.expanded').forEach(r=>r.classList.remove('expanded'));
  if(forceOpen || !open){dr.classList.add('open');mr.classList.add('expanded');expandedCaseId=id;dr.scrollIntoView({behavior:'smooth',block:'nearest'});}
  else { expandedCaseId=null; }
}
function updateTypeStats(cases){
  document.getElementById('s-total').textContent=cases.length;
  document.getElementById('s-pos').textContent=cases.filter(c=>c.type==='positive').length;
  document.getElementById('s-edge').textContent=cases.filter(c=>c.type==='edge').length;
  document.getElementById('s-neg').textContent=cases.filter(c=>c.type==='negative').length;
}

function getDriveViewImageUrl(fileId) {
  if (!fileId) return '';
  return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(fileId)}`;
}

function getGoogleusercontentImageUrl(fileId) {
  if (!fileId) return '';
  return `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}`;
}

function getDriveThumbnailUrl(fileId) {
  if (!fileId) return '';
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1600`;
}

function extractDriveFileIdFromUrl(value) {
  const url = String(value || '');
  const fromPath = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (fromPath?.[1]) return fromPath[1];
  const fromQuery = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (fromQuery?.[1]) return fromQuery[1];
  return '';
}

function getImageFileId(image) {
  if (!image) return '';
  return image.id
    || extractDriveFileIdFromUrl(image.url)
    || extractDriveFileIdFromUrl(image.viewUrl)
    || '';
}

function getImageDisplayUrl(image) {
  if (!image) return '';
  if (image.url) return image.url;
  return getDriveViewImageUrl(getImageFileId(image));
}

function setImageLoadPlaceholder(el) {
  if (!el) return;
  el.onerror = null;
  el.src = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 300%22><rect width=%22400%22 height=%22300%22 fill=%22%23f5f5f5%22/><text x=%22200%22 y=%22155%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2216%22>ไม่สามารถโหลดรูปได้</text></svg>";
}

function handleImageElementError(el) {
  if (!el) return;
  const fileId = (el.dataset.fileId || '').trim();
  if (!fileId) {
    setImageLoadPlaceholder(el);
    return;
  }

  const currentSrc = String(el.getAttribute('src') || '');
  const hasDriveView = currentSrc.includes('drive.google.com/uc?export=view');
  const hasGoogleusercontent = currentSrc.includes('lh3.googleusercontent.com/d/');
  const hasThumb = currentSrc.includes('drive.google.com/thumbnail');

  if (!hasDriveView) {
    el.src = getDriveViewImageUrl(fileId);
    return;
  }
  if (!hasGoogleusercontent) {
    el.src = getGoogleusercontentImageUrl(fileId);
    return;
  }
  if (!hasThumb) {
    el.src = getDriveThumbnailUrl(fileId);
    return;
  }
  setImageLoadPlaceholder(el);
}

// ══════════════════════════════════════════
//  IMAGE UPLOAD & VIEWER
// ══════════════════════════════════════════
async function uploadImages(event, caseId, featureId) {
  if (!ensureWritable()) {
    event.target.value = '';
    return;
  }
  const files = Array.from(event.target.files);
  if (!files.length) return;
  showLoadingOverlay(`กำลังอัปโหลด ${files.length} รูป...`);
  try {
    const f = DB.features[featureId]; if (!f) return;
    const c = f.cases.find(x => x.id === caseId); if (!c) return;
    if (!c.images) c.images = [];
    const uploaded = await driveUploadImages(files, caseId);
    c.images.push(...uploaded);
    await saveCase(featureId, c);
    hideLoadingOverlay();
    FEATURES = buildFeatures();
    const feat = FEATURES.find(f => f.meta.id === featureId);
    if (feat) renderFeature(feat);
    // re-open detail
    setTimeout(() => toggleDetail(caseId), 100);
  } catch (err) {
    hideLoadingOverlay();
    alert('อัปโหลดรูปไม่สำเร็จ: ' + err.message);
  }
}

function confirmDeleteImage(caseId, featureId, imgIndex) {
  if (!ensureWritable()) return;
  openConfirmModal('ลบรูปภาพ', 'ต้องการลบรูปนี้ออกใช่ไหม?', async () => {
    const f = DB.features[featureId]; if (!f) return;
    const c = f.cases.find(x => x.id === caseId); if (!c || !c.images) return;
    const [removed] = c.images.splice(imgIndex, 1);
    if (removed?.id) driveDeleteFile(removed.id).catch(() => {});
    await saveCase(featureId, c);
    FEATURES = buildFeatures();
    const feat = FEATURES.find(f => f.meta.id === featureId);
    if (feat) renderFeature(feat);
    setTimeout(() => toggleDetail(caseId), 100);
  });
}

function openImageViewer(caseId, featureId, startIndex = 0) {
  const f = DB.features[featureId]; if (!f) return;
  const c = f.cases.find(x => x.id === caseId); if (!c || !c.images?.length) return;
  let cur = startIndex;
  const imgs = c.images;

  let overlay = document.getElementById('img-viewer-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'img-viewer-overlay';
    overlay.className = 'img-viewer-overlay';
    overlay.onclick = e => { if (e.target === overlay) closeImageViewer(); };
    document.body.appendChild(overlay);
  }

  function render() {
    overlay.innerHTML = `
      <div class="img-viewer-box">
        <div class="img-viewer-header">
          <span style="font-size:13px;font-weight:600;">${imgs[cur].name}</span>
          <div style="display:flex;gap:8px;align-items:center;">
            <span style="font-size:12px;color:var(--text3);">${cur+1} / ${imgs.length}</span>
            <a href="${imgs[cur].viewUrl||imgs[cur].url}" target="_blank" style="font-size:12px;color:var(--blue);">ดูภาพขนาดเต็ม</a>
            <button onclick="closeImageViewer()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text2);">✕</button>
          </div>
        </div>
        <div class="img-viewer-body">
          <button class="img-viewer-nav img-viewer-prev" onclick="imgViewerNav(-1)" ${cur===0?'disabled':''}>‹</button>
          <img src="${getImageDisplayUrl(imgs[cur])}" data-file-id="${escapeHtml(getImageFileId(imgs[cur]))}" alt="${imgs[cur].name}" class="img-viewer-img"
            onerror="handleImageElementError(this)" />
          <button class="img-viewer-nav img-viewer-next" onclick="imgViewerNav(1)" ${cur===imgs.length-1?'disabled':''}>›</button>
        </div>
        <div class="img-viewer-dots">
          ${imgs.map((_,i)=>`<span class="img-viewer-dot ${i===cur?'active':''}" onclick="imgViewerGoTo(${i})"></span>`).join('')}
        </div>
      </div>`;
    overlay.style.display = 'flex';
  }

  window.imgViewerNav = (d) => { cur = Math.max(0, Math.min(imgs.length-1, cur+d)); render(); };
  window.imgViewerGoTo = (i) => { cur = i; render(); };
  window.closeImageViewer = () => { overlay.style.display = 'none'; };

  render();

  // Keyboard nav
  overlay._keyHandler = (e) => {
    if (e.key === 'ArrowRight') imgViewerNav(1);
    if (e.key === 'ArrowLeft')  imgViewerNav(-1);
    if (e.key === 'Escape')     closeImageViewer();
  };
  document.removeEventListener('keydown', overlay._keyHandler);
  document.addEventListener('keydown', overlay._keyHandler);
}

// ══════════════════════════════════════════
//  CSV IMPORT / EXPORT
// ══════════════════════════════════════════
const CSV_HEADERS = ['id','type','screen','title','sub','steps','expect'];
// steps & expect คั่นด้วย " | "

function exportCsv(featureId) {
  const f = DB.features[featureId]; if (!f) return;
  const rows = [CSV_HEADERS];
  f.cases.forEach(c => {
    rows.push([
      c.id, c.type, c.screen, c.title, c.sub||'',
      (c.steps||[]).join(' | '),
      (c.expect||[]).join(' | '),
    ]);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const bom = '\uFEFF';
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = `${featureId}-testcases.csv`; a.click();
  URL.revokeObjectURL(url);
}

function openImportCsvModal(featureId) {
  if (!ensureWritable()) return;
  const f = DB.features[featureId]; if (!f) return;
  openModal('import-csv-modal', `
    <div class="modal-header"><span class="modal-title">📥 Import CSV</span><span class="modal-sub">${f.meta.emoji} ${f.meta.name}</span></div>
    <div class="modal-body">
      <div style="font-size:12px;color:var(--text2);background:var(--surface2);padding:12px;border-radius:8px;margin-bottom:4px;line-height:1.8;">
        <strong>รูปแบบ CSV (UTF-8 with BOM):</strong><br>
        คอลัมน์: <code>id, type, screen, title, sub, steps, expect</code><br>
        • <b>type</b>: positive / edge / negative<br>
        • <b>screen</b>: key จาก screens เช่น S1, S2<br>
        • <b>steps</b> และ <b>expect</b>: คั่นหลายบรรทัดด้วย <code> | </code>
      </div>
      <div class="form-group">
        <label>เลือกไฟล์ CSV</label>
        <input type="file" id="csv-file-input" accept=".csv,text/csv" class="form-input" style="padding:6px;" />
      </div>
      <div id="csv-preview" style="display:none;">
        <div class="detail-section-title" style="margin-bottom:6px;">Preview (10 แถวแรก)</div>
        <div id="csv-preview-content" style="font-size:12px;max-height:200px;overflow-y:auto;background:var(--surface2);padding:10px;border-radius:8px;border:1px solid var(--border);"></div>
        <div id="csv-stats" style="font-size:12px;color:var(--text2);margin-top:6px;"></div>
      </div>
      <div id="csv-error" class="form-error" style="display:none;"></div>
    </div>
    <div class="modal-footer">
      <button class="btn-modal-cancel" onclick="closeModal()">ยกเลิก</button>
      <button class="btn-modal-ok" id="btn-do-import" onclick="submitImportCsv('${featureId}')" disabled>Import</button>
    </div>`);

  document.getElementById('csv-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const text = await file.text();
    parseCsvPreview(text, featureId);
  });
}

let _csvParsed = [];
let _bulkCsvParsed = [];
function parseCasesFromCsvText(text) {
  const rows = parseCsvText(text);
  if (rows.length < 2) throw new Error('ไฟล์ CSV ว่าง หรือไม่มีข้อมูล');
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const required = ['id','type','title'];
  const missing = required.filter(h => !headers.includes(h));
  if (missing.length) throw new Error(`ไม่พบคอลัมน์: ${missing.join(', ')}`);

  return rows.slice(1).filter(r => r.some(v => v.trim())).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = (row[i] || '').trim());
    return {
      id: obj.id, type: obj.type||'positive', screen: obj.screen||'S1',
      title: obj.title, sub: obj.sub||'',
      steps: obj.steps ? obj.steps.split('|').map(s=>s.trim()).filter(Boolean) : [],
      expect: obj.expect ? obj.expect.split('|').map(s=>s.trim()).filter(Boolean) : [],
      images: [],
    };
  }).filter(c => c.id && c.title);
}

function parseCsvPreview(text, featureId) {
  const errEl = document.getElementById('csv-error');
  errEl.style.display = 'none';
  try {
    _csvParsed = parseCasesFromCsvText(text);

    const preview = document.getElementById('csv-preview');
    const content = document.getElementById('csv-preview-content');
    const stats   = document.getElementById('csv-stats');
    preview.style.display = 'block';
    content.innerHTML = _csvParsed.slice(0,10).map(c =>
      `<div style="padding:4px 0;border-bottom:1px solid var(--border);"><strong>${c.id}</strong> — ${c.title} <span style="color:var(--text3);">(${c.type})</span></div>`
    ).join('');
    stats.textContent = `รวม ${_csvParsed.length} test cases จะถูก import`;
    document.getElementById('btn-do-import').disabled = false;
  } catch (err) {
    errEl.textContent = err.message; errEl.style.display = 'block';
    document.getElementById('btn-do-import').disabled = true;
    _csvParsed = [];
  }
}

function parseCsvText(text) {
  // handle BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i+1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || (ch === '\r' && text[i+1] === '\n')) {
        row.push(field); field = '';
        if (row.some(v=>v)) rows.push(row);
        row = []; if (ch === '\r') i++;
      } else field += ch;
    }
  }
  if (field || row.length) { row.push(field); if (row.some(v=>v)) rows.push(row); }
  return rows;
}

function inferFeatureIdFromFilename(name) {
  return name
    .replace(/\.[^.]+$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function mergeImportedCases(featureId, cases, mode = 'merge') {
  const f = DB.features[featureId];
  if (!f) throw new Error(`ไม่พบ feature: ${featureId}`);

  const existingMap = new Map(f.cases.map(c => [c.id, c]));
  let added = 0;
  let updated = 0;

  if (mode === 'replace') {
    f.cases = cases.map(c => {
      const existing = existingMap.get(c.id);
      if (existing) updated++;
      else added++;
      return { ...c, images: existing?.images || [], attachments: existing?.attachments || [] };
    });
    return { added, updated };
  }

  const nextCases = [...f.cases];
  cases.forEach(c => {
    const existing = existingMap.get(c.id);
    if (existing) {
      Object.assign(existing, c, { images: existing.images || [], attachments: existing.attachments || [] });
      updated++;
      return;
    }
    nextCases.push({ ...c, images: c.images || [], attachments: c.attachments || [] });
    added++;
  });
  f.cases = nextCases;
  return { added, updated };
}

async function submitImportCsv(featureId) {
  if (!_csvParsed.length) return;
  const btn = document.getElementById('btn-do-import');
  btn.disabled = true; btn.textContent = 'กำลัง import...';
  try {
    const { added, updated } = mergeImportedCases(featureId, _csvParsed, 'merge');
    await writeFeatureFile(featureId);
    closeModal();
    FEATURES = buildFeatures(); rebuildNav(); updateHeaderStrip();
    const feat = FEATURES.find(f => f.meta.id === featureId);
    if (feat) renderFeature(feat);
    setTimeout(() => alert(`Import สำเร็จ: เพิ่ม ${added} cases${updated ? `, อัปเดต ${updated}` : ''}`),100);
  } catch (err) {
    const errEl = document.getElementById('csv-error');
    if (errEl) { errEl.textContent = 'Import ไม่สำเร็จ: ' + err.message; errEl.style.display = 'block'; }
    btn.disabled = false; btn.textContent = 'Import';
  }
}

function openBulkImportModal() {
  if (!ensureWritable()) return;
  openModal('bulk-import-modal', `
    <div class="modal-header"><span class="modal-title">📦 Bulk CSV Import</span><span class="modal-sub">หลายไฟล์พร้อมกัน แยกตาม feature</span></div>
    <div class="modal-body">
      <div style="font-size:12px;color:var(--text2);background:var(--surface2);padding:12px;border-radius:8px;line-height:1.8;">
        ไฟล์แต่ละอันต้องตั้งชื่อให้ตรงกับ <code>featureId</code> เช่น <code>auth.csv</code> หรือ <code>xray-planogram.csv</code><br>
        รองรับไฟล์ CSV แบบ UTF-8 / UTF-8 with BOM
      </div>
      <div class="form-group">
        <label>โหมดการ import</label>
        <select class="form-select" id="bulk-import-mode">
          <option value="merge">Merge: เพิ่มใหม่และอัปเดต ID ที่ซ้ำ</option>
          <option value="replace">Replace: แทนที่ทั้ง feature ด้วยข้อมูลในไฟล์</option>
        </select>
      </div>
      <div class="form-group">
        <label>เลือกหลายไฟล์ CSV</label>
        <input type="file" id="bulk-csv-file-input" multiple accept=".csv,text/csv" class="form-input" style="padding:6px;" />
      </div>
      <div id="bulk-csv-preview" style="display:none;">
        <div class="detail-section-title" style="margin-bottom:6px;">Preview</div>
        <div id="bulk-csv-preview-content" style="font-size:12px;max-height:240px;overflow-y:auto;background:var(--surface2);padding:10px;border-radius:8px;border:1px solid var(--border);"></div>
      </div>
      <div id="bulk-csv-error" class="form-error" style="display:none;"></div>
    </div>
    <div class="modal-footer">
      <button class="btn-modal-cancel" onclick="closeModal()">ยกเลิก</button>
      <button class="btn-modal-ok" id="btn-do-bulk-import" onclick="submitBulkImport()" disabled>Import ทั้งหมด</button>
    </div>`);

  document.getElementById('bulk-csv-file-input').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    await parseBulkCsvFiles(files);
  });
}

async function parseBulkCsvFiles(files) {
  const errEl = document.getElementById('bulk-csv-error');
  const preview = document.getElementById('bulk-csv-preview');
  const content = document.getElementById('bulk-csv-preview-content');
  const btn = document.getElementById('btn-do-bulk-import');
  errEl.style.display = 'none';
  _bulkCsvParsed = [];

  if (!files.length) {
    btn.disabled = true;
    preview.style.display = 'none';
    return;
  }

  for (const file of files) {
    const featureId = inferFeatureIdFromFilename(file.name);
    try {
      if (!DB.features[featureId]) throw new Error(`ไม่พบ featureId "${featureId}" จากชื่อไฟล์`);
      const text = await file.text();
      const cases = parseCasesFromCsvText(text);
      _bulkCsvParsed.push({ fileName: file.name, featureId, cases, error: '' });
    } catch (err) {
      _bulkCsvParsed.push({ fileName: file.name, featureId, cases: [], error: err.message });
    }
  }

  preview.style.display = 'block';
  content.innerHTML = _bulkCsvParsed.map(item => `
    <div style="padding:8px 0;border-bottom:1px solid var(--border);">
      <div><strong>${item.fileName}</strong> → <code>${item.featureId}</code></div>
      <div style="color:${item.error ? 'var(--red)' : 'var(--text2)'};margin-top:2px;">
        ${item.error || `พร้อม import ${item.cases.length} cases`}
      </div>
    </div>`).join('');

  const invalidCount = _bulkCsvParsed.filter(item => item.error).length;
  if (invalidCount) {
    errEl.textContent = `มี ${invalidCount} ไฟล์ที่ import ไม่ได้ กรุณาแก้ชื่อไฟล์หรือรูปแบบ CSV`;
    errEl.style.display = 'block';
  }
  btn.disabled = !_bulkCsvParsed.some(item => !item.error);
}

async function submitBulkImport() {
  const btn = document.getElementById('btn-do-bulk-import');
  const mode = document.getElementById('bulk-import-mode').value;
  const validImports = _bulkCsvParsed.filter(item => !item.error);
  if (!validImports.length) return;

  btn.disabled = true;
  btn.textContent = 'กำลัง import...';
  try {
    const results = [];
    for (const item of validImports) {
      const result = mergeImportedCases(item.featureId, item.cases, mode);
      await writeFeatureFile(item.featureId);
      results.push({ featureId: item.featureId, ...result });
    }

    closeModal();
    FEATURES = buildFeatures();
    rebuildNav();
    updateHeaderStrip();
    if (currentFeatureId === 'overview') renderOverview();
    else {
      const feat = FEATURES.find(f => f.meta.id === currentFeatureId);
      if (feat) renderFeature(feat);
    }

    const summary = results.map(item =>
      `${item.featureId}: +${item.added}${item.updated ? ` / update ${item.updated}` : ''}`
    ).join('\n');
    setTimeout(() => alert(`Bulk import สำเร็จ\n${summary}`), 100);
  } catch (err) {
    const errEl = document.getElementById('bulk-csv-error');
    errEl.textContent = 'Bulk import ไม่สำเร็จ: ' + err.message;
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Import ทั้งหมด';
  }
}

// ══════════════════════════════════════════
//  DELETE
// ══════════════════════════════════════════
function confirmDeleteCase(caseId,featureId){
  if (!ensureWritable()) return;
  openConfirmModal('ลบ Test Case',
    `ต้องการลบ <strong>${caseId}</strong> ออกใช่ไหม?`,
    async()=>{
      showLoadingOverlay('กำลังลบ...');
      await deleteCaseData(featureId,caseId);
      FEATURES=buildFeatures();hideLoadingOverlay();
      const f=FEATURES.find(f=>f.meta.id===featureId);
      if(f)renderFeature(f);else renderOverview();
      rebuildNav();updateHeaderStrip();
    }
  );
}
function confirmDeleteFeature(featureId){
  if (!ensureWritable()) return;
  const f=FEATURES.find(f=>f.meta.id===featureId);if(!f)return;
  openConfirmModal('ลบ Feature',
    `ต้องการลบ <strong>${f.meta.emoji} ${f.meta.name}</strong> ทั้งหมดใช่ไหม?<br><small style="color:var(--red);">ลบทุก test case และไฟล์ใน Drive</small>`,
    async()=>{
      showLoadingOverlay('กำลังลบ...');
      await deleteFeatureData(featureId);
      FEATURES=buildFeatures();currentFeatureId='overview';
      hideLoadingOverlay();rebuildNav();renderOverview();updateHeaderStrip();
    }
  );
}

let caseModalAttachments = [];

function getCaseModalAttachmentHtml(){
  const list = caseModalAttachments || [];
  const gallery = list.length
    ? `<div class="attachment-gallery case-attachment-gallery">${list.map((att, index) => `<div class="attachment-item">${renderAttachmentPreview(att)}<div class="attachment-meta">${escapeHtml(att.uploadedBy || '-')} · ${escapeHtml(formatExecTimestamp(att.uploadedAt))}</div><button class="inline-remove-btn" type="button" onclick="removeCaseModalAttachment(${index})">ลบ</button></div>`).join('')}</div>`
    : `<div class="workspace-empty-inline">ยังไม่มี attachment</div>`;
  return `
    <div class="form-group case-attachment-section">
      <label>Attachments <span class="form-hint">รองรับรูปภาพและวิดีโอ .mp4 .mov .webm</span></label>
      <div class="attachment-upload-row">
        <label class="btn-modal-secondary workspace-upload-btn">แนบรูป / วิดีโอ
          <input type="file" multiple accept="image/*,video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" style="display:none" onchange="uploadCaseModalAttachments(event)">
        </label>
      </div>
      <div id="case-modal-attachments">${gallery}</div>
    </div>`;
}

function refreshCaseModalAttachments(){
  const el = document.getElementById('case-modal-attachments');
  if (!el) return;
  const list = caseModalAttachments || [];
  el.innerHTML = list.length
    ? `<div class="attachment-gallery case-attachment-gallery">${list.map((att, index) => `<div class="attachment-item">${renderAttachmentPreview(att)}<div class="attachment-meta">${escapeHtml(att.uploadedBy || '-')} · ${escapeHtml(formatExecTimestamp(att.uploadedAt))}</div><button class="inline-remove-btn" type="button" onclick="removeCaseModalAttachment(${index})">ลบ</button></div>`).join('')}</div>`
    : `<div class="workspace-empty-inline">ยังไม่มี attachment</div>`;
}

async function uploadCaseModalAttachments(event){
  if (!ensureWritable()) { event.target.value = ''; return; }
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  const caseId = String(document.getElementById('fc-id')?.value || '').trim() || `case-${Date.now()}`;
  showLoadingOverlay(`กำลังอัปโหลด ${files.length} ไฟล์...`);
  try {
    const uploaded = await driveUploadAttachments(files, caseId);
    caseModalAttachments.push(...uploaded.map(normalizeUploadedAttachment));
    refreshCaseModalAttachments();
  } catch (err) {
    alert('อัปโหลด attachment ไม่สำเร็จ: ' + buildErrorMessage(err));
  } finally {
    hideLoadingOverlay();
    event.target.value = '';
  }
}

function removeCaseModalAttachment(index){
  const [removed] = caseModalAttachments.splice(index, 1);
  refreshCaseModalAttachments();
  if (removed?.id) driveDeleteFile(removed.id).catch(() => {});
}

function normalizeCaseAttachments(c){
  if (!c) return [];
  if (!Array.isArray(c.attachments)) c.attachments = [];
  return c.attachments;
}

function getCaseAttachmentCount(c){
  return (c?.attachments || []).length;
}

function renderCaseAttachmentGallery(attachments, caseId, featureId){
  if (!attachments || !attachments.length) return '';
  return `<div style="grid-column:1/-1;">
    <div class="detail-section-title">Attachments (${attachments.length})</div>
    <div class="attachment-gallery case-attachment-gallery">${attachments.map((att) => `<div class="attachment-item">${renderAttachmentPreview(att)}<div class="attachment-meta">${escapeHtml(att.uploadedBy || '-')} · ${escapeHtml(formatExecTimestamp(att.uploadedAt))}</div><button class="inline-remove-btn" type="button" onclick="event.stopPropagation();removeCaseAttachment('${caseId}','${featureId}','${att.id || ''}')">ลบ</button></div>`).join('')}</div>
  </div>`;
}

async function uploadCaseAttachments(event, caseId, featureId){
  if (!ensureWritable()) { event.target.value = ''; return; }
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  showLoadingOverlay(`กำลังอัปโหลด ${files.length} ไฟล์...`);
  try {
    const f = DB.features[featureId]; if (!f) return;
    const c = f.cases.find(x => x.id === caseId); if (!c) return;
    normalizeCaseAttachments(c);
    const uploaded = await driveUploadAttachments(files, caseId);
    c.attachments.push(...uploaded.map(normalizeUploadedAttachment));
    await saveCase(featureId, c);
    FEATURES = buildFeatures();
    const feat = FEATURES.find(item => item.meta.id === featureId);
    if (feat) renderFeature(feat);
    setTimeout(() => toggleDetail(caseId, true), 100);
  } catch (err) {
    alert('อัปโหลด attachment ไม่สำเร็จ: ' + buildErrorMessage(err));
  } finally {
    hideLoadingOverlay();
    event.target.value = '';
  }
}

function removeCaseAttachment(caseId, featureId, attachmentId){
  if (!ensureWritable()) return;
  const f = DB.features[featureId]; if (!f) return;
  const c = f.cases.find(x => x.id === caseId); if (!c) return;
  normalizeCaseAttachments(c);
  const target = c.attachments.find(att => att.id === attachmentId);
  c.attachments = c.attachments.filter(att => att.id !== attachmentId);
  saveCase(featureId, c).then(() => {
    FEATURES = buildFeatures();
    const feat = FEATURES.find(item => item.meta.id === featureId);
    if (feat) renderFeature(feat);
    setTimeout(() => toggleDetail(caseId, true), 100);
  });
  if (target?.id) driveDeleteFile(target.id).catch(() => {});
}

// ══════════════════════════════════════════
//  ADD / EDIT CASE MODAL
// ══════════════════════════════════════════
function openAddCaseModal(featureId){
  if (!ensureWritable()) return;
  caseModalAttachments = [];
  const f=FEATURES.find(f=>f.meta.id===featureId);if(!f)return;
  const screenOptions=Object.entries(f.meta.screens).map(([k,sc])=>`<option value="${k}">${sc.label} – ${sc.name}</option>`).join('');
  const nums=f.cases.map(c=>parseInt(c.id.replace(/\D/g,''))||0);
  const next=(Math.max(0,...nums)+1).toString().padStart(2,'0');
  const prefix=featureId.split('-').map(w=>w[0].toUpperCase()).join('');
  openModal('add-case-modal',`
    <div class="modal-header"><span class="modal-title">＋ Add Test Case</span><span class="modal-sub">${f.meta.emoji} ${f.meta.name}</span></div>
    <div class="modal-body">
      <div class="form-row2">
        <div class="form-group"><label>Case ID</label><input class="form-input" id="fc-id" value="${prefix}-${next}" /></div>
        <div class="form-group"><label>Type</label><select class="form-select" id="fc-type">
          <option value="positive">✓ Positive</option><option value="edge">~ Edge case</option><option value="negative">✗ Negative</option>
        </select></div>
      </div>
      <div class="form-group"><label>Screen</label><select class="form-select" id="fc-screen">${screenOptions}</select></div>
      <div class="form-group"><label>Title</label><input class="form-input" id="fc-title" placeholder="ชื่อ test case" /></div>
      <div class="form-group"><label>Sub-title</label><input class="form-input" id="fc-sub" placeholder="คำอธิบายสั้น" /></div>
      <div class="form-group"><label>Steps to reproduce <span class="form-hint">บรรทัดละ 1 step</span></label>
        <textarea class="form-textarea" id="fc-steps" rows="4" placeholder="เปิดแอป&#10;กด Login&#10;ใส่ email และ password"></textarea></div>
      <div class="form-group"><label>Expected behavior <span class="form-hint">บรรทัดละ 1 รายการ</span></label>
        <textarea class="form-textarea" id="fc-expect" rows="4" placeholder="แสดงหน้า Home&#10;Token บันทึกแล้ว"></textarea></div>
      ${getCaseModalAttachmentHtml()}
    </div>
    <div class="modal-footer">
      <button class="btn-modal-cancel" onclick="closeModal()">ยกเลิก</button>
      <button class="btn-modal-ok" onclick="submitAddCase('${featureId}')">บันทึก</button>
    </div>`);
}

function openEditCaseModal(featureId, caseId){
  if (!ensureWritable()) return;
  const f = DB.features[featureId]; if (!f) return;
  const c = f.cases.find(item => item.id === caseId); if (!c) return;
  normalizeCaseAttachments(c);
  caseModalAttachments = (c.attachments || []).map(att => ({...att}));
  const screenOptions = Object.entries(f.meta.screens)
    .map(([k, sc]) => `<option value="${k}"${k===c.screen?' selected':''}>${sc.label} – ${sc.name}</option>`)
    .join('');

  openModal('edit-case-modal',`
    <div class="modal-header"><span class="modal-title">✏️ Edit Test Case</span><span class="modal-sub">${f.meta.emoji} ${f.meta.name}</span></div>
    <div class="modal-body">
      <div class="form-row2">
        <div class="form-group"><label>Case ID</label><input class="form-input" id="fc-id" value="${escapeHtml(c.id)}" readonly /></div>
        <div class="form-group"><label>Type</label><select class="form-select" id="fc-type">
          <option value="positive"${c.type==='positive'?' selected':''}>✓ Positive</option>
          <option value="edge"${c.type==='edge'?' selected':''}>~ Edge case</option>
          <option value="negative"${c.type==='negative'?' selected':''}>✗ Negative</option>
        </select></div>
      </div>
      <div class="form-group"><label>Screen</label><select class="form-select" id="fc-screen">${screenOptions}</select></div>
      <div class="form-group"><label>Title</label><input class="form-input" id="fc-title" value="${escapeHtml(c.title||'')}" placeholder="ชื่อ test case" /></div>
      <div class="form-group"><label>Sub-title</label><input class="form-input" id="fc-sub" value="${escapeHtml(c.sub||'')}" placeholder="คำอธิบายสั้น" /></div>
      <div class="form-group"><label>Steps to reproduce <span class="form-hint">บรรทัดละ 1 step</span></label>
        <textarea class="form-textarea" id="fc-steps" rows="4" placeholder="เปิดแอป&#10;กด Login&#10;ใส่ email และ password">${escapeHtml((c.steps||[]).join('\n'))}</textarea></div>
      <div class="form-group"><label>Expected behavior <span class="form-hint">บรรทัดละ 1 รายการ</span></label>
        <textarea class="form-textarea" id="fc-expect" rows="4" placeholder="แสดงหน้า Home&#10;Token บันทึกแล้ว">${escapeHtml((c.expect||[]).join('\n'))}</textarea></div>
      ${getCaseModalAttachmentHtml()}
    </div>
    <div class="modal-footer">
      <button class="btn-modal-cancel" onclick="closeModal()">ยกเลิก</button>
      <button class="btn-modal-ok" onclick="submitEditCase('${featureId}','${caseId}')">บันทึก</button>
    </div>`);
}

async function submitAddCase(featureId){
  const id=document.getElementById('fc-id').value.trim();
  const type=document.getElementById('fc-type').value;
  const screen=document.getElementById('fc-screen').value;
  const title=document.getElementById('fc-title').value.trim();
  const sub=document.getElementById('fc-sub').value.trim();
  const steps=document.getElementById('fc-steps').value.split('\n').map(s=>s.trim()).filter(Boolean);
  const expect=document.getElementById('fc-expect').value.split('\n').map(s=>s.trim()).filter(Boolean);
  if(!id||!title||!steps.length||!expect.length){showFormError('กรุณากรอก ID, Title, Steps และ Expected ให้ครบ');return;}
  const f = DB.features[featureId];
  if(f&&f.cases.some(c=>c.id===id)){showFormError(`Case ID "${id}" ซ้ำ`);return;}
  const okBtn=document.querySelector('.btn-modal-ok');
  if(okBtn){okBtn.disabled=true;okBtn.textContent='กำลังบันทึก...';}
  try{
    await saveCase(featureId,{id,type,screen,title,sub,steps,expect,images:[],attachments:[...caseModalAttachments]});
    FEATURES=buildFeatures();closeModal();rebuildNav();updateHeaderStrip();
    const feat=FEATURES.find(f=>f.meta.id===featureId);if(feat)renderFeature(feat);
  }catch(err){
    showFormError(`บันทึกไม่สำเร็จ: ${err.message}`);
    if(okBtn){okBtn.disabled=false;okBtn.textContent='บันทึก';}
  }
}

async function submitEditCase(featureId, caseId){
  const id = document.getElementById('fc-id').value.trim();
  const type = document.getElementById('fc-type').value;
  const screen = document.getElementById('fc-screen').value;
  const title = document.getElementById('fc-title').value.trim();
  const sub = document.getElementById('fc-sub').value.trim();
  const steps = document.getElementById('fc-steps').value.split('\n').map(s=>s.trim()).filter(Boolean);
  const expect = document.getElementById('fc-expect').value.split('\n').map(s=>s.trim()).filter(Boolean);
  if(!id||!title||!steps.length||!expect.length){showFormError('กรุณากรอก ID, Title, Steps และ Expected ให้ครบ');return;}

  const f = DB.features[featureId];
  const existing = f?.cases.find(c => c.id === caseId);
  if(!existing){showFormError('ไม่พบ test case ที่ต้องการแก้ไข');return;}

  const okBtn=document.querySelector('.btn-modal-ok');
  if(okBtn){okBtn.disabled=true;okBtn.textContent='กำลังบันทึก...';}
  try{
    await saveCase(featureId,{
      ...existing,
      id: existing.id,
      type,
      screen,
      title,
      sub,
      steps,
      expect,
      images: existing.images || [],
      attachments: [...caseModalAttachments],
    });
    FEATURES=buildFeatures();closeModal();rebuildNav();updateHeaderStrip();
    const feat=FEATURES.find(item=>item.meta.id===featureId);if(feat)renderFeature(feat);
  }catch(err){
    showFormError(`บันทึกไม่สำเร็จ: ${err.message}`);
    if(okBtn){okBtn.disabled=false;okBtn.textContent='บันทึก';}
  }
}


function openEditFeatureModal(featureId){
  if (!ensureWritable()) return;
  const feature = DB.features[featureId];
  if (!feature?.meta) return;
  const meta = feature.meta;
  const themeKey = Object.entries(THEME_COLORS).find(([, value]) => value.color === meta.color)?.[0] || 'orange';
  const screenText = Object.values(meta.screens || {})
    .map(sc => {
      const colorToken = sc.tone || sc.color || '';
      return `${sc.name || ''}${colorToken ? `|${colorToken}` : ''}`;
    })
    .join('\n');
  const tagText = (meta.tags || [])
    .map(tag => `${tag.label || ''}${tag.style === 'badge-custom' && tag.color ? `|${tag.color}` : ''}`)
    .join('\n');

  openModal('edit-feature-modal',`
    <div class="modal-header"><span class="modal-title">✏️ Edit Feature</span><span class="modal-sub">${escapeHtml(featureId)}</span></div>
    <div class="modal-body">
      <div class="form-row2">
        <div class="form-group"><label>Feature ID</label><input class="form-input" id="ef-id" value="${escapeHtml(meta.id)}" readonly /></div>
        <div class="form-group"><label>Emoji</label><input class="form-input" id="ef-emoji" value="${escapeHtml(meta.emoji || '📋')}" maxlength="2" /></div>
      </div>
      <div class="form-group"><label>Feature name</label><input class="form-input" id="ef-name" value="${escapeHtml(meta.name || '')}" /></div>
      <div class="form-group"><label>Description</label><input class="form-input" id="ef-desc" value="${escapeHtml(meta.description || '')}" /></div>
      <div class="form-group"><label>Color theme</label><select class="form-select" id="ef-color">
        <option value="orange"${themeKey==='orange'?' selected':''}>🟠 Orange</option>
        <option value="blue"${themeKey==='blue'?' selected':''}>🔵 Blue</option>
        <option value="green"${themeKey==='green'?' selected':''}>🟢 Green</option>
        <option value="purple"${themeKey==='purple'?' selected':''}>🟣 Purple</option>
        <option value="teal"${themeKey==='teal'?' selected':''}>🩵 Teal</option>
        <option value="amber"${themeKey==='amber'?' selected':''}>🟡 Amber</option>
      </select></div>
      <div class="form-group"><label>Screens</label>
        <textarea class="form-textarea" id="ef-screens" rows="5">${escapeHtml(screenText)}</textarea>
        <div class="form-hint" style="margin-top:4px;">บรรทัดละ 1 ชื่อ · เลือกสีได้ด้วยรูปแบบ ชื่อ|สี</div>
      </div>
      <div class="form-group"><label>Tags</label>
        <textarea class="form-textarea" id="ef-tags" rows="4">${escapeHtml(tagText)}</textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn-modal-cancel" onclick="closeModal()">ยกเลิก</button>
      <button class="btn-modal-ok" onclick="submitEditFeature('${featureId}')">บันทึก Feature</button>
    </div>`);
}

async function submitEditFeature(featureId){
  const current = DB.features[featureId];
  if(!current?.meta){showFormError('ไม่พบ feature ที่ต้องการแก้ไข');return;}
  const emoji=document.getElementById('ef-emoji').value.trim()||'📋';
  const name=document.getElementById('ef-name').value.trim();
  const desc=document.getElementById('ef-desc').value.trim();
  const theme=document.getElementById('ef-color').value;
  const screenInputs=document.getElementById('ef-screens').value.split('\n').map(parseScreenLineInput).filter(item=>item.name);
  const tags=parseFeatureTagsInput(document.getElementById('ef-tags').value, (THEME_COLORS[theme]||THEME_COLORS.orange).badge);
  if(!name||!screenInputs.length){showFormError('กรุณากรอก Name และ Screens');return;}
  const th=THEME_COLORS[theme]||THEME_COLORS.orange;
  const screens={};
  screenInputs.forEach((input,i)=>{
    const style = buildScreenStyleFromToken(input.colorToken);
    screens[`S${i+1}`] = {
      label:`Screen ${i+1}`,
      name:input.name,
      cssClass:`sc-${featureId}-s${i+1}`,
      tone: (SCREEN_THEME_COLORS[input.colorToken] ? input.colorToken : ''),
      color: style?.color || '',
      bg: style?.bg || '',
      border: style?.border || '',
    };
  });

  const nextMeta = {
    ...current.meta,
    emoji,
    name,
    description: desc || name,
    color: th.color,
    colorBg: th.colorBg,
    colorBorder: th.colorBorder,
    tags: tags.length ? tags : current.meta.tags,
    screens,
  };

  const okBtn=document.querySelector('.btn-modal-ok');
  if(okBtn){okBtn.disabled=true;okBtn.textContent='กำลังบันทึก...';}
  try{
    DB.features[featureId].meta = nextMeta;
    await writeFeatureFile(featureId);
    FEATURES=buildFeatures();
    injectScreenStyles();
    closeModal();
    rebuildNav();
    updateHeaderStrip();
    const feat=FEATURES.find(item=>item.meta.id===featureId);
    if(feat) renderFeature(feat);
  }catch(err){
    showFormError(`บันทึกไม่สำเร็จ: ${err.message}`);
    if(okBtn){okBtn.disabled=false;okBtn.textContent='บันทึก Feature';}
  }
}


// ══════════════════════════════════════════
//  ADD FEATURE MODAL
// ══════════════════════════════════════════
function openAddFeatureModal(projectId = selectedProjectId){
  if (!ensureWritable()) return;
  const targetProjectId = sanitizeProjectId(projectId || selectedProjectId || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID);
  const targetProject = (DB.projects || {})[targetProjectId] || { id: targetProjectId, name: DEFAULT_PROJECT_NAME, overview: '' };
  openModal('add-feature-modal',`
    <div class="modal-header"><span class="modal-title">＋ Add Feature</span><span class="modal-sub">สร้าง feature ใหม่</span></div>
    <div class="modal-body">
      <div class="form-row2">
        <div class="form-group"><label>Feature ID <span class="form-hint">ตัวเล็ก ไม่มีช่องว่าง</span></label><input class="form-input" id="ff-id" placeholder="เช่น checkout" /></div>
        <div class="form-group"><label>Emoji</label><input class="form-input" id="ff-emoji" placeholder="🛒" maxlength="2" /></div>
      </div>
      <div class="form-group"><label>Feature name</label><input class="form-input" id="ff-name" placeholder="เช่น Checkout Flow" /></div>
      <div class="form-row2">
        <div class="form-group"><label>Description</label><input class="form-input" id="ff-desc" placeholder="อธิบาย feature นี้" /></div>
        <div class="form-group"><label>Project</label><input class="form-input" value="${escapeHtml(targetProject.name)}" disabled /></div>
      </div>
      <div class="form-group"><label>Color theme</label><select class="form-select" id="ff-color">
        <option value="orange">🟠 Orange</option><option value="blue">🔵 Blue</option><option value="green">🟢 Green</option>
        <option value="purple">🟣 Purple</option><option value="teal">🩵 Teal</option><option value="amber">🟡 Amber</option>
      </select></div>
      <div class="form-group"><label>Screens <span class="form-hint">บรรทัดละ 1 ชื่อ · เลือกสีได้ด้วยรูปแบบ ชื่อ|สี</span></label>
        <textarea class="form-textarea" id="ff-screens" rows="5" placeholder="Login form|blue&#10;OTP verify|teal&#10;Dashboard|#7C3AED"></textarea>
        <div class="form-hint" style="margin-top:4px;">สีที่รองรับ: purple, blue, orange, green, amber, teal หรือกำหนดเองแบบ #HEX</div>
      </div>
      <div class="form-group"><label>Tags <span class="form-hint">บรรทัดละ 1 tag · ใส่สีได้ด้วยรูปแบบ Tag|#HEX</span></label>
        <textarea class="form-textarea" id="ff-tags" rows="4" placeholder="Journey&#10;Mobile App|#185FA5&#10;Security|#A32D2D"></textarea></div>
    </div>
    <div class="modal-footer">
      <button class="btn-modal-cancel" onclick="closeModal()">ยกเลิก</button>
      <button class="btn-modal-ok" onclick="submitAddFeature()">สร้าง Feature</button>
    </div>`);
}
async function submitAddFeature(){
  const id=document.getElementById('ff-id').value.trim().replace(/\s+/g,'-').toLowerCase();
  const emoji=document.getElementById('ff-emoji').value.trim()||'📋';
  const name=document.getElementById('ff-name').value.trim();
  const desc=document.getElementById('ff-desc').value.trim();
  const theme=document.getElementById('ff-color').value;
  const screenInputs=document.getElementById('ff-screens').value.split('\n').map(parseScreenLineInput).filter(item=>item.name);
  const tags=parseFeatureTagsInput(document.getElementById('ff-tags').value, (THEME_COLORS[theme]||THEME_COLORS.orange).badge);
  if(!id||!name||!screenInputs.length){showFormError('กรุณากรอก ID, Name และ Screens');return;}
  if(DB.features[id]){showFormError(`Feature ID "${id}" ซ้ำ`);return;}
  const th=THEME_COLORS[theme]||THEME_COLORS.orange;
  const screens={};
  screenInputs.forEach((input,i)=>{
    const style = buildScreenStyleFromToken(input.colorToken);
    screens[`S${i+1}`] = {
      label:`Screen ${i+1}`,
      name:input.name,
      cssClass:`sc-${id}-s${i+1}`,
      tone: (SCREEN_THEME_COLORS[input.colorToken] ? input.colorToken : ''),
      color: style?.color || '',
      bg: style?.bg || '',
      border: style?.border || '',
    };
  });
  const targetProject = (DB.projects || {})[sanitizeProjectId(selectedProjectId || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID)] || { id: sanitizeProjectId(selectedProjectId || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID), name: DEFAULT_PROJECT_NAME, overview: '' };
  const meta={id,name,emoji,color:th.color,colorBg:th.colorBg,colorBorder:th.colorBorder,
    tags:tags.length?tags:[{label:'Journey',style:th.badge}],description:desc||name,screens,projectId:targetProject.id,projectName:targetProject.name,projectOverview:targetProject.overview||''};
  const okBtn=document.querySelector('.btn-modal-ok');
  if(okBtn){okBtn.disabled=true;okBtn.textContent='กำลังสร้าง...';}
  try{
    await saveNewFeature(meta);
    FEATURES=buildFeatures();injectScreenStyles();closeModal();rebuildNav();switchTab(id);updateHeaderStrip();
  }catch(err){
    showFormError(`สร้างไม่สำเร็จ: ${err.message}`);
    if(okBtn){okBtn.disabled=false;okBtn.textContent='สร้าง Feature';}
  }
}

// ══════════════════════════════════════════
//  MODAL HELPERS
// ══════════════════════════════════════════
function openModal(id,html){
  let o=document.getElementById('modal-overlay');
  if(!o){
    o=document.createElement('div');
    o.id='modal-overlay';
    o.className='modal-overlay';
    // Do not close add/edit/submit dialogs when clicking outside.
    // Users must choose Cancel/Close or Save explicitly to prevent accidental data loss.
    o.onclick=e=>{
      if(e.target===o){
        const box=o.querySelector('.modal-box');
        if(box){
          box.classList.remove('modal-attention');
          void box.offsetWidth;
          box.classList.add('modal-attention');
        }
      }
    };
    document.body.appendChild(o);
  }
  o.innerHTML=`<div class="modal-box" id="${id}">${html}</div>`;
  o.style.display='flex';requestAnimationFrame(()=>o.classList.add('open'));
}
function openConfirmModal(title,body,fn){
  openModal('confirm-modal',`
    <div class="modal-header"><span class="modal-title">${title}</span></div>
    <div class="modal-body"><p style="font-size:14px;line-height:1.6;">${body}</p></div>
    <div class="modal-footer">
      <button class="btn-modal-cancel" onclick="closeModal()">ยกเลิก</button>
      <button class="btn-modal-danger" id="confirm-ok-btn">ลบ</button>
    </div>`);
  document.getElementById('confirm-ok-btn').onclick=()=>{closeModal();fn();};
}
function closeModal(){
  const o=document.getElementById('modal-overlay');
  if(o){o.classList.remove('open');setTimeout(()=>o.style.display='none',200);}
}
function showFormError(msg){
  let e=document.getElementById('form-error');
  if(!e){e=document.createElement('div');e.id='form-error';e.className='form-error';document.querySelector('.modal-footer')?.before(e);}
  e.textContent=msg;e.style.display='block';
}

// ══════════════════════════════════════════
//  RESET STATUS
// ══════════════════════════════════════════
async function resetAllStatus() {
  if (!ensureWritable()) return;
  if (APP_RUNTIME.connecting || APP_RUNTIME.resetting) return;
  if (!confirm('Reset ทุก status กลับเป็น No Run?')) return;

  const requestId = beginAsyncFlow('resetting');
  showLoadingOverlay('กำลัง reset...');

  try {
    clearPendingWrites();
    await resetAllStatusDB();
    DB.status = {};
    DB.deletedCases = [];
    DB.executions = {};
    syncAppView();
  } finally {
    hideLoadingOverlay();
    endAsyncFlow('resetting', requestId);
  }
}
