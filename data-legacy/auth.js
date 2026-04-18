// ── LOGIN & AUTHENTICATION TEST CASES ──
// Journey: Login / Auth | Mobile App | Thai locale

const AUTH_META = {
  id: 'auth',
  name: 'Login & Authentication',
  emoji: '🔐',
  color: '#185FA5',
  colorBg: '#EAF2FB',
  colorBorder: '#B5D0F0',
  tags: [
    { label: 'Journey', style: 'badge-blue' },
    { label: 'Mobile App', style: 'badge-blue' },
    { label: 'Security', style: 'badge-gray' },
  ],
  description: 'ทดสอบการเข้าสู่ระบบ, การจัดการ session, Biometric login, และการรีเซ็ตรหัสผ่าน',
  screens: {
    S1: { label: 'Screen 1', name: 'Login form',     cssClass: 'sc-auth-s1' },
    S2: { label: 'Screen 2', name: 'OTP verify',     cssClass: 'sc-auth-s2' },
    S3: { label: 'Screen 3', name: 'Reset password', cssClass: 'sc-auth-s3' },
    S4: { label: 'Screen 4', name: 'Home / session', cssClass: 'sc-auth-s4' },
  },
};

const AUTH_CASES = [
  { id:'AU-01', screen:'S1', type:'positive',
    title:'Login with valid credentials', sub:'Email + password — happy path',
    steps:['Open app','Enter valid email and password','Tap "เข้าสู่ระบบ"'],
    expect:['Loading indicator shown briefly','User redirected to Home screen','Session token stored','Username displayed in header'] },

  { id:'AU-02', screen:'S1', type:'negative',
    title:'Login with wrong password', sub:'Invalid credentials error handling',
    steps:['Enter valid email with incorrect password','Tap "เข้าสู่ระบบ"'],
    expect:['Error message shown: "อีเมลหรือรหัสผ่านไม่ถูกต้อง"','Fields not cleared','No navigation away from login screen','Attempt counter incremented'] },

  { id:'AU-03', screen:'S1', type:'negative',
    title:'Login with unregistered email', sub:'Account not found',
    steps:['Enter email that has no account','Enter any password','Tap "เข้าสู่ระบบ"'],
    expect:['Error message: "ไม่พบบัญชีนี้"','Form remains on screen','No hint given about whether email exists (security)'] },

  { id:'AU-04', screen:'S1', type:'negative',
    title:'Empty fields submission', sub:'Form validation before API call',
    steps:['Leave email and password blank','Tap "เข้าสู่ระบบ"'],
    expect:['Inline validation shows on both fields','No API call made','Fields highlighted in red'] },

  { id:'AU-05', screen:'S1', type:'edge',
    title:'Invalid email format', sub:'Email format validation',
    steps:['Enter "notanemail" in email field','Enter any password','Tap "เข้าสู่ระบบ"'],
    expect:['Email field shows format error','No API call made','Password field unaffected'] },

  { id:'AU-06', screen:'S1', type:'edge',
    title:'Account locked after failed attempts', sub:'Brute-force protection',
    steps:['Enter wrong password 5 times in a row'],
    expect:['Account temporarily locked','Error message with lockout duration shown','Login button disabled during lockout','Unlock option via email sent'] },

  { id:'AU-07', screen:'S1', type:'positive',
    title:'Biometric login (Face ID / Fingerprint)', sub:'Biometric shortcut on returning user',
    steps:['Return to app with biometric enabled','Biometric prompt appears','Authenticate with face/fingerprint'],
    expect:['Biometric prompt shown on app launch','Successful auth navigates to Home','Falls back to password if biometric fails'] },

  { id:'AU-08', screen:'S1', type:'edge',
    title:'Biometric cancelled by user', sub:'User dismisses biometric prompt',
    steps:['Biometric prompt appears','User taps "Cancel"'],
    expect:['Prompt dismissed','Manual email/password form shown','No error state'] },

  { id:'AU-09', screen:'S2', type:'positive',
    title:'OTP sent and verified successfully', sub:'2FA via SMS',
    steps:['Login with valid credentials (2FA enabled)','OTP screen shown','Enter correct 6-digit OTP'],
    expect:['OTP verified','Redirected to Home','Session started with 2FA flag'] },

  { id:'AU-10', screen:'S2', type:'negative',
    title:'Wrong OTP entered', sub:'OTP mismatch',
    steps:['Enter incorrect OTP','Tap "ยืนยัน"'],
    expect:['Error shown: "รหัส OTP ไม่ถูกต้อง"','Input cleared','Remaining attempts shown','Not navigated away'] },

  { id:'AU-11', screen:'S2', type:'edge',
    title:'OTP expires before entry', sub:'OTP timeout (60s)',
    steps:['Request OTP','Wait 60 seconds without entering it','Attempt to submit expired OTP'],
    expect:['OTP expired message shown','Resend button enabled','Expired OTP rejected even if correct digits'] },

  { id:'AU-12', screen:'S2', type:'positive',
    title:'Resend OTP', sub:'User requests new code',
    steps:['On OTP screen tap "ส่งรหัสใหม่"'],
    expect:['New OTP sent via SMS','Countdown timer resets','Old OTP invalidated','Confirmation message shown'] },

  { id:'AU-13', screen:'S3', type:'positive',
    title:'Request password reset email', sub:'Forgot password flow',
    steps:['Tap "ลืมรหัสผ่าน?" on login screen','Enter registered email','Tap "ส่งอีเมล"'],
    expect:['Success message shown','Reset email sent to address','Link valid for 15 minutes'] },

  { id:'AU-14', screen:'S3', type:'negative',
    title:'Reset email for unregistered address', sub:'No account found',
    steps:['Enter unregistered email in reset form','Tap "ส่งอีเมล"'],
    expect:['Generic success message shown (no account enumeration)','No actual email sent','Security: does not reveal account existence'] },

  { id:'AU-15', screen:'S4', type:'edge',
    title:'Session expires mid-use', sub:'Token TTL reached while app is open',
    steps:['Login successfully','Leave app idle until session expires','Attempt to perform an action'],
    expect:['API returns 401','App shows session-expired dialog','Redirected to login screen','No data loss on current screen preserved if possible'] },

  { id:'AU-16', screen:'S4', type:'positive',
    title:'Logout clears session', sub:'Explicit logout action',
    steps:['From Home screen tap logout','Confirm logout'],
    expect:['Session token cleared from storage','Biometric token invalidated','Redirected to Login screen','No back-navigation returns to protected screens'] },
];
