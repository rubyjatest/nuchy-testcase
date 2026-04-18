# QA Test Cases v7 — Setup Guide

## Architecture
- **Auth**: Supabase (email/password login)
- **Data**: Google Drive (folder กลาง `qa-testcases` ที่แชร์ทุกคน)
  - แต่ละ feature = ไฟล์ `<featureId>.json` แยก
  - รูปภาพ = folder `images/<caseId>/`
  - status = `status.json`

## Step 1: Supabase Setup
1. สร้าง project ที่ supabase.com
2. ไปที่ Authentication → Users → สร้าง user ทุกคนที่จะใช้งาน
3. คัดลอก Project URL และ anon key ใส่ใน `js/app.js`

## Step 2: Google Cloud Console
1. ไปที่ [console.cloud.google.com](https://console.cloud.google.com)
2. สร้าง project → เปิด **Google Drive API**
3. OAuth consent screen → External → เพิ่ม test users
4. Credentials → OAuth 2.0 Client ID → Web application
5. Authorized JavaScript origins: ใส่ URL ของ GitHub Pages เช่น `https://yourusername.github.io`
6. คัดลอก Client ID ใส่ใน `js/app.js`

## Step 3: Google Drive Setup (สำคัญมาก!)
1. Login ด้วย account `testbulk87@gmail.com`
2. สร้าง folder ชื่อ `qa-testcases`
3. คลิกขวา → Share → เพิ่ม email ทุกคนที่จะใช้งาน (เลือก Editor)
4. แอพจะหา folder นี้อัตโนมัติเมื่อ login ด้วย Google

## Step 4: Deploy to GitHub Pages
```bash
git add .
git commit -m "QA Test Cases v7"
git push
```
Settings → Pages → Source: main branch

## CSV Import Format
```
id,type,screen,title,sub,steps,expect
TC-01,positive,S1,ชื่อ test case,คำอธิบาย,step1 | step2 | step3,expect1 | expect2
```
- **type**: positive / edge / negative  
- **screen**: key ใน feature เช่น S1, S2, S3
- **steps** และ **expect**: คั่นหลายรายการด้วย ` | ` (เว้นวรรคหน้าหลัง pipe)

ดู `csv-template.csv` เป็นตัวอย่าง
