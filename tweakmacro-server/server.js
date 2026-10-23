// Сервер TweakMacro: оплата подписок, выдача ключей и их проверка программой.
// Запуск: npm install && npm start (настройки — в файле .env, пример в .env.example).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

// ───── настройки из .env ─────
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
loadEnv(path.join(__dirname, '.env'));
const env = (k, d = '') => process.env[k] || d;
const CFG = {
  port: +env('PORT', '8080'),
  site: env('SITE_URL', 'http://localhost:8080').replace(/\/$/, ''),
  ykShop: env('YOOKASSA_SHOP_ID'),
  ykKey: env('YOOKASSA_SECRET_KEY'),
  ykReceipts: env('YOOKASSA_RECEIPTS') === '1',
  ykVat: +env('YOOKASSA_VAT_CODE', '1'),
  resendKey: env('RESEND_API_KEY'),
  mailFrom: env('MAIL_FROM', 'TweakMacro <keys@example.com>'),
  adminToken: env('ADMIN_TOKEN'),
  maxDevices: Math.max(1, +env('MAX_DEVICES', '1')),
  devPay: env('DEV_FAKE_PAY') === '1',
  dbFile: env('DB_FILE', path.join(__dirname, 'data.sqlite')),
  siteDir: env('SITE_DIR', path.join(__dirname, '..', 'tweakmacro-site')),
  downloadFile: env('DOWNLOAD_FILE', path.join(__dirname, '..', 'macros', 'install-TweakMacro.bat')),
  appDir: env('APP_DIR', path.join(__dirname, '..', 'macros'))
};

// ───── тарифы (цены в рублях) ─────
const PLANS = {
  m1: { days: 31, rub: 849, name: { ru: 'TweakMacro — 1 месяц', en: 'TweakMacro — 1 month' } },
  m3: { days: 92, rub: 1890, name: { ru: 'TweakMacro — 3 месяца', en: 'TweakMacro — 3 months' } },
  life: { days: null, rub: 4790, name: { ru: 'TweakMacro — навсегда', en: 'TweakMacro — lifetime' } }
};
// Платный сброс привязки ключа к ПК: после оплаты ключ переходит на ПК, с которого куплен сброс
const HWID_RESET = { rub: 279, name: { ru: 'TweakMacro — сброс привязки к ПК', en: 'TweakMacro — PC binding reset' } };

// ───── база ─────
const db = new Database(CFG.dbFile);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS licenses (
  key TEXT PRIMARY KEY, email TEXT, plan TEXT NOT NULL, expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active', provider TEXT, sub_id TEXT, auto_renew INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
  key TEXT NOT NULL, hwid TEXT NOT NULL, first_seen INTEGER, last_seen INTEGER, app TEXT,
  PRIMARY KEY (key, hwid));
CREATE TABLE IF NOT EXISTS orders (
  ref TEXT PRIMARY KEY, provider TEXT, provider_id TEXT, plan TEXT, currency TEXT, amount INTEGER,
  email TEXT, lang TEXT, status TEXT NOT NULL DEFAULT 'pending', license_key TEXT, created_at INTEGER, paid_at INTEGER);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at INTEGER);
