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
let activeSortMode = 'id-asc';
let DRIVE_STATE = {
  rootFolderId: null,
  rootFolderName: '',
  featuresFolderId: null,
  imagesFolderId: null,
  statusFileId: null,
};

const SORT_MODES = ['id-asc', 'id-desc', 'title-asc', 'title-desc'];

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
      rounds: [],
      fileId: null,
    };
  });
}

function getAccessToken() {
  return localStorage.getItem('qa_access_token') || '';
}

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

function getInitialSortMode() {
  const saved = (localStorage.getItem('qa_sort_mode') || '').trim();
  return SORT_MODES.includes(saved) ? saved : 'id-asc';
}

initTheme();
activeSortMode = getInitialSortMode();

function buildAuthHeaders(extra = {}) {
  const headers = new Headers(extra);
  headers.set('apikey', SUPABASE_ANON_KEY);
  const token = getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

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

  const headers = buildAuthHeaders();
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
  hideLoadingOverlay();
  hideSavingIndicator();
  showFallbackBanner(buildErrorMessage(err));
  document.getElementById('login-overlay').style.display = 'none';
  document.getElementById('drive-expired-banner').style.display = 'none';
  document.getElementById('drive-status-badge').style.display = 'none';
  init();
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
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error_description || d.msg || 'Login failed');
    localStorage.setItem('qa_access_token', d.access_token);
    await connectDriveWithServiceAccount();
  } catch (err) {
    errEl.textContent = err.message === 'Invalid login credentials' ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : err.message;
    errEl.style.display = 'block';
    btn.textContent = 'เข้าสู่ระบบ';
    btn.disabled = false;
  }
}

function handleLogout() {
  localStorage.removeItem('qa_access_token');
  currentAppMode = APP_MODE.DRIVE;
  lastDriveError = null;
  lastDriveDiagnostic = null;
  DB_READY = false;
  location.reload();
}

async function retryDriveConnect() {
  document.getElementById('drive-expired-banner').style.display = 'none';
  await connectDriveWithServiceAccount();
}

async function connectDriveWithServiceAccount() {
  showLoadingOverlay('กำลังโหลดข้อมูล');
  try {
    await loadAllData();
  } catch (err) {
    await useBundledFallback(err);
  }
}

(async () => {
  const supToken = getAccessToken();
  if (supToken) {
    document.getElementById('login-overlay').style.display = 'flex';
    await connectDriveWithServiceAccount();
  }
})();

