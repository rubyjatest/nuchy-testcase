# Setup Guide — QA Test Cases v5

## Architecture

| ส่วน | ใช้สำหรับ |
|------|----------|
| **Supabase** | Login เท่านั้น (email/password → JWT) |
| **Google Drive** | เก็บข้อมูลทั้งหมด (status, custom features, cases) |

ข้อมูลถูกเก็บใน Google Drive `Application Data folder` ของ user แต่ละคน
— ไม่มองเห็นในหน้า Drive ปกติ, ไม่กินโควต้า Supabase

---

## Step 1 — Supabase (เฉพาะ Auth)

Supabase project เดิมใช้ได้เลย ไม่ต้องสร้าง table ใหม่
ตรวจสอบว่า `SUPABASE_URL` และ `SUPABASE_ANON_KEY` ใน `js/app.js` ถูกต้อง

---

## Step 2 — Google Cloud Project (สำหรับ Drive API)

### 2.1 สร้าง Project

1. ไปที่ [console.cloud.google.com](https://console.cloud.google.com)
2. กด **Select a project** → **New Project**
3. ตั้งชื่อ เช่น `QA Test Cases` → **Create**

### 2.2 เปิด Drive API

1. ไปที่ **APIs & Services → Library**
2. ค้นหา `Google Drive API`
3. กด **Enable**

### 2.3 สร้าง OAuth Consent Screen

1. ไปที่ **APIs & Services → OAuth consent screen**
2. เลือก **External** → **Create**
3. กรอก:
   - App name: `QA Test Cases`
   - User support email: อีเมลของคุณ
   - Developer contact information: อีเมลของคุณ
4. กด **Save and Continue**
5. ใน **Scopes** → **Add or remove scopes** → เพิ่ม:
   - `https://www.googleapis.com/auth/drive.appdata`
6. ใน **Test users** → เพิ่มอีเมลของทุกคนในทีม (ขณะที่ยังเป็น Testing mode)
7. กด **Save and Continue**

### 2.4 สร้าง OAuth 2.0 Client ID

1. ไปที่ **APIs & Services → Credentials**
2. กด **+ Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Name: `QA Test Cases Web`
5. **Authorized JavaScript origins** — เพิ่ม URL ที่ใช้งาน:
   ```
   https://yourusername.github.io
   http://localhost:3000
   http://127.0.0.1:5500
   ```
   > ⚠️ ต้องตรงกับ URL ที่เปิดเว็บจริงๆ ไม่มี trailing slash
6. กด **Create**
7. คัดลอก **Client ID** (รูปแบบ `1234567890-abc.apps.googleusercontent.com`)

### 2.5 ใส่ Client ID ในโค้ด

เปิด `js/app.js` แก้บรรทัดที่ 8:
```js
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
// เปลี่ยนเป็น
const GOOGLE_CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
```

---

## Step 3 — Deploy ขึ้น GitHub Pages

```bash
# 1. สร้าง repo บน GitHub (Public)
# 2. upload ไฟล์ทั้งหมด
# 3. Settings → Pages → Source: main / (root)
```

จากนั้นกลับไปที่ Google Cloud Console → Credentials
เพิ่ม `https://yourusername.github.io` ใน **Authorized JavaScript origins**

---

## การใช้งานครั้งแรก

1. เปิดเว็บ → ใส่ email/password (Supabase)
2. กด **เชื่อมต่อ Google Drive** → เลือก Google account
3. อนุญาต access → ข้อมูลจะถูกโหลดจาก Drive

### Session หมดอายุ (ทุก ~1 ชั่วโมง)
Google access token มีอายุ 1 ชั่วโมง เมื่อหมดอายุ:
- จะมี banner แจ้งเตือน "Google Drive session หมดอายุ"
- กด **เชื่อมต่อใหม่** → OAuth popup อีกครั้ง (เร็วกว่าครั้งแรก)

---

## โครงสร้างข้อมูลใน Google Drive

ไฟล์ `qa-testcases-data.json` ใน Application Data folder:
```json
{
  "version": 1,
  "status": {
    "XP-01": "passed",
    "XP-02": "failed"
  },
  "customFeatures": [
    { "meta": { "id": "checkout", "name": "Checkout", ... } }
  ],
  "customCases": {
    "checkout": [{ "id": "C-01", "title": "...", ... }]
  },
  "deletedCases": ["XP-03"]
}
```

---

## ลบ Built-in Feature

Built-in feature (จากไฟล์ `data/*.js`) ไม่สามารถลบจาก UI ได้
ให้ลบ (หรือ comment out) script tag ใน `index.html` แทน:

```html
<!-- <script src="data/auth.js"></script> -->
```
