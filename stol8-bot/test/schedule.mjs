// Свой распорядок: «напомни …», «встал в …», свои дела в кроне, фикс. время еды, подъём по дням недели, пропуск.
import bot from '../worker.js';
const store = new Map();
const env = { BOT_TOKEN: 'T', WEBHOOK_SECRET: 'sec', DB: { get: async (k) => store.get(k) ?? null, put: async (k, v) => store.set(k, v) } };
const sent = [];
globalThis.fetch = async (url, o) => { const b = typeof o?.body === 'string' ? JSON.parse(o.body) : {}; sent.push({ m: String(url).split('/').pop(), b }); return { ok: true, json: async () => ({ ok: true, result: {} }) }; };
let FAKE; Date.now = () => FAKE; const at = (s) => { FAKE = Date.parse(s + '+03:00'); };
const msg = (text) => bot.fetch(new Request('https://x/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'sec' }, body: JSON.stringify({ message: { chat: { id: 7 }, from: { first_name: 'Т' }, text } }) }), env);
const cb = (data) => bot.fetch(new Request('https://x/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'sec' }, body: JSON.stringify({ callback_query: { id: 'q', data, message: { message_id: 1, chat: { id: 7 } } } }) }), env);
const U = () => JSON.parse(store.get('u:7'));
const assert = (c, t) => { if (!c) { console.error('❌', t); process.exitCode = 1; } else console.log('✔', t); };
const last = () => (sent.filter((s) => s.m === 'sendMessage').pop() || { b: {} }).b.text || '';

at('2026-11-16T14:00:00'); // понедельник
await msg('/start'); for (const a of ['6:30', '9:00', '8:30', 'нет', 'пн ср пт 17:00', '15:00']) await msg(a);
const cases = [
  ['напомни завтра в 15:00 позвонить бабушке', (c) => c.date === '2026-11-17' && c.t === 900 && c.title === 'Позвонить бабушке'],
  ['напомни по вторникам и четвергам в 16:30 музыка', (c) => c.days && c.days.sort().join() === '2,4' && c.t === 990 && c.title === 'Музыка'],
  ['напомни через 20 минут выключить духовку', (c) => c.date === '2026-11-16' && c.t === 860 && /духовку/.test(c.title)],
  ['напомни в 9 выпить таблетку', (c) => c.date === '2026-11-17' && c.t === 540],
  ['напомни по будням в 7:00 взять сменку', (c) => c.rep === 'wd' && c.t === 420],
  ['напомни в пятницу в 18:00 репетитор', (c) => c.date === '2026-11-20' && c.t === 1080 && c.title === 'Репетитор'],
  ['напомни каждый день в 21:00 таблетки', (c) => c.days && c.days.length === 7],
];
for (const [t, ok] of cases) { await msg(t); const c = U().custom.at(-1); assert(ok(c), `«${t}» → ${JSON.stringify({ t: c.t, date: c.date, days: c.days, rep: c.rep, title: c.title })}`); }
await msg('/dela'); console.log(last().split('\n').slice(0, 3).join(' / '));
// крон: дело через 20 минут срабатывает в 14:20
sent.length = 0;
for (let m = 14 * 60 + 18; m <= 14 * 60 + 21; m++) { at(`2026-11-16T14:${String(m - 840).padStart(2, '0')}:00`); await bot.scheduled({}, env, { waitUntil: (p) => p }); await new Promise((r) => setTimeout(r, 5)); }
assert(sent.some((s) => /духовку/i.test(s.b.text || '') && s.b.reply_markup), 'своё дело пришло в нужную минуту с кнопками');
// отложить на 10 минут
const id = U().custom.find((c) => /духовку/.test(c.title)).id;
at('2026-11-16T14:20:00'); await cb('cs|' + id); assert(U().custom.some((c) => c.t === 870 && c.date === '2026-11-16'), '«+10 мин» создаёт напоминание на 14:30');
// встал позже
at('2026-11-17T09:40:00'); await msg('встал в 9:40');
assert(U().dayWake.t === 580 && /9:40/.test(last()), '«встал в 9:40» перестраивает день');
// API-уровень: фикс. время еды, подъём по дню недели, пропуск
const { createHmac } = await import('node:crypto');
const p = new URLSearchParams({ auth_date: String(Math.floor(FAKE / 1000)), user: JSON.stringify({ id: 7 }) });
const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
p.set('hash', createHmac('sha256', createHmac('sha256', 'WebAppData').update('T').digest()).update(dcs).digest('hex'));
const api = async (action, x = {}) => (await bot.fetch(new Request('https://x/api', { method: 'POST', body: JSON.stringify({ initData: p.toString(), action, ...x }) }), env)).json();
let r = await api('mealtime', { type: 'wd', slot: 'lunch', t: 13 * 60 + 40 });
const wed = r.state.sched.week.find((d) => d.dow === 3);
assert(wed.ev.some((e) => e.kind === 'meal' && e.slot === 'lunch' && e.t === 820 && e.fixed), 'своё время обеда в будни');
r = await api('wakedow', { dow: 6, t: 600 });
assert(r.state.sched.week.find((d) => d.dow === 6).wake === 600, 'свой подъём в субботу');
r = await api('skip', { key: 'meal:dinner' });
assert(r.state.sched.week[0].ev.find((e) => e.key === 'meal:dinner').skipped, 'пропустить ужин сегодня');
r = await api('custom_add', { title: 'Бассейн', emoji: '🏊', t: 1110, days: [2], lead: 30 });
assert(r.state.sched.custom.some((c) => c.title === 'Бассейн' && c.lead === 30), 'дело из приложения');
r = await api('custom_add', { title: 'x', t: 600 }); assert(r.msg, 'без дней — ошибка');