async function persistFeatureFile(featureId) {
  const f = DB.features[featureId];
  if (!f) return;
  const result = await driveProxyRequest('feature-upsert', {
    method: 'POST',
    body: {
      featureId,
      meta: f.meta,
      cases: f.cases,
      rounds: f.rounds || [],
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
      fileId: null,
    };
    await persistFeatureFile(template.meta.id);
  }
}

async function loadAllData() {
  showLoadingOverlay('กำลังโหลดข้อมูล');
  const payload = await driveProxyRequest('bootstrap');
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
    deletedCases: payload.deletedCases || [],
    executions: payload.executions || {},
  };
  (payload.features || []).forEach(feature => {
    const featureId = feature.featureId || feature.meta?.id;
    if (!featureId) return;
    DB.features[featureId] = {
      meta: feature.meta,
      cases: feature.cases || [],
      rounds: feature.rounds || [],
      fileId: feature.fileId || null,
    };
  });

  currentAppMode = APP_MODE.DRIVE;
  DB_READY = true;
  await seedBundledFeaturesIfNeeded();
  hideLoadingOverlay();
  hideFallbackBanner();
  document.getElementById('login-overlay').style.display = 'none';
  document.getElementById('drive-expired-banner').style.display = 'none';
  document.getElementById('drive-status-badge').style.display = 'inline-flex';
  init();
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
  DB.features[meta.id] = { meta, cases: [], rounds: [], fileId: null };
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

let FEATURES=[], currentFeatureId='overview', activeType='all', activeScreen='all', activeStatusFilt='all';

function buildFeatures() {
  const deleted = getDeletedSet();
  return Object.values(DB.features).map(f => ({
    meta: f.meta,
    cases: f.cases.filter(c => !deleted.has(c.id)),
    rounds: Array.isArray(f.rounds) ? f.rounds : [],
    custom: true,
  }));
}


function getFeatureRecord(featureId) {
  return DB.features[featureId] || null;
}

function getFeatureRounds(featureId) {
  const rec = getFeatureRecord(featureId);
  if (!rec) return [];
  if (!Array.isArray(rec.rounds)) rec.rounds = [];
  return rec.rounds;
}

function getActiveRoundId(featureId) {
  const rec = getFeatureRecord(featureId);
  return String(rec?.meta?.activeRoundId || 'main');
}

function getActiveRound(featureId) {
  const activeRoundId = getActiveRoundId(featureId);
  if (!activeRoundId || activeRoundId === 'main') return null;
  return getFeatureRounds(featureId).find(r => r.id === activeRoundId) || null;
}

function getVisibleCasesForFeature(feature) {
  const round = getActiveRound(feature?.meta?.id);
  return round ? (round.cases || []) : (feature?.cases || []);
}

function getRoundSummary(round) {
  if (!round || !Array.isArray(round.cases)) {
    return { total: 0, passed: 0, failed: 0, executing: 0, blocked: 0, cancelled: 0, noRun: 0, passRate: 0 };
  }
  const total = round.cases.length;
  const passed = round.cases.filter(c => getStatus(c.id) === 'passed').length;
  const failed = round.cases.filter(c => getStatus(c.id) === 'failed').length;
  const executing = round.cases.filter(c => getStatus(c.id) === 'executing').length;
  const blocked = round.cases.filter(c => getStatus(c.id) === 'blocked').length;
  const cancelled = round.cases.filter(c => getStatus(c.id) === 'cancelled').length;
  const noRun = round.cases.filter(c => getStatus(c.id) === 'no-run').length;
  const passRate = total ? Math.round((passed / total) * 100) : 0;
  return { total, passed, failed, executing, blocked, cancelled, noRun, passRate };
}

function renderRoundSummary(featureId) {
  const round = getActiveRound(featureId);
  if (!round) {
    return `<div class="round-summary-card round-summary-empty">
      <div><strong>Main Test Case</strong></div>
      <div>ใช้เป็น master/template เท่านั้น ไม่เอามาคิด Summary</div>
    </div>`;
  }
  const s = getRoundSummary(round);
  return `<div class="round-summary-card">
    <div class="round-summary-head">
      <div><strong>${escapeHtml(round.name || 'Test Round')}</strong></div>
      <div class="round-pass-rate">Pass Rate ${s.passRate}%</div>
    </div>
    <div class="round-summary-grid">
      <div><span>${s.total}</span><small>Total</small></div>
      <div class="rs-pass"><span>${s.passed}</span><small>Pass</small></div>
      <div class="rs-fail"><span>${s.failed}</span><small>Fail</small></div>
      <div class="rs-pending"><span>${s.noRun}</span><small>No Run</small></div>
      <div class="rs-blocked"><span>${s.blocked}</span><small>Blocked</small></div>
    </div>
  </div>`;
}

async function setActiveRound(featureId, roundId) {
  const rec = getFeatureRecord(featureId);
  if (!rec) return;
  rec.meta.activeRoundId = roundId || 'main';
  scheduleFeatureWrite(featureId);
  FEATURES = buildFeatures();
  const feat = FEATURES.find(f => f.meta.id === featureId);
  if (feat) renderFeature(feat);
}

function makeRoundCaseId(baseId, roundId) {
  return `${String(baseId).replace(/__ROUND_.+$/, '')}__ROUND_${roundId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

async function duplicateRoundFromMain(featureId) {
  if (!ensureWritable()) return;
  const rec = getFeatureRecord(featureId);
  if (!rec) return;
  const name = prompt('ตั้งชื่อ Test Round', `Round ${(rec.rounds || []).length + 1}`);
  if (!name) return;
  if (!Array.isArray(rec.rounds)) rec.rounds = [];
  const roundId = `R${Date.now()}`;
  const cases = (rec.cases || []).map(c => ({
    ...cloneJson(c),
    id: makeRoundCaseId(c.id, roundId),
    originalId: c.originalId || c.id,
    displayId: c.displayId || c.id,
    images: cloneJson(c.images || []),
  }));
  rec.rounds.push({
    id: roundId,
    name: name.trim(),
    source: 'main',
    createdAt: new Date().toISOString(),
    cases,
    defects: [],
  });
  rec.meta.activeRoundId = roundId;
  await writeFeatureFile(featureId);
  FEATURES = buildFeatures();
  injectScreenStyles();
  rebuildNav();
  const feat = FEATURES.find(f => f.meta.id === featureId);
  if (feat) renderFeature(feat);
}

function deleteRound(featureId, roundId) {
  if (!confirm('ลบ Test Round นี้? ผล execute ของรอบนี้จะไม่ถูกใช้ในหน้ารอบอีก')) return;
  const rec = getFeatureRecord(featureId);
  if (!rec || !Array.isArray(rec.rounds)) return;
  const round = rec.rounds.find(r => r.id === roundId);
  (round?.cases || []).forEach(c => {
    if (DB.status?.[c.id]) delete DB.status[c.id];
    if (DB.executions?.[c.id]) delete DB.executions[c.id];
  });
  rec.rounds = rec.rounds.filter(r => r.id !== roundId);
  rec.meta.activeRoundId = 'main';
  scheduleFeatureWrite(featureId);
  scheduleStatusWrite();
  FEATURES = buildFeatures();
  const feat = FEATURES.find(f => f.meta.id === featureId);
  if (feat) renderFeature(feat);
}

function normalizeScreenName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function ensureScreenMappingForCases(featureId, cases) {
  const rec = getFeatureRecord(featureId);
  if (!rec) return cases;
  if (!rec.meta.screens || typeof rec.meta.screens !== 'object') rec.meta.screens = {};
  const screens = rec.meta.screens;
  const nameToKey = {};
  Object.entries(screens).forEach(([key, sc]) => {
    nameToKey[String(key).toLowerCase()] = key;
    if (sc?.name) nameToKey[normalizeScreenName(sc.name).toLowerCase()] = key;
    if (sc?.label) nameToKey[normalizeScreenName(sc.label).toLowerCase()] = key;
  });
  let nextIndex = Object.keys(screens)
    .map(k => parseInt(String(k).replace(/\D/g, ''), 10))
    .filter(n => Number.isFinite(n))
    .reduce((max, n) => Math.max(max, n), 0) + 1;

  return cases.map(c => {
    const raw = normalizeScreenName(c.screen_name || c.screen || 'Unknown');
    let key = nameToKey[raw.toLowerCase()];
    if (!key) {
      key = `S${nextIndex++}`;
      const style = getScreenStyle(Object.keys(screens).length);
      screens[key] = {
        label: key,
        name: raw,
        cssClass: `sc-${featureId}-${key.toLowerCase()}`,
        tone: '',
        color: style.color,
        bg: style.bg,
        border: style.border,
      };
      nameToKey[raw.toLowerCase()] = key;
      nameToKey[key.toLowerCase()] = key;
    }
    return { ...c, screen: key, screen_name: raw, screen_id: key };
  });
}


function refreshRoundSummary(featureId) {
  const card = document.querySelector('.round-summary-card');
  if (!card) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderRoundSummary(featureId);
  const next = wrapper.firstElementChild;
  if (next) card.replaceWith(next);
}

function buildRoundControls(feature) {
  const featureId = feature.meta.id;
  const activeRoundId = getActiveRoundId(featureId);
  const rounds = getFeatureRounds(featureId);
  const options = [`<option value="main"${activeRoundId === 'main' ? ' selected' : ''}>Main Test Case (template)</option>`]
    .concat(rounds.map(r => `<option value="${escapeHtml(r.id)}"${activeRoundId === r.id ? ' selected' : ''}>${escapeHtml(r.name || r.id)}</option>`))
    .join('');
  const activeRound = getActiveRound(featureId);
  return `<div class="round-toolbar">
    <div class="round-toolbar-left">
      <label>Test Round</label>
      <select class="form-select round-select" onchange="setActiveRound('${featureId}', this.value)">${options}</select>
      <button class="btn-add-case" onclick="duplicateRoundFromMain('${featureId}')">⧉ Duplicate จาก Main</button>
      ${activeRound ? `<button class="icon-btn icon-btn-danger" onclick="deleteRound('${featureId}','${activeRound.id}')">🗑 ลบรอบ</button>` : ''}
    </div>
    <div class="round-toolbar-right">
      <button class="btn-export-csv" onclick="exportSummaryHtml('${featureId}')">📧 Export Summary HTML</button>
      <button class="btn-export-csv" onclick="exportSummaryImage('${featureId}')">🖼 Export Summary PNG</button>
    </div>
  </div>${renderRoundSummary(featureId)}`;
}

function safeFileName(text) {
  return String(text || 'qa-summary').replace(/[^\w\-]+/g, '_').slice(0, 90);
}

function buildSummaryExportHtml(featureId) {
  const rec = getFeatureRecord(featureId);
  const round = getActiveRound(featureId);
  if (!rec || !round) {
    alert('กรุณาเลือก Test Round ก่อน export summary');
    return '';
  }
  const s = getRoundSummary(round);
  const rows = (round.cases || []).map(c => `<tr><td>${escapeHtml(c.screen_id || c.screen || '-')}</td><td>${escapeHtml(c.screen_name || rec.meta.screens?.[c.screen]?.name || '-')}</td><td>${escapeHtml(c.displayId || c.originalId || c.id)}</td><td>${escapeHtml(c.title || '-')}</td><td>${escapeHtml(getStatusLabel(getStatus(c.id)))}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>QA Summary - ${escapeHtml(rec.meta.name)} - ${escapeHtml(round.name)}</title>
  <style>body{font-family:Arial,sans-serif;background:#f8fafc;color:#0f172a;padding:24px}.card{background:white;border:1px solid #e2e8f0;border-radius:16px;padding:24px;max-width:1000px;margin:auto}.meta{color:#64748b;line-height:1.7}.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:20px 0}.box{background:#f1f5f9;border-radius:12px;padding:14px;text-align:center}.num{font-size:26px;font-weight:700}.pass{color:#16a34a}.fail{color:#dc2626}.pending{color:#ca8a04}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #cbd5e1;padding:8px;text-align:left}th{background:#e2e8f0}</style></head><body><div class="card">
    <h1>QA Progress Summary</h1><div class="meta">Feature: ${escapeHtml(rec.meta.name)}<br>Round: ${escapeHtml(round.name)}<br>Generated: ${escapeHtml(new Date().toLocaleString())}</div>
    <div class="grid"><div class="box"><div class="num">${s.total}</div><div>Total</div></div><div class="box pass"><div class="num">${s.passed}</div><div>Pass</div></div><div class="box fail"><div class="num">${s.failed}</div><div>Fail</div></div><div class="box pending"><div class="num">${s.noRun}</div><div>No Run</div></div><div class="box"><div class="num">${s.passRate}%</div><div>Pass Rate</div></div></div>
    <h2>Test Case Status</h2><table><thead><tr><th>Screen ID</th><th>Screen</th><th>Case ID</th><th>Test Case</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
  </div></body></html>`;
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportSummaryHtml(featureId) {
  const rec = getFeatureRecord(featureId);
  const round = getActiveRound(featureId);
  const html = buildSummaryExportHtml(featureId);
  if (!html || !rec || !round) return;
  downloadBlob(html, `${safeFileName(rec.meta.name)}_${safeFileName(round.name)}_summary.html`, 'text/html;charset=utf-8');
}

function exportSummaryImage(featureId) {
  const rec = getFeatureRecord(featureId);
  const round = getActiveRound(featureId);
  if (!rec || !round) {
    alert('กรุณาเลือก Test Round ก่อน export summary');
    return;
  }
  const s = getRoundSummary(round);
  const canvas = document.createElement('canvas');
  canvas.width = 1200; canvas.height = 720;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff'; roundRect(ctx, 40, 40, 1120, 640, 24, true);
  ctx.fillStyle = '#0f172a'; ctx.font = 'bold 42px Arial'; ctx.fillText('QA Progress Summary', 80, 110);
  ctx.font = '24px Arial'; ctx.fillStyle = '#475569';
  ctx.fillText(`Feature: ${rec.meta.name || '-'}`, 80, 155);
  ctx.fillText(`Round: ${round.name || '-'}`, 80, 190);
  ctx.fillText(`Generated: ${new Date().toLocaleString()}`, 80, 225);
  const boxes = [['Total', s.total, '#0f172a'], ['Pass', s.passed, '#16a34a'], ['Fail', s.failed, '#dc2626'], ['No Run', s.noRun, '#ca8a04'], ['Pass Rate', `${s.passRate}%`, '#2563eb']];
  boxes.forEach((b, i) => { const x = 80 + i * 215; ctx.fillStyle = '#f1f5f9'; roundRect(ctx, x, 280, 180, 130, 18, true); ctx.fillStyle = b[2]; ctx.font = 'bold 40px Arial'; ctx.fillText(String(b[1]), x + 24, 340); ctx.fillStyle = '#334155'; ctx.font = '22px Arial'; ctx.fillText(b[0], x + 24, 380); });
  ctx.fillStyle = '#0f172a'; ctx.font = 'bold 28px Arial'; ctx.fillText('Status Breakdown', 80, 480);
  const barX = 80, barY = 520, barW = 1040, barH = 42; const total = Math.max(s.total, 1);
  const passW = barW * (s.passed / total), failW = barW * (s.failed / total), pendingW = barW * (s.noRun / total);
  ctx.fillStyle = '#16a34a'; ctx.fillRect(barX, barY, passW, barH);
  ctx.fillStyle = '#dc2626'; ctx.fillRect(barX + passW, barY, failW, barH);
  ctx.fillStyle = '#ca8a04'; ctx.fillRect(barX + passW + failW, barY, pendingW, barH);
  ctx.fillStyle = '#475569'; ctx.font = '20px Arial'; ctx.fillText(`Pass ${s.passed}  •  Fail ${s.failed}  •  No Run ${s.noRun}`, 80, 600);
  canvas.toBlob(blob => { if (!blob) return; const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${safeFileName(rec.meta.name)}_${safeFileName(round.name)}_summary.png`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); }, 'image/png');
}

