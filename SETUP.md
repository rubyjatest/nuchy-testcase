# QA Test Cases v8 — Setup Guide

## Architecture
- **Auth**: Supabase email/password
- **Data**: Google Drive only via Supabase Edge Function `drive-proxy`
- **Storage layout in Google Drive**
  - `status.json`
  - `features/<featureId>.json`
  - `images/<caseId>/<filename>`

## Important
- ข้อมูล test case, status, และรูปภาพ อยู่ใน **Google Drive เท่านั้น**
- Supabase ใช้สำหรับ **login + proxy ไปหา Google Drive** ไม่ได้เก็บข้อมูล test case
- ถ้าปลายทางเป็น **My Drive ของ Gmail ส่วนตัว** เช่น `testbulk87@gmail.com`
  service account มักสร้างไฟล์ใหม่ไม่ได้ หรือเจอ `storage quota restriction`
- ถ้าคุณต้องการแนวทาง `1 feature = 1 file` แบบเต็มรูป แนะนำให้ใช้ **Google OAuth refresh token ของ account เจ้าของ Drive** มากกว่า service account

## Step 1: Supabase
1. สร้าง project ใน Supabase
2. ไปที่ `Authentication -> Users`
3. เพิ่ม user ที่จะใช้ login
4. ใส่ `SUPABASE_URL` และ `SUPABASE_ANON_KEY` ใน `js/app.js`

## Step 2: Google Drive Root Folder
1. Login เป็น `testbulk87@gmail.com`
2. สร้างโฟลเดอร์หลัก เช่น `qa-testcases`
3. คัดลอก folder id จาก URL
4. ใช้ folder id นี้เป็น secret `DRIVE_SHARED_FOLDER_ID` ของ Supabase function

## Step 3: เลือก Google Auth Mode

### Option A: OAuth Refresh Token (Recommended for personal Gmail)
เหมาะกับกรณีที่ต้องการสร้างไฟล์ใหม่ได้จริงใน Drive ของ `testbulk87@gmail.com`

ต้องมี secrets เหล่านี้ใน Supabase function:
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `DRIVE_SHARED_FOLDER_ID`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

หมายเหตุ:
- refresh token ต้องเป็นของ account ที่เป็นเจ้าของ Drive คือ `testbulk87@gmail.com`
- เมื่อใช้ mode นี้ proxy จะสร้าง/ลบ/อัปเดตไฟล์ใน Drive ได้ในนาม account จริง

### Option B: Service Account
ใช้ได้ถ้า Drive ปลายทางอนุญาตให้ service account สร้างไฟล์ใหม่ หรือคุณยอมสร้างไฟล์/โฟลเดอร์ล่วงหน้าเอง

ต้องมี secrets:
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `DRIVE_SHARED_FOLDER_ID`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

ข้อควรระวัง:
- บน My Drive ของ Gmail ส่วนตัว service account มัก **สร้างไฟล์ใหม่ไม่ได้**
- ถ้า diagnostics บอกเรื่อง `storage quota restriction`
  ให้เปลี่ยนไปใช้ OAuth refresh token mode

## Step 4: Deploy Supabase Function
```bash
supabase functions deploy drive-proxy
```

และใน `supabase/config.toml` ให้คง:
```toml
[functions.drive-proxy]
verify_jwt = false
```

## Step 5: Diagnostics
หลัง login เข้าแอปแล้ว กดปุ่ม `Drive Debug`

สิ่งที่ diagnostics เช็กให้:
- auth mode ที่ใช้อยู่
- ดึง Google access token ได้ไหม
- root folder id เข้าถึงได้ไหม
- มี `features` / `images` / `status.json` หรือยัง
- สร้างและลบ temp file ได้ไหม

ถ้ายังต่อไม่ได้:
1. กด `Drive Debug`
2. กด `คัดลอก JSON`
3. ส่ง JSON กลับมาให้ผมวิเคราะห์ต่อได้ทันที

## Bulk CSV Import
- มีทั้งแบบ **ราย feature** และ **Bulk CSV**
- Bulk CSV ต้องตั้งชื่อไฟล์ให้ตรงกับ `featureId`
  - เช่น `auth.csv`
  - เช่น `xray-planogram.csv`
- รองรับ `UTF-8` และ `UTF-8 with BOM`

รูปแบบ:
```csv
id,type,screen,title,sub,steps,expect
TC-01,positive,S1,ชื่อ test case,คำอธิบาย,step1 | step2 | step3,expect1 | expect2
```

## Initial Seeding
- ถ้า Drive เชื่อมต่อสำเร็จและยังไม่มี feature files
  แอปจะ seed ข้อมูลตั้งต้นจาก `data/*.js` ขึ้นไปเป็นไฟล์ใน Google Drive ให้
- ถ้า auth mode ที่ใช้อยู่สร้างไฟล์ใหม่ไม่ได้ ขั้นตอนนี้จะ fail และ diagnostics จะบอกสาเหตุ
