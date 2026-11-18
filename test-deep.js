'use strict';
// اختبار عميق: هل المصدر يشتغل من الأكشن؟ وهل اللي يجي بث حقيقي ولا شاشة انتظار؟
// ملف واحد، ما يعتمد على أي ملف ثاني. يُشغَّل من workflow: Test Deep
// env: URL_TEST (الرابط)  REF (ريفرك، اختياري)  OUT_URL (رابط اللوحة/النفق، اختياري)  FRAMES_DIR
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const URL_ = (process.env.URL_TEST || '').trim();
const REF = (process.env.REF || '').trim();
const OUT = (process.env.OUT_URL || '').trim();
const DIR = process.env.FRAMES_DIR || 'frames';
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
if (!/^https?:\/\//.test(URL_)) { console.error('حط رابط صحيح'); process.exit(1); }
fs.mkdirSync(DIR, { recursive: true });

const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

async function get(url, headers, { bin = false, ms = 20000 } = {}) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ct: r.headers.get('content-type') || '', buf, text: bin ? '' : buf.toString('utf8') };
  } catch (e) { return { status: 0, ct: '', buf: Buffer.alloc(0), text: '', err: String(e.message || e) }; }
}
const kind = (r) => r.status === 0 ? 'خطأ اتصال: ' + (r.err || '') : /^#EXTM3U/.test(r.text.trim()) ? 'm3u8 سليم' : /<MPD/.test(r.text) ? 'MPD' : r.text.replace(/\s+/g, ' ').slice(0, 70);
const isOk = (r) => r.status === 200 && /^#EXTM3U|<MPD/.test(r.text.trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseMaster(text, base) {
  const L = text.split(/\r?\n/);
  const variants = [], media = [];
  for (let i = 0; i < L.length; i++) {
    if (L[i].startsWith('#EXT-X-STREAM-INF:')) {
      const bw = +((L[i].match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
      const res = (L[i].match(/RESOLUTION=([\dx]+)/) || [])[1] || '';
      let j = i + 1; while (j < L.length && (!L[j].trim() || L[j].startsWith('#'))) j++;
      if (L[j]) variants.push({ bw, res, url: new URL(L[j].trim(), base).href, name: L[j].trim().split('?')[0].split('/').pop() });
    } else if (L[i].startsWith('#EXT-X-MEDIA:')) {
      const u = (L[i].match(/URI="([^"]+)"/) || [])[1];
      if (u) media.push({ type: (L[i].match(/TYPE=(\w+)/) || [])[1], url: new URL(u, base).href, name: u.split('?')[0].split('/').pop() });
    }
  }
  return { variants, media };
}
function parseMedia(text, base) {
  const L = text.split(/\r?\n/); const segs = []; let dur = 0;
  for (const l of L) {
    if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith('#')) { segs.push({ dur, url: new URL(l.trim(), base).href }); dur = 0; }
  }
  const g = (re) => (text.match(re) || [])[1];
  return { segs, seq: g(/#EXT-X-MEDIA-SEQUENCE:(\d+)/), tdur: g(/#EXT-X-TARGETDURATION:(\d+)/), endlist: /#EXT-X-ENDLIST/.test(text), key: g(/#EXT-X-KEY:METHOD=([A-Z0-9-]+)/) };
}
// لقطة صغيرة (رمادية 32x18) من مقطع، للمقارنة؛ ولقطة jpg للعرض
function frame(file, jpg) {
  if (!hasFfmpeg) return null;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=32:18,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-1', jpg]);
  return r.status === 0 && r.stdout.length === 32 * 18 ? r.stdout : null;
}
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

async function analyze(tag, v, H) {
  const out = { name: v.name };
  const pl = await get(v.url, H);
  if (!isOk(pl)) { out.verdict = `❌ القائمة: HTTP ${pl.status} — ${kind(pl)}`; return out; }
  const m = parseMedia(pl.text, v.url);
  out.info = `مقاطع=${m.segs.length} target=${m.tdur}s seq=${m.seq}${m.endlist ? ' ENDLIST' : ''}${m.key && m.key !== 'NONE' ? ' مشفّر:' + m.key : ''}`;
  if (m.segs.length < 2) { out.verdict = '❌ القائمة فاضية/مقطع واحد'; return out; }
  const pick = [m.segs[0], m.segs[m.segs.length - 2]];
  const got = [];
  for (let i = 0; i < 2; i++) {
    const s = await get(pick[i].url, H, { bin: true });
    if (s.status !== 200 || !s.buf.length) { out.verdict = `❌ المقطع: HTTP ${s.status} ${s.err || ''}`; return out; }
    const f = path.join(DIR, `${tag}_${v.name.replace(/\W+/g, '_')}_${i}`);
    fs.writeFileSync(f + '.ts', s.buf);
    got.push({ bytes: s.buf.length, dur: pick[i].dur || +m.tdur || 2, fr: frame(f + '.ts', f + '.jpg') });
  }
  const kbps = Math.round((got[0].bytes * 8 / got[0].dur) / 1000);
  const declared = v.bw ? Math.round(v.bw / 1000) : 0;
  out.rate = `${kbps}kbps${declared ? ` (معلن ${declared}, ${Math.round(100 * kbps / declared)}%)` : ''}`;
  if (got[0].fr && got[1].fr) {
    const d = diff(got[0].fr, got[1].fr);
    out.verdict = d < 3 ? `🖼️ ثابت (فرق اللقطات ${d.toFixed(1)}) — شاشة انتظار غالبًا` : `🎬 متحرك (فرق اللقطات ${d.toFixed(1)}) — بث حقيقي غالبًا`;
  } else out.verdict = hasFfmpeg ? '❓ ما قدرت أفك لقطة (راجع المقاطع)' : '❓ ما فيه ffmpeg — احكم من المعدل';
  return out;
}

async function run(label, tag, url, headerSets) {
  console.log(`\n══════ ${label} ══════`);
  let best = null, master = null;
  for (const [name, H] of headerSets) {
    const r = await get(url, H);
    console.log(`  ${isOk(r) ? '✅' : '❌'} ${name}: HTTP ${r.status} — ${kind(r)}`);
    if (!best && isOk(r)) { best = [name, H]; master = r; }
  }
  if (!best) { console.log('  ⛔ ما نجح أي شكل هيدرز، فالمشكلة قبل الجودات.'); return null; }
  console.log(`  → أكمل بـ: ${best[0]}`);
  const H = best[1];
  const { variants, media } = parseMaster(master.text, url);
  if (!variants.length) variants.push({ bw: 0, res: '', url, name: '(قائمة مباشرة)' });
  console.log(`  جودات=${variants.length}  صوت/ترجمة=${media.length}`);
  const res = [];
  for (const v of variants) {
    const a = await analyze(tag, { ...v }, H);
    console.log(`  ▸ ${v.name} ${v.res} bw=${v.bw}\n      ${a.info || ''}\n      ${a.rate || ''}\n      ${a.verdict}`);
    res.push({ ...a, res: v.res });
  }
  // هل المقاطع تحتاج الهيدرز؟ (نجرّب أول مقطع بدونها)
  const first = variants[variants.length > 1 ? 0 : 0];
  const p = await get(first.url, H);
  if (isOk(p)) {
    const m = parseMedia(p.text, first.url);
    if (m.segs[0]) {
      const s0 = await get(m.segs[0].url, {}, { bin: true });
      console.log(`  المقطع بدون هيدرز: HTTP ${s0.status}  ${s0.status === 200 ? '(المقاطع ما تحتاج الهيدرز)' : '(المقاطع تحتاج نفس الهيدرز!)'}`);
    }
  }
  const au = media.find((x) => x.type === 'AUDIO');
  if (au) {
    const ap = await get(au.url, H);
    const am = isOk(ap) ? parseMedia(ap.text, au.url) : null;
    if (am && am.segs[0]) { const s = await get(am.segs[0].url, H, { bin: true }); console.log(`  الصوت (${au.name}): قائمة ${ap.status} / مقطع HTTP ${s.status} ${s.buf.length}B`); }
    else console.log(`  الصوت (${au.name}): HTTP ${ap.status}`);
  }
  return { best: best[0], res };
}

(async () => {
  try {
    const g = await (await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(8000) })).json();
    console.log(`جهاز الأكشن: ${g.city}, ${g.country} | ${g.org}`);
  } catch { /* */ }
  console.log('ffmpeg:', hasFfmpeg ? 'موجود' : 'غير موجود');
  const host = new URL(URL_).origin;
  const sets = [];
  if (REF) {
    sets.push(['Origin+Referer (ريفرك)', { Origin: origin(REF), Referer: REF }]);
    sets.push(['Origin فقط', { Origin: origin(REF) }]);
    sets.push(['Referer فقط', { Referer: REF }]);
  }
  sets.push(['Origin+Referer = المصدر', { Origin: host, Referer: host + '/' }]);
  sets.push(['بدون هيدرز', {}]);

  const direct = await run('مباشر من الأكشن', 'direct', URL_, sets);
  let viaOut = null;
  if (OUT) viaOut = await run('عبر مسار اللوحة/النفق (رابطك الجديد)', 'out', OUT, [['بدون هيدرز (الريلاي يتكفل)', {}]]);

  console.log('\n══════ الخلاصة ══════');
  if (!direct) console.log('❌ المصدر ما يرد للأكشن بأي شكل هيدرز → حجب IP/توكن. (جرّب Test Hop)');
  else {
    console.log(`✅ المصدر يرد للأكشن (الهيدرز الناجح: ${direct.best})`);
    for (const r of direct.res) console.log(`   ${r.name} ${r.res || ''}: ${r.verdict}`);
    const live = direct.res.filter((r) => /🎬/.test(r.verdict)), slate = direct.res.filter((r) => /🖼️/.test(r.verdict));
    if (live.length && slate.length) console.log(`⚠️ المصدر يعطي جودات متحرك وجودات ثابتة. الكود لازم يختار من: ${live.map((r) => r.res || r.name).join(' ، ')}`);
    else if (!live.length && slate.length) console.log('⚠️ كل الجودات ثابتة → المصدر ما بدأ البث الحقيقي (شاشة انتظار) — مو مشكلة اتصال.');
    else if (live.length) console.log('🎬 كل الجودات متحركة → المصدر يشتغل تمام من الأكشن.');
  }
  if (viaOut) {
    console.log(`\nمسار اللوحة: جودات=${viaOut.res.length}`);
    for (const r of viaOut.res) console.log(`   ${r.name} ${r.res || ''}: ${r.verdict}`);
    if (direct && viaOut.res.length < direct.res.length) console.log(`⚠️ المسار يقدّم ${viaOut.res.length} جودة بس من ${direct.res.length} — الريلاي يقصّ الجودات (راجع منطق الاختيار).`);
  }
  console.log('\nاللقطات محفوظة في artifact اسمه frames (من صفحة التشغيل، تحت Artifacts).');
})();