function roundRect(ctx, x, y, width, height, radius, fill) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y); ctx.lineTo(x + width - radius, y); ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius); ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height); ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius); ctx.quadraticCurveTo(x, y, x + radius, y); ctx.closePath(); if (fill) ctx.fill();
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

  const saved = await openExecutionNoteModal(featureId, caseId, nextStatus, { reRender: false });
  if (!saved) {
    sel.value = prevStatus;
    applyStatusSelectClass(sel, prevStatus);
    return;
  }

  applyStatusSelectClass(sel, nextStatus);
  updateHeaderStrip();
  if(currentFeatureId==='overview')refreshFeatureRowStats(featureId);
  else { refreshStatusStatsBar(featureId); refreshRoundSummary(featureId); }
}

function init(){
  initTheme();
  activeSortMode = getInitialSortMode();
  FEATURES=buildFeatures();
  injectScreenStyles();buildNavTabs();renderOverview();updateHeaderStrip();
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
  const wrap=document.getElementById('nav-tabs');
  const total=FEATURES.reduce((s,f)=>s+f.cases.length,0);
  wrap.innerHTML=`
    <button class="nav-tab active" id="tab-overview" onclick="switchTab('overview')">📋 Overview <span class="tab-count">${total}</span></button>
    ${FEATURES.map(f=>`<button class="nav-tab" id="tab-${f.meta.id}" onclick="switchTab('${f.meta.id}')">${f.meta.emoji} ${f.meta.name} <span class="tab-count">${f.cases.length}</span></button>`).join('')}
    <button class="nav-tab nav-tab-add" id="tab-add-feature" onclick="openAddFeatureModal()" style="color:var(--orange);">＋ Feature</button>`;
}
function rebuildNav(){
  FEATURES=buildFeatures();buildNavTabs();
  document.getElementById(`tab-${currentFeatureId}`)?.classList.add('active');
  if(currentFeatureId==='overview')document.getElementById('tab-overview')?.classList.add('active');
}
function switchTab(id){
  currentFeatureId=id;activeType=activeScreen=activeStatusFilt='all';
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(`tab-${id}`)?.classList.add('active');
  if(id==='overview')renderOverview();
  else{const f=FEATURES.find(f=>f.meta.id===id);if(f)renderFeature(f);}
}

