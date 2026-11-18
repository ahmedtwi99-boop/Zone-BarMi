'use strict';
/**
 * مهمتين جديدتين داخل قسم التسجيل (كلهم يرسلون النتيجة لتيليجرام تلقائيًا):
 *
 *  1) تسجيل كل الجودات (mq): رابط master.m3u8 واحد → ffmpeg واحد يقرأ المصدر مرة وحدة ويكتب
 *     ملف مقاطع لكل جودة (نسخ مباشر بدون إعادة ترميز). عند الإيقاف يدمج كل جودة لحالها
 *     ويرسلها فيديو (مقسّم لو كبير) لتيليجرام، جودة بعد جودة (عشان القرص ما يمتلي).
 *
 *  2) تحميل وإرسال (fs): رابط لفيديو مسجّل (mp4 مباشر / m3u8 / صفحة archive.org) → تحميل → إرسال.
 *
 * ما يلمس مسار التسجيل العادي إطلاقًا.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const tg = require('./telegram-send');

const jobs = new Map();
let D = null; // الاعتماديات من server.js

const ACTIVE = ['recording', 'stopping', 'downloading', 'processing'];
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_FREE_BYTES = (parseInt(process.env.MQ_MIN_FREE_MB, 10) || 1200) * 1024 * 1024;
const STALL_MS = parseInt(process.env.DL_STALL_MS, 10) || 60000; // لو المصدر وقف يرسل بيانات هالمدة نقطع ونعيد المحاولة
const CHAT_RE = /^(-?\d{5,20}|@[A-Za-z0-9_]{4,64})$/;

/** اسم للعرض (يبقى بمسافاته)، مو اسم ملف: نشيل الرموز الخطرة ونقصّه */
function displayName(raw, fallback) {
  const t = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return t || fallback;
}
const escHtml = (t) => String(t == null ? '' : t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** عدد المهام الشغالة من نوع معيّن. الافتراضي 'mq' (تسجيل كل الجودات) لأن server.js يضيفه لحد التسجيلات.
 *  مهام "تحميل وإرسال" (fs) تسجيل؟ لا — لها حد مستقل MAX_DOWNLOAD_JOBS وما تأثر على التسجيلات. */
function busyCount(kind = 'mq') {
  let n = 0;
  for (const j of jobs.values()) if (j.kind === kind && ACTIVE.includes(j.status)) n++;
  return n;
}
const MAX_DOWNLOAD_JOBS = parseInt(process.env.MAX_DOWNLOAD_JOBS, 10) || 3;

// ------------------------------------------------------------------ أدوات

function newJob(kind, name, extra = {}) {
  const id = D.uuidv4();
  const job = {
    id, kind, name, status: kind === 'mq' ? 'recording' : 'downloading',
    createdAt: Date.now(), startedAt: Date.now(), finishedAt: null,
    error: null, items: [], note: '',
    dir: path.join(D.TEMP_DIR, `job_${id}`),
    procs: new Set(), reqs: new Set(), aborts: new Set(),
    cancelled: false, ...extra,
  };
  fs.mkdirSync(job.dir, { recursive: true });
  jobs.set(id, job);
  return job;
}

function serialize(j) {
  return {
    id: j.id, kind: j.kind, name: j.name, status: j.status, error: j.error, note: j.note,
    startedAt: j.startedAt, finishedAt: j.finishedAt, stoppedAt: j.stoppedAt || null,
    items: j.items.map((i) => ({
      label: i.label, status: i.status, detail: i.detail || '', sizeBytes: i.sizeBytes || 0, summary: i.summary || '',
    })),
    events: (j.events || []).slice(-8),
  };
}

function finish(j, status, error) {
  if (j.finishedAt) return;
  j.status = status;
  j.error = error || null;
  j.finishedAt = Date.now();
  try { fs.rmSync(j.dir, { recursive: true, force: true }); } catch (_) {}
  setTimeout(() => jobs.delete(j.id), 30 * 60 * 1000).unref();
}

function killAll(j) {
  for (const p of j.procs) { try { p.kill('SIGKILL'); } catch (_) {} }
  for (const r of j.reqs) { try { r.destroy(new Error('أُلغي')); } catch (_) {} }
  for (const a of j.aborts) { try { a.abort(); } catch (_) {} }
}

function runFfmpeg(j, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    j.procs.add(p);
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    p.stdout.on('data', (d) => { if (onStdout) onStdout(d.toString()); });
    p.on('error', (e) => { j.procs.delete(p); reject(e); });
    p.on('close', (code) => {
      j.procs.delete(p);
      if (j.cancelled) return reject(new Error('أُلغي'));
      code === 0 ? resolve() : reject(new Error(`ffmpeg فشل (code ${code}): ${err.slice(-300)}`));
    });
  });
}

