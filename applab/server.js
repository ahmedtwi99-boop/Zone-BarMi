// سيرفر App Lab: رفع APK وتثبيته على الجهاز الافتراضي + عرض الروابط المرصودة.
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const KEY = process.env.API_KEY || '';
const VNCPASS = process.env.VNCPASS || '';
const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '/usr/local/lib/android/sdk';
const ADB = process.env.ADB || path.join(SDK, 'platform-tools', 'adb');
const L = '/tmp/lab';
const UP = path.join(L, 'uploads');
const FLOWS = path.join(L, 'flows.jsonl');
fs.mkdirSync(UP, { recursive: true });
if (!fs.existsSync(FLOWS)) fs.writeFileSync(FLOWS, '');

function adb(args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (e, out, err) => {
      resolve({ ok: !e, out: ((out || '') + (err || '')).trim() });
    });
  });
}
async function thirdParty() {
  const r = await adb(['shell', 'pm', 'list', 'packages', '-3']);
  return r.out.split('\n').map((s) => s.replace('package:', '').trim()).filter(Boolean);
}
async function launch(pkg) {
  return adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
}
function readState() {
  try { return JSON.parse(fs.readFileSync(path.join(L, 'state.json'), 'utf8')); }
  catch (e) { return { stage: 'starting', detail: '' }; }
}