// ── OVERVIEW ──────────────────────────────
function renderOverview(){
  FEATURES=buildFeatures();
  const ac=FEATURES.flatMap(f=>f.cases),total=ac.length,counts=getStatusCounts(ac);
  const statNums={passed:'var(--green)',failed:'var(--red)',executing:'var(--blue)',blocked:'var(--amber)',cancelled:'var(--purple)','no-run':'var(--text3)'};
  document.getElementById('main-content').innerHTML=`
    <div class="ov-summary-bar">
      <div class="ov-summary-item"><span class="ov-summary-num" style="color:var(--blue);">${total}</span><span class="ov-summary-lbl">Total cases</span></div>
      <div class="ov-divider"></div>
      <div class="ov-summary-item"><span class="ov-summary-num" style="color:var(--text2);">${FEATURES.length}</span><span class="ov-summary-lbl">Features</span></div>
      <div class="ov-divider"></div>
      ${STATUSES.map(s=>`<div class="ov-summary-item"><span class="ov-summary-num" style="color:${statNums[s.key]};">${counts[s.key]}</span><span class="ov-summary-lbl">${s.label}</span></div>`).join('')}
      <div class="ov-divider"></div>
      <div class="ov-progress-wrap"><div class="ov-progress-label">Overall progress</div>
        <div class="ov-progress-bar" id="ov-global-progress">${buildProgressBar(counts,total,'ov-pb-seg')}</div>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
      <button class="btn-import-csv" onclick="openBulkImportModal()">📦 Bulk CSV</button>
    </div>
    <div class="section-sep"><span>Features</span><span class="count-pill">${FEATURES.length} features · ${total} cases</span></div>
    <div class="ov-list" id="ov-list">
      ${FEATURES.length===0
        ?`<div class="empty-state"><div class="emoji">📂</div><p>ยังไม่มี feature — กด <strong>＋ Feature</strong> เพื่อเริ่ม</p></div>`
        :FEATURES.map(f=>buildFeatureRow(f)).join('')}
    </div>`;
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
  const gp=document.getElementById('ov-global-progress');
  if(gp){const ac=FEATURES.flatMap(f=>f.cases);gp.innerHTML=buildProgressBar(getStatusCounts(ac),ac.length,'ov-pb-seg');}
}

