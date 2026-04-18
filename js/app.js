// ── QA TEST CASES — v7 ──
// Auth : Supabase (email/password)  → ตรวจสอบว่าเป็น user ที่อนุญาต
// Data : Google Drive (testbulk87@gmail.com) → ทุกคนอ่าน/เขียน folder เดียวกัน
//        แต่ละ feature = ไฟล์ JSON แยก  /qa-testcases/<featureId>.json
//        รูปภาพ        = /qa-testcases/images/<caseId>/<filename>

// ══════════════════════════════════════════
//  🔧 CONFIG
// ══════════════════════════════════════════
const SUPABASE_URL      = 'https://kgwuakgtnvcvnybipqyz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtnd3Vha2d0bnZjdm55YmlwcXl6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MTYxMDQsImV4cCI6MjA5MTk5MjEwNH0.pgkW0qdi4EDz5h5lju_eoNY7oWIvw6fpvTBzO7YQB_E';
const GOOGLE_CLIENT_ID  = '403194325485-pqib1qjnqjbqlj9ftki70s2d4jpoui20.apps.googleusercontent.com';

// Drive scope: drive.file = access to files created by this app only
// แต่เราต้องการ folder กลาง → ต้องใช้ drive scope เต็ม หรือ share folder แล้วใช้ drive.file
// ใช้ drive scope เพื่อให้เข้าถึง shared folder ได้
const DRIVE_SCOPE    = 'https://www.googleapis.com/auth/drive';
const DRIVE_API      = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD   = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_FOLDER   = 'qa-testcases';   // folder name ใน Drive ของ testbulk87@gmail.com

// ── Google Drive ที่ใช้เป็น "shared" คือต้อง share folder กับ user ที่จะใช้งาน
// วิธีตั้งค่า: ไปที่ Drive ของ testbulk87@gmail.com → สร้างโฟลเดอร์ "qa-testcases"
//              → Share กับ user อื่นๆ ที่ต้องการ (เป็น Editor)
// แอพจะหา folder นั้นโดยชื่อเสมอ (หา folder ที่ชื่อ qa-testcases ที่ share มาให้)

// ══════════════════════════════════════════
//  SUPABASE AUTH
// ══════════════════════════════════════════
async function handleLogin() {
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('btn-login');
  errEl.style.display = 'none';
  if (!email || !password) { errEl.textContent = 'กรุณากรอก Email และ Password'; errEl.style.display = 'block'; return; }
  btn.textContent = 'กำลังเข้าสู่ระบบ...'; btn.disabled = true;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error_description || d.msg || 'Login failed');
    localStorage.setItem('qa_access_token', d.access_token);
    showDriveStep();
  } catch (err) {
    errEl.textContent = err.message === 'Invalid login credentials' ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : err.message;
    errEl.style.display = 'block';
    btn.textContent = 'เข้าสู่ระบบ'; btn.disabled = false;
  }
}

function handleLogout() {
  localStorage.removeItem('qa_access_token');
  sessionStorage.removeItem('qa_google_token');
  gAccessToken = null; gFolderId = null; DB_READY = false;
  location.reload();
}

function showDriveStep() {
  document.getElementById('step-login').style.display = 'none';
  document.getElementById('step-drive').style.display = 'block';
}

// ══════════════════════════════════════════
//  GOOGLE DRIVE CLIENT
// ══════════════════════════════════════════
let gAccessToken = null;
let gTokenClient = null;
let gFolderId    = null;   // ID ของ folder qa-testcases
let gImgFolderId = null;   // ID ของ folder images ภายใน qa-testcases
let gWriteQueue  = {};     // featureId → setTimeout handle

