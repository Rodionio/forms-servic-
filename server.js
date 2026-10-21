'use strict';
/**
 * Сервис форм — без внешних зависимостей (только встроенные модули Node.js).
 * Хранилище: JSON-файл data/db.json (атомарная запись через временный файл).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;

const FIELD_TYPES = ['text', 'textarea', 'email', 'tel', 'number', 'date', 'select', 'radio', 'checkbox'];
const CHOICE_TYPES = ['select', 'radio', 'checkbox'];

/* ------------------------------ хранилище ------------------------------ */

let db = { forms: [], responses: [], sessions: [] };

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = { forms: [], responses: [], sessions: [], ...parsed };
    } catch (e) {
      const backup = DB_FILE + '.broken-' + Date.now();
      fs.copyFileSync(DB_FILE, backup);
      console.error(`db.json повреждён, копия сохранена в ${backup}. Начинаем с пустой базы.`);
    }
  }
}

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
/** Отложенная запись — для частых событий аналитики. */
function saveSoon() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 300);
}

const uid = (n = 8) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, '').toLowerCase().slice(0, n);
const newSlug = () => {
  let s;
  do { s = uid(8); } while (db.forms.some((f) => f.slug === s));
  return s;
};

/* ------------------------------ валидация формы ------------------------------ */

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanForm(body) {
  const title = str(body.title, 200);
  if (!title) throw new HttpError(400, 'Укажите название формы');
  if (!Array.isArray(body.fields)) throw new HttpError(400, 'Некорректный список полей');
  if (body.fields.length > 50) throw new HttpError(400, 'Не более 50 полей в форме');

  const seen = new Set();
  const fields = body.fields.map((f, i) => {
    const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
    const label = str(f.label, 300);
    if (!label) throw new HttpError(400, `Поле №${i + 1}: укажите название вопроса`);
    let id = typeof f.id === 'string' && /^[a-z0-9]{4,16}$/.test(f.id) ? f.id : uid(6);
    while (seen.has(id)) id = uid(6);
    seen.add(id);
    const field = { id, type, label, required: !!f.required };
    const hint = str(f.hint, 300);
    if (hint) field.hint = hint;
    if (CHOICE_TYPES.includes(type)) {
      const opts = (Array.isArray(f.options) ? f.options : []).map((o) => str(o, 200)).filter(Boolean);
      const unique = [...new Set(opts)].slice(0, 100);
      if (unique.length < 1) throw new HttpError(400, `Поле «${label}»: добавьте хотя бы один вариант ответа`);
      field.options = unique;
    }
    return field;
  });

  return { title, description: str(body.description, 2000), fields, published: !!body.published };
}

/* ------------------------------ валидация ответов ------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[\d\s()\-]{6,20}$/;

function validateAnswers(form, answers) {
  const errors = {};
  const out = [];
  if (!answers || typeof answers !== 'object') answers = {};

  for (const f of form.fields) {
    let v = answers[f.id];
    const isEmpty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (isEmpty) {
      if (f.required) errors[f.id] = 'Обязательное поле';
      else out.push({ fieldId: f.id, label: f.label, value: f.type === 'checkbox' ? [] : '' });
      continue;
    }

    if (f.type === 'checkbox') {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && f.options.includes(x))) {
        errors[f.id] = 'Недопустимое значение'; continue;
      }
      v = [...new Set(v)];
    } else if (typeof v !== 'string' && typeof v !== 'number') {
      errors[f.id] = 'Недопустимое значение'; continue;
    } else {
      v = String(v).trim();
      if (!v) { if (f.required) errors[f.id] = 'Обязательное поле'; else out.push({ fieldId: f.id, label: f.label, value: '' }); continue; }
      if (f.type === 'text' && v.length > 500) errors[f.id] = 'Слишком длинный ответ (макс. 500 символов)';
      else if (f.type === 'textarea' && v.length > 5000) errors[f.id] = 'Слишком длинный ответ (макс. 5000 символов)';
      else if (f.type === 'email' && !EMAIL_RE.test(v)) errors[f.id] = 'Введите корректный email';
      else if (f.type === 'tel' && !PHONE_RE.test(v)) errors[f.id] = 'Введите корректный номер телефона';
      else if (f.type === 'number' && !Number.isFinite(Number(v))) errors[f.id] = 'Введите число';
      else if (f.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))) errors[f.id] = 'Введите корректную дату';
      else if ((f.type === 'select' || f.type === 'radio') && !f.options.includes(v)) errors[f.id] = 'Выберите вариант из списка';
      else if (v.length > 5000) errors[f.id] = 'Слишком длинный ответ';
    }
    if (!errors[f.id]) out.push({ fieldId: f.id, label: f.label, value: v });
  }
  return { errors, values: out };
}

/* ------------------------------ аналитика ------------------------------ */