// ── FEATURE VIEW ───────────────────────────
function renderFeature(feature){
  const { meta } = feature;
  const cases = getVisibleCasesForFeature(feature);
  const tags=(meta.tags||[]).map(renderFeatureTag).join('');
  const screenBtns=Object.entries(meta.screens).map(([k,sc],i)=>{
    const cls=['active-purple','active-blue','active-orange','active-green','active-amber','active-teal'][i%6];
    return`<button class="filter-btn" onclick="setScreenFilter('${k}',this,'${cls}')">${sc.label} – ${sc.name}</button>`;
  }).join('');
  document.getElementById('main-content').innerHTML=`
    <div class="feature-header">
      <div style="font-size:24px;">${meta.emoji}</div>
      <div class="feature-info" style="flex:1;"><div class="feature-name">${meta.name}</div>
        <div class="feature-desc">${meta.description}</div><div class="feature-tags">${tags}</div></div>
      <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;">
        <button class="icon-btn icon-btn-danger" onclick="confirmDeleteFeature('${meta.id}')">🗑 ลบ Feature</button>
        <button class="btn-import-csv" onclick="openImportCsvModal('${meta.id}')">📥 Import CSV</button>
        <button class="btn-export-csv" onclick="exportCsv('${meta.id}')">📤 Export CSV</button>
        <button class="btn-add-case" onclick="openAddCaseModal('${meta.id}')">＋ Add case</button>
      </div>
    </div>
    ${buildRoundControls(feature)}
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
    <div class="list-toolbar">
      <div class="list-toolbar-item">
        <span class="filter-label" style="margin:0;">Sort</span>
        <select id="sort-select" class="form-select sort-select" onchange="setSortMode(this.value)">
          <option value="id-asc"${activeSortMode==='id-asc'?' selected':''}>ID A-Z</option>
          <option value="id-desc"${activeSortMode==='id-desc'?' selected':''}>ID Z-A</option>
          <option value="title-asc"${activeSortMode==='title-asc'?' selected':''}>Test Case A-Z</option>
          <option value="title-desc"${activeSortMode==='title-desc'?' selected':''}>Test Case Z-A</option>
        </select>
      </div>
    </div>
    <div class="filter-section"><div class="filter-label">Type</div><div class="filter-group" id="type-filters">
      <button class="filter-btn active" onclick="setTypeFilter('all',this,'active')">All types</button>
      <button class="filter-btn" onclick="setTypeFilter('positive',this,'active-green')">✓ Positive</button>
      <button class="filter-btn" onclick="setTypeFilter('edge',this,'active-amber')">~ Edge case</button>
      <button class="filter-btn" onclick="setTypeFilter('negative',this,'active-red')">✗ Negative</button>
    </div></div>
    <div class="filter-section"><div class="filter-label">Screen</div><div class="filter-group" id="screen-filters">
      <button class="filter-btn active" onclick="setScreenFilter('all',this,'active')">All screens</button>${screenBtns}
    </div></div>
    <div class="filter-section"><div class="filter-label">Status</div><div class="filter-group" id="status-filters">
      <button class="filter-btn active" onclick="setStatusFilter('all',this,'active')">All status</button>
      ${STATUSES.map(s=>`<button class="filter-btn" onclick="setStatusFilter('${s.key}',this,'${s.filterClass}')">${s.icon} ${s.label}</button>`).join('')}
    </div></div>
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
  updateTypeStats(cases);refreshStatusStatsBar(meta.id);applyFilters();
}

function refreshStatusStatsBar(fid){
  const el=document.getElementById('status-stats-bar');if(!el)return;
  const f=FEATURES.find(f=>f.meta.id===fid);if(!f)return;
  const visibleCases = getVisibleCasesForFeature(f);
  const counts=getStatusCounts(visibleCases),total=visibleCases.length;
  el.innerHTML=`<span class="ssg-label">Test Run</span>
    ${STATUSES.map(s=>`<span class="ssg-item" style="background:${STATUS_COLORS[s.key]}22;color:var(--st-${s.key});border-color:${STATUS_COLORS[s.key]};">${s.icon} ${s.label} <strong>${counts[s.key]}</strong></span>`).join('')}
    <div class="ssg-progress">${buildProgressBar(counts,total,'ssg-pt-seg')}</div>`;
}

function clearGroup(id){document.querySelectorAll(`#${id} .filter-btn`).forEach(b=>b.className=b.className.replace(/\bactive[\w-]*/g,'').trim());}
function setTypeFilter(v,b,c){clearGroup('type-filters');b.classList.add(c);activeType=v;applyFilters();}
function setScreenFilter(v,b,c){clearGroup('screen-filters');b.classList.add(c);activeScreen=v;applyFilters();}
function setStatusFilter(v,b,c){clearGroup('status-filters');b.classList.add(c);activeStatusFilt=v;applyFilters();}

function setSortMode(mode) {
  if (!SORT_MODES.includes(mode)) return;
  activeSortMode = mode;
  localStorage.setItem('qa_sort_mode', mode);
  applyFilters();
}

function normalizeCompareText(value) {
  return String(value || '').trim().toLowerCase();
}

function sortCasesForView(cases) {
  const sorted = [...cases];
  if (activeSortMode === 'id-asc') {
    sorted.sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric: true, sensitivity: 'base' }));
  } else if (activeSortMode === 'id-desc') {
    sorted.sort((a, b) => String(b.id || '').localeCompare(String(a.id || ''), undefined, { numeric: true, sensitivity: 'base' }));
  } else if (activeSortMode === 'title-asc') {
    sorted.sort((a, b) => normalizeCompareText(a.title).localeCompare(normalizeCompareText(b.title), undefined, { numeric: true, sensitivity: 'base' }));
  } else if (activeSortMode === 'title-desc') {
    sorted.sort((a, b) => normalizeCompareText(b.title).localeCompare(normalizeCompareText(a.title), undefined, { numeric: true, sensitivity: 'base' }));
  }
  return sorted;
}

