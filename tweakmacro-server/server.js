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
  appDir: env('APP_DIR', path.join(__dirname, '..', 'macros')),
  trialDays: Math.max(0, +env('TRIAL_DAYS', '3')),
  refBonusDays: Math.max(0, +env('REF_BONUS_DAYS', '7')),
  refFriendDays: Math.max(0, +env('REF_FRIEND_DAYS', '3')),
  tgToken: env('TELEGRAM_BOT_TOKEN'),
  tgOwners: env('TELEGRAM_OWNER_IDS').split(',').map(x => x.trim()).filter(Boolean),
  tgApi: env('TELEGRAM_API', 'https://api.telegram.org').replace(/\/$/, '')
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
CREATE TABLE IF NOT EXISTS promos (
  code TEXT PRIMARY KEY, kind TEXT NOT NULL, value INTEGER NOT NULL, max_uses INTEGER DEFAULT 0, used INTEGER DEFAULT 0,
  expires_at INTEGER, active INTEGER DEFAULT 1, created_at INTEGER);
CREATE TABLE IF NOT EXISTS trials (hwid TEXT, parts TEXT, key TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS news (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at INTEGER);
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, last_at INTEGER, count INTEGER DEFAULT 1,
  app TEXT, hwid TEXT, key TEXT, message TEXT, what TEXT, line TEXT, extra TEXT);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, hwid TEXT, email TEXT, text TEXT, app TEXT,
  created_at INTEGER, answer TEXT, answered_at INTEGER);
CREATE TABLE IF NOT EXISTS shares (code TEXT PRIMARY KEY, data TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS cloud (key TEXT PRIMARY KEY, data TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);
// Колонки, добавленные позже: дописываем в старую базу, если их нет
for (const [table, col, def] of [['devices', 'parts', 'TEXT'], ['orders', 'hwid', 'TEXT'], ['orders', 'parts', 'TEXT'],
  ['orders', 'source', 'TEXT'], ['orders', 'renew_key', 'TEXT'], ['licenses', 'last_transfer', 'INTEGER'], ['licenses', 'transfers', 'INTEGER DEFAULT 0'],
  ['licenses', 'ref_code', 'TEXT'], ['licenses', 'referred_by', 'TEXT'], ['orders', 'promo', 'TEXT'], ['orders', 'ref_code', 'TEXT'],
  ['orders', 'base_amount', 'INTEGER'], ['orders', 'bonus_days', 'INTEGER DEFAULT 0']]) {
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
function randCode(prefix, n) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += KEY_ABC[b[i] % KEY_ABC.length];
  return prefix + s;
}
const kvGet = k => { const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? r.v : null; };
const kvSet = (k, v) => db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, String(v));

// Уведомления владельцу в Telegram (бот подключается в bot.js); без бота — просто в лог
let notify = text => console.log('[notify]', text.replace(/<[^>]+>/g, ''));
const setNotifier = fn => { notify = fn; };
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const maskEmail = e => e ? String(e).replace(/^(.{2})[^@]*/, '$1***') : '—';
const fmtDate = ms => ms ? new Date(ms).toISOString().slice(0, 10).split('-').reverse().join('.') : 'без срока';

// Код для друзей: у каждого ключа свой, создаётся при первой проверке
function refCodeFor(key) {
  const l = db.prepare('SELECT ref_code FROM licenses WHERE key = ?').get(key);
  if (!l) return null;
  if (l.ref_code) return l.ref_code;
  let code;
  do code = randCode('R-', 6); while (db.prepare('SELECT 1 FROM licenses WHERE ref_code = ?').get(code));
  db.prepare('UPDATE licenses SET ref_code = ? WHERE key = ?').run(code, key);
  return code;
}
const refCount = code => db.prepare("SELECT COUNT(*) AS n FROM orders WHERE ref_code = ? AND status = 'paid'").get(code).n;

// Добавить дни к ключу (вечный не трогаем)
function addDays(key, days) {
  const l = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  if (!l || !days) return l;
  if (l.plan === 'life' && !l.expires_at) return l;
  const exp = Math.max(now(), l.expires_at || now()) + days * DAY;
  db.prepare('UPDATE licenses SET expires_at = ? WHERE key = ?').run(exp, key);
  return { ...l, expires_at: exp };
}

