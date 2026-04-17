// ── QA TEST CASES — MAIN APP v5 ──
// Auth: Supabase (email/password)
// Data: Google Drive (appDataFolder) → qa-testcases-data.json

// ══════════════════════════════════════════
//  🔧 CONFIG — แก้ค่าเหล่านี้ก่อนใช้งาน
// ══════════════════════════════════════════
const SUPABASE_URL      = 'https://kgwuakgtnvcvnybipqyz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtnd3Vha2d0bnZjdm55YmlwcXl6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MTYxMDQsImV4cCI6MjA5MTk5MjEwNH0.pgkW0qdi4EDz5h5lju_eoNY7oWIvw6fpvTBzO7YQB_E';
const GOOGLE_CLIENT_ID  = '403194325485-pqib1qjnqjbqlj9ftki70s2d4jpoui20.apps.googleusercontent.com'; 

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
  gAccessToken = null; gDriveFileId = null; DB_READY = false;
  location.reload();
}

function showDriveStep() {
  document.getElementById('step-login').style.display = 'none';
  document.getElementById('step-drive').style.display = 'block';
}

// ══════════════════════════════════════════
//  GOOGLE DRIVE CLIENT
// ══════════════════════════════════════════
const DRIVE_API      = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD   = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_SCOPE    = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILENAME = 'qa-testcases-data.json';

let gAccessToken = null;
let gTokenClient = null;
let gDriveFileId = null;
let gWriteTimer  = null;

// Called by GIS script onload
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
        // Show reconnect banner if was already connected
        hideDriveExpiredBanner();
        document.getElementById('drive-expired-banner').style.display = 'flex';
        return;
      }
      gAccessToken = resp.access_token;
      sessionStorage.setItem('qa_google_token', resp.access_token);
      if (btn) { btn.disabled = false; }
      await loadDriveData();
    },
  });

  // Auto-try from session if already Supabase-authed
  const supToken = localStorage.getItem('qa_access_token');
  const gToken   = sessionStorage.getItem('qa_google_token');
  if (supToken && gToken) {
    gAccessToken = gToken;
    document.getElementById('login-overlay').style.display = 'none';
    loadDriveData();
  } else if (supToken) {
    // Supabase ok but no Drive token → show Drive connect step
    document.getElementById('login-overlay').style.display = 'flex';
    showDriveStep();
  }
  // else: show login overlay (default)
}

function requestGoogleToken() {
  if (!gTokenClient) { alert('Google Identity Services ยังโหลดไม่เสร็จ กรุณารอสักครู่แล้วลองใหม่'); return; }
  const btn = document.getElementById('btn-connect-drive');
  if (btn) { btn.disabled = true; btn.textContent = 'กำลังเชื่อมต่อ...'; }
  gTokenClient.requestAccessToken({ prompt: '' });
}

// ── DRIVE API HELPERS ──────────────────────
function driveHeaders(extra = {}) {
  return { Authorization: `Bearer ${gAccessToken}`, ...extra };
}

async function driveFindFile() {
  const r = await fetch(
    `${DRIVE_API}/files?spaces=appDataFolder&q=name='${DRIVE_FILENAME}'&fields=files(id)`,
    { headers: driveHeaders() }
  );
  if (r.status === 401) throw new Error('UNAUTHORIZED');
  const d = await r.json();
  return d.files?.[0]?.id || null;
}

async function driveCreateFile() {
  const meta    = { name: DRIVE_FILENAME, parents: ['appDataFolder'] };
  const empty   = JSON.stringify({ version:1, status:{}, customFeatures:[], customCases:{}, deletedCases:[] });
  const form    = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type:'application/json' }));
  form.append('media',    new Blob([empty],                { type:'application/json' }));
  const r = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, {
    method:'POST', headers: driveHeaders(), body: form,
  });
  if (!r.ok) throw new Error(`Drive create failed: ${r.status}`);
  return (await r.json()).id;
}

async function driveGetOrCreate() {
  if (gDriveFileId) return gDriveFileId;
  let id = await driveFindFile();
  if (!id) id = await driveCreateFile();
  gDriveFileId = id;
  return id;
}