function sendOpts(j, title, chatId, item) {
  return {
    title, chatId,
    workDir: path.join(j.dir, 'tgparts'),
    onReq: (r) => { j.reqs.add(r); r.once('close', () => j.reqs.delete(r)); },
    isCancelled: () => j.cancelled,
    onProgress: ({ part, parts, sent, total }) => {
      item.detail = `جزء ${part}/${parts} — ${total ? Math.floor((sent / total) * 100) : 0}%`;
    },
  };
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch (_) { return Infinity; }
}

function dirSize(dir) {
  let t = 0;
  try { for (const f of fs.readdirSync(dir)) { try { t += fs.statSync(path.join(dir, f)).size; } catch (_) {} } } catch (_) {}
  return t;
}

function qualityLabel(v, k, all) {
  let l = v.height ? `${v.height}p` : `جودة${k + 1}`;
  const dup = all.filter((x) => x.height === v.height).length > 1;
  if (dup && v.bandwidth) l += `-${Math.round(v.bandwidth / 1000)}k`;
  return l;
}

// ------------------------------------------------------------------ 1) تسجيل كل الجودات
// كل جودة لها عملية ffmpeg مستقلة تمامًا: لو وحدة تعلّقت أو وقفت ما تأثر على الباقي. تنراقب وتنعاد تلقائيًا،
// وكل الأحداث (توقفت/رجعت/انتهت) تنكتب برسالة وحدة بالبوت تتعدّل مكانها بصمت. عند إيقافك تنرسل كل جودة
// مع مدتها وأوقات الانقطاع.

const REC_STALL_WARN_MS = parseInt(process.env.MQ_STALL_WARN_MS, 10) || 45000;   // ما وصل بيانات → نبلغ إنها توقفت
const REC_STALL_KILL_MS = parseInt(process.env.MQ_STALL_KILL_MS, 10) || 120000;  // وما رجعت → نعيد تشغيل ffmpeg لها
const MQ_MAX_RESTARTS = parseInt(process.env.MQ_MAX_RESTARTS, 10) || 60;
const RESTART_DELAYS = [3, 5, 10, 20, 30];
const TG_API_BASE = () => process.env.TG_STATUS_API || 'https://api.telegram.org';

const hms = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};
const clockOf = (t) => { try { return new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } };
const secsTxt = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}د ${s % 60}ث` : `${s}ث`; };

function treeSize(dir) {
  let t = 0;
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) t += treeSize(p);
      else { try { t += fs.statSync(p).size; } catch (_) {} }
    }
  } catch (_) {}
  return t;
}

function probeDuration(file) {
  return new Promise((resolve) => {
    let o = '';
    let p;
    try { p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { return resolve(0); }
    p.stdout.on('data', (d) => { o += d; });
    p.on('error', () => resolve(0));
    p.on('close', () => resolve(parseFloat(o) || 0));
  });
}

// ---- رسالة حالة وحدة بالبوت (تتعدّل بصمت، ما تزعج) ----
async function tgApi(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const r = await fetch(`${TG_API_BASE()}/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    return await r.json().catch(() => null);
  } catch (_) { return null; }
}

function statusText(job) {
  const now = Date.now();
  const end = job.stoppedAt || job.finishedAt || now;
  const head = job.status === 'recording' ? `🔴 يسجّل — ${hms(now - job.startedAt)}`
    : job.status === 'stopping' ? `⏳ أوقفت — أجهّز الملفات (${hms(end - job.startedAt)})`
    : job.status === 'processing' ? `📤 أدمج وأرسل (مدة التسجيل ${hms(end - job.startedAt)})`
    : job.status === 'done' ? `✅ اكتمل (مدة التسجيل ${hms(end - job.startedAt)})`
    : job.status === 'error' ? '❌ فشل' : `${job.status}`;
  const icon = { recording: '🟢', stalled: '🟡', restarting: '🔄', ended: '🏁', failed: '🔴', queued: '⏳', merging: '🔧', sending: '📤', sent: '✅', empty: '⚪' };
  const lines = job.items.map((it) => {
    if (it.summary) return `${icon[it.status] || '•'} ${escHtml(it.summary)}`;
    return `${icon[it.status] || '•'} ${escHtml(it.label)}${it.detail ? ' — ' + escHtml(it.detail) : ''}`;
  });
  const ev = job.events.slice(-8).map((e) => escHtml(e));
  return `🎛 <b>${escHtml(job.name)}</b>\n${head}\n\n${lines.join('\n')}${ev.length ? '\n\n' + ev.join('\n') : ''}`.slice(0, 3900);
}

function touchStatus(job) { job.dirty = true; }
async function flushStatus(job, force) {
  if (!force && !job.dirty) return;
  job.dirty = false;
  const text = statusText(job);
  if (text === job.lastText) return;
  job.lastText = text;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!chat) return;
  if (!job.statusMsgId) {
    const r = await tgApi('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_notification: true });
    if (r && r.ok) job.statusMsgId = r.result.message_id;
  } else {
    await tgApi('editMessageText', { chat_id: chat, message_id: job.statusMsgId, text, parse_mode: 'HTML' });
  }
}

