# Setup Guide — QA Test Cases v6

## Architecture

| ส่วน | ใช้สำหรับ |
|------|----------|
| **Supabase Auth** | Login ด้วย email/password |
| **Supabase Edge Function** | ตัวกลางตรวจสิทธิ์ user แล้วคุยกับ Google Drive |
| **Google Drive (shared folder)** | เก็บข้อมูล test cases กลางของทีม 1 ไฟล์ |

โครงสร้างใหม่นี้ไม่ผูกกับ Google account ของคนที่ login หน้าเว็บอีกแล้ว
หลัง Supabase login สำเร็จ หน้าเว็บจะอ่าน/เขียนไฟล์ JSON เดียวใน Google Drive กลางโดยอัตโนมัติ

---

## Step 1 — Frontend config

ใน [js/app.js](/Users/chiinuch/nuchy-testcase/js/app.js) ให้ตรวจสอบ 2 ค่านี้:

```js
const SUPABASE_URL      = 'https://kgwuakgtnvcvnybipqyz.supabase.co';
const SUPABASE_ANON_KEY = '...';
```

ค่า `GOOGLE_CLIENT_ID` ไม่ต้องใช้แล้ว

---

## Step 2 — เตรียม Google Drive กลาง

1. ใช้โฟลเดอร์ใน Drive ของ `testbulk87@gmail.com`
2. แชร์โฟลเดอร์นั้นให้ service account นี้เป็น `Editor`

```txt
qa-test-cases@nuchy-testcase.iam.gserviceaccount.com
```

3. คัดลอก `folder id` จาก URL ของโฟลเดอร์

ตัวอย่าง:

```txt
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp
```

ค่า `DRIVE_SHARED_FOLDER_ID` คือ:

```txt
1AbCdEfGhIjKlMnOp
```

---

## Step 3 — เก็บ service account key เป็น Supabase secret

ไฟล์ key ที่ใช้:

```txt
/Users/chiinuch/Downloads/nuchy-testcase-deb69e16caf2.json
```

สำคัญ:
- อย่าเอา JSON key ไปใส่ใน frontend
- อย่า commit key เข้า repo
- ให้เก็บเป็น Supabase secret เท่านั้น

ถ้ายังไม่ได้ login / link project:

```bash
supabase login
supabase link --project-ref kgwuakgtnvcvnybipqyz
```

จากนั้น set secrets:

```bash
supabase secrets set \
  GOOGLE_SERVICE_ACCOUNT_JSON="$(cat /Users/chiinuch/Downloads/nuchy-testcase-deb69e16caf2.json)" \
  DRIVE_SHARED_FOLDER_ID="YOUR_GOOGLE_DRIVE_FOLDER_ID" \
  DRIVE_DATA_FILENAME="qa-testcases-data.json"
```

แนะนำเพิ่มอีก 1 secret เพื่อเลี่ยงปัญหา service account สร้างไฟล์ใหม่ไม่ได้:

```bash
supabase secrets set DRIVE_DATA_FILE_ID="YOUR_EXISTING_JSON_FILE_ID"
```

โดยวิธีหา `DRIVE_DATA_FILE_ID`:

1. login Google Drive ด้วย `testbulk87@gmail.com`
2. ในโฟลเดอร์เป้าหมาย สร้างไฟล์ชื่อ `qa-testcases-data.json`
3. ใส่ข้อมูลเริ่มต้นนี้:

```json
{
  "version": 1,
  "status": {},
  "customFeatures": [],
  "customCases": {},
  "deletedCases": []
}
```

4. แชร์ไฟล์นั้นให้ `qa-test-cases@nuchy-testcase.iam.gserviceaccount.com` เป็น `Editor`
5. คัดลอก file id จาก URL ของไฟล์ แล้ว set เป็น `DRIVE_DATA_FILE_ID`

---

## Step 4 — Deploy Edge Function