CREATE INDEX IF NOT EXISTS lic_sub ON licenses(sub_id);
`);
// Колонки, добавленные позже: дописываем в старую базу, если их нет
for (const [table, col, def] of [['devices', 'parts', 'TEXT'], ['orders', 'hwid', 'TEXT'], ['orders', 'parts', 'TEXT'],
  ['orders', 'source', 'TEXT'], ['orders', 'renew_key', 'TEXT'], ['licenses', 'last_transfer', 'INTEGER'], ['licenses', 'transfers', 'INTEGER DEFAULT 0']]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

const now = () => Date.now();
const DAY = 86400000;
const KEY_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newKey() {
  const b = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += KEY_ABC[b[i] % KEY_ABC.length];
  return 'TM-' + s.match(/.{4}/g).join('-');
}
const normKey = k => String(k || '').trim().toUpperCase();

// ───── привязка к ПК ─────
// Программа присылает общий отпечаток hwid и хэши отдельных частей железа:
// mg — MachineGuid Windows, vol — серийный номер системного диска, cpu — процессор, board — материнская плата.
// Если человек поменял одну деталь или переустановил Windows, ПК узнаётся по оставшимся (нужно 2 совпадения из 4).
const PARTS = ['mg', 'vol', 'cpu', 'board'];
const normHwid = h => String(h || '').trim().slice(0, 128);
function normParts(p) {
  const o = {};
  if (p && typeof p === 'object') for (const k of PARTS) if (/^[0-9a-f]{16,64}$/i.test(String(p[k] || ''))) o[k] = String(p[k]).toLowerCase();
  return o;
}
function sameParts(a, b) {
  let n = 0;
  for (const k of PARTS) if (a[k] && a[k] === b[k]) n++;
  return n;
}
function findDevice(key, hwid, parts) {
  const list = db.prepare('SELECT * FROM devices WHERE key = ?').all(key);
  const exact = list.find(d => d.hwid === hwid);
  if (exact) return exact;
  return list.find(d => sameParts(parts, JSON.parse(d.parts || '{}')) >= 2) || null;
}
function bindDevice(key, hwid, parts, app) {
  db.prepare('INSERT OR REPLACE INTO devices (key, hwid, parts, first_seen, last_seen, app) VALUES (?, ?, ?, ?, ?, ?)')
    .run(key, hwid, JSON.stringify(parts), now(), now(), String(app || '').slice(0, 32));
}
// Проверка ключа и привязка: { ok, error, license }
function checkDevice(key, hwid, parts, app) {
  const l = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  if (!l || l.status !== 'active') return { error: 'invalid_key' };
  if (l.expires_at && l.expires_at < now()) return { error: 'expired', license: l };
  const d = findDevice(key, hwid, parts);
  if (d) {
    db.prepare('UPDATE devices SET hwid = ?, parts = ?, last_seen = ?, app = ? WHERE key = ? AND hwid = ?')
      .run(hwid, JSON.stringify({ ...JSON.parse(d.parts || '{}'), ...parts }), now(), String(app || '').slice(0, 32), key, d.hwid);
  } else {
    const n = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE key = ?').get(key).n;
    if (n >= CFG.maxDevices) return { error: 'other_device', license: l };
    bindDevice(key, hwid, parts, app);
  }
  return { ok: true, license: l };
}

function licenseView(l) {
  return {
    plan: l.plan,
    expires: l.expires_at ? new Date(l.expires_at).toISOString() : null,
    expires_unix: l.expires_at ? Math.floor(l.expires_at / 1000) : 0
  };
}

// Выдать ключ по оплаченному заказу (повторный вызов ничего не дублирует)
function markPaid(ref, extra = {}) {
  const o = db.prepare('SELECT * FROM orders WHERE ref = ?').get(ref);
  if (!o) throw new Error('order not found: ' + ref);
  if (o.status === 'paid' && o.license_key) return o.license_key;
  const paid = key => db.prepare("UPDATE orders SET status = 'paid', license_key = ?, paid_at = ?, provider_id = COALESCE(?, provider_id) WHERE ref = ?")
    .run(key, now(), extra.providerId || null, ref);
  if (o.plan === 'reset') {
    db.transaction(() => {
      db.prepare('DELETE FROM devices WHERE key = ?').run(o.renew_key);
      if (o.hwid) bindDevice(o.renew_key, o.hwid, normParts(JSON.parse(o.parts || '{}')), 'reset');
      db.prepare('UPDATE licenses SET last_transfer = ?, transfers = COALESCE(transfers, 0) + 1 WHERE key = ?').run(now(), o.renew_key);
      paid(o.renew_key);
    })();
    console.log(`[hwid-reset] ${ref} → ${o.renew_key}`);
    return o.renew_key;
  }
  const plan = PLANS[o.plan];
  // Продление из лаунчера: тот же ключ, срок добавляется к оставшемуся
  const old = o.renew_key && db.prepare("SELECT * FROM licenses WHERE key = ? AND status = 'active'").get(o.renew_key);
  if (old) {
    const exp = !plan.days || !old.expires_at && old.plan === 'life' ? null : Math.max(now(), old.expires_at || 0) + plan.days * DAY;
    db.transaction(() => {
      db.prepare('UPDATE licenses SET plan = ?, expires_at = ?, email = COALESCE(email, ?) WHERE key = ?')
        .run(old.plan === 'life' ? 'life' : o.plan, old.plan === 'life' ? null : exp, o.email, old.key);
      paid(old.key);
    })();
    sendKeyMail(o.email, old.key, o.plan, o.lang).catch(e => console.error('mail:', e.message));
    console.log(`[renew-paid] ${ref} ${o.plan} → ${old.key}`);
    return old.key;
  }
  const key = newKey();
  db.transaction(() => {
    db.prepare('INSERT INTO licenses (key, email, plan, expires_at, provider, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(key, o.email, o.plan, plan.days ? now() + plan.days * DAY : null, o.provider, now());
    paid(key);
    // Куплено из лаунчера — ключ сразу привязывается к этому ПК
    if (o.hwid) bindDevice(key, o.hwid, normParts(JSON.parse(o.parts || '{}')), 'checkout');
  })();
  sendKeyMail(o.email, key, o.plan, o.lang).catch(e => console.error('mail:', e.message));
  console.log(`[paid] ${ref} ${o.plan} → ${key}`);
  return key;
}

async function sendKeyMail(to, key, planId, lang) {
  if (!CFG.resendKey || !to) return;
  const ru = lang !== 'en';
  const plan = PLANS[planId].name[ru ? 'ru' : 'en'];
  const html = ru
    ? `<p>Спасибо за покупку <b>${plan}</b>!</p><p>Твой ключ: <b style="font-size:18px">${key}</b></p><p>Запусти TweakMacro → в лаунчере вставь ключ → «Активировать». Если покупал из лаунчера, ключ уже активирован.</p><p>Скачать программу: <a href="${CFG.site}/download">${CFG.site}/download</a></p>`
    : `<p>Thanks for buying <b>${plan}</b>!</p><p>Your key: <b style="font-size:18px">${key}</b></p><p>Start TweakMacro → paste the key in the launcher → “Activate”. If you bought in the launcher, the key is already active.</p><p>Download: <a href="${CFG.site}/download">${CFG.site}/download</a></p>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CFG.resendKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: CFG.mailFrom, to: [to], subject: ru ? 'Твой ключ TweakMacro' : 'Your TweakMacro key', html })
  });
  if (!r.ok) throw new Error('resend ' + r.status + ' ' + (await r.text()));
}

