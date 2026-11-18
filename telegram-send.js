'use strict';
/**
 * إرسال فيديو لتيليجرام (قناة أو محادثة) — بدون أي مكتبات خارجية.
 *
 * - يقسّم الملف الكبير لأجزاء أقل من الحد (نسخ مباشر بدون إعادة ترميز) ويرسل كل جزء كفيديو.
 * - الرفع بـ multipart مبثوث (stream) من القرص، فما يحمّل الملف كله بالذاكرة ولا فيه مهلة قصيرة.
 * - يشتغل مع الخادم الرسمي (حد 50MB للملف) أو مع telegram-bot-api المحلي (حد 2GB للملف).
 *
 * المتغيرات (كلها اختيارية، لو ما انحطت يستخدم إعدادات التنبيهات الحالية):
 *   TG_UPLOAD_TOKEN    توكن بوت الرفع (الافتراضي TELEGRAM_BOT_TOKEN)
 *   TG_UPLOAD_CHAT_ID  القناة/المحادثة الهدف (الافتراضي TELEGRAM_CHAT_ID)
 *   TG_UPLOAD_API      عنوان الـ API (الافتراضي https://api.telegram.org، للمحلي http://127.0.0.1:8081)
 *   TG_UPLOAD_LOCAL    1 لو الخادم محلي (يرفع الحد لـ 2GB) — يُكتشف تلقائيًا لو العنوان localhost
 *   TG_PART_MB         أقصى حجم للجزء بالميجا (الافتراضي 1900 للمحلي، 48 للرسمي)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

function config() {
  const token = (process.env.TG_UPLOAD_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TG_UPLOAD_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '').trim();
  const apiBase = (process.env.TG_UPLOAD_API || 'https://api.telegram.org').trim().replace(/\/+$/, '');
  const isLocal =
    /^(1|true|yes)$/i.test(process.env.TG_UPLOAD_LOCAL || '') ||
    /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(apiBase);
  const partMb = parseFloat(process.env.TG_PART_MB) || (isLocal ? 1900 : 48);
  return { token, chatId, apiBase, isLocal, partBytes: Math.floor(partMb * 1024 * 1024) };
}

function isConfigured() {
  const c = config();
  return !!(c.token && c.chatId);
}

function publicStatus() {
  const c = config();
  return {
    configured: !!(c.token && c.chatId),
    local: c.isLocal,
    partMb: Math.round(c.partBytes / 1024 / 1024),
    hasToken: !!c.token,
    hasChat: !!c.chatId,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scrub = (s, token) => String(s || '').split(token || '\u0000').join('***');

// ------------------------------------------------------------------ ffprobe / ffmpeg

function run(cmd, args, { capture = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { if (capture) out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} فشل (code ${code}): ${err.slice(-300)}`))));
  });
}

/** معلومات الفيديو: المدة والأبعاد (تنفع لتيليجرام عشان يعرض الفيديو بنسبته الصحيحة) */
async function probe(file) {
  try {
    const out = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json', file,
    ]);
    const j = JSON.parse(out);
    const s = (j.streams && j.streams[0]) || {};
    return {
      width: s.width || 0,
      height: s.height || 0,
      duration: Math.round(parseFloat(j.format && j.format.duration) || 0),
      hasVideo: !!(j.streams && j.streams[0]),
    };
  } catch (_) {
    return { width: 0, height: 0, duration: 0, hasVideo: false };
  }
}

/** يقسّم الملف لأجزاء ≤ maxBytes (نسخ مباشر). لو الملف أصغر من الحد يرجّعه كما هو. */
async function splitIfNeeded(file, maxBytes, workDir) {
  const size = fs.statSync(file).size;
  if (size <= maxBytes) return { files: [file], created: false };

  const info = await probe(file);
  if (!info.duration) throw new Error('تعذّر قراءة مدة الفيديو للتقسيم');

  fs.mkdirSync(workDir, { recursive: true });
  // نجرب نسب أصغر لو جزء طلع أكبر من الحد (البت ريت المتغير)
  for (const ratio of [0.9, 0.75, 0.6, 0.45]) {
    const numParts = Math.max(2, Math.ceil(size / (maxBytes * ratio)));
    const chunkSec = Math.max(5, Math.ceil(info.duration / numParts));
    for (const f of fs.readdirSync(workDir)) fs.rmSync(path.join(workDir, f), { force: true });
    await run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', file,
      '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
      '-f', 'segment', '-segment_time', String(chunkSec),
      '-segment_format', 'mp4', '-segment_format_options', 'movflags=+faststart',
      '-reset_timestamps', '1',
      path.join(workDir, 'part_%03d.mp4'),
    ]);
    const files = fs.readdirSync(workDir).filter((f) => /^part_\d+\.mp4$/.test(f)).sort()
      .map((f) => path.join(workDir, f));
    if (files.length && files.every((f) => fs.statSync(f).size <= maxBytes)) return { files, created: true };
  }
  throw new Error('تعذّر تقسيم الفيديو لأجزاء أقل من حد تيليجرام');
}

// ------------------------------------------------------------------ multipart streaming

