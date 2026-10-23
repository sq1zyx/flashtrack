// Проверка сервера без реальных платёжных систем: тестовая оплата, привязка к ПК, админка.
const assert = require('assert');
const os = require('os');
const path = require('path');
process.env.DB_FILE = path.join(os.tmpdir(), 'tm-test-' + Date.now() + '.sqlite');
process.env.DEV_FAKE_PAY = '1';
process.env.ADMIN_TOKEN = 'admin-test-token-123';
process.env.SITE_URL = 'http://site.test';
const { app, db } = require('./server');

(async () => {
  const srv = app.listen(0);
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (u, b, h = {}) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) });
  try {
    // 1. заказ и тестовая оплата
    let r = await post('/api/checkout', { plan: 'm3', email: 'Test@Mail.ru', lang: 'ru' });
    let j = await r.json();
    assert.ok(j.url.includes('/dev-pay?ref='), 'checkout url');
    const ref = new URL(j.url).searchParams.get('ref');
    assert.equal((await (await fetch(base + '/api/order/' + ref)).json()).status, 'pending');
    r = await fetch(base + '/dev-pay?ref=' + ref, { method: 'POST', redirect: 'manual' });
    assert.equal(r.status, 302);
    j = await (await fetch(base + '/api/order/' + ref)).json();
    assert.equal(j.status, 'paid'); assert.match(j.key, /^TM-[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/); assert.equal(j.plan, 'm3');
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
    j = await (await post('/api/license/activate', { key: 'TM-AAAA-BBBB-CCCC-DDDD', hwid: 'PC-A' })).json(); assert.equal(j.error, 'invalid_key');
    console.log('✓ активация, привязка к ПК, сброс');

    // 3. истечение срока
    db.prepare('UPDATE licenses SET expires_at = ? WHERE key = ?').run(Date.now() - 1000, key);
    j = await (await post('/api/license/activate', { key, hwid: 'PC-B' })).json(); assert.equal(j.error, 'expired');
    console.log('✓ просроченный ключ не принимается');

    // 4. ошибки ввода и админка
    assert.equal((await post('/api/checkout', { plan: 'x', email: 'a@b.cc' })).status, 400);
    assert.equal((await post('/api/checkout', { plan: 'm1', email: 'bad' })).status, 400);
    assert.equal((await post('/api/admin/licenses', { plan: 'life' })).status, 401);
    j = await (await post('/api/admin/licenses', { plan: 'life', email: 'friend@x.io' }, { Authorization: 'Bearer admin-test-token-123' })).json();
    const life = j.key;
    j = await (await post('/api/license/activate', { key: life, hwid: 'PC-Z' })).json(); assert.equal(j.valid, true); assert.equal(j.expires, null);
    console.log('✓ проверки ввода, ручной вечный ключ');

    // 6. покупка из лаунчера: ключ сразу привязан к ПК, допуск к смене одной детали
    const P = { mg: 'a'.repeat(64), vol: 'b'.repeat(64), cpu: 'c'.repeat(64), board: 'd'.repeat(64) };
    j = await (await post('/api/checkout', { plan: 'm1', email: 'app@x.io', hwid: 'HW-1', parts: P })).json();
    assert.ok(j.ref && j.url, 'checkout returns ref');
    await fetch(base + '/dev-pay?ref=' + j.ref, { method: 'POST', redirect: 'manual' });
    const ak = (await (await fetch(base + '/api/order/' + j.ref)).json()).key;
    j = await (await post('/api/license/activate', { key: ak, hwid: 'HW-OTHER', parts: { mg: 'e'.repeat(64) } })).json();
    assert.equal(j.error, 'other_device', 'bound to buyer PC at payment');
    j = await (await post('/api/license/activate', { key: ak, hwid: 'HW-1b', parts: { ...P, vol: 'f'.repeat(64), board: '1'.repeat(64) } })).json();
    assert.equal(j.valid, true, 'same PC after 2 parts changed');
    j = await (await post('/api/license/activate', { key: ak, hwid: 'HW-1c', parts: { ...P, vol: 'f'.repeat(64), board: '1'.repeat(64), cpu: '2'.repeat(64) } })).json();
    assert.equal(j.valid, true, 'parts updated after previous match');
    console.log('✓ автовыдача в лаунчер, привязка при оплате, смена железа');

    // 7. платный сброс привязки: ключ переезжает на ПК, с которого куплен сброс
    j = await (await post('/api/checkout', { plan: 'reset', email: 'app@x.io', renew_key: 'TM-AAAA-BBBB-CCCC-DDDD', hwid: 'HW-NEW' })).json();
    assert.equal(j.error, 'invalid_key');
    j = await (await post('/api/checkout', { plan: 'reset', email: 'app@x.io', renew_key: ak, hwid: 'HW-NEW' })).json();
    let o = db.prepare('SELECT amount, plan FROM orders WHERE ref = ?').get(j.ref);
    assert.equal(o.amount, 279); assert.equal(o.plan, 'reset');
    j = await (await post('/api/license/activate', { key: ak, hwid: 'HW-NEW' })).json(); assert.equal(j.error, 'other_device', 'not moved before payment');
    const rref = db.prepare("SELECT ref FROM orders WHERE plan = 'reset'").get().ref;
    await fetch(base + '/dev-pay?ref=' + rref, { method: 'POST', redirect: 'manual' });
    assert.equal((await (await fetch(base + '/api/order/' + rref)).json()).key, ak);
    j = await (await post('/api/license/activate', { key: ak, hwid: 'HW-NEW' })).json(); assert.equal(j.valid, true);
    j = await (await post('/api/license/activate', { key: ak, hwid: 'HW-1' })).json(); assert.equal(j.error, 'other_device');
    // с сайта: без ПК — привязка снимается, ключ берёт первый ПК, где его активируют
    j = await (await post('/api/checkout', { plan: 'reset', email: 'app@x.io', renew_key: ak })).json();
    await fetch(base + '/dev-pay?ref=' + j.ref, { method: 'POST', redirect: 'manual' });
    o = await (await fetch(base + '/api/order/' + j.ref)).json(); assert.equal(o.kind, 'reset'); assert.equal(o.key, ak);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices WHERE key = ?').get(ak).n, 0);
    j = await (await post('/api/license/activate', { key: ak, hwid: 'HW-NEW' })).json(); assert.equal(j.valid, true);
    console.log('✓ сброс привязки за 279 ₽');

    // 7b. продление из лаунчера сохраняет ключ и добавляет срок
    const before = db.prepare('SELECT expires_at FROM licenses WHERE key = ?').get(ak).expires_at;
    j = await (await post('/api/checkout', { plan: 'm3', email: 'app@x.io', hwid: 'HW-NEW', renew_key: ak })).json();
    await fetch(base + '/dev-pay?ref=' + j.ref, { method: 'POST', redirect: 'manual' });
    j = await (await fetch(base + '/api/order/' + j.ref)).json();
    assert.equal(j.key, ak, 'same key after renewal');
    const after = db.prepare('SELECT expires_at, plan FROM licenses WHERE key = ?').get(ak);
    assert.equal(Math.round((after.expires_at - before) / 86400000), 92); assert.equal(after.plan, 'm3');
    console.log('✓ продление того же ключа');

    // 7c. статистика для админ-вкладки
    assert.equal((await fetch(base + '/api/admin/stats')).status, 401);
    j = await (await fetch(base + '/api/admin/stats', { headers: { Authorization: 'Bearer admin-test-token-123' } })).json();
    assert.ok(j.active >= 2 && j.people >= 2 && j.by_plan.life >= 1 && Array.isArray(j.recent), 'stats');
    j = await (await fetch(base + '/api/plans')).json(); assert.equal(j.reset, 279); assert.equal(j.plans.m1.rub, 849); assert.ok(!('usd' in j.plans.m1));
    console.log('✓ статистика подписок для админа');

    // 8. обновления
    j = await (await fetch(base + '/api/app/manifest')).json();
    assert.match(j.version, /^\d+\.\d+/); assert.ok(j.files.some(f => f.name === 'TweakMacro.ahk' && f.sha256.length === 64));
    assert.equal((await fetch(base + '/app/server.js')).status, 404);
    assert.equal((await fetch(base + '/app/ui.html')).status, 200);
    console.log('✓ манифест обновлений', j.version);
    console.log('\nВСЕ ПРОВЕРКИ ПРОШЛИ');
  } finally {
    srv.close();
  }
})().catch(e => { console.error('ОШИБКА:', e); process.exit(1); });