// ───── платёжные системы ─────
const ykOn = !!(CFG.ykShop && CFG.ykKey);

async function ykRequest(method, url, body, idemKey) {
  const r = await fetch('https://api.yookassa.ru/v3' + url, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(CFG.ykShop + ':' + CFG.ykKey).toString('base64'),
      'Content-Type': 'application/json',
      ...(idemKey ? { 'Idempotence-Key': idemKey } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('yookassa ' + r.status + ' ' + (data.description || ''));
  return data;
}

async function createCheckout({ planId, email, lang, hwid = '', parts = {}, source = 'site', renewKey = null }) {
  const plan = planId === 'reset' ? HWID_RESET : PLANS[planId];
  const ref = crypto.randomUUID();
  const success = `${CFG.site}/success.html?ref=${ref}`;
  const name = plan.name[lang === 'en' ? 'en' : 'ru'];
  const insert = provider => db.prepare(`INSERT INTO orders (ref, provider, plan, currency, amount, email, lang, created_at, hwid, parts, source, renew_key)
                                         VALUES (?, ?, ?, 'rub', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ref, provider, planId, plan.rub, email, lang, now(), hwid || null, JSON.stringify(parts), source, renewKey);

  if (CFG.devPay) {
    insert('dev');
    return { ref, url: `${CFG.site}/dev-pay?ref=${ref}` };
  }
  if (!ykOn) throw Object.assign(new Error('Оплата ещё не подключена'), { code: 'not_configured' });
  insert('yookassa');
  const value = plan.rub.toFixed(2);
  const p = await ykRequest('POST', '/payments', {
    amount: { value, currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: success },
    description: name,
    metadata: { ref, plan: planId },
    ...(CFG.ykReceipts ? {
      receipt: {
        customer: { email },
        items: [{ description: name, quantity: '1.00', amount: { value, currency: 'RUB' }, vat_code: CFG.ykVat, payment_mode: 'full_payment', payment_subject: 'service' }]
      }
    } : {})
  }, ref);
  db.prepare('UPDATE orders SET provider_id = ? WHERE ref = ?').run(p.id, ref);
  return { ref, url: p.confirmation.confirmation_url };
}

// ───── HTTP ─────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// Простое ограничение частоты запросов к API
const hits = new Map();
function limit(max) {
  return (req, res, next) => {
    const k = req.ip + req.path, t = now(), h = hits.get(k) || { n: 0, t };
    if (t - h.t > 60000) { h.n = 0; h.t = t; }
    h.n++; hits.set(k, h);
    if (h.n > max) return res.status(429).json({ error: 'too_many_requests' });
    next();
  };
}
setInterval(() => { const t = now(); for (const [k, h] of hits) if (t - h.t > 120000) hits.delete(k); }, 60000).unref();

app.use(express.json({ limit: '20kb' }));
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Вебхук ЮKassa: данные не подписаны, поэтому статус платежа перепроверяем запросом к API
app.post('/webhooks/yookassa', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.event !== 'payment.succeeded' || !b.object || !b.object.id || !ykOn) return res.json({ ok: true });
    const p = await ykRequest('GET', '/payments/' + encodeURIComponent(b.object.id));
    if (p.status === 'succeeded' && p.paid && p.metadata && p.metadata.ref) markPaid(p.metadata.ref, { providerId: p.id });
    res.json({ ok: true });
  } catch (e) {
    console.error('yookassa webhook:', e.message);
    res.status(500).end();
  }
});

app.get('/api/plans', (req, res) => {
  res.json({
    plans: Object.fromEntries(Object.entries(PLANS).map(([id, p]) => [id, { rub: p.rub }])),
    reset: HWID_RESET.rub,
    enabled: ykOn || CFG.devPay
  });
});

app.post('/api/checkout', limit(20), async (req, res) => {
  const { plan, email, lang, hwid, parts, renew_key } = req.body || {};
  if (!PLANS[plan] && plan !== 'reset') return res.status(400).json({ error: 'bad_plan' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || ''))) return res.status(400).json({ error: 'bad_email' });
  const key = renew_key ? normKey(renew_key) : null;
  const lic = key && db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  // Сброс привязки покупается только для существующего ключа и с ПК, на который он переедет
  if (plan === 'reset' && (!lic || lic.status !== 'active' || !hwid)) return res.status(400).json({ error: 'invalid_key' });
  try {
    const r = await createCheckout({ planId: plan, email: String(email).trim().toLowerCase(), lang: lang === 'en' ? 'en' : 'ru',
      hwid: normHwid(hwid), parts: normParts(parts), source: hwid ? 'app' : 'site', renewKey: lic ? key : null });
    res.json(r);
  } catch (e) {
    console.error('checkout:', e.message);
    res.status(e.code === 'not_configured' ? 503 : 502).json({ error: e.code || 'payment_error', message: e.message });
  }
});

// Страница «после оплаты» спрашивает ключ по номеру заказа
app.get('/api/order/:ref', limit(120), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE ref = ?').get(String(req.params.ref));
  if (!o) return res.status(404).json({ error: 'not_found' });
  if (o.status !== 'paid') return res.json({ status: 'pending', plan: o.plan });
  const l = db.prepare('SELECT * FROM licenses WHERE key = ?').get(o.license_key);
  res.json({ status: 'paid', key: o.license_key, email: o.email, ...licenseView(l) });
});

// Проверка ключа программой. Первый запуск привязывает ключ к ПК.
app.post('/api/license/activate', limit(30), (req, res) => {
  const b = req.body || {}, key = normKey(b.key), hwid = normHwid(b.hwid);
  if (!key || !hwid) return res.status(400).json({ valid: false, error: 'bad_request' });
  const r = checkDevice(key, hwid, normParts(b.parts), b.app);
  if (!r.ok) return res.json({ valid: false, error: r.error, ...(r.license ? licenseView(r.license) : {}) });
  res.json({ valid: true, ...licenseView(r.license) });
});

// ───── обновления программы ─────
// Лаунчер сравнивает версию и хэши файлов и скачивает только изменённые.
const APP_FILES = ['TweakMacro.ahk', 'ui.html', 'launcher.html', 'icon.ico'];
let manifestCache = null;
function manifest() {
  const files = APP_FILES.map(name => {
    const f = path.join(CFG.appDir, name);
    return fs.existsSync(f) ? { name, f, st: fs.statSync(f) } : null;
  }).filter(Boolean);
  const stamp = files.map(x => x.name + x.st.mtimeMs + ':' + x.st.size).join('|');
  if (manifestCache && manifestCache.stamp === stamp) return manifestCache.data;
  const main = files.find(x => x.name === 'TweakMacro.ahk');
  const m = main && fs.readFileSync(main.f, 'utf8').match(/^APP_VERSION := "([\d.]+)"/m);
  const data = {
    version: m ? m[1] : '0',
    files: files.map(x => ({ name: x.name, size: x.st.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(x.f)).digest('hex') }))
  };
  manifestCache = { stamp, data };
  return data;
}
app.get('/api/app/manifest', limit(60), (req, res) => res.json(manifest()));
app.get('/app/:name', limit(60), (req, res) => {
  if (!APP_FILES.includes(req.params.name)) return res.status(404).end();
  const f = path.join(CFG.appDir, req.params.name);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.set('Cache-Control', 'no-store');
  res.sendFile(f);
});

// ───── админка (Authorization: Bearer ADMIN_TOKEN) ─────
function admin(req, res, next) {
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!CFG.adminToken || CFG.adminToken === 'change-me-to-long-random-string' ||
      t.length !== CFG.adminToken.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(CFG.adminToken)))
    return res.status(401).json({ error: 'unauthorized' });
  next();
}
app.post('/api/admin/licenses', admin, (req, res) => {
  const { plan = 'life', email = '', days } = req.body || {};
  if (!PLANS[plan]) return res.status(400).json({ error: 'bad_plan' });
  const key = newKey(), d = days ? +days : PLANS[plan].days;
  db.prepare('INSERT INTO licenses (key, email, plan, expires_at, provider, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(key, email, plan, d ? now() + d * DAY : null, 'manual', now());
  res.json({ key });
});
app.get('/api/admin/licenses', admin, (req, res) => {
  res.json(db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM devices d WHERE d.key = l.key) AS devices
                       FROM licenses l ORDER BY created_at DESC LIMIT 500`).all());
});
// Сводка для админ-вкладки программы
app.get('/api/admin/stats', admin, (req, res) => {
  const t = now(), one = (sql, ...a) => db.prepare(sql).get(...a);
  const activeWhere = "status = 'active' AND (expires_at IS NULL OR expires_at > ?)";
  const byPlan = {};
  for (const r of db.prepare(`SELECT plan, COUNT(*) AS n FROM licenses WHERE ${activeWhere} GROUP BY plan`).all(t)) byPlan[r.plan] = r.n;
  const sum = (from, plan) => one(`SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS n FROM orders WHERE status = 'paid' AND currency = 'rub' AND provider != 'dev' AND paid_at >= ?${plan ? ' AND plan = ?' : ''}`, from, ...(plan ? [plan] : []));
  res.json({
    active: one(`SELECT COUNT(*) AS n FROM licenses WHERE ${activeWhere}`, t).n,
    people: one(`SELECT COUNT(DISTINCT COALESCE(NULLIF(email, ''), key)) AS n FROM licenses WHERE ${activeWhere}`, t).n,
    by_plan: { m1: byPlan.m1 || 0, m3: byPlan.m3 || 0, life: byPlan.life || 0 },
    expired: one("SELECT COUNT(*) AS n FROM licenses WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?", t).n,
    revoked: one("SELECT COUNT(*) AS n FROM licenses WHERE status = 'revoked'").n,
    total: one('SELECT COUNT(*) AS n FROM licenses').n,
    new7: one('SELECT COUNT(*) AS n FROM licenses WHERE created_at >= ?', t - 7 * DAY).n,
    new30: one('SELECT COUNT(*) AS n FROM licenses WHERE created_at >= ?', t - 30 * DAY).n,
    expiring7: one(`SELECT COUNT(*) AS n FROM licenses WHERE ${activeWhere} AND expires_at IS NOT NULL AND expires_at < ?`, t, t + 7 * DAY).n,
    online24: one('SELECT COUNT(DISTINCT key) AS n FROM devices WHERE last_seen >= ?', t - DAY).n,
    revenue30: sum(t - 30 * DAY).s,
    revenue: sum(0).s,
    resets30: sum(t - 30 * DAY, 'reset').n,
    recent: db.prepare(`SELECT l.key, l.email, l.plan, l.status, l.expires_at, l.created_at, l.provider,
                          (SELECT COUNT(*) FROM devices d WHERE d.key = l.key) AS devices,
                          (SELECT MAX(last_seen) FROM devices d WHERE d.key = l.key) AS last_seen
                        FROM licenses l ORDER BY l.created_at DESC LIMIT 100`).all()
  });
});
app.get('/api/admin/licenses/:key', admin, (req, res) => {
  const key = normKey(req.params.key);
  const l = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  if (!l) return res.status(404).json({ error: 'not_found' });
  res.json({ ...l, devices: db.prepare('SELECT hwid, parts, first_seen, last_seen, app FROM devices WHERE key = ?').all(key) });
});
app.post('/api/admin/reset-device', admin, (req, res) => {
  const r = db.prepare('DELETE FROM devices WHERE key = ?').run(normKey(req.body && req.body.key));
  res.json({ removed: r.changes });
});
app.post('/api/admin/revoke', admin, (req, res) => {
  const r = db.prepare("UPDATE licenses SET status = 'revoked' WHERE key = ?").run(normKey(req.body && req.body.key));
  res.json({ updated: r.changes });
});