async function driveRead() {
  const id = await driveGetOrCreate();
  const r  = await fetch(`${DRIVE_API}/files/${id}?alt=media`, { headers: driveHeaders() });
  if (r.status === 401) throw new Error('UNAUTHORIZED');
  if (!r.ok) throw new Error(`Drive read failed: ${r.status}`);
  return r.json();
}

async function driveWrite() {
  try {
    const id = await driveGetOrCreate();
    const r  = await fetch(`${DRIVE_UPLOAD}/files/${id}?uploadType=media`, {
      method:'PATCH',
      headers: driveHeaders({ 'Content-Type':'application/json' }),
      body: JSON.stringify(DB),
    });
    if (r.status === 401) { onDriveTokenExpired(); return; }
    if (!r.ok) throw new Error(`Drive write failed: ${r.status}`);
    hideSavingIndicator();
  } catch (e) {
    hideSavingIndicator();
    console.error('Drive write error:', e);
  }
}

function scheduleWrite() {
  showSavingIndicator();
  clearTimeout(gWriteTimer);
  gWriteTimer = setTimeout(driveWrite, 800);
}

function onDriveTokenExpired() {
  gAccessToken = null;
  sessionStorage.removeItem('qa_google_token');
  document.getElementById('drive-expired-banner').style.display = 'flex';
  hideSavingIndicator();
}

// ══════════════════════════════════════════
//  IN-MEMORY DB
// ══════════════════════════════════════════
let DB = { version:1, status:{}, customFeatures:[], customCases:{}, deletedCases:[] };
let DB_READY = false;

