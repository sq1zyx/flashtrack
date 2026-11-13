// Новые функции: фото еды (мок Workers AI), штрихкод (мок Open Food Facts), свои продукты, вода, шаги, сон,
// вес кнопками, таймер отдыха, достижения, отчёт, графики, замены, экспорт, доступ, каникулы.
import bot from '../worker.js';
const store = new Map();
let aiAnswer = '{"items":[{"name":"гречка","grams":200,"kcal":220,"protein":8,"fat":2,"carbs":42},{"name":"котлета домашняя","grams":120,"kcal":290,"protein":18,"fat":20,"carbs":8}]}';
const env = {
  BOT_TOKEN: 'T', WEBHOOK_SECRET: 'sec',
  DB: { get: async (k) => store.get(k) ?? null, put: async (k, v) => store.set(k, v) },
  AI: { run: async (m, inp) => { if (inp.prompt === 'agree') return {}; if (inp.audio) return { text: 'гречка 200 и котлета' }; const txt = JSON.stringify(inp.messages); return { response: /штрихкод/.test(txt) ? '4607001234567' : aiAnswer }; } },
};
const sent = [];
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url.includes('openfoodfacts')) return { ok: true, json: async () => ({ product: { product_name_ru: 'Йогурт клубничный', brands: 'Тест', product_quantity: 125, nutriments: { 'energy-kcal_100g': 80, proteins_100g: 3, fat_100g: 2.5, carbohydrates_100g: 11 } } }) };
  if (url.includes('/file/bot')) return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  const m = url.split('/').pop();
  const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : { text: '[FormData ' + (opts?.body?.get?.('document')?.size ?? '?') + ' bytes]' };
  sent.push({ m, body });
  if (m === 'getFile') return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/x.jpg' } }) };
  return { ok: true, json: async () => ({ ok: true, result: {} }) };
};
let FAKE; Date.now = () => FAKE;
const at = (iso) => { FAKE = Date.parse(iso + '+03:00'); };
const call = (u) => bot.fetch(new Request('https://x/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'sec' }, body: JSON.stringify(u) }), env);
const msg = (text, chat = 42) => call({ message: { chat: { id: chat }, from: { first_name: 'Тест' }, text } });
const cb = (data, chat = 42) => call({ callback_query: { id: 'q', data, message: { message_id: 9, chat: { id: chat }, text: 'x' } } });
const show = (label) => { console.log(`\n===== ${label} =====`); for (const s of sent.splice(0)) if (s.body.text || s.body.photo || s.body.caption) console.log(`[${s.m}]`, (s.body.text || s.body.photo || s.body.caption).toString().slice(0, 700)); };
const assert = (c, t) => { if (!c) { console.error('❌ FAIL:', t); process.exitCode = 1; } else console.log('✔', t); };
const U = () => JSON.parse(store.get('u:42'));

at('2026-11-16T13:00:00');
await msg('/start'); sent.splice(0);
// доступ
await msg('привет', 777); show('stranger');
assert(store.get('owner') === '42', 'владелец — первый пользователь');
await msg('/dobavit 777'); await msg('/kkal', 777); show('guest allowed');
// фото еды
await call({ message: { chat: { id: 42 }, photo: [{ file_id: 'p1' }] } }); show('photo ask');
await cb('ph|food'); show('photo food');
assert(U().pendingMeal?.length === 2, 'ИИ распознал 2 позиции');
await cb('pm|ok'); show('photo confirm');
assert(U().food.items.length === 2, 'еда по фото записана');
// штрихкод по фото и цифрами
await call({ message: { chat: { id: 42 }, photo: [{ file_id: 'p2' }], caption: 'штрихкод' } }); show('barcode photo');
await cb('og|125'); show('barcode grams');
await msg('4607001234567'); await msg('150 г'); show('barcode digits');
assert(U().food.items.length === 4, 'штрихкод записан дважды');
// свои продукты, повтор
await msg('/moe сырники мамы 220 б12 ж8 у20'); await msg('сырники мамы 2, кефир'); await cb('r'); await msg('/moe'); show('my foods + repeat');
assert(U().food.items.filter((x) => x.name.startsWith('сырники')).length === 2, 'свои продукты + повтор');
// вода, шаги, сон, вес
await msg('вода 500'); await cb('v|250'); await msg('/shagi 12000'); await cb('st|9000'); await cb('sl|2'); await cb('w|117.5'); show('water/steps/sleep/weight');
assert(U().water.ml === 750 && U().steps.at(-1).n === 9000 && U().sleepLog.length === 1 && U().weights.at(-1).kg === 117.5, 'вода/шаги/сон/вес');
// тренировка + таймер
await msg('присед 60x8 60x8'); show('set + timer');
assert(U().restAt?.m === 13 * 60 + 2, 'таймер на +2 мин');
at('2026-11-16T13:02:00'); await bot.scheduled({}, env, { waitUntil: (p) => p }); await new Promise((r) => setTimeout(r, 30)); show('timer fired');
await msg('/zamena верхний блок'); await msg('/grafik вес'); await msg('/grafik присед'); show('zamena/grafik');
// отчёт, достижения, экспорт
await msg('/otchet'); await msg('/dostizheniya'); await msg('/eksport'); show('report/ach/export');
// каникулы
at('2026-12-28T10:00:00'); await msg('/segodnya'); show('holiday');
// голос, дневник с удалением, умный ужин, напоминания, тихие часы, свободный текст через ИИ
at('2026-11-16T19:00:00');
await call({ message: { chat: { id: 42 }, voice: { file_id: 'v1', duration: 4 } } }); show('voice');
const nBefore = U().food.items.length;
await msg('/dnevnik'); await cb('dl|0'); show('dnevnik delete');
assert(U().food.items.length === nBefore - 1, 'удаление любой записи');
await msg('/uzhin'); show('uzhin');
await msg('/napominaniya'); await cb('n|water'); await msg('/tishina 22:30 7:00'); show('reminders');
assert(U().off.includes('water') && U().quiet.from === 1350, 'настройки напоминаний');
aiAnswer = '{"items":[{"name":"бизнес-ланч","grams":450,"kcal":750,"protein":35,"fat":28,"carbs":85}]}';
await msg('съел бизнес-ланч в столовой'); show('ai text');
assert(U().pendingMeal?.[0]?.k === 750, 'свободный текст через ИИ');
await cb('pm|ok'); sent.splice(0);
await cb('n|water'); await msg('/tishina нет'); sent.splice(0);
// крон воскресенья: вес кнопками + отчёт; будний день: вода, сон-кнопки, шаги
const day = async (date) => { const out = []; for (let m = 0; m < 1440; m++) { FAKE = Date.parse(`${date}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+03:00`); await bot.scheduled({}, env, { waitUntil: (p) => p }); await new Promise((r) => setImmediate(r)); for (const s of sent.splice(0)) out.push(`${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} [${s.m}] ${(s.body.text || '').split('\n')[0]}${s.body.reply_markup?.inline_keyboard ? ' ⌨' : ''}`); } return out; };
console.log('\n===== cron Sun 2026-11-22 =====\n' + (await day('2026-11-22')).filter((l) => /взвеш|Итоги|💧|Как спал|шагов/.test(l)).join('\n'));
console.log('\n===== cron Tue 2026-11-24 =====\n' + (await day('2026-11-24')).filter((l) => /Доброе|💧|Итог дня|ничего не записано/.test(l)).join('\n'));
