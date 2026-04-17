# QA Test Cases — Mobile App

A clean, searchable HTML-based test case repository for mobile app features. The UI is still a static site, but shared persistence now runs through Supabase Auth + Supabase Edge Function + a single Google Drive folder.

## 🗂 Project Structure

```
qa-testcases/
├── index.html              # Main entry point
├── css/
│   └── style.css           # All styles
├── js/
│   └── app.js              # App logic (nav, filters, rendering)
├── supabase/
│   └── functions/
│       └── drive-proxy/    # Shared Google Drive proxy via service account
├── data/
│   ├── xray-planogram.js   # Feature: X-ray Planogram test cases
│   ├── auth.js             # Feature: Login & Authentication test cases
│   └── ...                 # Add more features here
├── SETUP.md                # Deploy + secrets setup
└── README.md
```

## ✨ Features

- **Multi-feature support** — each feature lives in its own data file
- **Overview dashboard** — summary cards with stats per feature
- **Filter by type** — Positive / Edge case / Negative
- **Filter by screen** — per-feature screen segments
- **Live search** — searches ID, title, steps, and expected behavior
- **Expandable rows** — click any row to see steps + expected behavior
- **Responsive** — works on mobile too
- **Shared persistence** — every logged-in user reads/writes the same Google Drive JSON file

## ➕ Adding a New Feature

### Step 1 — Create `data/my-feature.js`

```js
const MY_FEATURE_META = {
  id: 'my-feature',
  name: 'My Feature Name',
  emoji: '🛒',
  color: '#185FA5',
  colorBg: '#EAF2FB',
  colorBorder: '#B5D0F0',
  tags: [
    { label: 'Journey', style: 'badge-blue' },
    { label: 'Mobile App', style: 'badge-blue' },
  ],
  description: 'Short description of this feature and what is being tested.',
  screens: {
    S1: { label: 'Screen 1', name: 'Home',    cssClass: 'sc-mf-s1' },
    S2: { label: 'Screen 2', name: 'Detail',  cssClass: 'sc-mf-s2' },
  },
};

const MY_FEATURE_CASES = [
  {
    id: 'MF-01',
    screen: 'S1',
    type: 'positive',         // 'positive' | 'edge' | 'negative'
    title: 'Short title',
    sub: 'One-line description',
    steps: ['Step 1', 'Step 2'],
    expect: ['Expected outcome 1', 'Expected outcome 2'],
  },
  // ...
];
```

### Step 2 — Register in `js/app.js`

```js
const FEATURES = [
  { meta: XRAY_META,        cases: XRAY_CASES       },
  { meta: AUTH_META,        cases: AUTH_CASES        },
  { meta: MY_FEATURE_META,  cases: MY_FEATURE_CASES  }, // 👈 add this
];
```

### Step 3 — Include the script in `index.html`

```html
<script src="data/xray-planogram.js"></script>
<script src="data/auth.js"></script>
<script src="data/my-feature.js"></script>  <!-- 👈 add this -->
```

That's it. The feature will appear as a new tab automatically.

## 🎨 Test Case Types

| Type | Color | When to use |
|------|-------|-------------|
| `positive` | 🟢 Green | Happy path — expected normal behavior |
| `edge` | 🟡 Amber | Boundary conditions, timeouts, unusual inputs |
| `negative` | 🔴 Red | Error handling, invalid input, failure states |

## 🚀 Deployment

The frontend can still be deployed as a static site, but the app also requires:

- Supabase Auth
- Supabase Edge Function `drive-proxy`
- Google Drive shared folder + service account secret

See [SETUP.md](/Users/chiinuch/nuchy-testcase/SETUP.md) for the full setup flow.

## 🛠 Tech Stack

- Vanilla HTML / CSS / JS — zero dependencies, zero build step
- [IBM Plex Sans Thai](https://fonts.google.com/specimen/IBM+Plex+Sans+Thai) + IBM Plex Mono (Google Fonts)