function formStats(form) {
  const sessions = db.sessions.filter((s) => s.formId === form.id);
  const views = sessions.length;
  const started = sessions.filter((s) => s.touched.length > 0 || s.submitted).length;
  const submitted = sessions.filter((s) => s.submitted).length;
  const abandoned = sessions.filter((s) => !s.submitted && s.touched.length > 0);

  const perField = form.fields.map((f, i) => ({
    fieldId: f.id,
    label: f.label,
    index: i + 1,
    reached: sessions.filter((s) => s.touched.includes(f.id)).length,
    abandonedHere: abandoned.filter((s) => s.lastField === f.id).length,
  }));
  return { views, started, submitted, abandoned: abandoned.length, perField };
}

/* ------------------------------ вспомогательное для HTTP ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
const sendJson = (res, status, data) =>
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, file, extraHeaders = {}) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...extraHeaders });
  });
}

function csvCell(v) {
  let s = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // защита от CSV-инъекций в Excel
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function responsesCsv(form) {
  const rows = db.responses.filter((r) => r.formId === form.id);
  // колонки: актуальные поля + «осиротевшие» (поля, удалённые из формы после получения ответов)
  const cols = form.fields.map((f) => ({ id: f.id, label: f.label }));
  for (const r of rows) for (const a of r.answers) if (!cols.some((c) => c.id === a.fieldId)) cols.push({ id: a.fieldId, label: a.label + ' (удалено)' });
  const lines = [['Дата отправки', ...cols.map((c) => c.label)].map(csvCell).join(';')];
  for (const r of rows) {
    const byId = Object.fromEntries(r.answers.map((a) => [a.fieldId, a.value]));
    lines.push([new Date(r.submittedAt).toLocaleString('ru-RU'), ...cols.map((c) => byId[c.id] ?? '')].map(csvCell).join(';'));
  }
  return '\ufeff' + lines.join('\r\n');
}

/* ------------------------------ API ------------------------------ */