function applyFilters(){
  const f=FEATURES.find(f=>f.meta.id===currentFeatureId);if(!f)return;
  const q=(document.getElementById('search-input')?.value||'').toLowerCase();
  const visibleCases = getVisibleCasesForFeature(f);
  const filtered=visibleCases.filter(c=>{
    const typeOk=activeType==='all'||c.type===activeType;
    const screenOk=activeScreen==='all'||c.screen===activeScreen;
    const stOk=activeStatusFilt==='all'||getStatus(c.id)===activeStatusFilt;
    const srchOk=!q||[c.title,c.sub,c.id,...(c.steps||[]),...(c.expect||[])].some(s=>s&&s.toLowerCase().includes(q));
    return typeOk&&screenOk&&stOk&&srchOk;
  });
  renderTable(sortCasesForView(filtered),f);
}

function renderTable(list,feature){
  const tbody=document.getElementById('tc-tbody'),countEl=document.getElementById('showing-count'),emptyEl=document.getElementById('empty-state');
  if(!tbody)return;
  const visibleCases = getVisibleCasesForFeature(feature);
  countEl.textContent=`${list.length} / ${visibleCases.length}`;
  emptyEl.style.display=list.length?'none':'block';
  if(!list.length){tbody.innerHTML='';return;}
  tbody.innerHTML=list.map(c=>{
    const sc=feature.meta.screens[c.screen];
    const typePill=`<span class="type-pill tp-${c.type}"><span class="type-pill-label">${{positive:'✓ Positive',edge:'~ Edge',negative:'✗ Negative'}[c.type]||c.type}</span></span>`;
    const screenTag=sc
      ? `<span class="screen-tag ${sc.cssClass}"><span class="screen-tag-label">${sc.label}</span><span class="screen-tag-name">${sc.name}</span></span>`
      : `<span class="screen-tag"><span class="screen-tag-label">${c.screen_id || c.screen || ''}</span><span class="screen-tag-name">${c.screen_name || ''}</span></span>`;
    const execMeta = getExecutionMeta(c.id) || {};
    const execBy = execMeta.executor || '-';
    const execRemark = execMeta.remark || '-';
    const execTime = formatExecTimestamp(execMeta.updatedAt);
    const imgCount=c.images?.length||0;
    const imgBadge=imgCount>0?`<span class="img-badge" onclick="event.stopPropagation();openImageViewer('${c.id}','${feature.meta.id}')">🖼 ${imgCount}</span>`:'';
    return`
    <tr class="tc-row" id="row-${c.id}" onclick="toggleDetail('${c.id}')">
      <td class="col-id"><span class="tc-id">${c.displayId || c.originalId || c.id}</span></td>
      <td class="col-screen hide-sm">${screenTag}</td>
      <td class="col-title"><div class="tc-title-text">${c.title} ${imgBadge}</div><div class="tc-sub-text">${c.sub||''}</div></td>
      <td class="col-type hide-sm">${typePill}</td>
      <td class="col-status">${statusSelectHtml(c.id,feature.meta.id)}</td>
      <td class="col-actions">
        <div class="case-actions">
          <button class="icon-btn icon-btn-compact" onclick="event.stopPropagation();openExecutionNoteModal('${feature.meta.id}','${c.id}')" title="Remark / Execute">📝</button>
          ${getActiveRound(feature.meta.id) ? '' : `<button class="icon-btn icon-btn-compact" onclick="event.stopPropagation();openEditCaseModal('${feature.meta.id}','${c.id}')" title="แก้ไข">✏️</button><button class="icon-btn icon-btn-danger icon-btn-compact" onclick="event.stopPropagation();confirmDeleteCase('${c.id}','${feature.meta.id}')" title="ลบ">🗑</button>`}
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
        </div>
      </td>
    </tr>`;
  }).join('');
}

