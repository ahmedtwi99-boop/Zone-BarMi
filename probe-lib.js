'use strict';
// مكتبة فحص رابط HLS: هل اللي يرجع بث حقيقي ولا شاشة انتظار ثابتة؟
// تُستخدم من App Lab (فحص من نفس جهاز الأكشن اللي التقط الرابط). ما تعتمد على أي مكتبة خارجية (ffmpeg اختياري للقطات).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const hasFfmpeg = () => spawnSync('ffmpeg', ['-version']).status === 0;

async function get(url, headers = {}, { bin = false, ms = 20000 } = {}) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, buf, text: bin ? '' : buf.toString('utf8') };
  } catch (e) { return { status: 0, buf: Buffer.alloc(0), text: '', err: String(e.message || e) }; }
}
const isM3u8 = (r) => r.status === 200 && /^#EXTM3U/.test(r.text.trim());
const snip = (r) => (r.status === 0 ? 'خطأ اتصال: ' + (r.err || '') : r.text.replace(/\s+/g, ' ').slice(0, 80));

function parseMaster(text, base) {
  const L = text.split(/\r?\n/), variants = [];
  for (let i = 0; i < L.length; i++) {
    if (!L[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const bw = +((L[i].match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
    const res = (L[i].match(/RESOLUTION=([\dx]+)/) || [])[1] || '';
    let j = i + 1; while (j < L.length && (!L[j].trim() || L[j].startsWith('#'))) j++;
    if (L[j]) variants.push({ bw, res, url: new URL(L[j].trim(), base).href, name: L[j].trim().split('?')[0].split('/').pop() });
  }
  return variants;
}
function parseMedia(text, base) {
  const segs = []; let dur = 0;
  for (const l of text.split(/\r?\n/)) {
    if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith('#')) { segs.push({ dur, url: new URL(l.trim(), base).href }); dur = 0; }
  }
  return { segs, tdur: (text.match(/#EXT-X-TARGETDURATION:(\d+)/) || [])[1] };
}
function tinyFrame(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=32:18,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  return r.status === 0 && r.stdout.length === 32 * 18 ? r.stdout : null;
}
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

async function analyzeVariant(v, H, dir, tag, ff) {
  const o = { name: v.name, res: v.res, verdict: 'error', note: '' };
  const pl = await get(v.url, H);
  if (!isM3u8(pl)) { o.note = `القائمة HTTP ${pl.status} ${snip(pl)}`; return o; }
  const m = parseMedia(pl.text, v.url);
  if (m.segs.length < 2) { o.note = 'القائمة فاضية'; return o; }
  const pick = [m.segs[0], m.segs[m.segs.length - 2]], fr = [];
  let bytes0 = 0;
  for (let i = 0; i < 2; i++) {
    const s = await get(pick[i].url, H, { bin: true });
    if (s.status !== 200 || !s.buf.length) { o.note = `المقطع HTTP ${s.status} ${s.err || ''}`; return o; }
    if (i === 0) bytes0 = s.buf.length;
    if (ff) {
      const f = path.join(dir, `${tag}_${v.name.replace(/\W+/g, '_')}_${i}.ts`);
      fs.writeFileSync(f, s.buf); fr.push(tinyFrame(f)); try { fs.unlinkSync(f); } catch (_e) { /* */ }
    }
  }
  const dur = pick[0].dur || +m.tdur || 2;
  const kbps = Math.round(bytes0 * 8 / dur / 1000);
  o.note = `مقاطع=${m.segs.length} | ${kbps}kbps${v.bw ? ` من ${Math.round(v.bw / 1000)}` : ''}`;
  if (fr[0] && fr[1]) { const d = diff(fr[0], fr[1]); o.verdict = d < 3 ? 'slate' : 'live'; o.note += ` | فرق اللقطات ${d.toFixed(1)}`; }
  else { o.verdict = 'unknown'; o.note += ff ? ' | ما قدرت أفك لقطة' : ' | ما فيه ffmpeg'; }
  return o;
}

// يفحص الماستر وكل جودة: النتيجة summary: live | slate | mixed | unknown | error
async function analyzeUrl(url, H = {}, { dir = '/tmp', tag = 'p', maxVariants = 6 } = {}) {
  const out = { status: 0, variants: [], summary: 'error', lines: [] };
  const r = await get(url, H);
  out.status = r.status;
  if (!isM3u8(r)) { out.lines.push(`❌ الماستر: HTTP ${r.status} — ${snip(r)}`); return out; }
  let vs = parseMaster(r.text, url);
  if (!vs.length) vs = [{ bw: 0, res: '', url, name: '(قائمة مباشرة)' }];
  out.lines.push(`✅ الماستر وصل: ${vs.length} جودة`);
  const ff = hasFfmpeg();
  for (const v of vs.slice(0, maxVariants)) {
    const a = await analyzeVariant(v, H, dir, tag, ff);
    out.variants.push(a);
    const mark = a.verdict === 'live' ? '🎬 بث حقيقي' : a.verdict === 'slate' ? '🖼️ شاشة ثابتة' : a.verdict === 'unknown' ? '❓' : '❌';
    out.lines.push(`  ${a.name} ${a.res}: ${mark} — ${a.note}`);
  }
  const k = out.variants.map((x) => x.verdict);
  out.summary = k.every((x) => x === 'live') ? 'live' : k.every((x) => x === 'slate') ? 'slate' : k.includes('live') && k.includes('slate') ? 'mixed' : k.includes('unknown') && !k.includes('error') ? 'unknown' : k.includes('live') ? 'mixed' : 'error';
  return out;
}

module.exports = { analyzeUrl, get, parseMaster, parseMedia, UA };