// Промокод или код друга → цена и бонусы. ownKey — ключ покупателя, чтобы нельзя было ввести свой код друга.
function resolveCode(codeRaw, planId, ownKey) {
  const code = String(codeRaw || '').trim().toUpperCase();
  const base = planId === 'reset' ? HWID_RESET.rub : PLANS[planId] ? PLANS[planId].rub : 0;
  const r = { base, amount: base, bonusDays: 0, promo: null, refCode: null };
  if (!code) return r;
  if (planId === 'reset') return { ...r, error: 'not_for_reset' };
  const p = db.prepare('SELECT * FROM promos WHERE code = ?').get(code);
  if (p) {
    if (!p.active) return { ...r, error: 'not_found' };
    if (p.expires_at && p.expires_at < now()) return { ...r, error: 'expired' };
    if (p.max_uses && p.used >= p.max_uses) return { ...r, error: 'used_up' };
    if (p.kind === 'percent') r.amount = Math.max(1, Math.round(base * (100 - p.value) / 100));
    else r.bonusDays = p.value;
    return { ...r, promo: code, kind: p.kind, value: p.value };
  }
  const owner = db.prepare("SELECT key FROM licenses WHERE ref_code = ? AND status = 'active'").get(code);
  if (owner) {
    if (ownKey && normKey(ownKey) === owner.key) return { ...r, error: 'own_code' };
    return { ...r, refCode: code, kind: 'ref', value: CFG.refFriendDays, bonusDays: CFG.refFriendDays };
  }
  return { ...r, error: 'not_found' };
}

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
    notify(`🔄 <b>Сброс HWID</b> · ${o.amount} ₽\nКлюч: <code>${o.renew_key}</code>\nПочта: ${esc(maskEmail(o.email))}${o.provider === 'dev' ? '\n<i>тестовая оплата</i>' : ''}`);
    return o.renew_key;
  }
  const plan = PLANS[o.plan];
  const afterPaid = key => {
    if (o.bonus_days) addDays(key, o.bonus_days);
    if (o.promo) db.prepare('UPDATE promos SET used = used + 1 WHERE code = ?').run(o.promo);
    let refLine = '';
    if (o.ref_code) {
      const owner = db.prepare('SELECT key FROM licenses WHERE ref_code = ?').get(o.ref_code);
      if (owner && owner.key !== key) {
        addDays(owner.key, CFG.refBonusDays);
        db.prepare('UPDATE licenses SET referred_by = COALESCE(referred_by, ?) WHERE key = ?').run(o.ref_code, key);
        refLine = `\nПо коду друга ${o.ref_code}: другу +${CFG.refBonusDays} дн.`;
      }
    }
    const l = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
    notify(`💰 <b>Продажа</b> · ${esc(plan.name.ru.replace('TweakMacro — ', ''))} · <b>${o.amount} ₽</b>` +
      (o.base_amount && o.base_amount !== o.amount ? ` (без скидки ${o.base_amount} ₽)` : '') +
      `\nКлюч: <code>${key}</code>${o.renew_key ? ' (продление)' : ''}\nПочта: ${esc(maskEmail(o.email))}\nДо: ${fmtDate(l && l.expires_at)}` +
      (o.promo ? `\nПромокод: ${o.promo}` : '') + refLine + (o.provider === 'dev' ? '\n<i>тестовая оплата</i>' : ''));
  };
  // Продление из лаунчера: тот же ключ, срок добавляется к оставшемуся
  const old = o.renew_key && db.prepare("SELECT * FROM licenses WHERE key = ? AND status = 'active'").get(o.renew_key);
  if (old) {
    const exp = !plan.days || !old.expires_at && old.plan === 'life' ? null : Math.max(now(), old.expires_at || 0) + plan.days * DAY;
    db.transaction(() => {
      db.prepare('UPDATE licenses SET plan = ?, expires_at = ?, email = COALESCE(email, ?) WHERE key = ?')
        .run(old.plan === 'life' ? 'life' : o.plan, old.plan === 'life' ? null : exp, o.email, old.key);
      paid(old.key);
    })();
    afterPaid(old.key);
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
  afterPaid(key);
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

async function createCheckout({ planId, email, lang, hwid = '', parts = {}, source = 'site', renewKey = null, price }) {
  const plan = planId === 'reset' ? HWID_RESET : PLANS[planId];
  price = price || { base: plan.rub, amount: plan.rub, bonusDays: 0 };
  const ref = crypto.randomUUID();
  const success = `${CFG.site}/success.html?ref=${ref}`;
  const name = plan.name[lang === 'en' ? 'en' : 'ru'];
  const insert = provider => db.prepare(`INSERT INTO orders (ref, provider, plan, currency, amount, email, lang, created_at, hwid, parts, source, renew_key,
                                           promo, ref_code, base_amount, bonus_days)
                                         VALUES (?, ?, ?, 'rub', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ref, provider, planId, price.amount, email, lang, now(), hwid || null, JSON.stringify(parts), source, renewKey,
      price.promo || null, price.refCode || null, price.base, price.bonusDays || 0);

  if (CFG.devPay) {
    insert('dev');
    return { ref, url: `${CFG.site}/dev-pay?ref=${ref}` };
  }
  if (!ykOn) throw Object.assign(new Error('Оплата ещё не подключена'), { code: 'not_configured' });
  insert('yookassa');
  const value = price.amount.toFixed(2);
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

// Облако и обмен конфигами принимают до 80 КБ, остальное API — до 20 КБ
const jsonSmall = express.json({ limit: '20kb' }), jsonBig = express.json({ limit: '80kb' });
app.use((req, res, next) => (/^\/api\/(cloud|share)/.test(req.path) ? jsonBig : jsonSmall)(req, res, next));
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
    trial_days: CFG.trialDays,
    ref_bonus_days: CFG.refBonusDays,
    ref_friend_days: CFG.refFriendDays,
    enabled: ykOn || CFG.devPay
  });
});

app.post('/api/checkout', limit(20), async (req, res) => {
  const { plan, email, lang, hwid, parts, renew_key, promo } = req.body || {};
  if (!PLANS[plan] && plan !== 'reset') return res.status(400).json({ error: 'bad_plan' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || ''))) return res.status(400).json({ error: 'bad_email' });
  const key = renew_key ? normKey(renew_key) : null;
  const lic = key && db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  // Сброс привязки покупается только для существующего ключа. Из лаунчера ключ сразу переезжает на этот ПК,
  // с сайта — привязка просто снимается, и ключ привяжется к первому ПК, где его активируют
  if (plan === 'reset' && (!lic || lic.status !== 'active')) return res.status(400).json({ error: 'invalid_key' });
  const price = resolveCode(promo, plan, lic ? key : null);
  if (promo && price.error) return res.status(400).json({ error: 'bad_promo', reason: price.error });
  try {
    const r = await createCheckout({ planId: plan, email: String(email).trim().toLowerCase(), lang: lang === 'en' ? 'en' : 'ru',
      hwid: normHwid(hwid), parts: normParts(parts), source: hwid ? 'app' : 'site', renewKey: lic ? key : null, price });
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
  if (o.status !== 'paid') return res.json({ status: 'pending', plan: o.plan, kind: o.plan === 'reset' ? 'reset' : 'buy' });
  const l = db.prepare('SELECT * FROM licenses WHERE key = ?').get(o.license_key);
  res.json({ status: 'paid', key: o.license_key, email: o.email, ...licenseView(l), kind: o.plan === 'reset' ? 'reset' : 'buy' });
});

// Проверка ключа программой. Первый запуск привязывает ключ к ПК.
app.post('/api/license/activate', limit(30), (req, res) => {
  const b = req.body || {}, key = normKey(b.key), hwid = normHwid(b.hwid);
  if (!key || !hwid) return res.status(400).json({ valid: false, error: 'bad_request' });
  const r = checkDevice(key, hwid, normParts(b.parts), b.app);
  if (!r.ok) return res.json({ valid: false, error: r.error, ...(r.license ? licenseView(r.license) : {}) });
  const code = r.license.plan === 'trial' ? '' : refCodeFor(key);
  res.json({ valid: true, ...licenseView(r.license), ref_code: code, ref_count: code ? refCount(code) : 0 });
});

// Проверка промокода или кода друга перед оплатой
app.post('/api/promo/check', limit(30), (req, res) => {
  const b = req.body || {};
  if (!PLANS[b.plan] && b.plan !== 'reset') return res.status(400).json({ valid: false, error: 'bad_plan' });
  const r = resolveCode(b.code, b.plan, b.key);
  if (r.error) return res.json({ valid: false, error: r.error });
  res.json({ valid: true, kind: r.kind, value: r.value, base: r.base, amount: r.amount, bonus_days: r.bonusDays });
});

// Пробный период: один раз на ПК (узнаём ПК так же, как при привязке ключа — 2 совпадения из 4)
app.post('/api/trial', limit(5), (req, res) => {
  const b = req.body || {}, hwid = normHwid(b.hwid), parts = normParts(b.parts);
  if (!hwid) return res.status(400).json({ error: 'bad_request' });
  if (!CFG.trialDays) return res.json({ error: 'trial_off' });
  const used = db.prepare('SELECT * FROM trials').all().some(t => t.hwid === hwid || sameParts(parts, JSON.parse(t.parts || '{}')) >= 2);
  if (used) return res.json({ error: 'trial_used' });
  const key = newKey(), exp = now() + CFG.trialDays * DAY;
  db.transaction(() => {
    db.prepare("INSERT INTO licenses (key, email, plan, expires_at, provider, created_at) VALUES (?, '', 'trial', ?, 'trial', ?)").run(key, exp, now());
    bindDevice(key, hwid, parts, b.app);
    db.prepare('INSERT INTO trials (hwid, parts, key, created_at) VALUES (?, ?, ?, ?)').run(hwid, JSON.stringify(parts), key, now());
  })();
  notify(`🎁 <b>Пробный период</b> на ${CFG.trialDays} дн.\nКлюч: <code>${key}</code>`);
  res.json({ key, plan: 'trial', expires: new Date(exp).toISOString(), expires_unix: Math.floor(exp / 1000) });
});

// Новости для лаунчера
app.get('/api/news', limit(60), (req, res) => {
  res.json({ items: db.prepare('SELECT id, text, created_at AS at FROM news ORDER BY id DESC LIMIT 5').all() });
});

// Отчёт об ошибке из программы. Одинаковые ошибки склеиваются, владельцу — не чаще раза в час на ошибку.
app.post('/api/report', limit(10), (req, res) => {
  const b = req.body || {}, cut = (v, n) => String(v == null ? '' : v).slice(0, n);
  const msg = cut(b.message, 500), line = cut(b.line, 40), what = cut(b.what, 120);
  if (!msg) return res.status(400).json({ error: 'bad_request' });
  const same = db.prepare('SELECT * FROM errors WHERE message = ? AND line = ? AND app = ? ORDER BY id DESC LIMIT 1').get(msg, line, cut(b.app, 20));
  if (same && now() - same.last_at < DAY) {
    db.prepare('UPDATE errors SET count = count + 1, last_at = ? WHERE id = ?').run(now(), same.id);
    if (now() - same.last_at > 3600000) notify(`🐞 Ошибка повторилась (${same.count + 1} раз): ${esc(msg)}`);
  } else {
    const r = db.prepare('INSERT INTO errors (at, last_at, app, hwid, key, message, what, line, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(now(), now(), cut(b.app, 20), cut(b.hwid, 20), cut(b.key, 40), msg, what, line, cut(b.extra, 500));
    notify(`🐞 <b>Ошибка в программе</b> #${r.lastInsertRowid}\n${esc(msg)}\n<code>${esc(what)}</code> строка ${esc(line)} · v${esc(cut(b.app, 20))}`);
  }
  res.json({ ok: true });
});