function onGISLoad() {
  if (typeof google === 'undefined') return;
  gTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: async (resp) => {
      const btn = document.getElementById('btn-connect-drive');
      if (resp.error) {
        const errEl = document.getElementById('drive-connect-error');
        if (errEl) { errEl.textContent = `Google error: ${resp.error}`; errEl.style.display = 'block'; }
        if (btn) { btn.disabled = false; btn.textContent = 'เชื่อมต่อ Google Drive'; }
        document.getElementById('drive-expired-banner').style.display = 'flex';
        return;
      }
      gAccessToken = resp.access_token;
      sessionStorage.setItem('qa_google_token', resp.access_token);
      if (btn) { btn.disabled = false; }
      await loadAllData();
    },
  });

  const supToken = localStorage.getItem('qa_access_token');
  const gToken   = sessionStorage.getItem('qa_google_token');
  if (supToken && gToken) {
    gAccessToken = gToken;
    document.getElementById('login-overlay').style.display = 'none';
    loadAllData();
  } else if (supToken) {
    document.getElementById('login-overlay').style.display = 'flex';
    showDriveStep();
  }
}

function requestGoogleToken() {
  if (!gTokenClient) { alert('Google Identity Services ยังโหลดไม่เสร็จ'); return; }
  const btn = document.getElementById('btn-connect-drive');
  if (btn) { btn.disabled = true; btn.textContent = 'กำลังเชื่อมต่อ...'; }
  gTokenClient.requestAccessToken({ prompt: '' });
}

function driveH(extra = {}) {
  return { Authorization: `Bearer ${gAccessToken}`, ...extra };
}

// ── ค้นหา/สร้าง folder ──────────────────
async function getOrCreateFolder(name, parentId = null) {
  const parentQ = parentId ? ` and '${parentId}' in parents` : '';
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentQ}`;
  const r = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: driveH()
  });
  if (r.status === 401) throw new Error('UNAUTHORIZED');
  const d = await r.json();
  if (d.files && d.files.length > 0) return d.files[0].id;

  // สร้างใหม่
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const cr = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: driveH({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(meta),
  });
  if (!cr.ok) throw new Error(`Create folder failed: ${cr.status}`);
  return (await cr.json()).id;
}

// ── อ่าน/เขียน JSON ไฟล์ ────────────────
async function driveReadJson(fileId) {
  const r = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, { headers: driveH() });
  if (r.status === 401) throw new Error('UNAUTHORIZED');
  if (!r.ok) throw new Error(`Read failed: ${r.status}`);
  return r.json();
}

async function driveWriteJson(fileId, data) {
  const r = await fetch(`${DRIVE_UPLOAD}/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: driveH({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(data),
  });
  if (r.status === 401) { onDriveTokenExpired(); throw new Error('UNAUTHORIZED'); }
  if (!r.ok) throw new Error(`Write failed: ${r.status}`);
}

async function driveCreateJson(name, parentId, data) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name, parents: [parentId] })], { type: 'application/json' }));
  form.append('media', new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const r = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST', headers: driveH(), body: form,
  });
  if (!r.ok) throw new Error(`Create file failed: ${r.status}`);
  return (await r.json()).id;
}

