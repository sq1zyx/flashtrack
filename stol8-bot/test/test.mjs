import bot from '../worker.js';

const store = new Map();
const env = {
  BOT_TOKEN: 'T', WEBHOOK_SECRET: 'sec',
  DB: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } },
};
const sent = [];
globalThis.fetch = async (url, opts) => {
  const body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : { text: '[file upload]' };
  sent.push({ method: String(url).split('/').pop(), body });
  return { ok: true, json: async () => ({ ok: true, result: { username: 'testbot' } }) };
};
let FAKE = null;
const RealNow = Date.now;
Date.now = () => FAKE ?? RealNow();
const setMsk = (iso) => { FAKE = Date.parse(iso + '+03:00'); };

async function upd(u) {
  const r = await bot.fetch(new Request('https://x.workers.dev/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'sec' }, body: JSON.stringify(u) }), env);
  if (r.status !== 200) throw new Error('status ' + r.status);
}
let mid = 1;
const msg = (text) => upd({ message: { message_id: mid++, chat: { id: 42 }, text } });
const show = (label) => {
  console.log(`\n===== ${label} =====`);
  for (const s of sent.splice(0)) console.log(`[${s.method}]`, (s.body.text || s.body.caption || JSON.stringify(s.body)).slice(0, 1500));
};

setMsk('2026-11-13T16:30:00');
await msg('/start'); show('start');
for (const a of ['6:30', '9:00', '8:30', '7:42', '7', '123 до школы', 'пн ср пт 17:00', '15:00']) await msg(a);
show('wizard');
await msg('/segodnya'); show('segodnya');
await msg('🍽 Меню'); show('menu');
await msg('/kkal'); show('kkal');
await msg('/el 350 б20 бутерброд'); await msg('/el 3000 пицца'); show('el');
await msg('гречка 250, курица 180, 2 яйца'); await msg('овсянка 90 на молоке 250 мл'); await msg('бутерброд с колбасой и кофе');
await msg('/el шаурма'); await msg('/produkt творог'); await msg('/otmena'); await msg('/nedelya'); show('food text');
await msg('/kkal 1500'); await msg('/kkal -300'); show('kkal adjust');
await msg('/trenirovka'); show('trenirovka');
await msg('присед 60x8 60x8 60x7'); await msg('Присед 60х10х3'); await msg('жим ногами 120x15x3'); show('lifts');
await msg('/istoriya присед'); show('istoriya');

// weights over weeks
const days = ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08'];
const kgs = [118, 117.2, 116.4, 115.5, 114.6, 113.8];
for (let i = 0; i < days.length; i++) { setMsk(days[i] + 'T08:00:00'); await msg('/ves ' + kgs[i]); }
sent.splice(0); await msg('/progress'); show('progress');
await upd({ message: { message_id: mid++, chat: { id: 42 }, photo: [{ file_id: 'a' }, { file_id: 'b' }] } });
await msg('/foto'); show('foto');

// callbacks
setMsk('2026-11-16T12:00:00');
await upd({ callback_query: { id: 'c1', data: 'a|lunch|0|900', message: { message_id: 5, chat: { id: 42 }, text: 'x' } } });
await upd({ callback_query: { id: 'c2', data: 'e|lunch|1', message: { message_id: 5, chat: { id: 42 }, text: '🍽 Обед\nтекст' } } });
await upd({ callback_query: { id: 'c3', data: 'm|1', message: { message_id: 6, chat: { id: 42 }, text: 'x' } } });
show('callbacks');

// cron: simulate full Monday + Sunday, minute by minute
async function day(date) {
  for (let m = 0; m < 1440; m++) {
    setMsk(`${date}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`);
    await bot.scheduled({}, env, { waitUntil: (p) => p });
    // waitUntil returns promise; await it
  }
}
const origSched = bot.scheduled;
bot.scheduled = async (e, en) => { let p; await origSched(e, en, { waitUntil: (x) => { p = x; } }); await p; };
sent.splice(0);
await day('2026-11-16');
console.log('\n===== cron Monday =====');
for (const s of sent.splice(0)) console.log(new Date(FAKE).toISOString().slice(11, 16), '|', (s.body.text || '').split('\n')[0]);
// capture times properly
async function dayTimed(date) {
  const out = [];
  for (let m = 0; m < 1440; m++) {
    setMsk(`${date}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`);
    await bot.scheduled({}, env);
    for (const s of sent.splice(0)) out.push(`${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} | ${(s.body.text || '').split('\n')[0]}`);
  }
  return out;
}
console.log('\n===== cron Sunday 2026-11-15 =====\n' + (await dayTimed('2026-11-15')).join('\n'));
console.log('\n===== cron Tuesday 2026-11-17 =====\n' + (await dayTimed('2026-11-17')).join('\n'));
console.log('\n===== cron Friday 2026-11-20 (bed uses Sat wake) =====\n' + (await dayTimed('2026-11-20')).filter(l=>/Отбой|отбой/.test(l)).join('\n'));
console.log('\n===== cron Sat 2026-11-21 00:00 region =====\n' + (await dayTimed('2026-11-21')).slice(0,3).join('\n'));

setMsk('2026-11-16T12:00:00');
await msg('/raspisanie'); await msg('/nastroiki'); await msg('/avtobus'); await msg('blah'); await msg('117'); await msg('/help');
show('misc');

const r = await bot.fetch(new Request('https://x.workers.dev/setup?key=sec'), env);
console.log('\n===== setup =====', r.status, (await r.text()).slice(0, 200));
const bad = await bot.fetch(new Request('https://x.workers.dev/webhook', { method: 'POST', body: '{}' }), env);
console.log('no-secret webhook ->', bad.status);