const app = express();
app.use(cors({ origin: true, allowedHeaders: ['x-api-key', 'content-type'] }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ===== ريلاي داخل App Lab =====
// نفس ريلاي المشروع (relay-bridge) يشتغل هنا على نفس جهاز الأكشن اللي يلتقط الرابط. فلو التوكن مربوط بآي بي، الرابط يمر من نفس الآي بي.
// الرابط العام: <رابط اللاب>/live/<اسم>/master.m3u8
globalThis.__relayNames = globalThis.__relayNames || new Map();
globalThis.__relayUps = globalThis.__relayUps || new Map();
globalThis.__relayUpsOrigin = globalThis.__relayUpsOrigin || new Map();
try { require('../relay-bridge').mount(app); } catch (e) { console.error('[lab] الريلاي ما اشتغل:', e && e.message); }
const probe = (() => { try { return require('../probe-lib'); } catch (e) { console.error('[lab] probe-lib:', e && e.message); return null; } })();
app.use('/api', (req, res, next) => {
  if (KEY && req.headers['x-api-key'] === KEY) return next();
  res.status(401).json({ error: 'مفتاح الـ API غير صحيح.' });
});

app.get('/api/lab/status', (_req, res) => {
  const s = readState();
  res.json({ stage: s.stage, detail: s.detail || '', vncPass: VNCPASS });
});

// رفع على قطع (عشان حد 100MB بنفق كلاودفلير)
const nextChunk = {};
app.post('/api/lab/chunk', express.raw({ type: '*/*', limit: '30mb' }), (req, res) => {
  const id = String(req.query.id || '');
  const i = parseInt(req.query.i, 10);
  if (!/^[a-z0-9]{6,40}$/.test(id) || !(i >= 0)) return res.status(400).json({ error: 'طلب غير صحيح.' });
  const file = path.join(UP, id + '.apk');
  if (i === 0) { fs.writeFileSync(file, ''); nextChunk[id] = 0; }
  if (nextChunk[id] !== i) return res.status(409).json({ error: 'قطعة خارج الترتيب، أعد الرفع.' });
  fs.appendFileSync(file, req.body);
  nextChunk[id] = i + 1;
  res.json({ ok: true, next: i + 1 });
});

app.post('/api/lab/install', express.json(), async (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const file = path.join(UP, id + '.apk');
  if (!/^[a-z0-9]{6,40}$/.test(id) || !fs.existsSync(file)) return res.status(400).json({ error: 'ما لقيت الملف المرفوع.' });
  if (readState().stage !== 'ready') return res.status(409).json({ error: 'الجهاز لسا يتجهز، انتظر لين يصير جاهز.' });
  const before = await thirdParty();
  let r = await adb(['install', '-r', '-g', '-t', file], 300000);
  let knownPkg = '';
  // نسخة قديمة بتوقيع مختلف: نحذفها ونعيد التثبيت
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|INSTALL_FAILED_VERSION_DOWNGRADE/.test(r.out)) {
    const m = r.out.match(/Package ([A-Za-z0-9._]+)/);
    if (m) {
      knownPkg = m[1];
      await adb(['uninstall', knownPkg]);
      r = await adb(['install', '-r', '-g', '-t', file], 300000);
    }
  }
  fs.unlink(file, () => {});
  if (!/Success/i.test(r.out)) {
    let hint = '';
    if (/NO_MATCHING_ABIS/.test(r.out)) hint = ' التطبيق ما يدعم معالج الجهاز الافتراضي (x86_64)، غالبًا نسخته ARM فقط.';
    if (/INSTALL_FAILED_OLDER_SDK/.test(r.out)) hint = ' التطبيق يحتاج أندرويد أحدث من نسخة الجهاز (11).';
    return res.status(400).json({ error: 'فشل التثبيت: ' + r.out.slice(0, 300) + hint });
  }
  const after = await thirdParty();
  const added = after.filter((p) => !before.includes(p));
  const pkg = knownPkg || added[0] || after[after.length - 1] || '';
  let launched = false;
  if (pkg) launched = (await launch(pkg)).ok;
  res.json({ ok: true, package: pkg, launched });
});

app.get('/api/lab/apps', async (_req, res) => res.json({ apps: await thirdParty() }));
app.post('/api/lab/launch', express.json(), async (req, res) => {
  const pkg = String((req.body && req.body.package) || '');
  if (!/^[A-Za-z0-9._]+$/.test(pkg)) return res.status(400).json({ error: 'اسم حزمة غير صحيح.' });
  res.json({ ok: (await launch(pkg)).ok });
});

// فتح رابط موقع (صفحة المباراة) في متصفح الجهاز الافتراضي. الطلبات تمر على mitmproxy فيترصد رابط البث
// وهو مربوط بآي بي الأكشن (مو بآي بي جوالك). بعدها يطلع في "الروابط المرصودة" مع هيدرزه الحقيقية.
let chromeFlagsSet = false;
async function pickBrowser() {
  for (const p of ['com.android.chrome', 'org.mozilla.firefox', 'com.android.browser', 'org.chromium.webview_shell']) {
    const r = await adb(['shell', 'pm', 'path', p]);
    if (/package:/.test(r.out)) return p;
  }
  return '';
}
app.post('/api/lab/open-url', express.json(), async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  if (!/^https?:\/\/[^\s'"`\\\x00-\x1f]{3,2000}$/i.test(url)) return res.status(400).json({ error: 'رابط غير صحيح (لازم يبدأ بـ http:// أو https://).' });
  if (readState().stage !== 'ready') return res.status(409).json({ error: 'الجهاز لسا يتجهز، انتظر لين يصير جاهز.' });
  if (req.body && req.body.clear) fs.writeFileSync(FLOWS, '');
  const pkg = await pickBrowser();
  // كروم: نتخطى شاشة الترحيب (تعطّل الفتح أول مرة)
  if (pkg === 'com.android.chrome' && !chromeFlagsSet) {
    await adb(['shell', "echo '_ --disable-fre --no-first-run --no-default-browser-check' > /data/local/tmp/chrome-command-line && chmod 755 /data/local/tmp/chrome-command-line && am set-debug-app --persistent com.android.chrome"]);
    await adb(['shell', 'am', 'force-stop', 'com.android.chrome']);
    chromeFlagsSet = true;
  }
  // الرابط بين علامتي اقتباس مفردة عشان & و ? ما يفسّرها شيل الجهاز (الـ regex فوق يمنع ' نفسها)
  const cmd = `am start -a android.intent.action.VIEW -d '${url}'` + (pkg ? ` -p ${pkg}` : '');
  const r = await adb(['shell', cmd], 30000);
  if (!r.ok || /Error|Exception|unable to resolve/i.test(r.out)) {
    return res.status(500).json({ error: 'ما قدرت أفتح الرابط: ' + r.out.slice(0, 200) + (pkg ? '' : ' (ما لقيت متصفح بالجهاز، ثبّت APK متصفح x86_64 من الأعلى ثم جرّب).') });
  }
  res.json({ ok: true, browser: pkg || 'الافتراضي' });
});

// تمرير رابط مرصود من نفس الجهاز: يسجّله بالريلاي المحلي (Referer/Origin اللي أرسلها المشغّل الحقيقي)،
// ثم يفحصه مرتين من هنا: مباشر بالهيدرز، وعبر الريلاي نفسه (يعني الرابط اللي بيطلع لك). النتيجة تقول بث حقيقي ولا شاشة ثابتة.
const PASS_DIR = path.join(L, 'pass'); fs.mkdirSync(PASS_DIR, { recursive: true });
const passMeta = {};
async function passCheck(name) {
  const m = passMeta[name]; if (!m || !probe) return null;
  const pub = `http://127.0.0.1:3100/live/${name}/master.m3u8`;
  const direct = await probe.analyzeUrl(m.url, m.hdr, { dir: PASS_DIR, tag: 'd' });
  const viaRelay = await probe.analyzeUrl(pub, {}, { dir: PASS_DIR, tag: 'r' });
  m.last = { at: Date.now(), direct: direct.summary, viaRelay: viaRelay.summary };
  return { direct, viaRelay };
}
app.post('/api/lab/pass', express.json(), async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || 'lab1').toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(name)) return res.status(400).json({ error: 'اسم غير صالح (حروف إنجليزي وأرقام و - _ فقط)' });
  let u; try { u = new URL(String(b.url || '')); } catch (_e) { return res.status(400).json({ error: 'رابط غير صالح' }); }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'الرابط لازم http/https' });
  let ref = String(b.referer || '').trim(), og = String(b.origin || '').trim();
  try { ref = ref ? new URL(ref).href : u.origin + '/'; } catch (_e) { return res.status(400).json({ error: 'Referer غير صالح' }); }
  try { og = og ? new URL(og).origin : ''; } catch (_e) { return res.status(400).json({ error: 'Origin غير صالح' }); }
  const cut = u.pathname.lastIndexOf('/') + 1;
  globalThis.__relayUps.set(u.origin, ref);
  if (og) globalThis.__relayUpsOrigin.set(u.origin, og); else globalThis.__relayUpsOrigin.delete(u.origin);
  globalThis.__relayNames.set(name, { o: u.origin, d: u.pathname.slice(0, cut), f: u.pathname.slice(cut), q: u.search, exp: Date.now() + 30 * 24 * 3600 * 1000, nosuf: true });
  passMeta[name] = { url: u.href, hdr: { Referer: ref, Origin: og || new URL(ref).origin } };
  let check = null;
  try { check = await passCheck(name); } catch (e) { check = { error: String(e.message || e) }; }
  res.json({ ok: true, name, path: `/live/${name}/master.m3u8`, check });
});
app.get('/api/lab/pass/check', async (req, res) => {
  const name = String(req.query.name || 'lab1').toLowerCase();
  if (!passMeta[name]) return res.status(404).json({ error: 'ما فيه رابط ممرر بهذا الاسم' });
  try { res.json({ ok: true, name, check: await passCheck(name) }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/lab/flows', (req, res) => {
  const kind = req.query.kind === 'all' ? 'all' : 'stream';
  let text = '';
  try {
    const st = fs.statSync(FLOWS);
    const max = 20 * 1024 * 1024;
    const fd = fs.openSync(FLOWS, 'r');
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (e) {}
  const out = [];
  const seen = new Set();
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < 300; i--) {
    if (!lines[i]) continue;
    let r; try { r = JSON.parse(lines[i]); } catch (e) { continue; }
    if (kind === 'stream' && r.kind !== 'stream' && r.kind !== 'video') continue;
    if (kind === 'all' && r.kind === 'segment') continue;
    const k = r.method + ' ' + r.url;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  res.json({ flows: out });
});
app.post('/api/lab/flows/clear', (_req, res) => { fs.writeFileSync(FLOWS, ''); res.json({ ok: true }); });

app.listen(3100, '127.0.0.1', () => console.log('app-lab server on 3100'));