// Тикеты поддержки: пишутся из лаунчера, отвечаешь в Telegram (ответом на сообщение бота)
app.post('/api/ticket', limit(5), (req, res) => {
  const b = req.body || {}, text = String(b.text || '').trim().slice(0, 2000);
  if (text.length < 3) return res.status(400).json({ error: 'empty' });
  const r = db.prepare('INSERT INTO tickets (key, hwid, email, text, app, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(normKey(b.key).slice(0, 40), normHwid(b.hwid), String(b.email || '').slice(0, 120), text, String(b.app || '').slice(0, 20), now());
  const id = r.lastInsertRowid;
  notify(`💬 <b>Тикет #${id}</b>\n${esc(text)}\n\nКлюч: <code>${esc(normKey(b.key) || '—')}</code> · почта: ${esc(b.email || '—')} · v${esc(b.app || '')}\n<i>Ответь на это сообщение, чтобы ответить пользователю.</i>`);
  res.json({ id });
});
app.post('/api/tickets/list', limit(30), (req, res) => {
  const b = req.body || {}, hwid = normHwid(b.hwid);
  if (!hwid) return res.status(400).json({ error: 'bad_request' });
  res.json({ items: db.prepare('SELECT id, text, created_at AS at, answer, answered_at FROM tickets WHERE hwid = ? ORDER BY id DESC LIMIT 20').all(hwid) });
});

// Облачные профили: настройки хранятся по ключу, доступны только с привязанного ПК
app.post('/api/cloud/:op', limit(20), (req, res) => {
  const b = req.body || {}, key = normKey(b.key), hwid = normHwid(b.hwid);
  if (!key || !hwid) return res.status(400).json({ error: 'bad_request' });
  const r = checkDevice(key, hwid, normParts(b.parts), b.app);
  if (!r.ok) return res.json({ error: r.error });
  if (req.params.op === 'save') {
    const data = String(b.data || '');
    if (!data || data.length > 64000) return res.status(400).json({ error: 'too_big' });
    db.prepare('INSERT OR REPLACE INTO cloud (key, data, updated_at) VALUES (?, ?, ?)').run(key, data, now());
    return res.json({ ok: true, at: now() });
  }
  if (req.params.op === 'load') {
    const c = db.prepare('SELECT data, updated_at FROM cloud WHERE key = ?').get(key);
    return c ? res.json({ data: c.data, at: c.updated_at }) : res.json({ error: 'empty' });
  }
  res.status(404).end();
});

// Обмен конфигами коротким кодом CFG-XXXXXX
app.post('/api/share', limit(10), (req, res) => {
  const data = String((req.body || {}).data || '');
  if (!data || data.length > 64000) return res.status(400).json({ error: 'too_big' });
  let code;
  do code = randCode('CFG-', 6); while (db.prepare('SELECT 1 FROM shares WHERE code = ?').get(code));
  db.prepare('INSERT INTO shares (code, data, created_at) VALUES (?, ?, ?)').run(code, data, now());
  res.json({ code });
});
app.get('/api/share/:code', limit(30), (req, res) => {
  const s = db.prepare('SELECT data FROM shares WHERE code = ?').get(normKey(req.params.code));
  s ? res.json({ data: s.data }) : res.status(404).json({ error: 'not_found' });
});

// ───── обновления программы ─────
// Лаунчер сравнивает версию и хэши файлов и скачивает только изменённые.
const APP_FILES = ['TweakMacro.exe', 'TweakMacro.ahk', 'ui.html', 'launcher.html', 'icon.ico'];
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
  // Что нового: пункты из CHANGELOG.md под заголовком текущей версии
  let changes = [];
  const cl = path.join(CFG.appDir, 'CHANGELOG.md');
  if (m && fs.existsSync(cl)) {
    const sec = fs.readFileSync(cl, 'utf8').split(/^## /m).find(x => x.startsWith(m[1]));
    if (sec) changes = sec.split(/\r?\n/).filter(x => /^\s*[-*] /.test(x)).map(x => x.replace(/^\s*[-*] /, '').trim()).slice(0, 8);
  }
  const data = {
    version: m ? m[1] : '0',
    changes,
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

// ───── админка ─────
// Одни и те же действия доступны из программы (вкладка Admin, заголовок Authorization: Bearer ADMIN_TOKEN) и из Telegram-бота.
const PLAN_NAME = { m1: '1 месяц', m3: '3 месяца', life: 'навсегда', trial: 'пробный' };
const A = {
  stats() {
    const t = now(), one = (sql, ...a) => db.prepare(sql).get(...a);
    const activeWhere = "status = 'active' AND (expires_at IS NULL OR expires_at > ?)";
    const byPlan = {};
    for (const r of db.prepare(`SELECT plan, COUNT(*) AS n FROM licenses WHERE ${activeWhere} GROUP BY plan`).all(t)) byPlan[r.plan] = r.n;
    const sum = (from, plan) => one(`SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS n FROM orders WHERE status = 'paid' AND currency = 'rub' AND provider != 'dev' AND paid_at >= ?${plan ? ' AND plan = ?' : ''}`, from, ...(plan ? [plan] : []));
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const daily = [];
    for (let i = 29; i >= 0; i--) {
      const from = day0.getTime() - i * DAY, r = one("SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS n FROM orders WHERE status = 'paid' AND provider != 'dev' AND paid_at >= ? AND paid_at < ?", from, from + DAY);
      daily.push({ day: new Date(from).toISOString().slice(0, 10), sum: r.s, n: r.n });
    }
    return {
      active: one(`SELECT COUNT(*) AS n FROM licenses WHERE ${activeWhere} AND plan != 'trial'`, t).n,
      people: one(`SELECT COUNT(DISTINCT COALESCE(NULLIF(email, ''), key)) AS n FROM licenses WHERE ${activeWhere} AND plan != 'trial'`, t).n,
      trials: byPlan.trial || 0,
      by_plan: { m1: byPlan.m1 || 0, m3: byPlan.m3 || 0, life: byPlan.life || 0 },
      expired: one("SELECT COUNT(*) AS n FROM licenses WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?", t).n,
      revoked: one("SELECT COUNT(*) AS n FROM licenses WHERE status = 'revoked'").n,
      total: one('SELECT COUNT(*) AS n FROM licenses').n,
      new7: one("SELECT COUNT(*) AS n FROM licenses WHERE created_at >= ? AND plan != 'trial'", t - 7 * DAY).n,
      new30: one("SELECT COUNT(*) AS n FROM licenses WHERE created_at >= ? AND plan != 'trial'", t - 30 * DAY).n,
      expiring7: one(`SELECT COUNT(*) AS n FROM licenses WHERE ${activeWhere} AND expires_at IS NOT NULL AND expires_at < ? AND plan != 'trial'`, t, t + 7 * DAY).n,
      online24: one('SELECT COUNT(DISTINCT key) AS n FROM devices WHERE last_seen >= ?', t - DAY).n,
      revenue_today: sum(day0.getTime()).s,
      revenue7: sum(t - 7 * DAY).s,
      revenue30: sum(t - 30 * DAY).s,
      revenue: sum(0).s,
      sales30: sum(t - 30 * DAY).n,
      resets30: sum(t - 30 * DAY, 'reset').n,
      referrals: one("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND ref_code IS NOT NULL").n,
      tickets_open: one('SELECT COUNT(*) AS n FROM tickets WHERE answer IS NULL').n,
      errors24: one('SELECT COALESCE(SUM(count), 0) AS n FROM errors WHERE last_at >= ?', t - DAY).n,
      daily,
      recent: A.search('')
    };
  },
  search(q) {
    q = String(q || '').trim();
    const like = '%' + q + '%';
    return db.prepare(`SELECT l.key, l.email, l.plan, l.status, l.expires_at, l.created_at, l.provider, l.ref_code,
                         (SELECT COUNT(*) FROM devices d WHERE d.key = l.key) AS devices,
                         (SELECT MAX(last_seen) FROM devices d WHERE d.key = l.key) AS last_seen
                       FROM licenses l ${q ? 'WHERE l.key LIKE ? OR l.email LIKE ? OR l.ref_code LIKE ?' : ''}
                       ORDER BY l.created_at DESC LIMIT 100`).all(...(q ? [like, like, like] : []));
  },
  info(key) {
    key = normKey(key);
    const l = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
    if (!l) return null;
    return { ...l, devices: db.prepare('SELECT hwid, parts, first_seen, last_seen, app FROM devices WHERE key = ?').all(key),
      ref_count: l.ref_code ? refCount(l.ref_code) : 0,
      paid: db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM orders WHERE license_key = ? AND status = 'paid' AND provider != 'dev'").get(key).s };
  },
  create(plan, email, days) {
    if (!PLANS[plan] && plan !== 'trial') return null;
    const key = newKey(), d = days ? +days : plan === 'trial' ? CFG.trialDays : PLANS[plan].days;
    db.prepare('INSERT INTO licenses (key, email, plan, expires_at, provider, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(key, String(email || ''), plan, d ? now() + d * DAY : null, 'manual', now());
    return key;
  },
  extend(key, days) {
    days = Math.round(+days);
    if (!days) return null;
    const l = db.prepare('SELECT * FROM licenses WHERE key = ?').get(normKey(key));
    if (!l) return null;
    if (l.plan === 'life' && !l.expires_at) return l;
    const exp = Math.max(now(), l.expires_at || now()) + days * DAY;
    db.prepare("UPDATE licenses SET expires_at = ?, status = 'active' WHERE key = ?").run(exp, l.key);
    return { ...l, expires_at: exp };
  },
  reset: key => db.prepare('DELETE FROM devices WHERE key = ?').run(normKey(key)).changes,
  revoke: key => db.prepare("UPDATE licenses SET status = 'revoked' WHERE key = ?").run(normKey(key)).changes,
  unrevoke: key => db.prepare("UPDATE licenses SET status = 'active' WHERE key = ?").run(normKey(key)).changes,
  promos: () => db.prepare('SELECT * FROM promos ORDER BY created_at DESC').all(),
  // kind: percent (скидка %) или days (бонусные дни); daysValid — сколько дней код действует (0 — бессрочно)
  promoCreate(code, kind, value, maxUses, daysValid) {
    code = String(code || '').trim().toUpperCase();
    value = Math.round(+value);
    if (!/^[A-Z0-9_-]{3,24}$/.test(code) || /^(R|CFG|TM)-/.test(code)) return { error: 'bad_code' };
    if (kind !== 'percent' && kind !== 'days') return { error: 'bad_kind' };
    if (!(value > 0) || (kind === 'percent' && value > 95) || value > 3650) return { error: 'bad_value' };
    if (db.prepare('SELECT 1 FROM promos WHERE code = ?').get(code)) return { error: 'exists' };
    db.prepare('INSERT INTO promos (code, kind, value, max_uses, used, expires_at, active, created_at) VALUES (?, ?, ?, ?, 0, ?, 1, ?)')
      .run(code, kind, value, Math.max(0, Math.round(+maxUses || 0)), +daysValid > 0 ? now() + daysValid * DAY : null, now());
    return { ok: true, code };
  },
  promoOff: code => db.prepare('UPDATE promos SET active = 0 WHERE code = ?').run(String(code || '').trim().toUpperCase()).changes,
  news: () => db.prepare('SELECT id, text, created_at FROM news ORDER BY id DESC LIMIT 20').all(),
  newsAdd(text) {
    text = String(text || '').trim().slice(0, 1000);
    return text ? db.prepare('INSERT INTO news (text, created_at) VALUES (?, ?)').run(text, now()).lastInsertRowid : null;
  },
  newsDel: id => db.prepare('DELETE FROM news WHERE id = ?').run(+id).changes,
  errors: () => db.prepare('SELECT * FROM errors ORDER BY last_at DESC LIMIT 30').all(),
  tickets: (all) => db.prepare(`SELECT * FROM tickets ${all ? '' : 'WHERE answer IS NULL'} ORDER BY id DESC LIMIT 30`).all(),
  answer(id, text) {
    text = String(text || '').trim().slice(0, 2000);
    if (!text) return 0;
    return db.prepare('UPDATE tickets SET answer = ?, answered_at = ? WHERE id = ?').run(text, now(), +id).changes;
  },
  csv() {
    const rows = db.prepare(`SELECT l.key, l.email, l.plan, l.status, l.expires_at, l.created_at, l.provider, l.ref_code,
                               (SELECT COUNT(*) FROM devices d WHERE d.key = l.key) AS devices,
                               (SELECT COALESCE(SUM(amount), 0) FROM orders o WHERE o.license_key = l.key AND o.status = 'paid' AND o.provider != 'dev') AS paid
                             FROM licenses l ORDER BY l.created_at DESC`).all();
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const d = ms => ms ? new Date(ms).toISOString().slice(0, 10) : '';
    return '﻿key;email;plan;status;expires;created;source;ref_code;devices;paid_rub\r\n' +
      rows.map(r => [r.key, r.email, r.plan, r.status, d(r.expires_at), d(r.created_at), r.provider, r.ref_code, r.devices, r.paid].map(q).join(';')).join('\r\n');
  }
};

function admin(req, res, next) {
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!CFG.adminToken || CFG.adminToken === 'change-me-to-long-random-string' ||
      t.length !== CFG.adminToken.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(CFG.adminToken)))
    return res.status(401).json({ error: 'unauthorized' });
  next();
}
const B = req => req.body || {};
app.get('/api/admin/stats', admin, (req, res) => res.json(A.stats()));
app.get('/api/admin/licenses', admin, (req, res) => res.json(A.search(req.query.q)));
app.get('/api/admin/licenses/:key', admin, (req, res) => { const i = A.info(req.params.key); i ? res.json(i) : res.status(404).json({ error: 'not_found' }); });
app.post('/api/admin/licenses', admin, (req, res) => {
  const key = A.create(B(req).plan || 'life', B(req).email, B(req).days);
  key ? res.json({ key }) : res.status(400).json({ error: 'bad_plan' });
});
app.post('/api/admin/extend', admin, (req, res) => { const l = A.extend(B(req).key, B(req).days); l ? res.json({ ok: true, expires_at: l.expires_at }) : res.status(400).json({ error: 'bad_request' }); });
app.post('/api/admin/reset-device', admin, (req, res) => res.json({ removed: A.reset(B(req).key) }));
app.post('/api/admin/revoke', admin, (req, res) => res.json({ updated: A.revoke(B(req).key) }));
app.post('/api/admin/unrevoke', admin, (req, res) => res.json({ updated: A.unrevoke(B(req).key) }));
app.get('/api/admin/promos', admin, (req, res) => res.json(A.promos()));
app.post('/api/admin/promos', admin, (req, res) => { const r = A.promoCreate(B(req).code, B(req).kind, B(req).value, B(req).max_uses, B(req).days_valid); res.status(r.error ? 400 : 200).json(r); });
app.post('/api/admin/promos/off', admin, (req, res) => res.json({ updated: A.promoOff(B(req).code) }));
app.get('/api/admin/news', admin, (req, res) => res.json(A.news()));
app.post('/api/admin/news', admin, (req, res) => { const id = A.newsAdd(B(req).text); id ? res.json({ id }) : res.status(400).json({ error: 'empty' }); });
app.post('/api/admin/news/delete', admin, (req, res) => res.json({ removed: A.newsDel(B(req).id) }));
app.get('/api/admin/errors', admin, (req, res) => res.json(A.errors()));
app.get('/api/admin/tickets', admin, (req, res) => res.json(A.tickets(req.query.all === '1')));
app.post('/api/admin/tickets/answer', admin, (req, res) => res.json({ updated: A.answer(B(req).id, B(req).text) }));
app.get('/api/admin/export.csv', admin, (req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="tweakmacro-keys.csv"');
  res.send(A.csv());
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
module.exports = { app, db, markPaid, PLANS, A, CFG, kvGet, kvSet, setNotifier };
