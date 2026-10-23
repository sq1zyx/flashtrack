// Сервер FlashMacro: оплата подписок, выдача ключей и их проверка программой.
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
  stripeKey: env('STRIPE_SECRET_KEY'),
  stripeHook: env('STRIPE_WEBHOOK_SECRET'),
  ykShop: env('YOOKASSA_SHOP_ID'),
  ykKey: env('YOOKASSA_SECRET_KEY'),
  ykReceipts: env('YOOKASSA_RECEIPTS') === '1',
  ykVat: +env('YOOKASSA_VAT_CODE', '1'),
  resendKey: env('RESEND_API_KEY'),
  mailFrom: env('MAIL_FROM', 'FlashMacro <keys@example.com>'),
  adminToken: env('ADMIN_TOKEN'),
  maxDevices: Math.max(1, +env('MAX_DEVICES', '1')),
  devPay: env('DEV_FAKE_PAY') === '1',
  dbFile: env('DB_FILE', path.join(__dirname, 'data.sqlite')),
  siteDir: env('SITE_DIR', path.join(__dirname, '..', 'flashmacro-site')),
  downloadFile: env('DOWNLOAD_FILE', path.join(__dirname, '..', 'macros', 'install-FlashMacro.bat'))
};

// ───── тарифы (цены в центах и рублях) ─────
const PLANS = {
  m1: { days: 31, usd: 899, rub: 849, months: 1, name: { ru: 'FlashMacro — 1 месяц', en: 'FlashMacro — 1 month' } },
  m3: { days: 92, usd: 1999, rub: 1890, months: 3, name: { ru: 'FlashMacro — 3 месяца', en: 'FlashMacro — 3 months' } },
  life: { days: null, usd: 4999, rub: 4790, months: 0, name: { ru: 'FlashMacro — навсегда', en: 'FlashMacro — lifetime' } }
};

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

const now = () => Date.now();
const DAY = 86400000;
const KEY_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newKey() {
  const b = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += KEY_ABC[b[i] % KEY_ABC.length];
  return 'FM-' + s.match(/.{4}/g).join('-');
}
const normKey = k => String(k || '').trim().toUpperCase();

function licenseView(l) {
  return {
    plan: l.plan,
    expires: l.expires_at ? new Date(l.expires_at).toISOString() : null,
    expires_unix: l.expires_at ? Math.floor(l.expires_at / 1000) : 0,
    auto_renew: !!l.auto_renew
  };
}

// Выдать ключ по оплаченному заказу (повторный вызов ничего не дублирует)
function markPaid(ref, extra = {}) {
  const o = db.prepare('SELECT * FROM orders WHERE ref = ?').get(ref);
  if (!o) throw new Error('order not found: ' + ref);
  if (o.status === 'paid' && o.license_key) return o.license_key;
  const plan = PLANS[o.plan];
  const key = newKey();
  db.transaction(() => {
    db.prepare(`INSERT INTO licenses (key, email, plan, expires_at, provider, sub_id, auto_renew, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, o.email, o.plan, plan.days ? now() + plan.days * DAY : null, o.provider, extra.subId || null, extra.subId ? 1 : 0, now());
    db.prepare("UPDATE orders SET status = 'paid', license_key = ?, paid_at = ?, provider_id = COALESCE(?, provider_id) WHERE ref = ?")
      .run(key, now(), extra.providerId || null, ref);
  })();
  sendKeyMail(o.email, key, o.plan, o.lang).catch(e => console.error('mail:', e.message));
  console.log(`[paid] ${ref} ${o.plan} ${o.currency} → ${key}`);
  return key;
}

// Продление подписки Stripe при очередном списании
function extendBySub(subId) {
  const l = db.prepare('SELECT * FROM licenses WHERE sub_id = ?').get(subId);
  if (!l) return;
  const plan = PLANS[l.plan];
  if (!plan.days) return;
  const base = Math.max(now(), l.expires_at || 0);
  db.prepare('UPDATE licenses SET expires_at = ?, auto_renew = 1 WHERE key = ?').run(base + plan.days * DAY, l.key);
  console.log(`[renew] ${l.key} +${plan.days}d`);
}

async function sendKeyMail(to, key, planId, lang) {
  if (!CFG.resendKey || !to) return;
  const ru = lang !== 'en';
  const plan = PLANS[planId].name[ru ? 'ru' : 'en'];
  const html = ru
    ? `<p>Спасибо за покупку <b>${plan}</b>!</p><p>Твой ключ: <b style="font-size:18px">${key}</b></p><p>Открой FlashMacro → вкладка «Подписка» → вставь ключ → «Активировать».</p><p>Скачать программу: <a href="${CFG.site}/download">${CFG.site}/download</a></p>`
    : `<p>Thanks for buying <b>${plan}</b>!</p><p>Your key: <b style="font-size:18px">${key}</b></p><p>Open FlashMacro → “License” tab → paste the key → “Activate”.</p><p>Download: <a href="${CFG.site}/download">${CFG.site}/download</a></p>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CFG.resendKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: CFG.mailFrom, to: [to], subject: ru ? 'Твой ключ FlashMacro' : 'Your FlashMacro key', html })
  });
  if (!r.ok) throw new Error('resend ' + r.status + ' ' + (await r.text()));
}

// ───── платёжные системы ─────
const stripe = CFG.stripeKey ? require('stripe')(CFG.stripeKey) : null;
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