const publicForm = (f) => ({ title: f.title, description: f.description, fields: f.fields });
const findForm = (id) => db.forms.find((f) => f.id === id);
const findPublished = (slug) => db.forms.find((f) => f.slug === slug && f.published);

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  const seg = parts.slice(1);

  /* ---- публичные ---- */
  if (seg[0] === 'public' && seg[1]) {
    const form = findPublished(seg[1]);
    if (!form) throw new HttpError(404, 'Форма не найдена или закрыта');

    if (method === 'GET' && seg.length === 2) return sendJson(res, 200, publicForm(form));

    if (method === 'POST' && seg[2] === 'track') {
      const b = await readBody(req);
      const sid = typeof b.sid === 'string' && /^[a-z0-9]{8,32}$/.test(b.sid) ? b.sid : null;
      if (!sid) throw new HttpError(400, 'Некорректный sid');
      let s = db.sessions.find((x) => x.id === sid && x.formId === form.id);
      if (!s) {
        if (db.sessions.length > 50000) db.sessions.splice(0, 10000); // ограничение роста файла
        s = { id: sid, formId: form.id, at: Date.now(), touched: [], lastField: null, submitted: false };
        db.sessions.push(s);
      }
      if (b.type === 'field' && form.fields.some((f) => f.id === b.fieldId)) {
        if (!s.touched.includes(b.fieldId)) s.touched.push(b.fieldId);
        s.lastField = b.fieldId;
      }
      saveSoon();
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && seg[2] === 'submit') {
      const b = await readBody(req);
      const { errors, values } = validateAnswers(form, b.answers);
      if (Object.keys(errors).length) throw new HttpError(422, 'Проверьте поля формы', { errors });
      const sid = typeof b.sid === 'string' && /^[a-z0-9]{8,32}$/.test(b.sid) ? b.sid : null;
      db.responses.push({ id: uid(10), formId: form.id, submittedAt: Date.now(), answers: values });
      if (sid) {
        let s = db.sessions.find((x) => x.id === sid && x.formId === form.id);
        if (!s) { s = { id: sid, formId: form.id, at: Date.now(), touched: [], lastField: null, submitted: false }; db.sessions.push(s); }
        s.submitted = true;
      }
      saveNow();
      return sendJson(res, 201, { ok: true });
    }
    throw new HttpError(404, 'Не найдено');
  }

  /* ---- админские ---- */
  if (seg[0] !== 'forms') throw new HttpError(404, 'Не найдено');

  if (seg.length === 1) {
    if (method === 'GET') {
      return sendJson(res, 200, db.forms.map((f) => ({
        id: f.id, slug: f.slug, title: f.title, published: f.published, createdAt: f.createdAt,
        fieldsCount: f.fields.length,
        responsesCount: db.responses.filter((r) => r.formId === f.id).length,
      })));
    }
    if (method === 'POST') {
      const data = cleanForm(await readBody(req));
      const form = { id: uid(10), slug: newSlug(), createdAt: Date.now(), updatedAt: Date.now(), ...data };
      db.forms.push(form);
      saveNow();
      return sendJson(res, 201, form);
    }
    throw new HttpError(405, 'Метод не поддерживается');
  }

  const form = findForm(seg[1]);
  if (!form) throw new HttpError(404, 'Форма не найдена');

  if (seg.length === 2) {
    if (method === 'GET') return sendJson(res, 200, form);
    if (method === 'PUT') {
      Object.assign(form, cleanForm(await readBody(req)), { updatedAt: Date.now() });
      saveNow();
      return sendJson(res, 200, form);
    }
    if (method === 'DELETE') {
      db.forms = db.forms.filter((f) => f.id !== form.id);
      db.responses = db.responses.filter((r) => r.formId !== form.id);
      db.sessions = db.sessions.filter((s) => s.formId !== form.id);
      saveNow();
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Метод не поддерживается');
  }

  if (seg[2] === 'responses') {
    if (method === 'GET' && seg.length === 3) {
      const list = db.responses.filter((r) => r.formId === form.id).sort((a, b) => b.submittedAt - a.submittedAt);
      return sendJson(res, 200, { form, responses: list, stats: formStats(form) });
    }
    if (method === 'GET' && seg[3] === 'export.csv') {
      return send(res, 200, responsesCsv(form), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="responses-${form.slug}.csv"`,
      });
    }
    if (method === 'DELETE' && seg[3]) {
      const before = db.responses.length;
      db.responses = db.responses.filter((r) => !(r.id === seg[3] && r.formId === form.id));
      if (db.responses.length === before) throw new HttpError(404, 'Ответ не найден');
      saveNow();
      return sendJson(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'Не найдено');
}

/* ------------------------------ сервер ------------------------------ */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p.startsWith('/api/')) return await handleApi(req, res, url);

    if (p === '/') { res.writeHead(302, { Location: '/admin' }); return res.end(); }
    if (p === '/admin' || p === '/admin/') return serveFile(res, path.join(PUBLIC_DIR, 'admin', 'index.html'), { 'Cache-Control': 'no-store' });
    if (/^\/f\/[a-z0-9]+\/?$/.test(p)) return serveFile(res, path.join(PUBLIC_DIR, 'form.html'), { 'Cache-Control': 'no-store' });

    if (p.startsWith('/static/')) {
      const rel = path.normalize(decodeURIComponent(p.slice('/static/'.length)));
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden');
      return serveFile(res, file, { 'Cache-Control': 'no-cache' });
    }
    throw new HttpError(404, 'Страница не найдена');
  } catch (e) {
    if (e instanceof HttpError) {
      if (req.url.startsWith('/api/')) return sendJson(res, e.status, { error: e.message, ...(e.extra || {}) });
      return send(res, e.status, e.message, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    console.error(e);
    return sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
  }
});

function start() {
  loadDb();
  server.listen(PORT, () => {
    console.log(`Сервис форм запущен:  http://localhost:${PORT}/admin`);
  });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (saveTimer) saveNow(); process.exit(0); });

if (require.main === module) start();
module.exports = { server, loadDb };