function postMultipart(urlStr, fields, file, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const boundary = '----zb' + crypto.randomBytes(12).toString('hex');
    const pre = Buffer.concat(
      Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
    );
    const fname = String(file.filename || 'video.mp4').replace(/[^\w.\-]/g, '_');
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${fname}"\r\n` +
      `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const fileSize = fs.statSync(file.path).size;

    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': pre.length + head.length + fileSize + tail.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try { body = JSON.parse(text); } catch (_) {}
          resolve({ status: res.statusCode, body, text });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(0);
    req.on('error', reject);
    if (opts.onReq) opts.onReq(req);

    req.write(pre);
    req.write(head);
    const rs = fs.createReadStream(file.path, { highWaterMark: 1 << 20 });
    let sent = 0;
    rs.on('data', (c) => {
      sent += c.length;
      if (opts.onProgress) opts.onProgress(sent, fileSize);
    });
    rs.on('error', (e) => req.destroy(e));
    rs.on('end', () => req.end(tail));
    rs.pipe(req, { end: false });
  });
}

/** يرسل ملف واحد (فيديو، ولو رفضه تيليجرام كفيديو يرسله كملف). يعيد المحاولة عند أخطاء الشبكة/الضغط. */
async function sendOne(file, { caption, chatId, onProgress, onReq, isCancelled }) {
  const c = config();
  const target = chatId || c.chatId;
  const info = await probe(file);
  const name = path.basename(file);

  const attempt = async (method) => {
    const isVideo = method === 'sendVideo';
    const fields = {
      chat_id: target,
      caption: (caption || '').slice(0, 1000),
      ...(isVideo ? {
        supports_streaming: 'true',
        duration: info.duration || undefined,
        width: info.width || undefined,
        height: info.height || undefined,
      } : {}),
    };
    return postMultipart(
      `${c.apiBase}/bot${c.token}/${method}`,
      fields,
      { field: isVideo ? 'video' : 'document', path: file, filename: name, type: isVideo ? 'video/mp4' : 'application/octet-stream' },
      { onProgress, onReq }
    );
  };

  let method = 'sendVideo';
  let lastErr = null;
  for (let n = 1; n <= 5; n++) {
    if (isCancelled && isCancelled()) throw new Error('أُلغي');
    try {
      const r = await attempt(method);
      if (r.body && r.body.ok) return { messageId: r.body.result && r.body.result.message_id, method };
      const desc = (r.body && r.body.description) || r.text.slice(0, 200) || `HTTP ${r.status}`;
      if (r.status === 429) {
        const wait = ((r.body && r.body.parameters && r.body.parameters.retry_after) || 5) + 1;
        lastErr = new Error(`ضغط من تيليجرام، انتظار ${wait}ث`);
        await sleep(wait * 1000);
        continue;
      }
      if (r.status >= 500) { lastErr = new Error(desc); await sleep(4000 * n); continue; }
      // 4xx: لو رفض الفيديو نجرب كملف مرة وحدة، غير كذا خطأ نهائي (توكن/صلاحيات/حجم...)
      if (method === 'sendVideo' && r.status === 400) { method = 'sendDocument'; lastErr = new Error(desc); continue; }
      throw Object.assign(new Error(desc), { fatal: true });
    } catch (e) {
      if (e.fatal) throw new Error(scrub(e.message, c.token));
      if (isCancelled && isCancelled()) throw new Error('أُلغي');
      lastErr = e;
      await sleep(4000 * n);
    }
  }
  throw new Error('فشل الإرسال لتيليجرام: ' + scrub(lastErr && lastErr.message, c.token));
}

/**
 * يرسل فيديو كامل: يقسّمه لو لزم، يرسل كل جزء، وينضّف الأجزاء المؤقتة (الملف الأصلي ما يُحذف هنا).
 * opts: { title, chatId, workDir, onProgress({part, parts, sent, total}), onReq, isCancelled }
 */
async function sendVideoFile(file, opts = {}) {
  const c = config();
  if (!c.token || !c.chatId) throw new Error('إعدادات تيليجرام ناقصة (TG_UPLOAD_TOKEN / TELEGRAM_BOT_TOKEN و TG_UPLOAD_CHAT_ID / TELEGRAM_CHAT_ID)');
  const workDir = opts.workDir || path.join(path.dirname(file), 'tg_parts_' + crypto.randomBytes(3).toString('hex'));
  const { files, created } = await splitIfNeeded(file, c.partBytes, workDir);
  const results = [];
  try {
    for (let i = 0; i < files.length; i++) {
      if (opts.isCancelled && opts.isCancelled()) throw new Error('أُلغي');
      const caption = (opts.title || path.basename(file)) + (files.length > 1 ? `\nالجزء ${i + 1}/${files.length}` : '');
      const r = await sendOne(files[i], {
        caption,
        chatId: opts.chatId,
        onReq: opts.onReq,
        isCancelled: opts.isCancelled,
        onProgress: (sent, total) => opts.onProgress && opts.onProgress({ part: i + 1, parts: files.length, sent, total }),
      });
      results.push({ part: i + 1, ...r });
      if (created) fs.rmSync(files[i], { force: true });
    }
  } finally {
    if (created) fs.rmSync(workDir, { recursive: true, force: true });
  }
  return { parts: files.length, results };
}

module.exports = { config, isConfigured, publicStatus, probe, splitIfNeeded, sendVideoFile, sendOne };
