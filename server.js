'use strict';
/**
 * مصاريفي — Masareefi server
 * Node.js (no framework) + PostgreSQL.
 * - Accounts: register / login with phone or email + password (scrypt hashed)
 * - Signed tokens (HMAC-SHA256), invalidated on password change
 * - Each user's data is stored separately in user_data (JSONB) with revision control
 * Without DATABASE_URL it falls back to a local JSON file (for development only).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { reportWorkbook } = require('./lib/xlsx');
const MX = require('./public/report-core');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TOKEN_DAYS = 90;
const MAX_BODY = 5 * 1024 * 1024;

let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  SECRET = crypto.createHash('sha256').update('masareefi-dev:' + (process.env.DATABASE_URL || '')).digest('hex');
  console.warn('[warn] JWT_SECRET is not set — using a derived development secret. Set JWT_SECRET in production.');
}

/* ------------------------------------------------------------------ */
/* Storage                                                            */
/* ------------------------------------------------------------------ */
function dupError() { const e = new Error('duplicate'); e.code = 'DUP'; return e; }

function fileStore() {
  const file = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
  let db = { seq: 0, users: [], data: {} };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* new file */ }
  const persist = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); };
  return {
    kind: 'file',
    async init() {},
    async createUser(name, identifier, hash) {
      if (db.users.find(u => u.identifier === identifier)) throw dupError();
      const u = { id: ++db.seq, name, identifier, pass_hash: hash, tv: 0, created_at: new Date().toISOString() };
      db.users.push(u); persist(); return u;
    },
    async userByIdent(identifier) { return db.users.find(u => u.identifier === identifier) || null; },
    async userById(id) { return db.users.find(u => u.id === id) || null; },
    async updateName(id, name) { const u = db.users.find(x => x.id === id); u.name = name; persist(); return u; },
    async setPassword(id, hash) { const u = db.users.find(x => x.id === id); u.pass_hash = hash; u.tv++; persist(); return u; },
    async deleteUser(id) { db.users = db.users.filter(u => u.id !== id); delete db.data[id]; persist(); },
    async getData(id) { return db.data[id] || null; },
    async putData(id, data, rev) {
      const cur = db.data[id]; const curRev = cur ? cur.rev : 0;
      if (rev !== undefined && rev !== null && rev !== curRev) return { conflict: true, ...(cur || { data: null, rev: 0 }) };
      const row = { data, rev: curRev + 1, updated_at: new Date().toISOString() };
      db.data[id] = row; persist(); return row;
    },
    async stats() { return { users: db.users.length }; }
  };
}

function pgStore() {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || process.env.PGSSL === 'disable';
  const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 10 });
  pool.on('error', e => console.error('[pg] idle client error', e.message));
  const q = (sql, params) => pool.query(sql, params);
  return {
    kind: 'postgres',
    async init() {
      await q(`
        CREATE TABLE IF NOT EXISTS users (
          id          SERIAL PRIMARY KEY,
          name        TEXT NOT NULL,
          identifier  TEXT NOT NULL UNIQUE,
          pass_hash   TEXT NOT NULL,
          tv          INTEGER NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS user_data (
          user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          data        JSONB NOT NULL,
          rev         INTEGER NOT NULL DEFAULT 1,
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );`);
    },
    async createUser(name, identifier, hash) {
      try {
        const r = await q('INSERT INTO users(name, identifier, pass_hash) VALUES ($1,$2,$3) RETURNING *', [name, identifier, hash]);
        return r.rows[0];
      } catch (e) { if (e.code === '23505') throw dupError(); throw e; }
    },
    async userByIdent(identifier) { return (await q('SELECT * FROM users WHERE identifier=$1', [identifier])).rows[0] || null; },
    async userById(id) { return (await q('SELECT * FROM users WHERE id=$1', [id])).rows[0] || null; },
    async updateName(id, name) { return (await q('UPDATE users SET name=$2 WHERE id=$1 RETURNING *', [id, name])).rows[0]; },
    async setPassword(id, hash) { return (await q('UPDATE users SET pass_hash=$2, tv=tv+1 WHERE id=$1 RETURNING *', [id, hash])).rows[0]; },
    async deleteUser(id) { await q('DELETE FROM users WHERE id=$1', [id]); },
    async getData(id) { return (await q('SELECT data, rev, updated_at FROM user_data WHERE user_id=$1', [id])).rows[0] || null; },
    async putData(id, data, rev) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const cur = (await c.query('SELECT data, rev, updated_at FROM user_data WHERE user_id=$1 FOR UPDATE', [id])).rows[0];
        const curRev = cur ? cur.rev : 0;
        if (rev !== undefined && rev !== null && rev !== curRev) {
          await c.query('ROLLBACK');
          return { conflict: true, ...(cur || { data: null, rev: 0 }) };
        }
        const json = JSON.stringify(data);
        const r = cur
          ? await c.query('UPDATE user_data SET data=$2::jsonb, rev=rev+1, updated_at=now() WHERE user_id=$1 RETURNING rev, updated_at', [id, json])
          : await c.query('INSERT INTO user_data(user_id, data, rev) VALUES ($1,$2::jsonb,1) RETURNING rev, updated_at', [id, json]);
        await c.query('COMMIT');
        return { data, ...r.rows[0] };
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { c.release(); }
    },
    async stats() { return { users: Number((await q('SELECT count(*) FROM users')).rows[0].count) }; }
  };
}