function toggleDetail(id){
  const dr=document.getElementById(`detail-${id}`),mr=document.getElementById(`row-${id}`),open=dr.classList.contains('open');
  document.querySelectorAll('.detail-row.open').forEach(r=>r.classList.remove('open'));
  document.querySelectorAll('.tc-row.expanded').forEach(r=>r.classList.remove('expanded'));
  if(!open){dr.classList.add('open');mr.classList.add('expanded');dr.scrollIntoView({behavior:'smooth',block:'nearest'});}
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
        • <b>screen</b>: ใส่ชื่อหน้าจอปกติได้ ระบบจะ map เป็น S1/S2/S3 ให้อัตโนมัติ<br>
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
      id: obj.id, type: obj.type||'positive', screen: obj.screen||'Unknown', screen_name: obj.screen || 'Unknown',
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
      return { ...c, images: existing?.images || [] };
    });
    return { added, updated };
  }

  const nextCases = [...f.cases];
  cases.forEach(c => {
    const existing = existingMap.get(c.id);
    if (existing) {
      Object.assign(existing, c, { images: existing.images || [] });
      updated++;
      return;
    }
    nextCases.push({ ...c, images: c.images || [] });
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
    const normalizedCases = ensureScreenMappingForCases(featureId, _csvParsed);
    const { added, updated } = mergeImportedCases(featureId, normalizedCases, 'merge');
    await writeFeatureFile(featureId);
    closeModal();
    FEATURES = buildFeatures(); injectScreenStyles(); rebuildNav(); updateHeaderStrip();
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
      const normalizedCases = ensureScreenMappingForCases(item.featureId, item.cases);
      const result = mergeImportedCases(item.featureId, normalizedCases, mode);
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

// ══════════════════════════════════════════
//  ADD / EDIT CASE MODAL
// ══════════════════════════════════════════
function openAddCaseModal(featureId){
  if (!ensureWritable()) return;
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
    await saveCase(featureId,{id,type,screen,title,sub,steps,expect,images:[]});
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
    });
    FEATURES=buildFeatures();closeModal();rebuildNav();updateHeaderStrip();
    const feat=FEATURES.find(item=>item.meta.id===featureId);if(feat)renderFeature(feat);
  }catch(err){
    showFormError(`บันทึกไม่สำเร็จ: ${err.message}`);
    if(okBtn){okBtn.disabled=false;okBtn.textContent='บันทึก';}
  }
}

