// ── X-RAY PLANOGRAM TEST CASES ──
// Journey: X-ray Planogram | Mobile App | Thai locale

const XRAY_META = {
  id: 'xray-planogram',
  name: 'X-ray Planogram',
  emoji: '🔬',
  color: '#D95F02',
  colorBg: '#FFF4EC',
  colorBorder: '#F5C49A',
  tags: [
    { label: 'Journey', style: 'badge-orange' },
    { label: 'Mobile App', style: 'badge-blue' },
    { label: 'Thai locale', style: 'badge-gray' },
  ],
  description: 'ทดสอบ flow ตั้งแต่เปิดภาพชั้นวาง, ทริกเกอร์ X-ray, เลือก mode แสดงผล จนถึงดาวน์โหลดผลลัพธ์',
  screens: {
    S1: { label: 'Screen 1', name: 'Image view',   cssClass: 'sc-xp-s1' },
    S2: { label: 'Screen 2', name: 'Trigger',       cssClass: 'sc-xp-s2' },
    S3: { label: 'Screen 3', name: 'Mode picker',   cssClass: 'sc-xp-s3' },
    S4: { label: 'Screen 4', name: 'Result',        cssClass: 'sc-xp-s4' },
  },
};

const XRAY_CASES = [
  { id:'TC-01', screen:'S1', type:'positive',
    title:'Access to image view', sub:'UX entry point from shelf list',
    steps:['Open shelf list (พื้นที่ชั้นวาง)','Tap a shelf record (รูปที่ 1-2)','Image viewer screen loads'],
    expect:['Full-screen shelf photo renders','Navigation back arrow visible','Date/time label shows (15 ม.ค. 25 12:12 น.)','Record label "รูปที่ 1-2" displayed','Bottom action bar with X-ray button present'] },

  { id:'TC-02', screen:'S1', type:'edge',
    title:'Image loading failure', sub:'Network or CDN error on image fetch',
    steps:['Open shelf image with no/slow network','Image fetch times out'],
    expect:['Error placeholder shown instead of broken img','Retry option available','Bottom action bar still rendered (not blocked)'] },

  { id:'TC-03', screen:'S1', type:'positive',
    title:'Paginate between photos', sub:'รูปที่ 1-1 / 1-2 navigation',
    steps:['Open shelf with multiple photos','Swipe or tap prev/next','Navigate to record 1-1'],
    expect:['Record label updates to "รูปที่ 1-1"','Image swaps correctly','X-ray button remains accessible on each page'] },

  { id:'TC-04', screen:'S2', type:'positive',
    title:'Trigger X-ray analysis', sub:'Tap action button → processing state',
    steps:['On image view tap the X-ray/report icon at bottom-left','System initiates analysis'],
    expect:['"กำลังประมวลผล" spinner shown','Icon changes to active/orange state','UI non-interactive during processing','Progress indicator visible'] },

  { id:'TC-05', screen:'S2', type:'edge',
    title:'Analysis times out', sub:'Server does not respond within threshold',
    steps:['Trigger X-ray analysis','Wait beyond timeout (e.g. 30 s)'],
    expect:['Timeout/error message shown','Option to retry displayed','UI returns to tappable state'] },

  { id:'TC-06', screen:'S2', type:'negative',
    title:'Double-tap action button', sub:'Prevent duplicate API calls',
    steps:['Tap X-ray button','Tap again before processing completes'],
    expect:['Second tap is ignored or debounced','Only one API call is sent','Spinner remains; no duplicate requests'] },

  { id:'TC-07', screen:'S3', type:'positive',
    title:'Display mode picker opens', sub:'"เลือกหน้าจอแสดงผล" bottom sheet',
    steps:['Processing completes','Bottom sheet with display options appears'],
    expect:['All 11 options listed with icon + label','Sheet is scrollable if content overflows','Background image dimmed'] },

  { id:'TC-08', screen:'S3', type:'positive',
    title:'Select "ขายของสินค้า"', sub:'Default / first option in list',
    steps:['Open mode picker','Tap "ขายของสินค้า"'],
    expect:['Sheet closes','Product sales overlay renders on shelf image','Header subtitle updates to "ขายของสินค้า"'] },

  { id:'TC-09', screen:'S3', type:'positive',
    title:'Select "แผนภาพการจัดวางสินค้า"', sub:'Journey target — last item in list',
    steps:['Open mode picker','Scroll to bottom','Tap "แผนภาพการจัดวางสินค้า"'],
    expect:['Sheet closes','Planogram overlay renders on shelf image','Header shows "แผนภาพการจัดวางสินค้า ↓"','Color-coded shelf map displayed'] },

  { id:'TC-10', screen:'S3', type:'positive',
    title:'Select "สินค้าที่จัดแสดง"', sub:'Second option in picker',
    steps:['Open mode picker','Tap "สินค้าที่จัดแสดง"'],
    expect:['Displayed-products overlay renders','Header label updates accordingly'] },

  { id:'TC-11', screen:'S3', type:'positive',
    title:'Select "Arrangement"', sub:'English-label option in Thai list',
    steps:['Open mode picker','Tap "Arrangement"'],
    expect:['Arrangement view renders correctly','No locale/encoding issue with mixed-language label'] },

  { id:'TC-12', screen:'S3', type:'edge',
    title:'Dismiss picker without selection', sub:'Back gesture or tap outside sheet',
    steps:['Open mode picker','Tap outside sheet or press back'],
    expect:['Sheet closes','Previous screen state is preserved','No mode is applied','User can re-open picker'] },

  { id:'TC-13', screen:'S3', type:'negative',
    title:'Mode picker with no analysis result', sub:'Picker opened with empty/null result',
    steps:['Analysis returns empty data','Mode picker is shown'],
    expect:['Options still display','Selecting a mode shows empty-state message','No crash on null data'] },

  { id:'TC-14', screen:'S4', type:'positive',
    title:'Planogram overlay renders correctly', sub:'Color-coded map on shelf photo',
    steps:['Select "แผนภาพการจัดวางสินค้า"','View result screen'],
    expect:['Shelf image visible behind overlay','Product zones highlighted with correct colors','Legend/label visible','Header shows "แผนภาพการจัดวางสินค้า ↓"'] },

  { id:'TC-15', screen:'S4', type:'positive',
    title:'Switch mode from result screen', sub:'Change mode via header dropdown',
    steps:['On result screen tap "แผนภาพการจัดวางสินค้า ↓" in header','Select a different mode'],
    expect:['Mode picker re-opens','New mode overlay replaces current one','Header label updates'] },

  { id:'TC-16', screen:'S4', type:'positive',
    title:'Download photo from result screen', sub:'"ดาวน์โหลดรูปที่ 1-1" button',
    steps:['On result screen','Tap download button'],
    expect:['Image with overlay saved to device','Success confirmation shown','File accessible in device gallery'] },

  { id:'TC-17', screen:'S4', type:'edge',
    title:'Download fails — storage full', sub:'Device has no available storage',
    steps:['Fill device storage to max','Attempt download on result screen'],
    expect:['Error message shown (no crash)','User prompted to free up space'] },

  { id:'TC-18', screen:'S4', type:'positive',
    title:'Navigate back from result screen', sub:'Back arrow in header',
    steps:['On result screen','Tap back arrow'],
    expect:['Returns to image view (Screen 1)','No data loss or crash','Back stack is correct'] },

  { id:'TC-19', screen:'S4', type:'edge',
    title:'Planogram on low-res / blurry image', sub:'Image quality impacts AI detection',
    steps:['Open shelf with a blurry/low-res photo','Trigger X-ray and select Planogram mode'],
    expect:['Overlay still renders (even if partial)','Low-confidence indication shown if applicable','No crash or blank screen'] },

  { id:'TC-20', screen:'S1', type:'negative',
    title:'Open empty shelf (no photos)', sub:'Record exists but no image attached',
    steps:['Navigate to shelf with 0 photos','Open image view'],
    expect:['Empty state illustration/message shown','X-ray button disabled or hidden','No crash'] },
];