function evt(job, it, text) {
  const t = Date.now();
  job.events.push(`[${hms(t - job.startedAt)} · ${clockOf(t)}] ${it.label} ${text}`);
  touchStatus(job);
}
function markDown(job, it, st, why) {
  if (!it.downSince) { it.downSince = Date.now(); evt(job, it, `🟡 ${why}`); }
  it.status = st;
  touchStatus(job);
}
function markUp(job, it) {
  if (it.status !== 'stalled' && it.status !== 'restarting') return;
  const now = Date.now();
  const g = { from: it.downSince - job.startedAt, to: now - job.startedAt };
  it.gaps.push(g);
  it.downMs += now - it.downSince;
  it.downSince = 0;
  it.status = 'recording'; it.detail = '';
  evt(job, it, `🟢 رجعت (بعد ${secsTxt(g.to - g.from)})`);
}

function buildQArgs(masterUrl, outPattern, aIdx, hasSeparateAudio) {
  return ['-y', '-hide_banner', '-loglevel', 'warning',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-thread_queue_size', '2048', '-i', masterUrl,
    '-map', '0:v:0', '-map', hasSeparateAudio ? `0:a:${aIdx}?` : '0:a:0?',
    '-c', 'copy',
    '-f', 'segment', '-segment_time', String(D.SEGMENT_SECONDS),
    '-segment_format', 'mp4', '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof',   // مقاطع مجزّأة: لو انقطعت العملية فجأة يبقى المقطع صالح
    '-reset_timestamps', '1', outPattern];
}

/** يشغّل (أو يعيد تشغيل) ffmpeg لجودة وحدة بمجلد تشغيل جديد r001, r002... */
function startQ(job, it) {
  if (job.status !== 'recording' || job.cancelled) return;
  it.restartTimer = null;
  it.run += 1;
  const dir = path.join(it.dir, `r${String(it.run).padStart(3, '0')}`);
  fs.mkdirSync(dir, { recursive: true });
  const proc = spawn('ffmpeg', buildQArgs(it.masterUrl, path.join(dir, 'part_%05d.mp4'), job.audioIdx, job.hasSeparateAudio), { stdio: ['pipe', 'ignore', 'pipe'] });
  it.proc = proc;
  job.procs.add(proc);
  it.lastGrowthAt = Date.now();
  let errTail = '';
  proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-1500); });
  proc.on('error', (e) => { errTail += ` spawn: ${e.message}`; });
  proc.on('close', (code) => {
    job.procs.delete(proc);
    if (it.proc === proc) it.proc = null;
    if (job.cancelled) return;
    if (job.status !== 'recording') return mqMaybeFinalize(job);       // إيقاف مننا
    if (it.killedByWatchdog) { it.killedByWatchdog = false; return scheduleRestart(job, it, 'ما رجعت البيانات فأعدت تشغيلها'); }
    // ffmpeg يطلع بـ code 0 حتى لو المصدر انقطع فجأة، فما نصدّق إنه "انتهى" إلا لو القائمة فيها ENDLIST فعلًا
    const reason = `وقفت (code ${code})${errTail ? ': ' + errTail.replace(/\s+/g, ' ').slice(-120) : ''}`;
    D.hlsLib.fetchText(it.uri).then(({ text }) => /#EXT-X-ENDLIST/.test(text), () => false).then((ended) => {
      if (job.status !== 'recording' || job.cancelled) return mqMaybeFinalize(job);
      if (ended) {
        it.status = 'ended'; it.endedAt = Date.now() - job.startedAt; it.detail = 'انتهت من المصدر';
        evt(job, it, '🏁 انتهت من المصدر (البث خلص)');
        return mqCheckAllDone(job);
      }
      scheduleRestart(job, it, code === 0 ? 'انقطع المصدر عنها' : reason);
    });
  });
}

function scheduleRestart(job, it, why) {
  if (job.status !== 'recording') return mqMaybeFinalize(job);
  it.restarts += 1;
  if (it.restarts > MQ_MAX_RESTARTS) {
    it.status = 'failed'; it.failedAt = Date.now() - job.startedAt; it.detail = 'فشلت نهائيًا';
    evt(job, it, `🔴 فشلت نهائيًا بعد ${MQ_MAX_RESTARTS} محاولة`);
    return mqCheckAllDone(job);
  }
  markDown(job, it, 'restarting', why);
  it.detail = `تعيد الاتصال (محاولة ${it.restarts})`;
  const delay = RESTART_DELAYS[Math.min(it.restarts - 1, RESTART_DELAYS.length - 1)] * 1000;
  it.restartTimer = setTimeout(() => startQ(job, it), delay);
}

