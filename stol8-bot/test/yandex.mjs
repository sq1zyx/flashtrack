import bot from '../worker.js';
const store=new Map();const env={BOT_TOKEN:'T',WEBHOOK_SECRET:'sec',YANDEX_KEY:'k',DB:{get:async k=>store.get(k)??null,put:async(k,v)=>store.set(k,v)}};
const out=[];
globalThis.fetch=async(url,o)=>{url=String(url);
 if(url.includes('nearest_stations'))return{ok:true,json:async()=>({stations:[{code:'s9600001',title:'Школа',distance:0.12}]})};
 if(url.includes('/schedule/'))return{ok:true,json:async()=>({schedule:[{thread:{number:'123'},departure:'2026-11-16T07:31:00+03:00'},{thread:{number:'123'},departure:'2026-11-16T07:39:00+03:00'},{thread:{number:'55'},departure:'2026-11-16T07:41:00+03:00'},{thread:{number:'123'},departure:'2026-11-16T07:52:00+03:00'}]})};
 out.push(JSON.parse(o.body));return{ok:true,json:async()=>({ok:true})};};
const call=b=>bot.fetch(new Request('https://x/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'sec'},body:JSON.stringify(b)}),env);
Date.now=()=>Date.parse('2026-11-16T06:30:00+03:00');
await call({message:{chat:{id:1},text:'/avtobus 7:42 7'}});
await call({message:{chat:{id:1},text:'/avtobus_nomer 123'}});
await call({message:{chat:{id:1},location:{latitude:55.7,longitude:37.6}}});
await call({callback_query:{id:'q',data:'s|s9600001',message:{message_id:1,chat:{id:1},reply_markup:{inline_keyboard:[[{text:'Школа (120 м)',callback_data:'s|s9600001'}]]}}}});
await call({message:{chat:{id:1},text:'/avtobus'}});
await bot.scheduled({},env,{waitUntil:p=>p}); await new Promise(r=>setTimeout(r,50));
for(const b of out) console.log('>',(b.text||JSON.stringify(b.reply_markup||b)).split('\n').slice(0,3).join(' / '));
console.log(JSON.parse(store.get('u:1')).busToday);

// --- отслеживание: изменение рейса за 30 мин до выхода + отметки «автобус пришёл»
out.length=0;
const u1=JSON.parse(store.get('u:1')); u1.busToday=null; u1.wakeWd=360; store.set('u:1',JSON.stringify(u1));
// обычное время 7:42, сегодня в Яндексе ближайший 7:39 → выход 7:42-7-2=7:33, проверка в 7:03
Date.now=()=>Date.parse('2026-11-16T07:03:00+03:00');
await bot.scheduled({},env,{waitUntil:p=>p}); await new Promise(r=>setTimeout(r,50));
for(const b of out) console.log('check>',(b.text||'').split('\n').join(' / '));
out.length=0;
for (const [d,m] of [['2026-11-16','07:43'],['2026-11-17','07:44'],['2026-11-18','07:40']]) {
  Date.now=()=>Date.parse(`${d}T${m}:00+03:00`);
  await call({callback_query:{id:'q',data:`b|${d}|462`,message:{message_id:2,chat:{id:1}}}});
}
for(const b of out) if(b.text) console.log('tap>',b.text.split('\n').join(' / '));