async function driveFindFile(name, parentId) {
  const q = `name='${name}' and '${parentId}' in parents and trashed=false`;
  const r = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)`, { headers: driveH() });
  if (r.status === 401) throw new Error('UNAUTHORIZED');
  const d = await r.json();
  return d.files?.[0]?.id || null;
}

// ── Upload รูปภาพ ─────────────────────────
async function driveUploadImage(file, caseId) {
  // หรือสร้าง images/<caseId> folder
  let caseFolderId = await getOrCreateFolder(caseId, gImgFolderId);
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({
    name: file.name,
    parents: [caseFolderId],
  })], { type: 'application/json' }));
  form.append('media', file);
  const r = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink`, {
    method: 'POST', headers: driveH(), body: form,
  });
  if (!r.ok) throw new Error(`Upload image failed: ${r.status}`);
  const d = await r.json();
  // Make file publicly readable
  await fetch(`${DRIVE_API}/files/${d.id}/permissions`, {
    method: 'POST',
    headers: driveH({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  return {
    id: d.id,
    name: d.name,
    url: `https://lh3.googleusercontent.com/d/${d.id}`,
    viewUrl: d.webViewLink,
  };
}

async function driveDeleteFile(fileId) {
  await fetch(`${DRIVE_API}/files/${fileId}`, { method: 'DELETE', headers: driveH() });
}

function onDriveTokenExpired() {
  gAccessToken = null;
  sessionStorage.removeItem('qa_google_token');
  document.getElementById('drive-expired-banner').style.display = 'flex';
  hideSavingIndicator();
}

// ══════════════════════════════════════════
//  IN-MEMORY DB  (per-feature files)
// ══════════════════════════════════════════
// DB.features[featureId] = { meta, cases:[], fileId }
// DB.status = { caseId: status }  → เก็บใน status.json
// DB.deletedCases = [...]         → เก็บใน status.json ด้วย
let DB = { features: {}, status: {}, deletedCases: [] };
let DB_READY = false;
let gStatusFileId = null;

async function loadAllData() {
  showLoadingOverlay('กำลังเชื่อมต่อ Google Drive...');
  try {
    // ค้นหา / สร้าง root folder
    gFolderId    = await getOrCreateFolder(DRIVE_FOLDER);
    gImgFolderId = await getOrCreateFolder('images', gFolderId);

    // โหลด status.json
    showLoadingOverlay('กำลังโหลด status...');
    let statusId = await driveFindFile('status.json', gFolderId);
    if (!statusId) {
      statusId = await driveCreateJson('status.json', gFolderId, { status: {}, deletedCases: [] });
    }
    gStatusFileId = statusId;
    const statusData = await driveReadJson(statusId);
    DB.status       = statusData.status       || {};
    DB.deletedCases = statusData.deletedCases || [];

    // list ไฟล์ feature *.json (ยกเว้น status.json)
    showLoadingOverlay('กำลังโหลด features...');
    const q = `'${gFolderId}' in parents and name != 'status.json' and mimeType='application/json' and trashed=false`;
    const lr = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, { headers: driveH() });
    if (lr.status === 401) throw new Error('UNAUTHORIZED');
    const listed = (await lr.json()).files || [];

    DB.features = {};
    await Promise.all(listed.map(async f => {
      try {
        const data = await driveReadJson(f.id);
        const fid = data.meta?.id || f.name.replace('.json','');
        DB.features[fid] = { meta: data.meta, cases: data.cases || [], fileId: f.id };
      } catch {}
    }));

    DB_READY = true;
    hideLoadingOverlay();
    document.getElementById('login-overlay').style.display = 'none';
    document.getElementById('drive-expired-banner').style.display = 'none';
    document.getElementById('drive-status-badge').style.display = 'inline-flex';
    init();
  } catch (err) {
    hideLoadingOverlay();
    if (err.message === 'UNAUTHORIZED') {
      onDriveTokenExpired();
      document.getElementById('login-overlay').style.display = 'flex';
      showDriveStep();
    } else {
      showDBError(err);
    }
  }
}

// ── schedule write per feature (debounce 800ms) ─
function scheduleFeatureWrite(featureId) {
  showSavingIndicator();
  clearTimeout(gWriteQueue[featureId]);
  gWriteQueue[featureId] = setTimeout(() => writeFeatureFile(featureId), 800);
}
async function writeFeatureFile(featureId) {
  const f = DB.features[featureId]; if (!f) return;
  try {
    if (!f.fileId) {
      f.fileId = await driveCreateJson(`${featureId}.json`, gFolderId, { meta: f.meta, cases: f.cases });
    } else {
      await driveWriteJson(f.fileId, { meta: f.meta, cases: f.cases });
    }
    hideSavingIndicator();
  } catch {}
}
function scheduleStatusWrite() {
  showSavingIndicator();
  clearTimeout(gWriteQueue['__status__']);
  gWriteQueue['__status__'] = setTimeout(writeStatusFile, 800);
}
async function writeStatusFile() {
  try {
    await driveWriteJson(gStatusFileId, { status: DB.status, deletedCases: DB.deletedCases });
    hideSavingIndicator();
  } catch {}
}

// ══════════════════════════════════════════
//  DB HELPERS
// ══════════════════════════════════════════
function getStatus(id)       { return DB.status[id] || 'no-run'; }
function getDeletedSet()     { return new Set(DB.deletedCases); }

async function setStatus(id, st) {
  DB.status[id] = st;
  scheduleStatusWrite();
}

// feature CRUD
async function saveNewFeature(meta) {
  DB.features[meta.id] = { meta, cases: [], fileId: null };
  await writeFeatureFile(meta.id);
}
async function deleteFeatureData(featureId) {
  const f = DB.features[featureId];
  if (f?.fileId) await driveDeleteFile(f.fileId);
  delete DB.features[featureId];
}

// case CRUD
async function saveCase(featureId, c) {
  const f = DB.features[featureId]; if (!f) return;
  const idx = f.cases.findIndex(x => x.id === c.id);
  if (idx >= 0) f.cases[idx] = c; else f.cases.push(c);
  scheduleFeatureWrite(featureId);
}
async function deleteCaseData(featureId, caseId) {
  const f = DB.features[featureId];
  if (f) f.cases = f.cases.filter(c => c.id !== caseId);
  if (!DB.deletedCases.includes(caseId)) DB.deletedCases.push(caseId);
  scheduleFeatureWrite(featureId);
  scheduleStatusWrite();
}
async function resetAllStatusDB() {
  DB.status = {};
  scheduleStatusWrite();
}

// ══════════════════════════════════════════
//  LOADING / ERROR / SAVING UI
// ══════════════════════════════════════════
function showLoadingOverlay(msg = 'Loading...') {
  let el = document.getElementById('db-loading');
  if (!el) {
    el = document.createElement('div'); el.id = 'db-loading';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,.9);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;gap:14px;font-family:inherit;';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div style="width:36px;height:36px;border:3px solid #e0e0e0;border-top-color:#4A3AB0;border-radius:50%;animation:spin .7s linear infinite;"></div>
    <div style="font-size:14px;color:#555;">${msg}</div>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>`;
  el.style.display = 'flex';
}
function hideLoadingOverlay() {
  const el = document.getElementById('db-loading'); if (el) el.style.display = 'none';
}
function showDBError(err) {
  let el = document.getElementById('db-loading');
  if (!el) { el = document.createElement('div'); el.id = 'db-loading'; document.body.appendChild(el); }
  el.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,.97);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;gap:12px;';
  el.innerHTML = `<div style="font-size:32px;">⚠️</div>
    <div style="font-size:16px;font-weight:600;color:#c00;">เชื่อมต่อ Google Drive ไม่ได้</div>
    <div style="font-size:13px;color:#555;max-width:400px;text-align:center;line-height:1.6;">
      ตรวจสอบ <b>GOOGLE_CLIENT_ID</b> และ Authorized origins ใน Google Cloud Console<br>
      และตรวจสอบว่า folder <b>qa-testcases</b> ถูก share ให้ account ของคุณแล้ว<br><br>
      <em style="color:#999;">${err.message}</em>
    </div>
    <button onclick="location.reload()" style="padding:8px 20px;background:#4A3AB0;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;">ลองใหม่</button>`;
  el.style.display = 'flex';
}
function showSavingIndicator() { const el = document.getElementById('saving-indicator'); if (el) el.style.display = 'flex'; }
function hideSavingIndicator() { const el = document.getElementById('saving-indicator'); if (el) el.style.display = 'none'; }

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
const SCREEN_PALETTE=[
  {bg:'#F0EFFE',color:'#4A3AB0',border:'#C5BCEF'},{bg:'#EAF2FB',color:'#185FA5',border:'#B5D0F0'},
  {bg:'#FFF4EC',color:'#D95F02',border:'#F5C49A'},{bg:'#EBF5E8',color:'#276B1F',border:'#A8D49D'},
  {bg:'#FFF8E6',color:'#8A5200',border:'#F5D68A'},{bg:'#E6F5F5',color:'#0F6B6B',border:'#8DD4D4'},
];
function getScreenStyle(i){return SCREEN_PALETTE[i%SCREEN_PALETTE.length];}

let FEATURES=[], currentFeatureId='overview', activeType='all', activeScreen='all', activeStatusFilt='all';

function buildFeatures() {
  const deleted = getDeletedSet();
  return Object.values(DB.features).map(f => ({
    meta: f.meta,
    cases: f.cases.filter(c => !deleted.has(c.id)),
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
async function onStatusChange(caseId,featureId,sel){
  STATUSES.forEach(s=>sel.classList.remove(s.cssClass));
  sel.classList.add(STATUSES.find(s=>s.key===sel.value).cssClass);
  await setStatus(caseId,sel.value);
  updateHeaderStrip();
  if(currentFeatureId==='overview')refreshFeatureRowStats(featureId);
  else refreshStatusStatsBar(featureId);
}

function init(){
  FEATURES=buildFeatures();
  injectScreenStyles();buildNavTabs();renderOverview();updateHeaderStrip();
}

function injectScreenStyles(){
  let s=document.getElementById('dyn-styles');
  if(!s){s=document.createElement('style');s.id='dyn-styles';document.head.appendChild(s);}
  s.textContent='';
  FEATURES.forEach(f=>Object.entries(f.meta.screens).forEach(([,sc],i)=>{
    const p=getScreenStyle(i);
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
    <div class="section-sep"><span>Features</span><span class="count-pill">${FEATURES.length} features · ${total} cases</span></div>
    <div class="ov-list" id="ov-list">
      ${FEATURES.length===0
        ?`<div class="empty-state"><div class="emoji">📂</div><p>ยังไม่มี feature — กด <strong>＋ Feature</strong> เพื่อเริ่ม</p></div>`
        :FEATURES.map(f=>buildFeatureRow(f)).join('')}
    </div>`;
}

function buildFeatureRow(f){
  const counts=getStatusCounts(f.cases),total=f.cases.length;
  const tags=f.meta.tags.map(t=>`<span class="badge ${t.style}">${t.label}</span>`).join('');
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
  const{meta,cases}=feature;
  const tags=meta.tags.map(t=>`<span class="badge ${t.style}">${t.label}</span>`).join('');
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
  const counts=getStatusCounts(f.cases),total=f.cases.length;
  el.innerHTML=`<span class="ssg-label">Test Run</span>
    ${STATUSES.map(s=>`<span class="ssg-item" style="background:${STATUS_COLORS[s.key]}22;color:var(--st-${s.key});border-color:${STATUS_COLORS[s.key]};">${s.icon} ${s.label} <strong>${counts[s.key]}</strong></span>`).join('')}
    <div class="ssg-progress">${buildProgressBar(counts,total,'ssg-pt-seg')}</div>`;
}

function clearGroup(id){document.querySelectorAll(`#${id} .filter-btn`).forEach(b=>b.className=b.className.replace(/\bactive[\w-]*/g,'').trim());}
function setTypeFilter(v,b,c){clearGroup('type-filters');b.classList.add(c);activeType=v;applyFilters();}
function setScreenFilter(v,b,c){clearGroup('screen-filters');b.classList.add(c);activeScreen=v;applyFilters();}
function setStatusFilter(v,b,c){clearGroup('status-filters');b.classList.add(c);activeStatusFilt=v;applyFilters();}

function applyFilters(){
  const f=FEATURES.find(f=>f.meta.id===currentFeatureId);if(!f)return;
  const q=(document.getElementById('search-input')?.value||'').toLowerCase();
  const filtered=f.cases.filter(c=>{
    const typeOk=activeType==='all'||c.type===activeType;
    const screenOk=activeScreen==='all'||c.screen===activeScreen;
    const stOk=activeStatusFilt==='all'||getStatus(c.id)===activeStatusFilt;
    const srchOk=!q||[c.title,c.sub,c.id,...(c.steps||[]),...(c.expect||[])].some(s=>s&&s.toLowerCase().includes(q));
    return typeOk&&screenOk&&stOk&&srchOk;
  });
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
    const typePill=`<span class="type-pill tp-${c.type}">${{positive:'✓ Positive',edge:'~ Edge',negative:'✗ Negative'}[c.type]||c.type}</span>`;
    const screenTag=sc?`<span class="screen-tag ${sc.cssClass}">${sc.label}<br><small style="font-weight:400;opacity:.75;">${sc.name}</small></span>`:`<span class="screen-tag">${c.screen||''}</span>`;
    const imgCount=c.images?.length||0;
    const imgBadge=imgCount>0?`<span class="img-badge" onclick="event.stopPropagation();openImageViewer('${c.id}','${feature.meta.id}')">🖼 ${imgCount}</span>`:'';
    return`
    <tr class="tc-row" id="row-${c.id}" onclick="toggleDetail('${c.id}')">
      <td class="col-id"><span class="tc-id">${c.id}</span></td>
      <td class="col-screen hide-sm">${screenTag}</td>
      <td class="col-title"><div class="tc-title-text">${c.title} ${imgBadge}</div><div class="tc-sub-text">${c.sub||''}</div></td>
      <td class="col-type hide-sm">${typePill}</td>
      <td class="col-status">${statusSelectHtml(c.id,feature.meta.id)}</td>
      <td class="col-actions"><button class="icon-btn icon-btn-danger" onclick="event.stopPropagation();confirmDeleteCase('${c.id}','${feature.meta.id}')" title="ลบ">🗑</button></td>
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
          ${imgCount>0?`<div style="grid-column:1/-1;">
            <div class="detail-section-title">รูปภาพ (${imgCount})</div>
            <div class="img-thumb-row">${c.images.map((img,i)=>`
              <div class="img-thumb" onclick="openImageViewer('${c.id}','${feature.meta.id}',${i})">
                <img src="${img.url}" alt="${img.name}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 80 60%22><rect width=%2280%22 height=%2260%22 fill=%22%23f0f0f0%22/><text x=%2240%22 y=%2235%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2212%22>img</text></svg>'" />
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

// ══════════════════════════════════════════
//  IMAGE UPLOAD & VIEWER
// ══════════════════════════════════════════
async function uploadImages(event, caseId, featureId) {
  const files = Array.from(event.target.files);
  if (!files.length) return;
  showLoadingOverlay(`กำลังอัปโหลด ${files.length} รูป...`);
  try {
    const f = DB.features[featureId]; if (!f) return;
    const c = f.cases.find(x => x.id === caseId); if (!c) return;
    if (!c.images) c.images = [];
    for (const file of files) {
      const img = await driveUploadImage(file, caseId);
      c.images.push(img);
    }
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
            <a href="${imgs[cur].viewUrl||imgs[cur].url}" target="_blank" style="font-size:12px;color:var(--blue);">เปิดใน Drive ↗</a>
            <button onclick="closeImageViewer()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text2);">✕</button>
          </div>
        </div>
        <div class="img-viewer-body">
          <button class="img-viewer-nav img-viewer-prev" onclick="imgViewerNav(-1)" ${cur===0?'disabled':''}>‹</button>
          <img src="${imgs[cur].url}" alt="${imgs[cur].name}" class="img-viewer-img"
            onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 300%22><rect width=%22400%22 height=%22300%22 fill=%22%23f5f5f5%22/><text x=%22200%22 y=%22155%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2216%22>ไม่สามารถโหลดรูปได้</text></svg>'" />
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
function parseCsvPreview(text, featureId) {
  const errEl = document.getElementById('csv-error');
  errEl.style.display = 'none';
  try {
    const rows = parseCsvText(text);
    if (rows.length < 2) throw new Error('ไฟล์ CSV ว่าง หรือไม่มีข้อมูล');
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const required = ['id','type','title'];
    const missing = required.filter(h => !headers.includes(h));
    if (missing.length) throw new Error(`ไม่พบคอลัมน์: ${missing.join(', ')}`);

    _csvParsed = rows.slice(1).filter(r => r.some(v => v.trim())).map(row => {
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

async function submitImportCsv(featureId) {
  if (!_csvParsed.length) return;
  const btn = document.getElementById('btn-do-import');
  btn.disabled = true; btn.textContent = 'กำลัง import...';
  try {
    const f = DB.features[featureId]; if (!f) return;
    let added = 0, skipped = 0;
    for (const c of _csvParsed) {
      if (f.cases.find(x => x.id === c.id)) { skipped++; continue; }
      f.cases.push(c); added++;
    }
    await writeFeatureFile(featureId);
    closeModal();
    FEATURES = buildFeatures(); rebuildNav(); updateHeaderStrip();
    const feat = FEATURES.find(f => f.meta.id === featureId);
    if (feat) renderFeature(feat);
    setTimeout(() => alert(`Import สำเร็จ: เพิ่ม ${added} cases${skipped?`, ข้าม ${skipped} (ID ซ้ำ)`:''}`)  ,100);
  } catch (err) {
    const errEl = document.getElementById('csv-error');
    if (errEl) { errEl.textContent = 'Import ไม่สำเร็จ: ' + err.message; errEl.style.display = 'block'; }
    btn.disabled = false; btn.textContent = 'Import';
  }
}

// ══════════════════════════════════════════
//  DELETE
// ══════════════════════════════════════════
function confirmDeleteCase(caseId,featureId){
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
//  ADD CASE MODAL
// ══════════════════════════════════════════
function openAddCaseModal(featureId){
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
async function submitAddCase(featureId){
  const id=document.getElementById('fc-id').value.trim();
  const type=document.getElementById('fc-type').value;
  const screen=document.getElementById('fc-screen').value;
  const title=document.getElementById('fc-title').value.trim();
  const sub=document.getElementById('fc-sub').value.trim();
  const steps=document.getElementById('fc-steps').value.split('\n').map(s=>s.trim()).filter(Boolean);
  const expect=document.getElementById('fc-expect').value.split('\n').map(s=>s.trim()).filter(Boolean);
  if(!id||!title||!steps.length||!expect.length){showFormError('กรุณากรอก ID, Title, Steps และ Expected ให้ครบ');return;}
  const f=FEATURES.find(f=>f.meta.id===featureId);
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

// ══════════════════════════════════════════
//  ADD FEATURE MODAL
// ══════════════════════════════════════════
function openAddFeatureModal(){
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
      <div class="form-group"><label>Screens <span class="form-hint">บรรทัดละ 1 ชื่อ</span></label>
        <textarea class="form-textarea" id="ff-screens" rows="4" placeholder="Login form&#10;OTP verify&#10;Dashboard"></textarea></div>
      <div class="form-group"><label>Tags <span class="form-hint">คั่นด้วย comma</span></label>
        <input class="form-input" id="ff-tags" placeholder="Journey, Mobile App, Security" /></div>
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
  const screenLines=document.getElementById('ff-screens').value.split('\n').map(s=>s.trim()).filter(Boolean);
  const tagLines=document.getElementById('ff-tags').value.split(',').map(s=>s.trim()).filter(Boolean);
  if(!id||!name||!screenLines.length){showFormError('กรุณากรอก ID, Name และ Screens');return;}
  if(DB.features[id]){showFormError(`Feature ID "${id}" ซ้ำ`);return;}
  const th=THEME_COLORS[theme]||THEME_COLORS.orange;
  const screens={};screenLines.forEach((n,i)=>{screens[`S${i+1}`]={label:`Screen ${i+1}`,name:n,cssClass:`sc-${id}-s${i+1}`};});
  const meta={id,name,emoji,color:th.color,colorBg:th.colorBg,colorBorder:th.colorBorder,
    tags:tagLines.map(l=>({label:l,style:th.badge})),description:desc||name,screens};
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
  if(!o){o=document.createElement('div');o.id='modal-overlay';o.className='modal-overlay';o.onclick=e=>{if(e.target===o)closeModal();};document.body.appendChild(o);}
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
  if(!confirm('Reset ทุก status กลับเป็น No Run?'))return;
  showLoadingOverlay('กำลัง reset...');
  await resetAllStatusDB();
  hideLoadingOverlay();
  updateHeaderStrip();
  if(currentFeatureId==='overview')renderOverview();
  else{const f=FEATURES.find(f=>f.meta.id===currentFeatureId);if(f)renderFeature(f);}
}