async function loadDriveData() {
  showLoadingOverlay('กำลังโหลดข้อมูลจาก Google Drive...');
  try {
    const data = await driveRead();
    DB = {
      version:        data.version        || 1,
      status:         data.status         || {},
      customFeatures: data.customFeatures || [],
      customCases:    data.customCases    || {},
      deletedCases:   Array.isArray(data.deletedCases) ? data.deletedCases : [],
    };
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

// ── DB READ HELPERS ─────────────────────
function getStatus(id)      { return DB.status[id] || 'no-run'; }
function getCustomFeatures(){ return DB.customFeatures; }
function getCustomCases(fid){ return DB.customCases[fid] || []; }
function getDeletedCases()  { return new Set(DB.deletedCases); }

// ── DB WRITE HELPERS (update + schedule Drive write) ─
async function setStatus(id, st) {
  DB.status[id] = st;
  scheduleWrite();
}
async function saveCustomCase(fid, c) {
  if (!DB.customCases[fid]) DB.customCases[fid] = [];
  DB.customCases[fid].push(c);
  scheduleWrite();
}
async function deleteCustomCase(fid, caseId) {
  if (DB.customCases[fid]) DB.customCases[fid] = DB.customCases[fid].filter(c => c.id !== caseId);
  if (!DB.deletedCases.includes(caseId)) DB.deletedCases.push(caseId);
  scheduleWrite();
}
async function saveCustomFeature(f) {
  DB.customFeatures.push(f);
  scheduleWrite();
}
async function deleteCustomFeature(fid) {
  DB.customFeatures = DB.customFeatures.filter(f => f.meta.id !== fid);
  scheduleWrite();
}
async function resetAllStatusDB() {
  DB.status = {};
  scheduleWrite();
}

// ══════════════════════════════════════════
//  LOADING / ERROR UI
// ══════════════════════════════════════════
function showLoadingOverlay(msg = 'Loading...') {
  let el = document.getElementById('db-loading');
  if (!el) {
    el = document.createElement('div'); el.id = 'db-loading';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,.9);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;gap:14px;font-family:inherit;';
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div style="width:36px;height:36px;border:3px solid #e0e0e0;border-top-color:#4A3AB0;border-radius:50%;animation:spin .7s linear infinite;"></div>
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
  el.innerHTML = `
    <div style="font-size:32px;">⚠️</div>
    <div style="font-size:16px;font-weight:600;color:#c00;">เชื่อมต่อ Google Drive ไม่ได้</div>
    <div style="font-size:13px;color:#555;max-width:380px;text-align:center;line-height:1.6;">
      กรุณาตรวจสอบ <code>GOOGLE_CLIENT_ID</code> ใน <code>js/app.js</code><br>
      และ Authorized JavaScript origins ใน Google Cloud Console<br><br>
      <em style="color:#888;">${err.message}</em>
    </div>
    <button onclick="location.reload()" style="margin-top:8px;padding:8px 20px;background:#4A3AB0;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;">ลองใหม่</button>`;
  el.style.display = 'flex';
}
function showSavingIndicator() {
  const el = document.getElementById('saving-indicator'); if (el) el.style.display = 'flex';
}
function hideSavingIndicator() {
  const el = document.getElementById('saving-indicator'); if (el) el.style.display = 'none';
}
function hideDriveExpiredBanner() {
  const el = document.getElementById('drive-expired-banner'); if (el) el.style.display = 'none';
}

// ══════════════════════════════════════════
//  APP CORE
// ══════════════════════════════════════════
const DATA_SOURCES = [
  { metaVar: 'XRAY_META', casesVar: 'XRAY_CASES' },
  // { metaVar: 'AUTH_META', casesVar: 'AUTH_CASES' },
  // { metaVar: 'MY_META', casesVar: 'MY_CASES' },
];

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

let FEATURES=[], currentFeatureId='overview', activeType='all', activeScreen='all', activeStatusFilt='all';
const SCREEN_PALETTE=[
  {bg:'#F0EFFE',color:'#4A3AB0',border:'#C5BCEF'},{bg:'#EAF2FB',color:'#185FA5',border:'#B5D0F0'},
  {bg:'#FFF4EC',color:'#D95F02',border:'#F5C49A'},{bg:'#EBF5E8',color:'#276B1F',border:'#A8D49D'},
  {bg:'#FFF8E6',color:'#8A5200',border:'#F5D68A'},{bg:'#E6F5F5',color:'#0F6B6B',border:'#8DD4D4'},
];
function getScreenStyle(i){return SCREEN_PALETTE[i%SCREEN_PALETTE.length];}

function buildFeatures(){
  const deleted=getDeletedCases();
  const builtIn=DATA_SOURCES
    .filter(s=>typeof window[s.metaVar]!=='undefined')
    .map(s=>{
      const extra=getCustomCases(window[s.metaVar].id).filter(c=>!deleted.has(c.id));
      const base=window[s.casesVar].filter(c=>!deleted.has(c.id)&&!extra.some(e=>e.id===c.id));
      return{meta:window[s.metaVar],cases:[...base,...extra],custom:false};
    });
  const custom=getCustomFeatures().map(f=>{
    const extra=getCustomCases(f.meta.id).filter(c=>!deleted.has(c.id));
    return{meta:f.meta,cases:extra,custom:true};
  });
  return[...builtIn,...custom];
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
    <button class="nav-tab" id="tab-add-feature" onclick="openAddFeatureModal()" style="color:var(--orange);">＋ Feature</button>`;
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
  const del=f.custom?`<button class="icon-btn icon-btn-danger" onclick="event.stopPropagation();confirmDeleteFeature('${f.meta.id}')" title="ลบ feature">🗑</button>`:'';
  return`<div class="ov-feature-row" onclick="switchTab('${f.meta.id}')">
    <div class="ov-feature-icon" style="background:${f.meta.colorBg};border-color:${f.meta.colorBorder};">${f.meta.emoji}</div>
    <div class="ov-feature-info"><div class="ov-feature-name">${f.meta.name} ${del}</div>
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
  const delFeat=feature.custom?`<button class="icon-btn icon-btn-danger" onclick="confirmDeleteFeature('${meta.id}')">🗑 ลบ Feature</button>`:'';
  document.getElementById('main-content').innerHTML=`
    <div class="feature-header">
      <div style="font-size:24px;">${meta.emoji}</div>
      <div class="feature-info" style="flex:1;"><div class="feature-name">${meta.name}</div>
        <div class="feature-desc">${meta.description}</div><div class="feature-tags">${tags}</div></div>
      <div style="display:flex;gap:8px;align-items:flex-start;">${delFeat}
        <button class="btn-add-case" onclick="openAddCaseModal('${meta.id}')">＋ Add test case</button></div>
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
    const srchOk=!q||[c.title,c.sub,c.id,...c.steps,...c.expect].some(s=>s.toLowerCase().includes(q));
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
  const customIds=new Set(getCustomCases(feature.meta.id).map(c=>c.id));
  tbody.innerHTML=list.map(c=>{
    const sc=feature.meta.screens[c.screen];
    const typePill=`<span class="type-pill tp-${c.type}">${{positive:'✓ Positive',edge:'~ Edge',negative:'✗ Negative'}[c.type]||c.type}</span>`;
    const screenTag=sc?`<span class="screen-tag ${sc.cssClass}">${sc.label}<br><small style="font-weight:400;opacity:.75;">${sc.name}</small></span>`:`<span class="screen-tag">${c.screen}</span>`;
    const customBadge=customIds.has(c.id)?`<span style="font-size:10px;background:var(--orange-bg);color:var(--orange);border:1px solid var(--orange-border);padding:1px 6px;border-radius:10px;margin-left:4px;">custom</span>`:'';
    return`
    <tr class="tc-row" id="row-${c.id}" onclick="toggleDetail('${c.id}')">
      <td class="col-id"><span class="tc-id">${c.id}</span></td>
      <td class="col-screen hide-sm">${screenTag}</td>
      <td class="col-title"><div class="tc-title-text">${c.title}${customBadge}</div><div class="tc-sub-text">${c.sub}</div></td>
      <td class="col-type hide-sm">${typePill}</td>
      <td class="col-status">${statusSelectHtml(c.id,feature.meta.id)}</td>
      <td class="col-actions"><button class="icon-btn icon-btn-danger" onclick="event.stopPropagation();confirmDeleteCase('${c.id}','${feature.meta.id}')" title="ลบ">🗑</button></td>
    </tr>
    <tr class="detail-row" id="detail-${c.id}">
      <td colspan="6" style="padding:0 0 8px 0;">
        <div class="detail-inner">
          <div><div class="detail-section-title">Steps to reproduce</div>
            <ol class="detail-list steps-list">${c.steps.map((s,i)=>`<li><strong style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text3);margin-right:5px;">${i+1}.</strong>${s}</li>`).join('')}</ol>
          </div>
          <div><div class="detail-section-title">Expected behavior</div>
            <ul class="detail-list expect-list">${c.expect.map(e=>`<li>${e}</li>`).join('')}</ul>
          </div>
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

// ── DELETE ─────────────────────────────────
function confirmDeleteCase(caseId,featureId){
  openConfirmModal('ลบ Test Case',
    `ต้องการลบ <strong>${caseId}</strong> ออกใช่ไหม?<br><span style="color:var(--text2);font-size:12px;">Built-in case จะถูกซ่อน, Custom case จะถูกลบถาวร</span>`,
    async()=>{
      showLoadingOverlay('กำลังลบ...');
      await deleteCustomCase(featureId,caseId);
      FEATURES=buildFeatures();hideLoadingOverlay();
      const f=FEATURES.find(f=>f.meta.id===featureId);
      if(f)renderFeature(f);else renderOverview();
      rebuildNav();updateHeaderStrip();
    }
  );
}
function confirmDeleteFeature(featureId){
  const f=FEATURES.find(f=>f.meta.id===featureId);if(!f)return;
  if(!f.custom){alert('Built-in feature ไม่สามารถลบจาก UI ได้\nลบไฟล์ data/*.js แล้ว refresh แทน');return;}
  openConfirmModal('ลบ Feature',
    `ต้องการลบ <strong>${f.meta.emoji} ${f.meta.name}</strong> ทั้งหมดใช่ไหม?`,
    async()=>{
      showLoadingOverlay('กำลังลบ...');
      f.cases.forEach(c=>delete DB.status[c.id]);
      delete DB.customCases[featureId];
      await deleteCustomFeature(featureId);
      FEATURES=buildFeatures();currentFeatureId='overview';
      hideLoadingOverlay();rebuildNav();renderOverview();updateHeaderStrip();
    }
  );
}

// ── ADD CASE ──────────────────────────────
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
  if(f&&f.cases.some(c=>c.id===id)){showFormError(`Case ID "${id}" ซ้ำกับที่มีอยู่แล้ว`);return;}
  const okBtn=document.querySelector('.btn-modal-ok');
  if(okBtn){okBtn.disabled=true;okBtn.textContent='กำลังบันทึก...';}
  try{
    await saveCustomCase(featureId,{id,type,screen,title,sub,steps,expect});
    FEATURES=buildFeatures();closeModal();rebuildNav();updateHeaderStrip();
    const feat=FEATURES.find(f=>f.meta.id===featureId);if(feat)renderFeature(feat);
  }catch(err){
    showFormError(`บันทึกไม่สำเร็จ: ${err.message}`);
    if(okBtn){okBtn.disabled=false;okBtn.textContent='บันทึก';}
  }
}

// ── ADD FEATURE ───────────────────────────
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
const THEME_COLORS={
  orange:{color:'#D95F02',colorBg:'#FFF4EC',colorBorder:'#F5C49A',badge:'badge-orange'},
  blue:  {color:'#185FA5',colorBg:'#EAF2FB',colorBorder:'#B5D0F0',badge:'badge-blue'},
  green: {color:'#276B1F',colorBg:'#EBF5E8',colorBorder:'#A8D49D',badge:'badge-green'},
  purple:{color:'#4A3AB0',colorBg:'#F0EFFE',colorBorder:'#C5BCEF',badge:'badge-purple'},
  teal:  {color:'#0F6B6B',colorBg:'#E6F5F5',colorBorder:'#8DD4D4',badge:'badge-teal'},
  amber: {color:'#8A5200',colorBg:'#FFF8E6',colorBorder:'#F5D68A',badge:'badge-gray'},
};
async function submitAddFeature(){
  const id=document.getElementById('ff-id').value.trim().replace(/\s+/g,'-').toLowerCase();
  const emoji=document.getElementById('ff-emoji').value.trim()||'📋';
  const name=document.getElementById('ff-name').value.trim();
  const desc=document.getElementById('ff-desc').value.trim();
  const theme=document.getElementById('ff-color').value;
  const screenLines=document.getElementById('ff-screens').value.split('\n').map(s=>s.trim()).filter(Boolean);
  const tagLines=document.getElementById('ff-tags').value.split(',').map(s=>s.trim()).filter(Boolean);
  if(!id||!name||!screenLines.length){showFormError('กรุณากรอก ID, Name และ Screens');return;}
  if(FEATURES.some(f=>f.meta.id===id)){showFormError(`Feature ID "${id}" ซ้ำ`);return;}
  const th=THEME_COLORS[theme]||THEME_COLORS.orange;
  const screens={};screenLines.forEach((n,i)=>{screens[`S${i+1}`]={label:`Screen ${i+1}`,name:n,cssClass:`sc-${id}-s${i+1}`};});
  const meta={id,name,emoji,color:th.color,colorBg:th.colorBg,colorBorder:th.colorBorder,
    tags:tagLines.map(l=>({label:l,style:th.badge})),description:desc||name,screens};
  const okBtn=document.querySelector('.btn-modal-ok');
  if(okBtn){okBtn.disabled=true;okBtn.textContent='กำลังสร้าง...';}
  try{
    await saveCustomFeature({meta});
    FEATURES=buildFeatures();injectScreenStyles();closeModal();rebuildNav();switchTab(id);updateHeaderStrip();
  }catch(err){
    showFormError(`สร้างไม่สำเร็จ: ${err.message}`);
    if(okBtn){okBtn.disabled=false;okBtn.textContent='สร้าง Feature';}
  }
}

// ── MODAL ────────────────────────────────
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

// ── RESET ─────────────────────────────────
async function resetAllStatus(){
  if(!confirm('Reset ทุก status กลับเป็น No Run?'))return;
  showLoadingOverlay('กำลัง reset...');
  await resetAllStatusDB();
  hideLoadingOverlay();
  updateHeaderStrip();
  if(currentFeatureId==='overview')renderOverview();
  else{const f=FEATURES.find(f=>f.meta.id===currentFeatureId);if(f)renderFeature(f);}
}
