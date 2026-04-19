# QA Test Cases — Mobile App

A searchable QA test case repository for mobile app flows.

## What Changed
- Google Drive is now the **only** data store for test cases, status, and images
- Data is split per feature:
  - `status.json`
  - `features/<featureId>.json`
  - `images/<caseId>/...`
- The browser no longer talks to Google Drive directly
- A Supabase Edge Function acts as a secure proxy and diagnostics layer

## Features
- Multi-feature test case management
- Status tracking per test case
- Image attachments stored in Google Drive
- Per-feature CSV import/export
- Bulk CSV import for multiple features in one go
- Drive diagnostics UI for debugging connection issues

## Google Drive Note
If the target Drive is a personal Gmail My Drive such as `testbulk87@gmail.com`, a Google service account may fail to create new files.

For a true `one feature = one file` setup, the recommended mode is:
- Google OAuth refresh token for the actual Drive owner account

See [SETUP.md](/Users/chiinuch/nuchy-testcase/SETUP.md) for the exact setup steps and diagnostics workflow.