const store = process.env.DATABASE_URL ? pgStore() : fileStore();

/* ------------------------------------------------------------------ */
/* Auth helpers                                                       */
/* ------------------------------------------------------------------ */
const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 64, SCRYPT, (err, key) => err ? reject(err) : resolve(`s1$${salt.toString('base64')}$${key.toString('base64')}`));
  });
}
function verifyPassword(pw, stored) {
  return new Promise(resolve => {
    const [v, s, h] = String(stored || '').split('$');
    if (v !== 's1' || !s || !h) return resolve(false);
    crypto.scrypt(pw, Buffer.from(s, 'base64'), 64, SCRYPT, (err, key) => {
      if (err) return resolve(false);
      const hb = Buffer.from(h, 'base64');
      resolve(hb.length === key.length && crypto.timingSafeEqual(hb, key));
    });
  });
}
function signToken(user) {
  const body = Buffer.from(JSON.stringify({ uid: user.id, tv: user.tv, exp: Math.floor(Date.now() / 1000) + TOKEN_DAYS * 86400 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function readToken(tok) {
  if (!tok) return null;
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch (_) { return null; }
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩', FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
function normalizeIdentifier(raw) {
  let s = String(raw || '').trim().replace(/[٠-٩]/g, d => AR_DIGITS.indexOf(d)).replace(/[۰-۹]/g, d => FA_DIGITS.indexOf(d));
  if (/^[+\d\s()-]+$/.test(s)) {
    let d = s.replace(/\D/g, '');
    if (d.startsWith('00964')) d = '0' + d.slice(5);
    else if (d.startsWith('964')) d = '0' + d.slice(3);
    else if (d.length === 10 && d.startsWith('7')) d = '0' + d;
    return /^\d{8,15}$/.test(d) ? d : null;
  }
  s = s.toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 120 ? s : null;
}
const publicUser = u => ({ id: u.id, name: u.name, identifier: u.identifier, created_at: u.created_at });

/* simple in-memory rate limiter for auth endpoints */
const hits = new Map();
function rateLimited(key, limit = 20, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  h.n++;
  return h.n > limit;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                       */
/* ------------------------------------------------------------------ */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}
async function authUser(req) {
  const h = req.headers.authorization || '';
  const p = readToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!p) return null;
  const u = await store.userById(p.uid);
  if (!u || u.tv !== p.tv) return null;
  return u;
}
function validState(d) {
  return d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.wallets) && Array.isArray(d.tx);
}

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */
async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'POST /api/auth/register' || route === 'POST /api/auth/login') {
    if (rateLimited('auth:' + clientIp(req))) return send(res, 429, { error: 'محاولات كثيرة، حاول بعد قليل' });
    const b = await readBody(req);
    const identifier = normalizeIdentifier(b.identifier);
    const password = String(b.password || '');
    if (!identifier) return send(res, 400, { error: 'أدخل رقم هاتف أو بريد إلكتروني صحيح' });

    if (route === 'POST /api/auth/register') {
      const name = String(b.name || '').trim().slice(0, 60);
      if (name.length < 2) return send(res, 400, { error: 'أدخل اسمك (حرفان على الأقل)' });
      if (password.length < 6) return send(res, 400, { error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
      try {
        const u = await store.createUser(name, identifier, await hashPassword(password));
        return send(res, 201, { token: signToken(u), user: publicUser(u) });
      } catch (e) {
        if (e.code === 'DUP') return send(res, 409, { error: 'هذا الحساب مسجل مسبقاً، سجّل الدخول' });
        throw e;
      }
    }
    const u = await store.userByIdent(identifier);
    if (!u || !(await verifyPassword(password, u.pass_hash))) return send(res, 401, { error: 'بيانات الدخول غير صحيحة' });
    return send(res, 200, { token: signToken(u), user: publicUser(u) });
  }

  // everything below requires a valid token
  const user = await authUser(req);
  if (!user) return send(res, 401, { error: 'يرجى تسجيل الدخول' });

  if (route === 'GET /api/me') return send(res, 200, { user: publicUser(user) });

  if (route === 'PATCH /api/me') {
    const b = await readBody(req);
    const name = String(b.name || '').trim().slice(0, 60);
    if (name.length < 2) return send(res, 400, { error: 'الاسم قصير جداً' });
    return send(res, 200, { user: publicUser(await store.updateName(user.id, name)) });
  }

  if (route === 'POST /api/me/password') {
    if (rateLimited('pw:' + user.id, 10)) return send(res, 429, { error: 'محاولات كثيرة، حاول بعد قليل' });
    const b = await readBody(req);
    if (!(await verifyPassword(String(b.current || ''), user.pass_hash))) return send(res, 400, { error: 'كلمة المرور الحالية غير صحيحة' });
    const next = String(b.next || '');
    if (next.length < 6) return send(res, 400, { error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' });
    const u = await store.setPassword(user.id, await hashPassword(next));
    return send(res, 200, { token: signToken(u), user: publicUser(u) });
  }

  if (route === 'DELETE /api/me') {
    const b = await readBody(req);
    if (!(await verifyPassword(String(b.password || ''), user.pass_hash))) return send(res, 400, { error: 'كلمة المرور غير صحيحة' });
    await store.deleteUser(user.id);
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/data') {
    const row = await store.getData(user.id);
    return send(res, 200, row ? { data: row.data, rev: row.rev, updated_at: row.updated_at } : { data: null, rev: 0 });
  }

  if (route === 'PUT /api/data') {
    const b = await readBody(req);
    if (!validState(b.data)) return send(res, 400, { error: 'بيانات غير صالحة' });
    const rev = Number.isInteger(b.rev) ? b.rev : null;
    const r = await store.putData(user.id, b.data, rev);
    if (r.conflict) return send(res, 409, { error: 'conflict', data: r.data, rev: r.rev, updated_at: r.updated_at });
    return send(res, 200, { rev: r.rev, updated_at: r.updated_at });
  }

  if (route === 'POST /api/export/link') {
    const b = await readBody(req);
    const day = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const opts = {
      from: day(b.from), to: day(b.to),
      type: ['all', 'income', 'expense', 'transfer'].includes(b.type) ? b.type : 'all',
      wallet: typeof b.wallet === 'string' ? b.wallet.slice(0, 40) : 'all'
    };
    const body = Buffer.from(JSON.stringify({ uid: user.id, tv: user.tv, exp: Math.floor(Date.now() / 1000) + 600, o: opts })).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update('dl:' + body).digest('base64url');
    const stamp = new Date().toISOString().slice(0, 10);
    return send(res, 200, { url: `/dl/${body}.${sig}/masareefi-${stamp}.xlsx` });
  }

  return send(res, 404, { error: 'not found' });
}

/* one-time-ish signed download link (works inside the Android WebView download manager) */
async function download(req, res, url) {
  const m = url.pathname.match(/^\/dl\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\/([\w.-]+)$/);
  if (!m) return send(res, 404, { error: 'not found' });
  const expected = crypto.createHmac('sha256', SECRET).update('dl:' + m[1]).digest('base64url');
  if (m[2].length !== expected.length || !crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(expected))) return send(res, 403, { error: 'رابط غير صالح' });
  let p;
  try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch (_) { return send(res, 403, { error: 'رابط غير صالح' }); }
  if (p.exp < Date.now() / 1000) return send(res, 410, { error: 'انتهت صلاحية الرابط، صدّر مرة أخرى' });
  const user = await store.userById(p.uid);
  if (!user || user.tv !== p.tv) return send(res, 403, { error: 'رابط غير صالح' });
  const row = await store.getData(user.id);
  const data = row && row.data ? row.data : { wallets: [], tx: [], debts: [], goals: [] };
  const report = MX.buildReport(data, p.o || {});
  const buf = reportWorkbook(report, user);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${m[3]}"`,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

/* ------------------------------------------------------------------ */
/* Static files                                                       */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/privacy') p = '/privacy.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : (path.extname(p) ? null : path.join(PUBLIC_DIR, 'index.html'));
    if (!target) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const ext = path.extname(target);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, store: store.kind });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/dl/')) return await download(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    serveStatic(req, res, url);
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.status === 413 ? 'حجم البيانات كبير جداً' : 'طلب غير صالح' });
    console.error('[error]', e);
    send(res, 500, { error: 'خطأ في الخادم، حاول مجدداً' });
  }
});

store.init()
  .then(() => server.listen(PORT, () => console.log(`Masareefi running on :${PORT} (store: ${store.kind})`)))
  .catch(e => { console.error('Failed to initialise storage:', e); process.exit(1); });
