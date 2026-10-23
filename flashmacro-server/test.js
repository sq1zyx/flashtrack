// Проверка сервера без реальных платёжных систем: тестовая оплата и подписанный вебхук Stripe.
const assert = require('assert');
const os = require('os');
const path = require('path');
process.env.DB_FILE = path.join(os.tmpdir(), 'fm-test-' + Date.now() + '.sqlite');
process.env.DEV_FAKE_PAY = '1';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.ADMIN_TOKEN = 'admin-test-token-123';
process.env.SITE_URL = 'http://site.test';
const { app, db } = require('./server');
const Stripe = require('stripe');

(async () => {
  const srv = app.listen(0);
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (u, b, h = {}) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) });
  try {
    // 1. заказ и тестовая оплата
    let r = await post('/api/checkout', { plan: 'm3', currency: 'rub', email: 'Test@Mail.ru', lang: 'ru' });
    let j = await r.json();
    assert.ok(j.url.includes('/dev-pay?ref='), 'checkout url');
    const ref = new URL(j.url).searchParams.get('ref');
    assert.equal((await (await fetch(base + '/api/order/' + ref)).json()).status, 'pending');
    r = await fetch(base + '/dev-pay?ref=' + ref, { method: 'POST', redirect: 'manual' });
    assert.equal(r.status, 302);
    j = await (await fetch(base + '/api/order/' + ref)).json();
    assert.equal(j.status, 'paid'); assert.match(j.key, /^FM-[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/); assert.equal(j.plan, 'm3');
    const days = (new Date(j.expires) - Date.now()) / 86400000;
    assert.ok(days > 91 && days < 93, '3 months ≈ 92 days');
    const key = j.key;
    console.log('✓ оплата → ключ', key);

    // 2. активация, второй ПК, сброс привязки
    j = await (await post('/api/license/activate', { key: key.toLowerCase(), hwid: 'PC-A' })).json();
    assert.equal(j.valid, true); assert.equal(j.plan, 'm3');
    j = await (await post('/api/license/activate', { key, hwid: 'PC-A' })).json(); assert.equal(j.valid, true);
    j = await (await post('/api/license/activate', { key, hwid: 'PC-B' })).json(); assert.equal(j.error, 'other_device');
    j = await (await post('/api/admin/reset-device', { key }, { Authorization: 'Bearer admin-test-token-123' })).json(); assert.equal(j.removed, 1);
    j = await (await post('/api/license/activate', { key, hwid: 'PC-B' })).json(); assert.equal(j.valid, true);
    j = await (await post('/api/license/activate', { key: 'FM-AAAA-BBBB-CCCC-DDDD', hwid: 'PC-A' })).json(); assert.equal(j.error, 'invalid_key');
    console.log('✓ активация, привязка к ПК, сброс');

    // 3. истечение срока
    db.prepare('UPDATE licenses SET expires_at = ? WHERE key = ?').run(Date.now() - 1000, key);
    j = await (await post('/api/license/activate', { key, hwid: 'PC-B' })).json(); assert.equal(j.error, 'expired');
    console.log('✓ просроченный ключ не принимается');

    // 4. ошибки ввода и админка
    assert.equal((await post('/api/checkout', { plan: 'x', currency: 'usd', email: 'a@b.cc' })).status, 400);
    assert.equal((await post('/api/checkout', { plan: 'm1', currency: 'usd', email: 'bad' })).status, 400);
    assert.equal((await post('/api/admin/licenses', { plan: 'life' })).status, 401);
    j = await (await post('/api/admin/licenses', { plan: 'life', email: 'friend@x.io' }, { Authorization: 'Bearer admin-test-token-123' })).json();
    const life = j.key;
    j = await (await post('/api/license/activate', { key: life, hwid: 'PC-Z' })).json(); assert.equal(j.valid, true); assert.equal(j.expires, null);
    console.log('✓ проверки ввода, ручной вечный ключ');

    // 5. вебхук Stripe: оплата подписки и продление
    db.prepare("INSERT INTO orders (ref, provider, plan, currency, amount, email, lang, created_at) VALUES ('stripe-ref', 'stripe', 'm1', 'usd', 899, 's@x.io', 'en', ?)").run(Date.now());
    const stripe = Stripe('sk_test_dummy');
    const send = async ev => {
      const payload = JSON.stringify(ev);
      const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret' });
      return fetch(base + '/webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body: payload });
    };
    r = await send({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'subscription', payment_status: 'paid', subscription: 'sub_1', metadata: { ref: 'stripe-ref' } } } });
    assert.equal(r.status, 200);
    const sk = db.prepare("SELECT * FROM licenses WHERE sub_id = 'sub_1'").get();
    assert.ok(sk && sk.plan === 'm1');
    const exp1 = sk.expires_at;
    await send({ id: 'evt_2', type: 'invoice.paid', data: { object: { billing_reason: 'subscription_cycle', subscription: 'sub_1' } } });
    const exp2 = db.prepare("SELECT expires_at FROM licenses WHERE sub_id = 'sub_1'").get().expires_at;
    assert.ok(Math.round((exp2 - exp1) / 86400000) === 31, 'renewal +31d');
    await send({ id: 'evt_2', type: 'invoice.paid', data: { object: { billing_reason: 'subscription_cycle', subscription: 'sub_1' } } });
    assert.equal(db.prepare("SELECT expires_at FROM licenses WHERE sub_id = 'sub_1'").get().expires_at, exp2, 'duplicate event ignored');
    r = await fetch(base + '/webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=bad' }, body: '{}' });
    assert.equal(r.status, 400);
    console.log('✓ вебхук Stripe: подпись, оплата, продление, защита от повторов');
    console.log('\nВСЕ ПРОВЕРКИ ПРОШЛИ');
  } finally {
    srv.close();
  }
})().catch(e => { console.error('ОШИБКА:', e); process.exit(1); });