// ══════════════════════════════════════════
//  ADD FEATURE MODAL
// ══════════════════════════════════════════
function openAddFeatureModal(){
  if (!ensureWritable()) return;
  openModal('add-feature-modal',`
    <div class="modal-header"><span class="modal-title">＋ Add Feature</span><span class="modal-sub">สร้าง feature ใหม่</span></div>
    <div class="modal-body">
      <div class="form-row2">
        <div class="form-group"><label>Feature ID <span class="form-hint">ตัวเล็ก ไม่มีช่องว่าง</span></label><input class="form-input" id="ff-id" placeholder="เช่น checkout" /></div>
        <div class="form-group"><label>Emoji</label><input class="form-input" id="ff-emoji" placeholder="🛒" maxlength="2" /></div>
      </div>
      <div class="form-group"><label>Feature name</label><input class="form-input" id="ff-name" placeholder="เช่น Checkout Flow" /></div>
      <div class="form-group"><label>Description</label><input class="form-input" id="ff-desc" placeholder="อธิบาย feature นี้" /></div>
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
  const meta={id,name,emoji,color:th.color,colorBg:th.colorBg,colorBorder:th.colorBorder,
    tags:tags.length?tags:[{label:'Journey',style:th.badge}],description:desc||name,screens};
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
  if(!o){o=document.createElement('div');o.id='modal-overlay';o.className='modal-overlay';o.onclick=e=>{if(e.target===o){const box=o.querySelector('.modal-box');if(box){box.animate([{transform:'scale(1)'},{transform:'scale(1.012)'},{transform:'scale(1)'}],{duration:160});}}};document.body.appendChild(o);}
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
async function resetAllStatus(){
  if (!ensureWritable()) return;
  if(!confirm('Reset ทุก status กลับเป็น No Run?'))return;
  showLoadingOverlay('กำลัง reset...');
  await resetAllStatusDB();
  hideLoadingOverlay();
  updateHeaderStrip();
  if(currentFeatureId==='overview')renderOverview();
  else{const f=FEATURES.find(f=>f.meta.id===currentFeatureId);if(f)renderFeature(f);}
}