/** كل الجودات خلصت لحالها (المصدر أنهى أو فشلت)؟ نوقف المهمة ونرسل */
function mqCheckAllDone(job) {
  if (job.status !== 'recording') return;
  if (job.items.every((i) => i.status === 'ended' || i.status === 'failed')) {
    D.notifyTelegram(`ℹ️ <b>${escHtml(job.name)}</b>: كل الجودات انتهت من المصدر — أرسل الملفات الحين.`);
    mqStop(job);
  }
}

function mqWatchdog(job) {
  const now = Date.now();
  for (const it of job.items) {
    it.sizeBytes = treeSize(it.dir);
    if (it.sizeBytes > it.lastSize) { it.lastSize = it.sizeBytes; it.lastGrowthAt = now; if (it.proc) markUp(job, it); }
    if (!it.proc) continue;
    const idle = now - it.lastGrowthAt;
    if (it.status === 'recording' && idle > REC_STALL_WARN_MS) { markDown(job, it, 'stalled', `توقفت (ما وصل بيانات من ${secsTxt(idle)})`); it.detail = 'متوقفة'; }
    if (it.status === 'stalled') it.detail = `متوقفة منذ ${secsTxt(now - it.downSince)}`;
    if ((it.status === 'stalled') && idle > REC_STALL_KILL_MS) { it.killedByWatchdog = true; const pp = it.proc; try { pp.kill('SIGINT'); } catch (_) {} setTimeout(() => { if (pp.exitCode === null) try { pp.kill('SIGKILL'); } catch (_) {} }, 8000).unref(); }
  }
  if (job.status === 'recording' && freeBytes(job.dir) < MIN_FREE_BYTES) {
    job.note = 'المساحة قاربت تخلص — أوقفت التسجيل وأرسل المسجّل';
    D.notifyTelegram(`⚠️ <b>${escHtml(job.name)}</b>: المساحة قاربت تخلص، أوقفت التسجيل وبدأت الإرسال.`);
    mqStop(job);
  }
}

const SRC_PATH_RE = /^\/(live|d|mh|relay|u|uh|m|p)(\/|$)/;

