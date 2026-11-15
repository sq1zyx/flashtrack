// Мини-приложение: подпись initData, API (state/add/edit/del/water/set/…), и рендер страницы в Chromium (скриншоты).
import bot from '../worker.js';
import { createHmac } from 'node:crypto';
import http from 'node:http';
const TOKEN = '123:TEST';
const store = new Map();
const env = { BOT_TOKEN: TOKEN, WEBHOOK_SECRET: 'sec', DB: { get: async (k) => store.get(k) ?? null, put: async (k, v) => store.set(k, v) },
  AI: { run: async () => ({ response: '{"items":[{"name":"шаурма","grams":350,"kcal":770,"protein":35,"fat":35,"carbs":77}]}' }) } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, o) => { if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, o); return { ok: true, json: async () => ({ ok: true, result: {} }) }; };
const sign = (user) => {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'q', user: JSON.stringify(user) });
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
};
const assert = (c, t) => { if (!c) { console.error('❌', t); process.exitCode = 1; } else console.log('✔', t); };
const initData = sign({ id: 42, first_name: 'Тест' });
const api = async (action, extra = {}) => (await bot.fetch(new Request('https://x/api', { method: 'POST', body: JSON.stringify({ initData, action, ...extra }) }), env)).json();
const msg = (text) => bot.fetch(new Request('https://x/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'sec' }, body: JSON.stringify({ message: { chat: { id: 42 }, from: { first_name: 'Тест' }, text } }) }), env);

await msg('/start');
for (const a of ['6:30', '9:00', '8:30', 'нет', 'пн ср пт 17:00', '15:00']) await msg(a);
const bad = await (await bot.fetch(new Request('https://x/api', { method: 'POST', body: JSON.stringify({ initData: initData.replace(/hash=[0-9a-f]+/, 'hash=' + 'ab'.repeat(32)), action: 'state' }) }), env)).json();
assert(bad.error === 'auth', 'поддельная подпись отклонена');
let r = await api('state');
assert(r.state && r.state.target === 3050, 'state: норма 3050');
r = await api('add', { fi: 0, g: 250 });
assert(r.state.items.length === 1 && r.state.items[0].k === 275, 'add из базы: гречка 250 = 275');
r = await api('add', { text: 'курица 180, шаурма' });
assert(r.state.items.length === 3, 'add текстом + ИИ для шаурмы');
r = await api('edit', { i: 0, g: 125 });
assert(r.state.items[0].k === 138 || r.state.items[0].k === 137, 'edit граммов пересчитал ккал');
const delIt = r.state.items[1];
r = await api('del', { i: 1 });
assert(r.state.items.length === 2, 'del');
r = await api('restore', { item: delIt }); assert(r.state.items.length === 3 && r.state.items.some((x) => x.name === delIt.name), 'вернуть удалённое');
r = await api('del', { i: r.state.items.findIndex((x) => x.name === delIt.name) });
r = await api('photo', { img: 'A'.repeat(400) });
assert(r.ai && /шаурма/.test(r.ai[0].name) && r.ai[0].k === 770, 'фото еды из приложения → список от ИИ');
const nBefore = r.state.items.length;
r = await api('additems', { items: [{ name: 'шаурма', g: 350, u: 'г', k: 770, p: 35, fat: 35, c: 77 }, { name: 'взлом', g: 1, k: 99999 }] });
assert(r.state.items.length === nBefore + 2 && r.state.items.at(-1).k === 3000, 'additems: запись + ограничение значений');
r = await api('del', { i: r.state.items.length - 1 }); r = await api('del', { i: r.state.items.length - 1 });
r = await api('water', { ml: 500 }); assert(r.state.water.ml === 500, 'water');
r = await api('steps', { n: 12000 }); r = await api('weight', { kg: 117.6 }); r = await api('sleep', { q: 2 });
r = await api('set', { key: 'squat', w: 60, r: 8 }); r = await api('set', { key: 'squat', w: 60, r: 8 });
assert(r.state.workout.list.find((x) => x.key === 'squat').today.length === 2, 'подходы из приложения');
r = await api('unset', { key: 'squat' }); assert(r.state.workout.list.find((x) => x.key === 'squat').today.length === 1, 'unset');
r = await api('note', { t: 'болел живот' }); assert(r.state.notes.length === 1, 'заметка');
r = await api('remind', { g: 'water' }); assert(r.state.settings.off.includes('water'), 'выключить напоминания о воде');
r = await api('quiet', { from: '22:30', to: '07:00' }); assert(r.state.settings.quiet.from === 1350, 'тихие часы');
r = await api('settings', { patch: { goalWeight: 100, proteinGoal: 160, waterGoal: 3000, gymDays: [1, 4], gymLead: 30, bedLead: 45, waterReminders: 4, sex: 'm', ui: { accent: '#8b5cf6', hide: ['plan'] } } });
assert(r.state.profile.goalWeight === 100 && r.state.macros.p === 160 && r.state.water.goal === 3000 && r.state.ui.accent === '#8b5cf6', 'настройки сохраняются');
r = await api('settings', { patch: { kcalOverride: 1500 } });
assert(r.msg && !r.state.profile.kcalOverride, 'норму ниже 2200 не ставит');
r = await api('settings', { patch: { kcalAdjust: -500 } });
assert(r.state.target >= 2700, 'поправка не опускает ниже 2700');
await api('settings', { patch: { kcalAdjust: 0 } });
r = await api('workout', { w: 'C' }); assert(r.state.workout.which === 'C' || r.state.workout.which === 'A', 'выбор тренировки');
r = await api('tomine', { i: 0, n: 'моя гречка' }); assert(r.state.myFoods.some((m) => m.n === 'моя гречка'), 'в мои продукты');
const u0 = JSON.parse(store.get('u:42')); const yd = new Date(Date.now() + 3 * 3600e3 - 864e5).toISOString().slice(0, 10);
u0.yesterday = { d: yd, items: [{ name: 'Овсянка 60 г', base: 'Овсянка', g: 60, u: 'г', k: 222, p: 7, fat: 4, c: 36 }] }; store.set('u:42', JSON.stringify(u0));
const n0 = (await api('state')).state.items.length;
r = await api('yadd', { i: 0 }); assert(r.state.items.length === n0 + 1, 'добавить как вчера');
// --- синхронизация с часами
r = await api('synctoken'); const surl = r.state.health.sync.url; assert(/\/sync\/[0-9a-f]{32}$/.test(surl), 'личная ссылка для часов');
const tok = surl.split('/sync/')[1];
const sync = async (body, method = 'POST', t = tok) => (await bot.fetch(new Request('https://x/sync/' + t, method === 'GET' ? {} : { method, body: JSON.stringify(body) }), env)).json();
const iso = (h) => new Date(Date.now() - h * 3600e3).toISOString();
let sr = await sync({ app_version: '1.2', steps: [{ count: 5200, start_time: iso(3), end_time: iso(2) }, { count: 3100, start_time: iso(1.5), end_time: iso(1) }],
  sleep: [{ session_end_time: iso(2), duration_seconds: 27000, stages: [] }], resting_heart_rate: [{ bpm: 64, time: iso(2) }], active_calories: [{ calories: 540, start_time: iso(3), end_time: iso(1) }] });
assert(sr.ok && sr.saved.resting_hr === 64 && sr.saved.sleep_hours === 7.5, 'Health Connect (Samsung): сон, пульс');
r = await api('state');
const tdSteps = r.state.steps.find((x) => x.d === r.state.date);
assert(tdSteps && tdSteps.src === 'watch' && tdSteps.n >= 3100, 'шаги с часов записаны');
sr = await sync({ steps: '12 345', active_kcal: '610,5', resting_hr: 61, sleep_hours: '7,8' });
assert(sr.ok && sr.saved.steps === 12345 && sr.today && typeof sr.today.kcal === 'number', 'iPhone «Команды»: числа строкой + ответ с калориями');
sr = await sync({ steps: 100 }); r = await api('state');
assert(r.state.steps.find((x) => x.d === r.state.date).n === 12345, 'шаги за день не уменьшаются от старых данных');
assert((await sync({}, 'GET')).today.target_kcal > 0, 'GET отдаёт итоги дня');
assert((await sync({ steps: 1 }, 'POST', 'ab'.repeat(16))).ok === false, 'чужая ссылка не работает');
r = await api('synctoken', { regen: true }); assert((await sync({ steps: 1 })).ok === false && r.state.health.sync.url !== surl, 'новая ссылка отключает старую');
// пара прошлых дней для графиков
const u = JSON.parse(store.get('u:42'));
u.days = Array.from({ length: 14 }, (_, i) => ({ d: `2026-11-${String(i + 1).padStart(2, '0')}`, k: 2600 + ((i * 337) % 900), p: 110 + ((i * 13) % 60) }));
u.weights = Array.from({ length: 8 }, (_, i) => ({ d: `2026-${i < 4 ? '10' : '11'}-${String(4 + (i % 4) * 7).padStart(2, '0')}`, kg: 118.4 - i * 0.55 + (i % 2) * 0.3 }));
u.steps = Array.from({ length: 10 }, (_, i) => ({ d: `2026-11-${String(i + 1).padStart(2, '0')}`, n: 9000 + ((i * 1777) % 5000) }));
u.lifts.squat = [{ d: '2026-11-02', sets: [[50, 8]] }, { d: '2026-11-06', sets: [[52.5, 8]] }, { d: '2026-11-09', sets: [[55, 9]] }].concat(u.lifts.squat);
store.set('u:42', JSON.stringify(u));

await api('settings', { patch: { ui: { accent: '#8b5cf6', hide: [] } } });
// --- рендер в браузере
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r2 = await bot.fetch(new Request('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), env);
  res.writeHead(r2.status, Object.fromEntries(r2.headers)); res.end(Buffer.from(await r2.arrayBuffer()));
}).listen(0);
const port = server.address().port;
const { createRequire } = await import('node:module');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const out = process.argv[2] || '.';
for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.route('https://telegram.org/**', (route) => route.fulfill({ contentType: 'application/javascript', body: `window.Telegram={WebApp:{initData:${JSON.stringify(initData)},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},HapticFeedback:{impactOccurred(){},notificationOccurred(){}}}};` + (scheme === 'dark' ? `document.documentElement.style.cssText='--tg-theme-bg-color:#1c1c1e;--tg-theme-secondary-bg-color:#000;--tg-theme-text-color:#fff;--tg-theme-hint-color:#8e8e93;--tg-theme-button-color:#0a84ff;--tg-theme-button-text-color:#fff';` : '') }));
  await page.goto(`http://127.0.0.1:${port}/app`);
  await page.waitForSelector('.ringwrap');
  for (const t of ['today', 'diary', 'charts', 'gym', 'more']) {
    await page.click(`#tabs [data-t="${t}"]`); await page.waitForTimeout(250);
    await page.screenshot({ path: `${out}/app-${scheme}-${t}.png`, fullPage: true });
  }
  await page.click('#tabs [data-t="today"]');
  const nq = (await api('state')).state.items.length; await page.click('[data-qr="0"]'); await page.waitForTimeout(400);
  assert((await api('state')).state.items.length === nq + 1, scheme + ': быстрая кнопка «как в прошлый раз»');
  await page.click('[data-plan="0"]'); await page.waitForSelector('.week');
  await page.screenshot({ path: `${out}/app-${scheme}-plan.png`, fullPage: true });
  await page.click('[data-newc]'); await page.waitForTimeout(350);
  await page.fill('#ct', 'Музыка ' + scheme); await page.click('[data-emo="🎵"]'); await page.fill('#ctime', '16:30');
  await page.click('[data-mode="days"]'); await page.click('[data-day="2"]'); await page.click('[data-day="4"]'); await page.click('[data-lead="15"]');
  await page.screenshot({ path: `${out}/app-${scheme}-custom.png` });
  await page.click('#csave'); await page.waitForTimeout(500);
  assert((await api('state')).state.sched.custom.some((c) => c.title === 'Музыка ' + scheme && c.days.sort().join() === '2,4' && c.lead === 15), scheme + ': дело добавлено через форму');
  await page.click('[data-ev^="meal:lunch"]'); await page.waitForTimeout(350); await page.screenshot({ path: `${out}/app-${scheme}-mealtime.png` }); await page.click('#backdrop', { position: { x: 20, y: 20 } }); await page.waitForTimeout(300);
  await page.click('.back'); await page.waitForTimeout(200);
  await page.click('#tabs [data-t="more"]'); await page.click('[data-watch="android"]'); await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/app-${scheme}-watch.png` }); await page.click('#backdrop', { position: { x: 20, y: 20 } }); await page.waitForTimeout(300);
  await page.click('#tabs [data-t="charts"]'); await page.click('[data-chart="sleep"]'); await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/app-${scheme}-sleep.png` });
  await page.click('#tabs [data-t="more"]'); await page.click('[data-edit="goalWeight"]'); await page.waitForTimeout(350);
  await page.screenshot({ path: `${out}/app-${scheme}-setting.png` }); await page.click('#nok'); await page.waitForTimeout(300);
  await page.click('#tabs [data-t="diary"]'); await page.fill('#q', 'твор'); await page.waitForTimeout(100);
  await page.click('[data-res="0"]'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/app-${scheme}-sheet.png` });
  await page.click('#gok'); await page.waitForTimeout(300);
  assert(errs.length === 0, `${scheme}: без ошибок в консоли ${errs.join(' | ')}`);
  await page.close();
}
// --- открытие по кнопке нижней клавиатуры: initData пустой, вход по личному ключу ?k=
{
  const key = JSON.parse(store.get('u:42')).appKey;
  assert(/^[0-9a-f]{32}$/.test(key || ''), 'личный ключ приложения создан при /start');
  const page = await browser.newPage({ viewport: { width: 390, height: 500 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.route('https://telegram.org/**', (route) => route.fulfill({ contentType: 'application/javascript', body: 'window.Telegram={WebApp:{initData:"",ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},HapticFeedback:{impactOccurred(){},notificationOccurred(){}}}};' }));
  await page.goto(`http://127.0.0.1:${port}/app?k=${key}`);
  await page.waitForSelector('.ringwrap', { timeout: 5000 });
  assert(true, 'кнопка внизу: дневник открылся по ключу без initData');
  // нет «перезагрузки»: нажатия внутри экрана не перезапускают анимацию и не сбрасывают прокрутку
  await page.click('#tabs [data-t="charts"]'); await page.waitForTimeout(450);
  await page.evaluate(() => window.scrollTo(0, 200)); await page.waitForTimeout(50); const y0 = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => document.querySelector('[data-range="0"]').click()); await page.waitForTimeout(80);
  const st = await page.evaluate(() => ({ noanim: document.getElementById('view').classList.contains('noanim'), anim: getComputedStyle(document.querySelector('#view > *')).animationName, y: window.scrollY }));
  assert(st.noanim && st.anim === 'none' && y0 > 50 && Math.abs(st.y - y0) < 5, `нажатие внутри экрана без анимации и прыжка (${JSON.stringify(st)}, было ${y0})`);
  await page.click('#tabs [data-t="today"]'); await page.waitForTimeout(30);
  assert(await page.evaluate(() => !document.getElementById('view').classList.contains('noanim')), 'смена вкладки — с плавным появлением');
  await page.click('[data-water="250"]'); await page.waitForTimeout(300);
  assert(await page.evaluate(() => document.getElementById('view').classList.contains('noanim')), 'после +250 мл экран не «перезагружается»');
  assert(errs.length === 0, 'по ключу без ошибок ' + errs.join('|'));
  const bad = await (await bot.fetch(new Request('https://x/api', { method: 'POST', body: JSON.stringify({ k: 'ab'.repeat(16), action: 'state' }) }), env)).json();
  assert(bad.error === 'auth', 'чужой ключ не пускает');
  await page.close();
}
const fin = await api('state');
assert(fin.state.items.some((x) => /Творог/.test(x.name)), 'добавление из интерфейса дошло до API');
await browser.close(); server.close();
