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
r = await api('del', { i: 1 });
assert(r.state.items.length === 2, 'del');
r = await api('water', { ml: 500 }); assert(r.state.water.ml === 500, 'water');
r = await api('steps', { n: 12000 }); r = await api('weight', { kg: 117.6 }); r = await api('sleep', { q: 2 });
r = await api('set', { key: 'squat', w: 60, r: 8 }); r = await api('set', { key: 'squat', w: 60, r: 8 });
assert(r.state.workout.list.find((x) => x.key === 'squat').today.length === 2, 'подходы из приложения');
r = await api('unset', { key: 'squat' }); assert(r.state.workout.list.find((x) => x.key === 'squat').today.length === 1, 'unset');
r = await api('note', { t: 'болел живот' }); assert(r.state.notes.length === 1, 'заметка');
r = await api('remind', { g: 'water' }); assert(r.state.settings.off.includes('water'), 'выключить напоминания о воде');
r = await api('quiet', { from: '22:30', to: '07:00' }); assert(r.state.settings.quiet.from === 1350, 'тихие часы');
// пара прошлых дней для графиков
const u = JSON.parse(store.get('u:42'));
u.days = Array.from({ length: 14 }, (_, i) => ({ d: `2026-11-${String(i + 1).padStart(2, '0')}`, k: 2600 + ((i * 337) % 900), p: 110 + ((i * 13) % 60) }));
u.weights = Array.from({ length: 8 }, (_, i) => ({ d: `2026-${i < 4 ? '10' : '11'}-${String(4 + (i % 4) * 7).padStart(2, '0')}`, kg: 118.4 - i * 0.55 + (i % 2) * 0.3 }));
u.steps = Array.from({ length: 10 }, (_, i) => ({ d: `2026-11-${String(i + 1).padStart(2, '0')}`, n: 9000 + ((i * 1777) % 5000) }));
u.lifts.squat = [{ d: '2026-11-02', sets: [[50, 8]] }, { d: '2026-11-06', sets: [[52.5, 8]] }, { d: '2026-11-09', sets: [[55, 9]] }].concat(u.lifts.squat);
store.set('u:42', JSON.stringify(u));

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
  await page.click('#tabs [data-t="diary"]'); await page.fill('#q', 'твор'); await page.waitForTimeout(100);
  await page.click('[data-res="0"]'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/app-${scheme}-sheet.png` });
  await page.click('#gok'); await page.waitForTimeout(300);
  assert(errs.length === 0, `${scheme}: без ошибок в консоли ${errs.join(' | ')}`);
  await page.close();
}
const fin = await api('state');
assert(fin.state.items.some((x) => /Творог/.test(x.name)), 'добавление из интерфейса дошло до API');
await browser.close(); server.close();
