// سيرفر App Lab: رفع APK / XAPK / APKS / APKM وتثبيته على الجهاز الافتراضي + عرض الروابط المرصودة.
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

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

// ===== الحزم المقسمة (XAPK / APKS / APKM) =====
// كلها ملفات zip فيها أكثر من APK (وأحيانًا ملفات OBB). نعرف النوع من محتوى الملف مو من امتداده.
function unzipList(file) {
  return new Promise((resolve) => {
    execFile('unzip', ['-Z1', file], { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }, (e, out) => {
      resolve(e ? null : out.split('\n').filter(Boolean));
    });
  });
}
// نطلع ملف واحد من الـ zip لمسار نختاره حنا (أسماء الملفات اللي داخل الحزمة ما تتحكم بمكان الكتابة)
function unzipEntry(file, entry, dest) {
  return new Promise((resolve, reject) => {
    const pattern = entry.replace(/[\[\]*?\\]/g, '\\$&');
    const p = spawn('unzip', ['-p', file, pattern], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 180000 });
    const w = fs.createWriteStream(dest);
    let code = null, closed = false;
    const done = () => {
      if (code === null || !closed) return;
      if (code === 0) resolve(); else reject(new Error('ما قدرت أفك ' + entry));
    };
    p.on('error', reject);
    w.on('error', (e) => { p.kill(); reject(e); });
    w.on('close', () => { closed = true; done(); });
    p.on('close', (c) => { code = c === null ? -1 : c; done(); });
    p.stdout.pipe(w);
  });
}
// الحزمة ممكن تحتوي أكثر من معالج: نختار واحد بس، الأنسب للجهاز الافتراضي (x86_64)
const ABI_RE = /(?:^|[._-])(x86_64|x86|arm64_v8a|armeabi_v7a|armeabi|mips64|mips)\.apk$/i;
const ABI_ORDER = ['x86_64', 'x86', 'arm64_v8a', 'armeabi_v7a', 'armeabi'];
function pickApks(entries) {
  let apks = entries.filter((n) => /\.apk$/i.test(n));
  // صيغة bundletool: مجلد splits/ هو المطلوب، و standalones/ نسخ بديلة تتعارض معه
  const splits = apks.filter((n) => /^splits\//.test(n));
  if (splits.length) apks = splits;
  const universal = apks.find((n) => /(^|\/)universal\.apk$/i.test(n));
  if (universal) return [universal];
  const abiOf = (n) => { const m = path.posix.basename(n).match(ABI_RE); return m ? m[1].toLowerCase() : ''; };
  const abis = apks.map(abiOf).filter(Boolean);
  if (!abis.length) return apks;
  const best = ABI_ORDER.find((a) => abis.includes(a));
  return apks.filter((n) => !abiOf(n) || abiOf(n) === best);
}
async function preparePackage(file, dir) {
  const entries = await unzipList(file);
  if (!entries) throw new Error('الملف تالف أو ناقص (مو ملف تطبيق صالح). حمّله من جديد وأعد الرفع.');
  if (entries.includes('AndroidManifest.xml')) return { apks: [file], obbs: [], pkg: '' };
  const wanted = pickApks(entries.filter((n) => !n.startsWith('-')));
  if (!wanted.length) throw new Error('ما لقيت أي APK داخل الملف.');
  fs.mkdirSync(dir, { recursive: true });
  const apks = [];
  for (let i = 0; i < wanted.length; i++) {
    const dest = path.join(dir, i + '.apk');
    await unzipEntry(file, wanted[i], dest);
    apks.push(dest);
  }
  const obbs = [];
  for (const n of entries) {
    const m = n.match(/^Android\/obb\/([A-Za-z0-9._]+)\/([A-Za-z0-9._-]+\.obb)$/);
    if (!m) continue;
    const dest = path.join(dir, 'obb' + obbs.length);
    await unzipEntry(file, n, dest);
    obbs.push({ file: dest, pkg: m[1], name: m[2] });
  }
  // اسم الحزمة من manifest.json (XAPK) أو info.json (APKM)
  let pkg = '';
  const meta = ['manifest.json', 'info.json'].find((n) => entries.includes(n));
  if (meta) {
    try {
      const dest = path.join(dir, 'meta.json');
      await unzipEntry(file, meta, dest);
      const j = JSON.parse(fs.readFileSync(dest, 'utf8'));
      const p = String(j.package_name || j.pname || '');
      if (/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(p)) pkg = p;
    } catch (e) {}
  }
  return { apks, obbs, pkg };
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
  const dir = path.join(UP, id + '.d');
  const cleanup = () => { fs.rmSync(file, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); };
  let bundle;
  try { bundle = await preparePackage(file, dir); }
  catch (e) { cleanup(); return res.status(400).json({ error: 'فشل التثبيت: ' + e.message }); }
  const before = await thirdParty();
  const cmd = [bundle.apks.length > 1 ? 'install-multiple' : 'install', '-r', '-g', '-t', ...bundle.apks];
  let r = await adb(cmd, 300000);
  let knownPkg = '';
  // نسخة قديمة بتوقيع مختلف: نحذفها ونعيد التثبيت
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|INSTALL_FAILED_VERSION_DOWNGRADE/.test(r.out)) {
    const m = r.out.match(/Package ([A-Za-z0-9._]+)/);
    if (m) {
      knownPkg = m[1];
      await adb(['uninstall', knownPkg]);
      r = await adb(cmd, 300000);
    }
  }
  const installed = /Success/i.test(r.out);
  // ملفات OBB (بيانات إضافية لبعض التطبيقات) تنسخ لمكانها بعد التثبيت
  let obbFailed = 0;
  if (installed) {
    for (const o of bundle.obbs) {
      const target = '/sdcard/Android/obb/' + o.pkg;
      await adb(['shell', 'mkdir', '-p', target]);
      if (!(await adb(['push', o.file, target + '/' + o.name], 300000)).ok) obbFailed++;
    }
  }
  cleanup();
  if (!installed) {
    let hint = '';
    if (/NO_MATCHING_ABIS/.test(r.out)) hint = ' التطبيق ما يدعم معالج الجهاز الافتراضي (x86_64)، غالبًا نسخته ARM فقط.';
    if (/INSTALL_FAILED_OLDER_SDK/.test(r.out)) hint = ' التطبيق يحتاج أندرويد أحدث من نسخة الجهاز (11).';
    if (/INSTALL_FAILED_MISSING_SPLIT/.test(r.out)) hint = ' التطبيق مقسم لأكثر من ملف، ارفع نسخة XAPK أو APKS كاملة.';
    return res.status(400).json({ error: 'فشل التثبيت: ' + r.out.slice(0, 300) + hint });
  }
  const after = await thirdParty();
  const added = after.filter((p) => !before.includes(p));
  const pkg = knownPkg || (after.includes(bundle.pkg) ? bundle.pkg : '') || added[0] || after[after.length - 1] || '';
  let launched = false;
  if (pkg) launched = (await launch(pkg)).ok;
  res.json({ ok: true, package: pkg, launched, parts: bundle.apks.length, obbFailed });
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