// ───── тестовая оплата (DEV_FAKE_PAY=1) ─────
if (CFG.devPay) {
  console.warn('ВНИМАНИЕ: включена тестовая оплата DEV_FAKE_PAY=1 — ключи выдаются без денег!');
  app.get('/dev-pay', (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE ref = ?').get(String(req.query.ref));
    if (!o) return res.status(404).send('Заказ не найден');
    res.send(`<!doctype html><meta charset="utf-8"><title>Тестовая оплата</title>
<body style="font:16px system-ui;background:#0A0A0D;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<form method="post" style="background:#17171D;padding:28px;border-radius:18px;max-width:360px">
<h2 style="margin-top:0">Тестовая оплата</h2><p>Тариф: <b>${o.plan}</b>, ${o.amount} ₽</p>
<p style="color:#999">Это заглушка для проверки. Настоящие деньги не списываются.</p>
<button style="background:#E5242F;color:#fff;border:0;padding:12px 18px;border-radius:12px;font-size:15px">Оплатить (тест)</button></form>`);
  });
  app.post('/dev-pay', express.urlencoded({ extended: false }), (req, res) => {
    try { markPaid(String(req.query.ref)); res.redirect(`${CFG.site}/success.html?ref=${encodeURIComponent(req.query.ref)}`); }
    catch (e) { res.status(404).send(e.message); }
  });
}

// ───── сайт и файл программы ─────
app.get('/download', (req, res) => {
  if (!fs.existsSync(CFG.downloadFile)) return res.status(404).send('Файл не найден');
  res.download(CFG.downloadFile, 'install-TweakMacro.bat');
});
if (fs.existsSync(CFG.siteDir)) app.use(express.static(CFG.siteDir, { extensions: ['html'] }));

if (require.main === module) {
  app.listen(CFG.port, () => {
    console.log(`TweakMacro server: http://localhost:${CFG.port}`);
    console.log(`  ЮKassa: ${ykOn ? 'вкл' : 'выкл'}, письма: ${CFG.resendKey ? 'вкл' : 'выкл'}, тест-оплата: ${CFG.devPay ? 'ВКЛ' : 'выкл'}`);
  });
}
module.exports = { app, db, markPaid, PLANS };