async function createCheckout({ planId, currency, email, lang }) {
  const plan = PLANS[planId];
  const ref = crypto.randomUUID();
  const amount = currency === 'usd' ? plan.usd : plan.rub;
  const success = `${CFG.site}/success.html?ref=${ref}`;
  const cancel = `${CFG.site}/#pricing`;
  const name = plan.name[lang === 'en' ? 'en' : 'ru'];
  const insert = provider => db.prepare('INSERT INTO orders (ref, provider, plan, currency, amount, email, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ref, provider, planId, currency, amount, email, lang, now());

  if (CFG.devPay) {
    insert('dev');
    return `${CFG.site}/dev-pay?ref=${ref}`;
  }
  if (currency === 'usd') {
    if (!stripe) throw Object.assign(new Error('Оплата в долларах ещё не подключена'), { code: 'not_configured' });
    insert('stripe');
    const recurring = plan.months ? { interval: 'month', interval_count: plan.months } : undefined;
    const s = await stripe.checkout.sessions.create({
      mode: recurring ? 'subscription' : 'payment',
      customer_email: email,
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: plan.usd, product_data: { name }, ...(recurring ? { recurring } : {}) } }],
      success_url: success,
      cancel_url: cancel,
      locale: lang === 'en' ? 'en' : 'auto',
      metadata: { ref, plan: planId },
      ...(recurring ? { subscription_data: { metadata: { ref, plan: planId } } } : {})
    });
    db.prepare('UPDATE orders SET provider_id = ? WHERE ref = ?').run(s.id, ref);
    return s.url;
  }
  if (!ykOn) throw Object.assign(new Error('Оплата в рублях ещё не подключена'), { code: 'not_configured' });
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
  return p.confirmation.confirmation_url;
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

// Вебхук Stripe — нужен «сырой» body для проверки подписи, поэтому до express.json()
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !CFG.stripeHook) return res.status(503).end();
  let ev;
  try { ev = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], CFG.stripeHook); }
  catch (e) { return res.status(400).send('bad signature'); }
  if (db.prepare('SELECT 1 FROM events WHERE id = ?').get(ev.id)) return res.json({ ok: true });
  try {
    const o = ev.data.object;
    if (ev.type === 'checkout.session.completed' && o.metadata && o.metadata.ref && (o.payment_status === 'paid' || o.mode === 'subscription')) {
      markPaid(o.metadata.ref, { subId: o.subscription || null, providerId: o.id });
    } else if (ev.type === 'invoice.paid' && o.billing_reason === 'subscription_cycle' && o.subscription) {
      extendBySub(typeof o.subscription === 'string' ? o.subscription : o.subscription.id);
    } else if (ev.type === 'customer.subscription.deleted') {
      db.prepare('UPDATE licenses SET auto_renew = 0 WHERE sub_id = ?').run(o.id);
    }
    db.prepare('INSERT INTO events (id, at) VALUES (?, ?)').run(ev.id, now());
    res.json({ ok: true });
  } catch (e) {
    console.error('stripe webhook:', e.message);
    res.status(500).end();
  }
});

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
    plans: Object.fromEntries(Object.entries(PLANS).map(([id, p]) => [id, { usd: p.usd / 100, rub: p.rub, months: p.months }])),
    methods: { usd: !!stripe || CFG.devPay, rub: ykOn || CFG.devPay }
  });
});

app.post('/api/checkout', limit(20), async (req, res) => {
  const { plan, currency, email, lang } = req.body || {};
  if (!PLANS[plan]) return res.status(400).json({ error: 'bad_plan' });
  if (currency !== 'usd' && currency !== 'rub') return res.status(400).json({ error: 'bad_currency' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || ''))) return res.status(400).json({ error: 'bad_email' });
  try {
    const url = await createCheckout({ planId: plan, currency, email: String(email).trim().toLowerCase(), lang: lang === 'en' ? 'en' : 'ru' });
    res.json({ url });
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
  const key = normKey(req.body && req.body.key), hwid = String((req.body && req.body.hwid) || '').slice(0, 128);
  if (!key || !hwid) return res.status(400).json({ valid: false, error: 'bad_request' });
  const l = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
  if (!l || l.status !== 'active') return res.json({ valid: false, error: 'invalid_key' });
  if (l.expires_at && l.expires_at < now()) return res.json({ valid: false, error: 'expired', ...licenseView(l) });
  const known = db.prepare('SELECT 1 FROM devices WHERE key = ? AND hwid = ?').get(key, hwid);
  if (!known) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE key = ?').get(key).n;
    if (n >= CFG.maxDevices) return res.json({ valid: false, error: 'other_device' });
    db.prepare('INSERT INTO devices (key, hwid, first_seen, last_seen, app) VALUES (?, ?, ?, ?, ?)').run(key, hwid, now(), now(), String(req.body.app || ''));
  } else {
    db.prepare('UPDATE devices SET last_seen = ?, app = ? WHERE key = ? AND hwid = ?').run(now(), String(req.body.app || ''), key, hwid);
  }
  res.json({ valid: true, ...licenseView(l) });
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
<h2 style="margin-top:0">Тестовая оплата</h2><p>Тариф: <b>${o.plan}</b>, ${o.currency === 'usd' ? '$' + (o.amount / 100).toFixed(2) : o.amount + ' ₽'}</p>
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
  res.download(CFG.downloadFile, 'install-FlashMacro.bat');
});
if (fs.existsSync(CFG.siteDir)) app.use(express.static(CFG.siteDir, { extensions: ['html'] }));

if (require.main === module) {
  app.listen(CFG.port, () => {
    console.log(`FlashMacro server: http://localhost:${CFG.port}`);
    console.log(`  Stripe: ${stripe ? 'вкл' : 'выкл'}, ЮKassa: ${ykOn ? 'вкл' : 'выкл'}, письма: ${CFG.resendKey ? 'вкл' : 'выкл'}, тест-оплата: ${CFG.devPay ? 'ВКЛ' : 'выкл'}`);
  });
}
module.exports = { app, db, markPaid, PLANS };
