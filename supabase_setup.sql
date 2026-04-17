-- ══════════════════════════════════════════════
--  QA Test Cases — Supabase Database Setup
--  Run this in Supabase SQL Editor (once only)
-- ══════════════════════════════════════════════

-- 1. Status ของแต่ละ test case
create table if not exists tc_status (
  case_id   text primary key,
  status    text not null default 'no-run',
  updated_at timestamptz default now()
);

-- 2. Custom features ที่ user สร้างเอง
create table if not exists custom_features (
  id         text primary key,
  meta_json  jsonb not null,
  created_at timestamptz default now()
);

-- 3. Custom cases ที่ user เพิ่มเอง
create table if not exists custom_cases (
  id          text primary key,
  feature_id  text not null,
  case_json   jsonb not null,
  created_at  timestamptz default now()
);

-- 4. รายการ case id ที่ถูกลบ (built-in ที่ซ่อนไว้)
create table if not exists deleted_cases (
  case_id    text primary key,
  deleted_at timestamptz default now()
);

-- ══ Policies: เปิด public access (แอพไม่มี auth) ══
alter table tc_status      enable row level security;
alter table custom_features enable row level security;
alter table custom_cases    enable row level security;
alter table deleted_cases   enable row level security;

create policy "allow all tc_status"       on tc_status       for all using (true) with check (true);
create policy "allow all custom_features" on custom_features  for all using (true) with check (true);
create policy "allow all custom_cases"    on custom_cases     for all using (true) with check (true);
create policy "allow all deleted_cases"   on deleted_cases    for all using (true) with check (true);