ไฟล์ function อยู่ที่:

[supabase/functions/drive-proxy/index.ts](/Users/chiinuch/nuchy-testcase/supabase/functions/drive-proxy/index.ts)

deploy ด้วยคำสั่ง:

```bash
supabase functions deploy drive-proxy --project-ref kgwuakgtnvcvnybipqyz
```

function นี้จะทำ 3 อย่าง:
- ตรวจว่า request มาจาก user ที่ login กับ Supabase จริง
- ใช้ service account ขอ access token จาก Google
- อ่าน/เขียนไฟล์ `qa-testcases-data.json` ใน shared folder เดียวของทีม

หมายเหตุ:
- repo นี้มี [supabase/config.toml](/Users/chiinuch/nuchy-testcase/supabase/config.toml) ที่ตั้ง `verify_jwt = false` สำหรับ `drive-proxy`
- จำเป็นต้องปิด gateway JWT verification เพราะ Supabase ระบุว่า flow เดิมนี้ไม่เข้ากับ JWT signing keys แบบใหม่
- จากนั้น function จะตรวจ bearer token เองภายใน `index.ts`

---

## Step 5 — Deploy frontend

frontend ยัง deploy แบบ static ได้เหมือนเดิม:

- GitHub Pages
- Netlify
- Vercel
- local static server

แต่ตอนใช้งานจริง หน้าเว็บจะต้องเรียก `drive-proxy` function ของ Supabase ได้

---

## การใช้งานหลังแก้

1. เปิดเว็บ
2. Login ด้วย Supabase email/password
3. ระบบ sync ข้อมูลจาก Google Drive กลางอัตโนมัติ
4. ไม่มี Google popup
5. ไม่ต้องเลือก Google account

ทุกคนจะอ่าน/เขียนไฟล์ชุดเดียวกันใน Drive ของ `testbulk87@gmail.com`

---

## รูปแบบข้อมูลที่เก็บใน Drive

ไฟล์ `qa-testcases-data.json`:

```json
{
  "version": 1,
  "status": {
    "XP-01": "passed",
    "XP-02": "failed"
  },
  "customFeatures": [],
  "customCases": {},
  "deletedCases": []
}
```

---

## Troubleshooting

ถ้า login ผ่านแต่โหลดข้อมูลไม่ได้ ให้เช็กตามนี้:

1. deploy `drive-proxy` แล้ว
2. secret `GOOGLE_SERVICE_ACCOUNT_JSON` ถูกต้อง
3. secret `DRIVE_SHARED_FOLDER_ID` ถูกต้อง
4. โฟลเดอร์ใน Drive แชร์ให้ service account เป็น `Editor` แล้ว
5. service account key ยังไม่ถูก revoke

ถ้าขึ้นประมาณนี้:

```txt
File not found: .
```

แปลว่า `DRIVE_SHARED_FOLDER_ID` ถูกตั้งผิดค่าอยู่มาก ๆ
- มักเป็น `.` หรือยังเป็น placeholder เดิม
- ต้องเปลี่ยน secret ให้เป็น folder id จริงจาก URL ของโฟลเดอร์ Google Drive

ถ้าขึ้นประมาณนี้:

```txt
Service Accounts do not have storage quota
```

แปลว่า service account พยายามสร้างไฟล์ใหม่เองอยู่
- ให้สร้างไฟล์ `qa-testcases-data.json` ด้วย `testbulk87@gmail.com` ก่อน
- แชร์ไฟล์นั้นให้ service account
- แล้ว set `DRIVE_DATA_FILE_ID` ให้ชี้ไปที่ file id ของไฟล์นั้น

ถ้าโฟลเดอร์แชร์ถูกแล้วแต่ยังเขียนไม่ได้ ให้ลองลบไฟล์ `qa-testcases-data.json` เดิมในโฟลเดอร์ แล้วให้ระบบสร้างใหม่อัตโนมัติ