/** يحدد رابط المصدر: مسار تمرير محلي أو رابط خارجي */
function resolveSrc(p) {
  if (p.path) {
    const sp = String(p.path);
    if (!SRC_PATH_RE.test(sp) || sp.includes('..') || /\s/.test(sp)) throw new Error('مسار التمرير غير صالح');
    return `http://127.0.0.1:${D.PORT}${sp}`;
  }
  const url = String(p.url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('رابط master لازم يبدأ بـ http:// أو https://');
  return url;
}

async function inspectSrc(p) {
  const srcUrl = resolveSrc(p);
  const { text, finalUrl } = await D.hlsLib.fetchText(srcUrl);
  return { srcUrl, info: D.hlsLib.parseMaster(text, finalUrl) };
}

async function mqStart(req, res) {
  const b = req.body || {};
  const fail = (status, error) => res.status(status).json({ error });
  if (!tg.isConfigured()) return fail(400, 'إعدادات إرسال تيليجرام ناقصة (التوكن أو رقم القناة/المحادثة)');
  const chatId = String(b.chatId || '').trim();
  if (chatId && !CHAT_RE.test(chatId)) return fail(400, 'رقم القناة/المحادثة غير صالح');
  if (D.countBusyRecordings() >= D.MAX_CONCURRENT_RECORDINGS) {
    return fail(409, `فيه ${D.MAX_CONCURRENT_RECORDINGS} تسجيل شغال حاليًا (الحد الأقصى المسموح بنفس الوقت)`);
  }
  let info;
  try { ({ info } = await inspectSrc(b)); } catch (e) { return fail(400, e.message); }
  if (!info.isMaster) return fail(400, 'الرابط مو متعدد الجودات (master) — استخدم التسجيل العادي');

  const wanted = Array.isArray(b.variants) ? b.variants.map(Number).filter(Number.isInteger) : [];
  const chosen = (wanted.length ? info.variants.filter((v) => wanted.includes(v.idx)) : info.variants.slice())
    .sort((a, c) => c.height - a.height || c.bandwidth - a.bandwidth);
  if (!chosen.length) return fail(400, 'ما اخترت أي جودة صالحة');

  let aIdx = parseInt(b.audio, 10);
  if (!Number.isInteger(aIdx) || !info.audios[aIdx]) aIdx = Math.max(0, info.audios.findIndex((a) => a.default));
  const hasSeparateAudio = info.audios.length > 0;

  const maxMs = (() => {
    const h = parseFloat(b.maxHours);
    return Math.min(Number.isFinite(h) && h > 0 ? h * 3600 * 1000 : D.MAX_RECORDING_MS, D.ABSOLUTE_MAX_RECORDING_MS);
  })();

  const job = newJob('mq', displayName(b.name, `تسجيل ${D.todayStamp()}`), {
    chatId: chatId || null, audioIdx: aIdx, hasSeparateAudio, events: [], dirty: true, lastText: '', statusMsgId: null, stoppedAt: null,
  });
  chosen.forEach((v, k) => {
    // كل جودة لها master مبسّط خاص فيها (جودة وحدة + الصوت) عشان تنفصل عن غيرها تمامًا
    const sub = { variants: [v], audios: info.audios };
    const sid = D.uuidv4();
    D.hlsSessions.set(sid, { id: sid, info: sub, mode: 'all', master: D.hlsLib.buildSimpleMaster(sub, 'all') });
    const dir = path.join(job.dir, `q${k}`);
    fs.mkdirSync(dir, { recursive: true });
    job.items.push({
      k, dir, sid, uri: v.uri, label: qualityLabel(v, k, chosen), status: 'recording', detail: '', sizeBytes: 0,
      masterUrl: `http://127.0.0.1:${D.PORT}/internal/hls/${sid}/master.m3u8`,
      run: 0, restarts: 0, proc: null, restartTimer: null, lastSize: 0, lastGrowthAt: Date.now(),
      downSince: 0, downMs: 0, gaps: [], killedByWatchdog: false, endedAt: null, failedAt: null, durSec: 0, summary: '',
    });
  });

  job.watchTimer = setInterval(() => mqWatchdog(job), 3000);
  job.statusTimer = setInterval(() => flushStatus(job).catch(() => {}), 4000);
  job.maxTimer = setTimeout(() => { if (job.status === 'recording') mqStop(job); }, maxMs);
  job.items.forEach((it) => startQ(job, it));
  flushStatus(job, true).catch(() => {});
  res.json(serialize(job));
}

function mqStopAll() { for (const j of jobs.values()) if (j.kind === 'mq' && j.status === 'recording') mqStop(j); }

/** إيقاف التسجيل بلطف (نفس زر الإيقاف بالموقع): يوقف الوقت وكل ffmpeg ثم يدمج ويرسل */
function mqStop(job) {
  if (job.status !== 'recording') return;
  job.status = 'stopping';
  job.stoppedAt = Date.now();
  clearInterval(job.watchTimer); clearTimeout(job.maxTimer);
  for (const it of job.items) {
    clearTimeout(it.restartTimer); it.restartTimer = null;
    if (it.downSince) {
      it.gaps.push({ from: it.downSince - job.startedAt, to: job.stoppedAt - job.startedAt, open: true });
      it.downMs += job.stoppedAt - it.downSince; it.downSince = 0;
    }
    const p = it.proc;
    if (p && p.exitCode === null) {
      // SIGINT = إيقاف لطيف (ffmpeg يقفل المقطع الأخير بسلامة) ويقطع أي قراءة شبكة معلّقة فورًا، بعكس 'q' اللي ينتظر
      try { p.kill('SIGINT'); } catch (_) {}
      setTimeout(() => { if (p.exitCode === null) try { p.kill('SIGKILL'); } catch (_) {} }, 12000).unref();
    }
  }
  touchStatus(job);
  mqMaybeFinalize(job);
}

function mqMaybeFinalize(job) {
  if (job.status !== 'stopping' || job.finalizing) return;
  if (job.items.some((i) => i.proc && i.proc.exitCode === null)) return;
  mqFinalize(job).catch((e) => finish(job, 'error', e.message));
}

function listParts(it) {
  const out = [];
  let runs = [];
  try { runs = fs.readdirSync(it.dir).filter((f) => /^r\d+$/.test(f)).sort(); } catch (_) {}
  for (const r of runs) {
    let files = [];
    try { files = fs.readdirSync(path.join(it.dir, r)).filter((f) => /^part_\d+\.mp4$/.test(f)).sort(); } catch (_) {}
    for (const f of files) {
      const p = path.join(it.dir, r, f);
      try { if (fs.statSync(p).size > 0) out.push(p); } catch (_) {}
    }
  }
  return out;
}

function gapsTxt(it) {
  if (!it.gaps.length) return '';
  const list = it.gaps.slice(0, 5).map((g) => `${hms(g.from)}→${hms(g.to)}`).join('، ');
  return `⚠️ انقطعت ${it.gaps.length} ${it.gaps.length === 1 ? 'مرة' : 'مرات'} (مجموع ${secsTxt(it.downMs)}): ${list}${it.gaps.length > 5 ? '…' : ''}`;
}

async function mqFinalize(job) {
  if (job.finalizing) return;
  job.finalizing = true;
  job.status = 'processing';
  job.items.forEach((it) => { it.sizeBytes = treeSize(it.dir); if (it.status === 'recording' || it.status === 'stalled' || it.status === 'restarting') { it.endNote = ''; } it.prev = it.status; it.status = 'queued'; it.detail = ''; });
  for (const it of job.items) D.hlsSessions.delete(it.sid);
  touchStatus(job);
  await flushStatus(job, true).catch(() => {});

  const totalMs = job.stoppedAt - job.startedAt;
  let ok = 0;
  const failed = [];
  for (const it of job.items) {
    if (job.cancelled) return;
    let parts = listParts(it);
    const good = [];
    let bad = 0;
    for (const p of parts) { if (await probeDuration(p) > 0) good.push(p); else bad++; }
    parts = good;
    if (bad) job.events.push(`${it.label}: تجاهلت ${bad} مقطع تالف`);
    if (!parts.length) { it.status = 'empty'; it.detail = 'ما فيه بيانات'; it.summary = `${it.label}: ما سجّلت شي ❌${it.prev === 'failed' ? ' (فشلت)' : ''}`; touchStatus(job); continue; }
    const finalFile = path.join(job.dir, `final_${it.k}.mp4`);
    try {
      it.status = 'merging'; it.detail = 'دمج المقاطع'; touchStatus(job);
      const listFile = path.join(it.dir, 'concat.txt');
      fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
      await runFfmpeg(job, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
        '-i', listFile, '-c', 'copy', '-movflags', '+faststart', finalFile]);
      parts.forEach((p) => fs.rmSync(p, { force: true }));
      it.sizeBytes = fs.statSync(finalFile).size;
      it.durSec = await probeDuration(finalFile);
      const durTxt = hms(it.durSec * 1000);
      const sizeMB = Math.round(it.sizeBytes / 1048576);
      const extra = [];
      if (it.prev === 'ended' || it.status === 'ended') extra.push(`🏁 انتهت من المصدر عند ${hms(it.endedAt || 0)}`);
      if (it.prev === 'failed') extra.push(`🔴 فشلت نهائيًا عند ${hms(it.failedAt || 0)}`);
      const g = gapsTxt(it); if (g) extra.push(g);

      it.status = 'sending'; it.detail = ''; touchStatus(job);
      await tg.sendVideoFile(finalFile, sendOpts(job, `${job.name} — ${it.label} (${durTxt})${it.gaps.length ? ' ⚠️ فيها انقطاع' : ''}`, job.chatId, it));
      it.status = 'sent'; it.detail = 'تم الإرسال ✅';
      it.summary = `${it.label}: ${durTxt} · ${sizeMB}MB${extra.length ? '\n   ' + extra.join('\n   ') : ''}`;
      ok++;
    } catch (e) {
      if (job.cancelled) return;
      it.status = 'failed'; it.detail = e.message.slice(0, 200);
      it.summary = `${it.label}: فشل الإرسال ❌ ${e.message.slice(0, 100)}`;
      failed.push(`${it.label}: ${e.message.slice(0, 120)}`);
    } finally {
      fs.rmSync(finalFile, { force: true });
      fs.rmSync(it.dir, { recursive: true, force: true });
      touchStatus(job);
    }
  }

  clearInterval(job.statusTimer);
  const okAll = !failed.length;
  job.status = okAll ? 'done' : (ok ? 'done' : 'error');
  job.events.push(`مدة التسجيل من الضغط على ابدأ إلى الإيقاف: ${hms(totalMs)}`);
  await flushStatus(job, true).catch(() => {});
  if (failed.length) D.notifyTelegram(`❌ <b>${escHtml(job.name)}</b>: أُرسل ${ok}، وفشل ${failed.length}\n${failed.map(escHtml).join('\n')}`);
  finish(job, job.status, failed.length ? `فشل: ${failed.join(' | ')}`.slice(0, 400) : null);
}


// ------------------------------------------------------------------ 2) تحميل وإرسال

const VIDEO_EXT = /\.(mp4|mkv|mov|webm|ts|m4v|avi|flv)$/i;

/** يحوّل الرابط لقائمة ملفات للتحميل: صفحة archive.org تنفتح لكل ملفاتها بالترتيب */
async function resolveSources(url) {
  const m = url.match(/^https?:\/\/(?:www\.)?archive\.org\/(?:details|download)\/([^/?#]+)\/?(?:[?#].*)?$/i);
  if (!m) return [{ url, label: decodeURIComponent((url.split('?')[0].split('/').pop() || 'video')).slice(0, 60) }];

  const id = m[1];
  const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`تعذّر قراءة بيانات archive.org (${r.status})`);
  const meta = await r.json();
  let files = (meta.files || []).filter((f) => VIDEO_EXT.test(f.name || ''));
  const originals = files.filter((f) => f.source === 'original');
  if (originals.length) files = originals;
  if (!files.length) throw new Error('ما لقيت ملفات فيديو بهذا العنصر في archive.org');
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return files.map((f) => ({
    url: `https://archive.org/download/${encodeURIComponent(id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
    label: f.name,
  }));
}

/** تحميل HTTP عادي مع استئناف تلقائي (Range) عند الانقطاع */
async function downloadHttp(j, url, dest, headers, item) {
  let have = 0;
  let attempts = 0;
  for (;;) {
    if (j.cancelled) throw new Error('أُلغي');
    const ac = new AbortController();
    j.aborts.add(ac);
    let lastData = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > STALL_MS) ac.abort(new Error('المصدر وقف يرسل بيانات'));
    }, Math.min(5000, Math.max(500, Math.floor(STALL_MS / 4))));
    try {
      const h = { 'User-Agent': UA, ...headers };
      if (have > 0) h.Range = `bytes=${have}-`;
      const r = await fetch(url, { headers: h, redirect: 'follow', signal: ac.signal });
      if (have > 0 && r.status !== 206) have = 0; // السيرفر تجاهل Range، نبدأ من جديد
      if (!r.ok) {
        const e = new Error(`المصدر رجّع ${r.status}`);
        if (r.status >= 400 && r.status < 500 && r.status !== 429) e.fatal = true;
        throw e;
      }
      if (/text\/html/i.test(r.headers.get('content-type') || '')) {
        throw Object.assign(new Error('الرابط يرجّع صفحة ويب مو فيديو'), { fatal: true });
      }
      const len = parseInt(r.headers.get('content-length'), 10) || 0;
      const total = r.status === 206 ? have + len : len;
      let got = have;
      const rs = Readable.fromWeb(r.body);
      rs.on('data', (c) => {
        lastData = Date.now();
        got += c.length;
        item.sizeBytes = got;
        item.detail = total ? `تحميل ${Math.floor((got / total) * 100)}%` : `تحميل ${(got / 1048576).toFixed(0)}MB`;
      });
      await pipeline(rs, fs.createWriteStream(dest, { flags: have > 0 ? 'a' : 'w' }));
      if (total && fs.statSync(dest).size < total) throw new Error('انقطع التحميل');
      return;
    } catch (e) {
      if (j.cancelled) throw new Error('أُلغي');
      if (e.fatal || ++attempts > 6) throw e;
      try { have = fs.statSync(dest).size; } catch (_) { have = 0; }
      await sleep(3000 * attempts);
    } finally {
      clearInterval(watchdog);
      j.aborts.delete(ac);
    }
  }
}

async function downloadStream(j, url, dest, referer, item) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
  if (referer) args.push('-headers', `Referer: ${referer}\r\n`);
  args.push('-rw_timeout', String(Math.max(10, Math.floor(STALL_MS / 1000)) * 1000000),
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', url, '-c', 'copy', '-movflags', '+faststart', dest);
  await runFfmpeg(j, args, {
    onStdout: (t) => {
      const m = t.match(/total_size=(\d+)/g);
      if (m) {
        const sz = parseInt(m[m.length - 1].split('=')[1], 10) || 0;
        item.sizeBytes = sz;
        item.detail = `تحميل ${(sz / 1048576).toFixed(0)}MB`;
      }
    },
  });
}

async function fsStart(req, res) {
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return res.status(400).json({ error: 'الرابط لازم يبدأ بـ http:// أو https://' });
  if (!tg.isConfigured()) return res.status(400).json({ error: 'إعدادات إرسال تيليجرام ناقصة (التوكن أو رقم القناة/المحادثة)' });
  const chatId = String(req.body.chatId || '').trim();
  if (chatId && !CHAT_RE.test(chatId)) return res.status(400).json({ error: 'رقم القناة/المحادثة غير صالح' });
  const referer = String(req.body.referer || '').trim();
  if (referer && !/^https?:\/\/\S+$/i.test(referer)) return res.status(400).json({ error: 'Referer غير صالح' });
  if (busyCount('fs') >= MAX_DOWNLOAD_JOBS) {
    return res.status(409).json({ error: `فيه ${MAX_DOWNLOAD_JOBS} مهام تحميل شغالة حاليًا (الحد الأقصى)، ألغِ مهمة أو انتظر تخلص` });
  }

  let sources;
  try { sources = await resolveSources(url); } catch (e) { return res.status(400).json({ error: e.message }); }

  const name = displayName(req.body.name, sources[0].label.replace(/\.[^.]+$/, '') || 'video');
  const job = newJob('fs', name, { chatId: chatId || null });
  sources.forEach((s, n) => job.items.push({ n, url: s.url, label: sources.length > 1 ? `${n + 1}/${sources.length} — ${s.label}` : s.label, status: 'queued', detail: '', sizeBytes: 0 }));
  D.notifyTelegram(`⬇️ بدأ التحميل والإرسال: <b>${escHtml(job.name)}</b> (${sources.length} ملف)`);

  fsRun(job, referer).catch((e) => finish(job, job.cancelled ? 'cancelled' : 'error', e.message));
  res.json(serialize(job));
}

async function fsRun(job, referer) {
  const failed = [];
  let ok = 0;
  for (const it of job.items) {
    if (job.cancelled) throw new Error('أُلغي');
    const isStream = /\.(m3u8|mpd)(\?|#|$)/i.test(it.url);
    const ext = isStream ? '.mp4' : ((it.url.split('?')[0].match(/\.[A-Za-z0-9]{2,4}$/) || ['.mp4'])[0]);
    const raw = path.join(job.dir, `src_${it.n}${ext}`);
    let mp4 = raw;
    try {
      it.status = 'downloading';
      if (isStream) await downloadStream(job, it.url, raw, referer, it);
      else await downloadHttp(job, it.url, raw, referer ? { Referer: referer } : {}, it);

      const info = await tg.probe(raw);
      if (!info.hasVideo) throw new Error('الملف المحمّل مو فيديو صالح');
      if (!/\.mp4$/i.test(raw)) {
        it.detail = 'تحويل الحاوية لـ mp4';
        mp4 = path.join(job.dir, `src_${it.n}.mp4`);
        await runFfmpeg(job, ['-y', '-hide_banner', '-loglevel', 'error', '-i', raw,
          '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', mp4]);
        fs.rmSync(raw, { force: true });
      }
      it.sizeBytes = fs.statSync(mp4).size;
      it.status = 'sending'; it.detail = '';
      job.status = 'processing';
      const title = job.items.length > 1 ? `${job.name} (${it.n + 1}/${job.items.length})` : job.name;
      await tg.sendVideoFile(mp4, sendOpts(job, title, job.chatId, it));
      it.status = 'sent'; it.detail = 'تم الإرسال ✅';
      ok++;
    } catch (e) {
      if (job.cancelled) throw new Error('أُلغي');
      it.status = 'failed'; it.detail = e.message.slice(0, 200);
      failed.push(`${it.label}: ${e.message.slice(0, 120)}`);
    } finally {
      fs.rmSync(raw, { force: true });
      fs.rmSync(mp4, { force: true });
      if (job.status === 'processing') job.status = 'downloading';
    }
  }
  if (failed.length) {
    D.notifyTelegram(`❌ <b>${escHtml(job.name)}</b>: أُرسل ${ok}، وفشل ${failed.length}\n${failed.join('\n')}`);
    finish(job, ok ? 'done' : 'error', `فشل: ${failed.join(' | ')}`.slice(0, 400));
  } else {
    D.notifyTelegram(`✅ اكتمل إرسال: <b>${escHtml(job.name)}</b>`);
    finish(job, 'done');
  }
}

// ------------------------------------------------------------------ المسارات

function register(app, deps) {
  D = deps;
  const auth = D.requireApiKey;

  app.get('/api/tg/status', auth, (req, res) => res.json(tg.publicStatus()));
  // فحص جودات رابط أو مسار تمرير (نفس /api/hls/inspect لكن يقبل مسار محلي)
  app.post('/api/mq/inspect', auth, async (req, res) => {
    try {
      const { info } = await inspectSrc(req.body || {});
      res.json({
        isMaster: info.isMaster,
        variants: info.variants.map((v) => ({ idx: v.idx, resolution: v.resolution, height: v.height, bandwidth: v.bandwidth, audio: v.audio })),
        audios: info.audios.map((a) => ({ idx: a.idx, group: a.group, name: a.name, lang: a.lang, default: a.default })),
      });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/mq/start', auth, (req, res) => mqStart(req, res).catch((e) => res.status(500).json({ error: e.message })));
  app.post('/api/fs/start', auth, (req, res) => fsStart(req, res).catch((e) => res.status(500).json({ error: e.message })));
  app.get('/api/jobs/active', auth, (req, res) => res.json({ jobs: [...jobs.values()].map(serialize) }));

  // إيقاف: mq شغّال → يوقف ويرسل المسجّل | غير كذا → إلغاء كامل
  app.post('/api/jobs/stop', auth, (req, res) => {
    const j = jobs.get(String(req.body.id || ''));
    if (!j) return res.status(404).json({ error: 'المهمة غير موجودة' });
    if (j.kind === 'mq' && j.status === 'recording') { mqStop(j); return res.json(serialize(j)); }
    if (!ACTIVE.includes(j.status)) return res.json(serialize(j));
    j.cancelled = true;
    killAll(j);
    clearInterval(j.watchTimer); clearInterval(j.statusTimer); clearTimeout(j.maxTimer);
    (j.items || []).forEach((i) => { clearTimeout(i.restartTimer); if (i.sid) D.hlsSessions.delete(i.sid); });
    finish(j, 'cancelled', null);
    D.notifyTelegram(`⛔ أُلغيت المهمة: <b>${escHtml(j.name)}</b>`);
    res.json(serialize(j));
  });

  app.delete('/api/jobs/:id', auth, (req, res) => {
    const j = jobs.get(req.params.id);
    if (j && !ACTIVE.includes(j.status)) jobs.delete(j.id);
    res.json({ ok: true });
  });
}

module.exports = { register, busyCount };
