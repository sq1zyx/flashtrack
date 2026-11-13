// =====================================================================
//  Телеграм-бот «Стол №8» — расписание, питание, тренировки, прогресс
//  Cloudflare Worker + Workers KV (binding: DB) + Cron (каждую минуту)
//  Секреты: BOT_TOKEN, WEBHOOK_SECRET. Необязательно: YANDEX_KEY, ALLOWED_IDS
// =====================================================================

import APP_HTML from './app.js';

const TZ_OFFSET_MIN = 180; // Москва, UTC+3 (перехода на летнее время нет)
const KCAL_FLOOR = 2700;   // ниже бот не опускает норму: подросток, ещё растёт

const DEFAULTS = {
  wakeWd: 390, wakeWe: 540, sleepH: 9, meals: 6,
  schoolStart: 510, busTime: null, walk: 7, buffer: 2,
  busInfo: '', busNumber: '', station: '', stationTitle: '', busToday: null,
  busLog: [], // отметки «автобус пришёл»: { d, diff } — diff = факт − расписание, мин
  name: '',
  water: null, waterDays: [], waterOff: false, steps: [], sleepLog: [], workoutDates: [], ach: [],
  myFoods: [], lastMeal: null, pendingMeal: null, pendingProduct: null, pendingPhoto: null,
  restAt: null, timer: true, timerMin: 2, autoHol: true,
  recent: [], notes: [], off: [], quiet: null, mealShift: {}, mealSeen: {},
  gymDays: [1, 3, 5], gymTime: 1020, home: 900,
  height: 191, age: 16, startWeight: 118,
  kcalAdjust: 0, kcalOverride: null,
  paused: false, holidays: false,
  nextWorkout: 'A', curWorkout: 'A', lastWorkoutDate: '',
  weights: [], waist: [], photos: [], lifts: {},
  food: { date: '', items: [] },
  days: [], // итоги прошлых дней: { d, k, p, n } — для /nedelya
  wiz: null,
};

// ---------------------------------------------------------------- время
function dateInfo(d, min = 0) {
  return { d, date: d.toISOString().slice(0, 10), dow: d.getUTCDay(), dom: d.getUTCDate(), min };
}
function nowMsk() {
  const d = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
  return dateInfo(d, d.getUTCHours() * 60 + d.getUTCMinutes());
}
function shiftDay(info, n) {
  const d = new Date(Date.UTC(info.d.getUTCFullYear(), info.d.getUTCMonth(), info.d.getUTCDate() + n));
  return dateInfo(d);
}
function nextDow(info, dow) {
  for (let i = 0; i < 7; i++) { const x = shiftDay(info, i); if (x.dow === dow) return x; }
  return info;
}
function dayOfYear(info) {
  const d = info.d;
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
}
function fmt(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
function parseTime(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{1,2})[:.\-\s](\d{2})$/) || s.match(/^(\d{1,2})(\d{2})$/);
  if (m) { const h = +m[1], mi = +m[2]; return h < 24 && mi < 60 ? h * 60 + mi : null; }
  m = s.match(/^(\d{1,2})$/);
  if (m && +m[1] < 24) return +m[1] * 60;
  return null;
}
const DAYS = { пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 0 };
const DAYNAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const isWorkday = (u, info) => !u.holidays && info.dow >= 1 && info.dow <= 5 && !(u.autoHol !== false && holidayName(info.date));
const r5 = (x) => Math.round(x / 5) * 5;
const kg = (x) => (Math.round(x * 10) / 10).toFixed(1).replace('.', ',');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ddmm = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;

// ---------------------------------------------------------------- питание
const SLOT_NAMES = {
  breakfast: 'Завтрак', snack1: 'Второй завтрак', lunch: 'Обед',
  snack2: 'Полдник', dinner: 'Ужин', late: 'Перекус перед сном',
};
const SLOTS_BY_N = {
  4: ['breakfast', 'lunch', 'snack2', 'dinner'],
  5: ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner'],
  6: ['breakfast', 'snack1', 'lunch', 'snack2', 'dinner', 'late'],
};
// t — что съесть, k — ккал, p — белок (г). Всё из магазина, готовка — заготовки/микроволновка/духовка.
const MENU = {
  breakfast: [
    { t: 'Овсянка 90 г (сухой) на молоке 1,5 % 250 мл + 2 варёных яйца + яблоко', k: 660, p: 32 },
    { t: 'Творог 5 % 200 г + 2 ломтика ржаного хлеба + 2 варёных яйца + огурец или помидор', k: 600, p: 52 },
    { t: 'Гречка из заготовки 250 г + 2 варёных яйца + кефир 1 % 250 мл + овощи', k: 610, p: 34 },
    { t: '3 ломтика цельнозернового хлеба + нежирный сыр 40 г + 2 варёных яйца + кефир 250 мл + яблоко', k: 670, p: 40 },
  ],
  snack1: [
    { t: 'Творог 5 % 180 г (пачка) + груша или апельсин + 2 ржаных хлебца + орехи 15 г', k: 450, p: 38 },
    { t: 'Кефир или питьевой йогурт без сахара 500 мл + бутерброд: 2 ломтика ржаного хлеба + курица из заготовки 80 г', k: 480, p: 44 },
    { t: 'Греческий йогурт без сахара 2 стаканчика (~280 г) + яблоко + несолёные орехи 20 г', k: 420, p: 28 },
  ],
  lunch: [
    { t: 'Гречка 250 г + запечённая курица 180 г + овощной салат с 1 ст. л. масла', k: 720, p: 66 },
    { t: 'Булгур или перловка 250 г + индейка/курица 180 г + овощи 200 г + 1 ч. л. масла', k: 700, p: 62 },
    { t: 'Запечённая белая рыба (минтай/треска) 250 г + гречка 200 г + овощная смесь 300 г + 1 ст. л. масла', k: 710, p: 58 },
  ],
  snack2: [
    { t: 'Кефир 1 % 500 мл + 2 ломтика ржаного хлеба с нежирным сыром 30 г + яблоко', k: 515, p: 29 },
    { t: 'Творог 5 % 180 г + овсяные хлопья 30 г + замороженные ягоды 100 г + орехи 15 г', k: 460, p: 39 },
    { t: '2 бутерброда: цельнозерновой хлеб + курица 100 г + огурец; кефир 250 мл', k: 430, p: 44 },
  ],
  dinner: [
    { t: 'Курица или индейка 180 г + замороженная овощная смесь 400 г (микроволновка) + ломтик ржаного хлеба + 1 ч. л. масла', k: 570, p: 63 },
    { t: 'Запечённая рыба 200 г + салат из свежих овощей с 1 ст. л. масла + гречка 150 г', k: 535, p: 44 },
    { t: 'Омлет из 3 яиц в микроволновке + овощи 300 г + творог 100 г + ломтик хлеба', k: 545, p: 43 },
  ],
  late: [
    { t: 'Кефир 1 % 250 мл', k: 100, p: 8 },
    { t: 'Греческий йогурт без сахара 150 г', k: 110, p: 12 },
    { t: 'Творог 5 % 100 г', k: 120, p: 17 },
  ],
};

const SHOPPING = `🛒 <b>Список покупок на неделю</b> (~3000 ккал/день)

<b>Белок</b>
• Куриное филе / индейка — 2,5 кг
• Белая рыба (минтай, треска, хек) — 1–1,2 кг
• Яйца — 30 шт
• Творог 5 % — 8–10 пачек (по 180–200 г)
• Кефир 1 % — 4–5 л
• Греческий йогурт без сахара — 6 шт
• Молоко 1,5 % — 2 л
• Сыр нежирный (до 17 %) — 200 г

<b>Крупы и хлеб</b>
• Гречка — 1 кг
• Овсянка (не быстрая, без сахара) — 700 г
• Булгур или перловка — 500 г
• Ржаной / цельнозерновой хлеб — 2 буханки
• Цельнозерновые хлебцы — 1 пачка

<b>Овощи и фрукты</b>
• Огурцы — 1,5 кг, помидоры — 1 кг
• Капуста / салат / зелень, морковь
• Замороженные овощные смеси <i>без риса и картошки</i> — 3–4 пачки по 400 г
• Яблоки — 2 кг, груши или апельсины — 1 кг
• Замороженные ягоды — 500 г

<b>Прочее</b>
• Несолёные орехи — 200 г
• Масло (оливковое/подсолнечное) — если закончилось
• Специи без соли (паприка, чеснок, прованские травы)

<b>Не покупать:</b> сладости, газировку, соки, колбасу/сосиски, майонез, белый хлеб, выпечку.`;

const SWAPS = `🔁 <b>Замены (примерно равноценно)</b>

<b>Белок:</b> курица 150 г = индейка 150 г = белая рыба 200 г = творог 5 % 250 г = 4 яйца
<b>Крупа:</b> гречка = булгур = перловка = овсянка (одна и та же порция)
<b>Хлеб:</b> 1 ломтик ржаного = 2 хлебца
<b>Кисломолочное:</b> кефир 1 % = йогурт без сахара = ряженка 2,5 % (чуть калорийнее)
<b>Фрукты:</b> яблоко = груша = апельсин = 150 г ягод (бананы и виноград — редко)
<b>Хочется сладкого:</b> яблоко, ягоды с творогом, греческий йогурт с корицей

<b>В школьной столовой:</b> мясо или рыба без панировки + овощи/гречка; без майонезных салатов и булочек.
<b>Если оказался в фастфуде:</b> ролл или бургер без соуса + салат + вода. Это не провал — следующий приём пищи просто нормальный.`;

const PREP_SUN = `🧺 <b>Воскресная заготовка</b> (~1 час — и 3–4 дня почти без готовки)

1. Отвари 10–12 яиц: 10 минут после закипания → в холодильник.
2. Запеки 1–1,2 кг куриного филе или индейки: специи без соли, 200 °C, 25–30 мин. Остуди, нарежь, разложи по контейнерам.
3. Свари 400 г гречки (получится ~1,2 кг готовой) — по 200–250 г в контейнер.
4. Помой и нарежь овощи палочками (огурцы, морковь) — в контейнер.
5. Проверь творог, кефир и фрукты на 3 дня — /pokupki`;

const PREP_WED = `🧺 <b>Мини-заготовка на четверг–воскресенье</b>

Запеки ещё ~1 кг курицы или рыбы и свари гречку. 30 минут — и до выходных еда готова.`;

const EXERCISE_TEXT = `🤸 <b>Зарядка, 7–10 минут</b> (2 круга)
• 20 приседаний
• 10 отжиманий (можно от стола)
• 30 сек планка
• 20 вращений руками
• 10 наклонов к носкам
Потом умыться и на завтрак 🙂`;

// ---------------------------------------------------------------- тренировки
const EX = {
  squat:    { n: 'Приседания со штангой', a: ['присед', 'приседания'], r: [6, 10], s: 3, step: 5 },
  bench:    { n: 'Жим штанги лёжа', a: ['жим', 'жим лежа'], r: [6, 10], s: 3, step: 2.5 },
  latpull:  { n: 'Тяга верхнего блока', a: ['тяга верх', 'верхний блок'], r: [8, 12], s: 3, step: 5 },
  rdl:      { n: 'Румынская тяга', a: ['румынка', 'румынская тяга', 'румынская'], r: [8, 12], s: 3, step: 5 },
  plank:    { n: 'Планка (секунды)', a: ['планка'], r: [30, 60], s: 3, bw: true },
  legpress: { n: 'Жим ногами', a: ['жим ногами', 'жим ноги'], r: [10, 15], s: 3, step: 10 },
  ohp:      { n: 'Жим гантелей сидя', a: ['жим сидя', 'жим гантелей сидя'], r: [8, 12], s: 3, step: 2 },
  dbrow:    { n: 'Тяга гантели в наклоне', a: ['тяга гантели', 'тяга в наклоне'], r: [8, 12], s: 3, step: 2 },
  lunge:    { n: 'Выпады с гантелями (на ногу)', a: ['выпады'], r: [8, 12], s: 2, step: 2 },
  crunch:   { n: 'Скручивания', a: ['скручивания', 'пресс'], r: [12, 20], s: 3, bw: true },
  goblet:   { n: 'Гоблет-присед', a: ['гоблет'], r: [10, 15], s: 3, step: 2 },
  incline:  { n: 'Жим гантелей на наклонной', a: ['жим наклон', 'наклонная', 'жим на наклонной'], r: [8, 12], s: 3, step: 2 },
  cablerow: { n: 'Тяга горизонтального блока', a: ['тяга гориз', 'горизонтальная тяга', 'тяга блока'], r: [10, 12], s: 3, step: 5 },
  hip:      { n: 'Ягодичный мост со штангой', a: ['мост', 'ягодичный мост'], r: [10, 12], s: 3, step: 5 },
  curl:     { n: 'Сгибания на бицепс', a: ['бицепс'], r: [10, 15], s: 2, step: 1 },
  tri:      { n: 'Разгибания на трицепс (блок)', a: ['трицепс'], r: [10, 15], s: 2, step: 2.5 },
};
const PROG = {
  A: ['squat', 'bench', 'latpull', 'rdl', 'plank'],
  B: ['legpress', 'ohp', 'dbrow', 'lunge', 'crunch'],
  C: ['goblet', 'incline', 'cablerow', 'hip', 'curl', 'tri'],
};
const NEXT_W = { A: 'B', B: 'C', C: 'A' };
const ALIASES = Object.entries(EX)
  .flatMap(([key, e]) => e.a.map((a) => [a, key]))
  .sort((x, y) => y[0].length - x[0].length);

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

function findExercise(text) {
  const t = norm(text);
  for (const [a, key] of ALIASES) {
    if (t === a || t.startsWith(a + ' ')) return { key, rest: t.slice(a.length).trim() };
  }
  return null;
}
function parseSets(rest) {
  const sets = [];
  for (let tok of rest.split(/\s+/).filter(Boolean)) {
    tok = tok.replace(/,/g, '.').replace(/[хХxX*×]/g, 'x');
    let m = tok.match(/^(\d+(?:\.\d+)?)x(\d+)(?:x(\d+))?$/);
    if (m) {
      const w = +m[1], r = +m[2], c = m[3] ? Math.min(+m[3], 10) : 1;
      for (let i = 0; i < c; i++) sets.push([w, r]);
      continue;
    }
    m = tok.match(/^(\d+)$/);
    if (m) { sets.push([0, +m[1]]); continue; }
    return null;
  }
  return sets.length ? sets : null;
}
const setsText = (sets) => sets.map(([w, r]) => (w ? `${String(w).replace('.', ',')}×${r}` : `${r}`)).join(', ');

function nextHint(key, sets) {
  const e = EX[key], [lo, hi] = e.r;
  const allTop = sets.every((s) => s[1] >= hi);
  const anyLow = sets.some((s) => s[1] < lo);
  if (e.bw) {
    return allTop ? `везде ${hi}+ — усложни (медленнее, пауза, доп. вес)` : `добавь по 1–2 ${e.unit || 'повтора'} в каждом подходе`;
  }
  const maxW = Math.max(...sets.map((s) => s[0]));
  if (allTop) return `в следующий раз <b>${String(maxW + e.step).replace('.', ',')} кг</b> и начни с ${lo} повторов`;
  if (anyLow) return `вес пока тяжеловат — оставь ${String(maxW).replace('.', ',')} кг и добирай до ${lo}–${hi}`;
  return `тот же вес, +1 повтор в 1–2 подходах. Когда везде будет ${hi} — добавляй вес`;
}

function workoutText(u, w) {
  const lines = [`<b>Тренировка ${w}</b>`];
  PROG[w].forEach((key, i) => {
    const e = EX[key];
    lines.push(`\n${i + 1}. <b>${e.n}</b> — ${e.s}×${e.r[0]}–${e.r[1]}`);
    const hist = u.lifts[key];
    if (hist && hist.length) {
      const last = hist[hist.length - 1];
      lines.push(`   прошлый раз (${ddmm(last.d)}): ${setsText(last.sets)}`);
      lines.push(`   → ${nextHint(key, last.sets)}`);
    }
  });
  lines.push('\nЗаписывай прямо сюда, например: <code>' + esc(EX[PROG[w][0]].a[0]) + ' 60x8 60x8 60x7</code>');
  lines.push('Последние 1–2 повтора в подходе должны быть тяжёлыми, но с чистой техникой. Разминка: 5 мин кардио + 1–2 лёгких подхода.');
  lines.push('Тренажёр занят? <code>/zamena жим</code> · график силы: <code>/grafik присед</code>');
  return lines.join('\n');
}

// ---------------------------------------------------------------- калории
function lastWeight(u) { return u.weights.length ? u.weights[u.weights.length - 1].kg : u.startWeight; }
function calc(u) {
  const w = lastWeight(u);
  const bmr = 10 * w + 6.25 * u.height - 5 * u.age + 5;
  const act = activity(u);
  const tdee = bmr * act.f;
  let target = Math.round((tdee - 500) / 50) * 50 + (u.kcalAdjust || 0);
  target = Math.max(target, KCAL_FLOOR);
  if (u.kcalOverride) target = u.kcalOverride;
  return { w, bmr: Math.round(bmr / 50) * 50, tdee: Math.round(tdee / 50) * 50, target, act };
}
function archiveFood(u, info) {
  // день сменился — сохраняем итог вчерашнего дня в историю (хранится 60 дней)
  const f = u.food;
  if (f.date && f.date !== info.date && f.items.length) {
    u.days = (u.days || []).filter((x) => x.d !== f.date);
    u.days.push({ d: f.date, k: f.items.reduce((a, x) => a + x.k, 0), p: f.items.reduce((a, x) => a + (x.p || 0), 0), n: f.items.length });
    u.days.sort((a, b) => (a.d < b.d ? -1 : 1));
    if (u.days.length > 60) u.days.splice(0, u.days.length - 60);
  }
}
function todayFood(u, info) {
  if (u.food.date !== info.date) { archiveFood(u, info); u.food = { date: info.date, items: [] }; }
  return u.food;
}
function foodSum(u, info) {
  const f = u.food.date === info.date ? u.food.items : [];
  const sum = (key) => f.reduce((a, x) => a + (x[key] || 0), 0);
  return { k: sum('k'), p: sum('p'), fat: sum('fat'), c: sum('c'), n: f.length };
}
function weekText(u, info) {
  const target = calc(u).target;
  const rows = [];
  for (let i = 6; i >= 0; i--) {
    const d = shiftDay(info, -i);
    let x = (u.days || []).find((y) => y.d === d.date);
    if (i === 0) { const s = foodSum(u, info); x = s.n ? { k: s.k, p: s.p } : null; }
    rows.push({ d, x });
  }
  const filled = rows.filter((r) => r.x && !(r.d.date === info.date));
  const lines = ['📊 <b>Калории за 7 дней</b> (норма ' + target + ')\n'];
  for (const r of rows) {
    const k = r.x ? r.x.k : null;
    const bar = k == null ? '—' : '▇'.repeat(Math.max(1, Math.min(12, Math.round((k / target) * 10))));
    const mark = k == null ? '' : k < target - 500 ? ' ⬇️' : k > target + 400 ? ' ⬆️' : ' ✅';
    lines.push(`<code>${DAYNAMES[r.d.dow]} ${ddmm(r.d.date)} ${k == null ? '   —' : String(k).padStart(5)}</code> ${k == null ? '' : bar}${mark}${r.d.date === info.date ? ' <i>(сегодня, ещё идёт)</i>' : ''}`);
  }
  if (filled.length) {
    const avg = Math.round(filled.reduce((a, r) => a + r.x.k, 0) / filled.length);
    const avgP = Math.round(filled.reduce((a, r) => a + (r.x.p || 0), 0) / filled.length);
    const ok = filled.filter((r) => Math.abs(r.x.k - target) <= 400).length;
    lines.push(`\nВ среднем (без сегодня): <b>${avg} ккал</b>, белок ~${avgP} г · в коридоре нормы: ${ok} из ${filled.length} дн.`);
    if (avg < target - 500) lines.push('Ты стабильно ешь меньше нормы. Либо не всё записываешь, либо реально недоедаешь — добавь перекус (творог, кефир, бутерброд с курицей). Голод мешает расти и приводит к срывам.');
    else if (avg > target + 400) lines.push('В среднем выходит чуть больше нормы. Без паники: посмотри, где лишнее — сладкое, напитки, перекусы на ходу. Еду не пропускай.');
    else lines.push('👍 В среднем ты в норме. Так и держи.');
  } else {
    lines.push('\nПока мало записей. Пиши, что съел, обычным текстом: <code>гречка 250, курица 180</code>');
  }
  return lines.join('\n');
}
function logFood(u, info, item) {
  const target = calc(u).target;
  const before = foodSum(u, info).k;
  todayFood(u, info).items.push({ ...item, at: info.min });
  if (u.food.items.length > 60) u.food.items.shift();
  const after = foodSum(u, info).k;
  let extra = '';
  if (before <= target + 400 && after > target + 400) {
    extra = '\n\nСегодня вышло больше нормы — это нормально, так бывает. Ничего не «отрабатывай» и не пропускай еду: следующий приём пищи просто сделай обычным 💪';
  }
  return { after, target, extra };
}

// ---------------------------------------------------------------- база продуктов
// На 100 г (крупы, мясо, рыба — в готовом виде): k — ккал, p/f/c — белки/жиры/углеводы.
// s — основы слов для поиска (любая форма: «гречка», «гречки», «гречку»),
// pc — вес одной штуки/ломтика/ложки (г), d — обычная порция (г), если количество не указано.
const FOODS = [
  // крупы и гарниры
  { n: 'Гречка', s: ['гречк', 'гречнев'], k: 110, p: 4.2, f: 1.1, c: 21, d: 200 },
  { n: 'Рис', s: ['рис'], k: 130, p: 2.7, f: 0.3, c: 28, d: 200 },
  { n: 'Булгур', s: ['булгур'], k: 83, p: 3.1, f: 0.2, c: 19, d: 200 },
  { n: 'Перловка', s: ['перлов'], k: 110, p: 3, f: 0.4, c: 23, d: 200 },
  { n: 'Овсянка (сухая)', s: ['овсян', 'геркулес', 'овсяные хлопья'], k: 370, p: 12, f: 6.5, c: 60, d: 60 },
  { n: 'Овсянка на молоке (готовая)', s: ['овсяная каша', 'каша'], k: 110, p: 4, f: 2.5, c: 17, d: 300 },
  { n: 'Макароны', s: ['макарон', 'спагетти', 'паст'], k: 140, p: 5, f: 1, c: 28, d: 200 },
  { n: 'Картофель варёный', s: ['картош', 'картоф'], k: 82, p: 2, f: 0.4, c: 17, d: 200, pc: 100 },
  { n: 'Пюре', s: ['пюре'], k: 95, p: 2, f: 3.3, c: 14, d: 200 },
  { n: 'Хлеб ржаной', s: ['ржан', 'черный хлеб', 'бородин'], k: 210, p: 6.6, f: 1.2, c: 42, pc: 30 },
  { n: 'Хлеб цельнозерновой', s: ['цельнозерн'], k: 240, p: 9, f: 3, c: 43, pc: 30 },
  { n: 'Хлеб белый', s: ['хлеб', 'батон', 'булк'], k: 260, p: 7.5, f: 2.9, c: 51, pc: 30 },
  { n: 'Хлебцы', s: ['хлебц'], k: 330, p: 11, f: 3, c: 63, pc: 10 },
  { n: 'Хлеб для бутерброда', s: ['бутерброд', 'тост', 'сэндвич'], k: 250, p: 8, f: 3, c: 48, pc: 35 },
  { n: 'Лаваш', s: ['лаваш'], k: 270, p: 9, f: 1, c: 56, pc: 80 },
  // мясо, рыба, яйца
  { n: 'Курица (филе)', s: ['куриц', 'курин', 'филе', 'грудк'], k: 155, p: 30, f: 3.5, c: 0, d: 150 },
  { n: 'Курица гриль', s: ['курица гриль', 'курицу гриль', 'бедр', 'окорочок', 'окорочк'], k: 210, p: 24, f: 12, c: 0, d: 200 },
  { n: 'Индейка', s: ['индейк', 'индюш'], k: 145, p: 29, f: 2.5, c: 0, d: 150 },
  { n: 'Говядина', s: ['говядин', 'телятин'], k: 220, p: 27, f: 12, c: 0, d: 150 },
  { n: 'Свинина', s: ['свинин'], k: 280, p: 24, f: 20, c: 0, d: 150 },
  { n: 'Котлета', s: ['котлет'], k: 230, p: 15, f: 15, c: 9, pc: 90 },
  { n: 'Белая рыба', s: ['рыб', 'минтай', 'минта', 'треск', 'хек', 'пикш'], k: 90, p: 19, f: 1, c: 0, d: 200 },
  { n: 'Лосось / сёмга', s: ['лосос', 'семг', 'горбуш', 'форел'], k: 200, p: 20, f: 13, c: 0, d: 150 },
  { n: 'Тунец (консервы в с/с)', s: ['тунец', 'тунц'], k: 100, p: 23, f: 1, c: 0, d: 150 },
  { n: 'Яйцо', s: ['яйц', 'яиц', 'яичниц', 'омлет'], k: 157, p: 12.7, f: 11.5, c: 0.7, pc: 55 },
  { n: 'Сосиска', s: ['сосис', 'сардельк'], k: 260, p: 11, f: 23, c: 1.5, pc: 50 },
  { n: 'Колбаса', s: ['колбас'], k: 300, p: 12, f: 27, c: 1.5, pc: 20 },
  { n: 'Пельмени', s: ['пельмен'], k: 250, p: 11, f: 12, c: 26, d: 250, pc: 12 },
  // молочное
  { n: 'Творог 5 %', s: ['творог', 'творож'], k: 121, p: 17, f: 5, c: 1.8, d: 180 },
  { n: 'Кефир 1 %', ml: 1, s: ['кефир'], k: 40, p: 3, f: 1, c: 4, d: 250 },
  { n: 'Молоко 1,5 %', ml: 1, s: ['молок'], k: 44, p: 3, f: 1.5, c: 4.8, d: 250 },
  { n: 'Ряженка', ml: 1, s: ['ряженк'], k: 54, p: 2.9, f: 2.5, c: 4.2, d: 250 },
  { n: 'Греческий йогурт', s: ['греческ'], k: 66, p: 8, f: 2, c: 4, d: 140, pc: 140 },
  { n: 'Йогурт', s: ['йогурт'], k: 70, p: 3, f: 1.5, c: 11, d: 250 },
  { n: 'Сыр нежирный', s: ['сыр нежирн', 'нежирный сыр', 'нежирного сыр'], k: 270, p: 29, f: 17, c: 0, pc: 20 },
  { n: 'Сыр', s: ['сыр'], k: 350, p: 25, f: 27, c: 0, pc: 20 },
  { n: 'Сырники', s: ['сырник'], k: 220, p: 14, f: 10, c: 18, pc: 60 },
  { n: 'Сметана 15 %', s: ['сметан'], k: 160, p: 2.6, f: 15, c: 3, pc: 20 },
  { n: 'Протеин (порошок)', s: ['протеин'], k: 380, p: 75, f: 5, c: 8, pc: 30 },
  // овощи и фрукты
  { n: 'Овощи', s: ['овощ', 'брокколи', 'капуст', 'кабач', 'фасоль стручк', 'стручков', 'морков'], k: 35, p: 2, f: 0.3, c: 6, d: 300 },
  { n: 'Салат из овощей с маслом', s: ['салат'], k: 90, p: 1, f: 7, c: 4, d: 200 },
  { n: 'Огурец', s: ['огур'], k: 15, p: 0.8, f: 0.1, c: 3, pc: 120 },
  { n: 'Помидор', s: ['помидор', 'томат'], k: 20, p: 1, f: 0.2, c: 4, pc: 120 },
  { n: 'Яблоко', s: ['яблок'], k: 47, p: 0.4, f: 0.4, c: 10, pc: 180 },
  { n: 'Груша', s: ['груш'], k: 47, p: 0.4, f: 0.3, c: 10, pc: 170 },
  { n: 'Апельсин', s: ['апельсин'], k: 43, p: 0.9, f: 0.2, c: 8, pc: 200 },
  { n: 'Мандарин', s: ['мандарин'], k: 38, p: 0.8, f: 0.2, c: 8, pc: 80 },
  { n: 'Банан', s: ['банан'], k: 95, p: 1.5, f: 0.5, c: 21, pc: 120 },
  { n: 'Ягоды', s: ['ягод', 'клубник', 'черник', 'малин'], k: 45, p: 1, f: 0.5, c: 9, d: 150 },
  { n: 'Виноград', s: ['виноград'], k: 70, p: 0.6, f: 0.2, c: 17, d: 150 },
  // жиры, сладкое, перекусы
  { n: 'Масло растительное', s: ['масло растит', 'оливков', 'подсолн', 'масл'], k: 899, p: 0, f: 100, c: 0, pc: 15 },
  { n: 'Масло сливочное', s: ['сливочн'], k: 748, p: 0.5, f: 82, c: 0.8, pc: 10 },
  { n: 'Орехи', s: ['орех', 'миндал', 'кешью', 'фундук', 'арахис'], k: 600, p: 18, f: 53, c: 13, pc: 30, d: 30 },
  { n: 'Арахисовая паста', s: ['арахисов', 'паста арах'], k: 600, p: 25, f: 50, c: 16, pc: 15 },
  { n: 'Майонез', s: ['майонез'], k: 630, p: 1, f: 67, c: 3, pc: 15 },
  { n: 'Кетчуп', s: ['кетчуп', 'соус'], k: 100, p: 1.5, f: 0, c: 23, pc: 15 },
  { n: 'Сахар', s: ['сахар'], k: 400, p: 0, f: 0, c: 100, pc: 5 },
  { n: 'Мёд', s: ['мед', 'варень'], k: 320, p: 0.5, f: 0, c: 80, pc: 10 },
  { n: 'Шоколад', s: ['шоколад'], k: 540, p: 6, f: 32, c: 55, pc: 90 },
  { n: 'Конфета', s: ['конфет'], k: 480, p: 4, f: 25, c: 60, pc: 15 },
  { n: 'Печенье', s: ['печень'], k: 440, p: 7, f: 15, c: 70, pc: 12 },
  { n: 'Выпечка / пирожок', s: ['пирож', 'выпечк', 'булочк', 'круассан', 'пирог'], k: 330, p: 8, f: 11, c: 50, pc: 80 },
  { n: 'Мороженое', s: ['морожен'], k: 230, p: 3.5, f: 12, c: 25, pc: 80 },
  { n: 'Чипсы', s: ['чипс'], k: 540, p: 6, f: 34, c: 52, d: 70 },
  // готовая еда и фастфуд
  { n: 'Суп', s: ['суп', 'борщ', 'щи', 'солянк'], k: 45, p: 2, f: 2, c: 5, d: 300 },
  { n: 'Плов', s: ['плов'], k: 180, p: 6, f: 8, c: 22, d: 300 },
  { n: 'Блины', s: ['блин', 'оладь'], k: 230, p: 6, f: 9, c: 30, pc: 50 },
  { n: 'Пицца', s: ['пицц'], k: 260, p: 11, f: 10, c: 30, pc: 120 },
  { n: 'Бургер', s: ['бургер', 'гамбургер', 'чизбургер'], k: 250, p: 13, f: 12, c: 24, pc: 220 },
  { n: 'Шаурма', s: ['шаурм', 'шаверм', 'ролл'], k: 220, p: 10, f: 10, c: 22, pc: 350 },
  { n: 'Картофель фри', s: ['фри'], k: 310, p: 3.4, f: 15, c: 41, d: 110 },
  { n: 'Наггетсы', s: ['наггетс'], k: 290, p: 15, f: 18, c: 17, pc: 18 },
  // напитки
  { n: 'Газировка', ml: 1, s: ['кола', 'газиров', 'лимонад', 'спрайт', 'фанта'], k: 42, p: 0, f: 0, c: 10.6, d: 330 },
  { n: 'Сок', ml: 1, s: ['сок'], k: 45, p: 0.5, f: 0, c: 10, d: 250 },
  { n: 'Энергетик', ml: 1, s: ['энергетик'], k: 45, p: 0, f: 0, c: 11, d: 450 },
  { n: 'Какао / капучино', ml: 1, s: ['какао', 'капучино', 'латте'], k: 60, p: 3, f: 2.5, c: 6, d: 300 },
  { n: 'Чай / кофе без сахара', ml: 1, s: ['чай', 'кофе'], k: 1, p: 0, f: 0, c: 0, d: 250 },
];
const FOOD_STEMS = FOODS
  .flatMap((f) => f.s.map((s) => [s, f]))
  .sort((a, b) => b[0].length - a[0].length);
const PIECE_WORDS = /^(шт|штук|штуки|штука|ломт|кус|ложк|горст|плитк|пачк|порц|стакан|банк|бутыл)/;
const FILLER = /^(съел[аи]?|съем|поел[аи]?|выпил[аи]?|ел[аи]?|на|завтрак|обед|ужин|перекус|полдник|еще|ещё|и|с|со|немного|примерно|около|грамм|граммов|гр|г|мл|кг|л|шт|штук|штуки|штука)$/;

function findFood(t) {
  for (const [stem, f] of FOOD_STEMS) {
    const i = t.indexOf(stem);
    if (i >= 0 && (i === 0 || /[\s,.(]/.test(t[i - 1]))) return { f, stem, i };
  }
  return null;
}
// Одна позиция: «гречка 250», «2 яйца», «курица 180г», «кефир 0.5л», «пицца 2 куска», «яблоко»
function parseFoodPart(part, u) {
  const t = norm(part).replace(/ё/g, 'е').replace(/\d+(?:[.,]\d+)?\s*%/g, ' ').trim();
  if (!t) return null;
  const mine = myFoodPart(t, u);
  if (mine) return mine;
  const hit = findFood(t);
  if (!hit) return { bad: part.trim() };
  const { f } = hit;
  let grams = null;
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:(кг|г|гр|грамм\S*|мл|л|шт\S*|ломт\S*|кус\S*|ложк\S*|горст\S*|плитк\S*|пачк\S*|порц\S*|стакан\S*|банк\S*|бутыл\S*)(?=$|[\s,.;)]))?/);
  if (m) {
    const n = parseFloat(m[1].replace(',', '.'));
    const unit = m[2] || '';
    if (unit === 'кг' || unit === 'л') grams = n * 1000;
    else if (/^(г|гр|грамм|мл)/.test(unit)) grams = n;
    else if (/^стакан/.test(unit)) grams = n * 250;
    else if (/^порц/.test(unit)) grams = n * (f.d || f.pc || 100);
    else if (unit && PIECE_WORDS.test(unit)) grams = n * (f.pc || f.d || 100);
    else if (f.pc && n <= 12 && Number.isInteger(n)) grams = n * f.pc; // «2 яйца», «яблоко 1»
    else if (n <= 3) grams = n * (f.d || 100); // «гречка 1.5» — полторы порции
    else grams = n;
  } else {
    const word = /(^|\s)(пол|половин\S*|полпорции)(\s|$)/.test(t) ? 0.5 : 1;
    const unitWord = t.match(/(стакан|порц)/);
    grams = word * (unitWord && unitWord[1] === 'стакан' ? 250 : f.pc && !f.d ? f.pc : f.d || f.pc || 100);
  }
  if (!(grams > 0 && grams <= 3000)) return { bad: part.trim() };
  const x = grams / 100;
  return { name: f.n, g: Math.round(grams), u: f.ml ? 'мл' : 'г', k: Math.round(f.k * x), p: Math.round(f.p * x), fat: Math.round(f.f * x), c: Math.round(f.c * x) };
}
function parseMeal(text, u) {
  const parts = text.split(/[,;\n+]|\s+и\s+|\s+на\s+(?=молок|кефир|вод)|\s+с\s+(?=\D)|\s+со\s+/i).map((s) => s.trim()).filter(Boolean)
    .map((s) => s.split(/\s+/).filter((w, i, arr) => !(i === 0 && arr.length > 1 && FILLER.test(norm(w)))).join(' '));
  const ok = [], bad = [];
  for (const p of parts) {
    if (FILLER.test(norm(p))) continue;
    const r = parseFoodPart(p, u);
    if (!r) continue;
    if (r.bad != null) bad.push(r.bad); else ok.push(r);
  }
  return { ok, bad };
}
function mealSummary(items) {
  const sum = (key) => items.reduce((a, x) => a + (x[key] || 0), 0);
  return items.map((x) => `• ${esc(x.name)} ${x.g} ${x.u} — <b>${x.k}</b> ккал (Б ${x.p} · Ж ${x.fat} · У ${x.c})`).join('\n') +
    (items.length > 1 ? `\n<b>Итого: ${sum('k')} ккал</b> · Б ${sum('p')} · Ж ${sum('fat')} · У ${sum('c')}` : '');
}
function productText(q) {
  const t = norm(q || '').replace(/ё/g, 'е');
  if (!t) {
    return '🔎 Что в базе (на 100 г):\n' + FOODS.map((f) => `${f.n} — ${f.k}`).join(' · ') +
      '\n\nПиши еду обычным текстом: <code>гречка 250, курица 180, 2 яйца</code>';
  }
  const hit = findFood(t);
  if (!hit) return `Не нашёл «${esc(q)}» в базе. Запиши вручную: <code>/el 300 ${esc(q)}</code>`;
  const f = hit.f;
  let s = `🔎 <b>${f.n}</b> — на 100 г: <b>${f.k} ккал</b> · Б ${f.p} · Ж ${f.f} · У ${f.c}`;
  if (f.pc) s += `\n1 шт/ломтик/ложка ≈ ${f.pc} г → ${Math.round(f.k * f.pc / 100)} ккал`;
  if (f.d) s += `\nОбычная порция ${f.d} г → ${Math.round(f.k * f.d / 100)} ккал`;
  return s;
}

// ---------------------------------------------------------------- каникулы и праздники (Москва, примерные даты)
const SCHOOL_HOLIDAYS = [
  ['2026-10-24', '2026-11-01'], ['2026-12-27', '2027-01-10'], ['2027-03-20', '2027-03-28'], ['2027-05-27', '2027-08-31'],
  ['2027-10-23', '2027-10-31'], ['2027-12-26', '2028-01-09'], ['2028-03-18', '2028-03-26'],
];
const PUBLIC_HOLIDAYS = ['2026-11-04', '2027-02-23', '2027-03-08', '2027-05-03', '2027-05-10', '2027-06-14', '2027-11-04', '2027-11-05',
  '2028-02-23', '2028-03-08', '2028-05-01', '2028-05-09', '2028-06-12'];
function holidayName(date) {
  if (PUBLIC_HOLIDAYS.includes(date)) return 'праздник';
  if (SCHOOL_HOLIDAYS.some(([a, b]) => date >= a && date <= b)) return 'каникулы';
  return null;
}

// ---------------------------------------------------------------- вода, шаги, сон
const WATER_GOAL = 2500;
function waterToday(u, info) {
  if (!u.water || u.water.d !== info.date) {
    if (u.water && u.water.ml > 0) {
      u.waterDays = (u.waterDays || []).filter((x) => x.d !== u.water.d);
      u.waterDays.push({ d: u.water.d, ml: u.water.ml });
      if (u.waterDays.length > 60) u.waterDays.shift();
    }
    u.water = { d: info.date, ml: 0 };
  }
  return u.water;
}
const waterKb = { inline_keyboard: [[{ text: '💧 +250 мл', callback_data: 'v|250' }, { text: '💧 +500 мл', callback_data: 'v|500' }]] };
function addWater(u, info, ml) {
  const w = waterToday(u, info);
  w.ml = Math.max(0, Math.min(8000, w.ml + ml));
  return `💧 Вода сегодня: <b>${w.ml}</b> из ${WATER_GOAL} мл${w.ml >= WATER_GOAL ? ' ✅' : ''}`;
}
function setDaily(arr, info, rec, max = 60) {
  const a = (arr || []).filter((x) => x.d !== info.date);
  a.push({ d: info.date, ...rec });
  a.sort((x, y) => (x.d < y.d ? -1 : 1));
  while (a.length > max) a.shift();
  return a;
}
const stepsKb = { inline_keyboard: [[5000, 8000, 11000, 14000].map((n) => ({ text: `👣 ${n / 1000}k`, callback_data: `st|${n}` }))] };
const sleepKb = { inline_keyboard: [[
  { text: '😃 Выспался', callback_data: 'sl|2' }, { text: '😐 Так себе', callback_data: 'sl|1' }, { text: '😫 Плохо', callback_data: 'sl|0' },
]] };
function activity(u) {
  const st = (u.steps || []).slice(-7);
  if (st.length < 3) return { f: 1.55, avg: null };
  const avg = Math.round(st.reduce((a, x) => a + x.n, 0) / st.length);
  return { f: avg < 6000 ? 1.45 : avg < 9000 ? 1.5 : avg < 14000 ? 1.55 : 1.6, avg };
}
function weightKb(u) {
  const lw = Math.round(lastWeight(u) * 10) / 10;
  return { inline_keyboard: [[-1, -0.5, -0.2, 0, 0.5].map((d) => {
    const v = Math.round((lw + d) * 10) / 10;
    return { text: kg(v), callback_data: `w|${v}` };
  })] };
}
function recordWeight(u, info, v) {
  u.weights = u.weights.filter((x) => x.d !== info.date);
  u.weights.push({ d: info.date, kg: v });
}

// ---------------------------------------------------------------- серии и достижения
function foodStreak(u, info) {
  const dates = new Set((u.days || []).map((x) => x.d));
  if (u.food.date === info.date && u.food.items.length) dates.add(info.date);
  let d = dates.has(info.date) ? info : shiftDay(info, -1), n = 0;
  while (dates.has(d.date)) { n++; d = shiftDay(d, -1); }
  return n;
}
const maxW = (sets) => Math.max(...sets.map((s) => s[0]));
const ACH = [
  ['food1', '🍽 Первая запись еды', (u) => (u.days || []).length > 0 || u.food.items.length > 0],
  ['streak3', '🔥 3 дня подряд записываешь еду', (u, i) => foodStreak(u, i) >= 3],
  ['streak7', '🔥 Неделя записей еды подряд', (u, i) => foodStreak(u, i) >= 7],
  ['streak30', '🏅 30 дней записей подряд!', (u, i) => foodStreak(u, i) >= 30],
  ['ves1', '⚖️ Первое взвешивание', (u) => u.weights.length > 0],
  ['kg3', '📉 −3 кг от старта', (u) => u.weights.length > 1 && u.weights[0].kg - lastWeight(u) >= 3],
  ['kg5', '📉 −5 кг от старта', (u) => u.weights.length > 1 && u.weights[0].kg - lastWeight(u) >= 5],
  ['kg10', '🏆 −10 кг от старта!', (u) => u.weights.length > 1 && u.weights[0].kg - lastWeight(u) >= 10],
  ['kg15', '🏆 −15 кг от старта!', (u) => u.weights.length > 1 && u.weights[0].kg - lastWeight(u) >= 15],
  ['gym1', '🏋️ Первая записанная тренировка', (u) => (u.workoutDates || []).length >= 1],
  ['gym10', '🏋️ 10 тренировок', (u) => (u.workoutDates || []).length >= 10],
  ['gym30', '🏋️ 30 тренировок', (u) => (u.workoutDates || []).length >= 30],
  ['gym100', '🦾 100 тренировок!', (u) => (u.workoutDates || []).length >= 100],
  ['pr10', '💪 +10 кг в упражнении с первой записи', (u) => Object.entries(u.lifts).some(([k, h]) => EX[k] && !EX[k].bw && h.length > 1 && maxW(h[h.length - 1].sets) - maxW(h[0].sets) >= 10)],
  ['water7', '💧 7 дней с нормой воды', (u) => (u.waterDays || []).filter((x) => x.ml >= WATER_GOAL).length + (u.water && u.water.ml >= WATER_GOAL ? 1 : 0) >= 7],
  ['bus5', '🚏 5 отметок автобуса', (u) => (u.busLog || []).length >= 5],
];
async function checkAch(env, id, info) {
  const { u, exists } = await loadUser(env, id);
  if (!exists) return;
  const got = u.ach || (u.ach = []);
  const nw = ACH.filter(([k, , f]) => !got.includes(k) && f(u, info));
  if (!nw.length) return;
  got.push(...nw.map((a) => a[0]));
  await saveUser(env, id, u);
  await send(env, id, '🏆 <b>Достижение!</b>\n' + nw.map((a) => a[1]).join('\n') + '\n\nВсе — /dostizheniya');
}
function achText(u, info) {
  const got = u.ach || [];
  return `🏆 <b>Достижения</b> (${got.length} из ${ACH.length})\n\n` +
    ACH.map(([k, t]) => (got.includes(k) ? '✅ ' : '▫️ ') + t).join('\n') +
    `\n\n🔥 Серия записей еды: <b>${foodStreak(u, info)}</b> дн.`;
}

// ---------------------------------------------------------------- недельный отчёт
function weeklyReport(u, info) {
  const target = calc(u).target;
  const from = shiftDay(info, -6).date;
  const inWeek = (x) => x.d >= from && x.d <= info.date;
  const L = [`📋 <b>Итоги недели</b> (${ddmm(from)}–${ddmm(info.date)})\n`];
  const ws = u.weights;
  if (ws.length) {
    const prev = [...ws].reverse().find((x) => x.d < from);
    L.push(`⚖️ Вес: <b>${kg(lastWeight(u))} кг</b>${prev ? ` (за неделю ${kg(lastWeight(u) - prev.kg)} кг)` : ''}`);
    const rate = weeklyRate(ws);
    if (rate != null) L.push(`   темп ${rate > 0 ? '+' : ''}${kg(rate)} кг/нед${rate < -0.7 ? ' — быстро, ешь чуть больше' : rate <= -0.2 ? ' — отлично 👍' : ''}`);
  }
  const days = (u.days || []).filter(inWeek);
  const s = foodSum(u, info);
  const all = days.concat(s.n ? [{ d: info.date, k: s.k, p: s.p }] : []);
  if (all.length) {
    const avg = Math.round(all.reduce((a, x) => a + x.k, 0) / all.length);
    const ap = Math.round(all.reduce((a, x) => a + (x.p || 0), 0) / all.length);
    L.push(`🍽 Еда: в среднем <b>${avg}</b> из ${target} ккал, белок ~${ap} г · записано ${all.length} из 7 дн.`);
  } else L.push('🍽 Еда за неделю не записана.');
  const gym = (u.workoutDates || []).filter((d) => d >= from).length;
  L.push(`🏋️ Тренировок: <b>${gym}</b>${u.gymTime != null ? ` из ${u.gymDays.length}` : ''}`);
  const wd = (u.waterDays || []).filter(inWeek).concat(u.water && u.water.d === info.date && u.water.ml ? [u.water] : []);
  if (wd.length) L.push(`💧 Вода: в среднем ${Math.round(wd.reduce((a, x) => a + x.ml, 0) / wd.length)} мл/день`);
  const st = (u.steps || []).filter(inWeek);
  if (st.length) L.push(`👣 Шаги: в среднем ${Math.round(st.reduce((a, x) => a + x.n, 0) / st.length)}/день`);
  const sl = (u.sleepLog || []).filter(inWeek);
  if (sl.length) {
    L.push(`😴 Сон: выспался ${sl.filter((x) => x.q === 2).length}, так себе ${sl.filter((x) => x.q === 1).length}, плохо ${sl.filter((x) => x.q === 0).length}`);
    const kOf = (q) => {
      const ks = (u.sleepLog || []).filter((x) => x.q === q).map((x) => (u.days || []).find((y) => y.d === x.d)?.k).filter((k) => k);
      return ks.length >= 2 ? Math.round(ks.reduce((a, k) => a + k, 0) / ks.length) : null;
    };
    const good = kOf(2), bad = kOf(0);
    if (good && bad && bad - good > 200) L.push(`   после плохого сна ты ешь в среднем на ${bad - good} ккал больше — сон реально влияет на аппетит`);
  }
  const bs = busStatsLine(u);
  if (bs) L.push('🚌' + bs.replace('\n📊', ''));
  L.push(`🔥 Серия записей еды: ${foodStreak(u, info)} дн.`);
  const nn = (u.notes || []).filter(inWeek);
  if (nn.length) L.push(`📝 Заметок о самочувствии: ${nn.length} — /zametka`);
  L.push('\nНеделя — это шаг, а не экзамен. Следующая будет ещё чуть лучше 💪');
  return L.join('\n');
}

// ---------------------------------------------------------------- графики (QuickChart)
function chartUrl(title, labels, data, unit) {
  const c = {
    type: 'line',
    data: { labels, datasets: [{ label: title, data, fill: false, borderColor: '#2563eb', backgroundColor: '#2563eb', pointRadius: 3, tension: 0.25 }] },
    options: { plugins: { legend: { display: false }, title: { display: true, text: title } }, scales: { y: { title: { display: true, text: unit } } } },
  };
  return 'https://quickchart.io/chart?w=700&h=400&bkg=white&v=4&c=' + encodeURIComponent(JSON.stringify(c));
}
function chartFor(u, what) {
  const q = norm(what || 'вес');
  if (/^(вес|ves)/.test(q)) {
    const w = u.weights.slice(-40);
    return w.length < 2 ? null : chartUrl('Вес', w.map((x) => ddmm(x.d)), w.map((x) => x.kg), 'кг');
  }
  if (/^(тали|talia)/.test(q)) {
    const w = u.waist.slice(-24);
    return w.length < 2 ? null : chartUrl('Талия', w.map((x) => ddmm(x.d)), w.map((x) => x.cm), 'см');
  }
  if (/^(ккал|калор|kkal|еда)/.test(q)) {
    const d = (u.days || []).slice(-30);
    return d.length < 2 ? null : chartUrl('Калории по дням', d.map((x) => ddmm(x.d)), d.map((x) => x.k), 'ккал');
  }
  const ex = findExercise(q);
  if (ex) {
    const h = u.lifts[ex.key] || [];
    if (h.length < 2) return null;
    const bw = EX[ex.key].bw;
    return chartUrl(EX[ex.key].n, h.map((x) => ddmm(x.d)), h.map((x) => (bw ? Math.max(...x.sets.map((s) => s[1])) : maxW(x.sets))), bw ? 'повторы' : 'кг');
  }
  return undefined;
}

// ---------------------------------------------------------------- замены упражнений
const SUBS = {
  squat: ['Гоблет-присед', 'Жим ногами', 'Присед в Смите'],
  bench: ['Жим гантелей лёжа', 'Жим в тренажёре от груди', 'Отжимания (с весом или от возвышения)'],
  latpull: ['Подтягивания в гравитроне', 'Тяга верхнего блока узким хватом', 'Пуловер на блоке'],
  rdl: ['Румынская тяга с гантелями', 'Гиперэкстензия', 'Сгибания ног в тренажёре'],
  plank: ['Боковая планка', 'Мёртвый жук', 'Скручивания'],
  legpress: ['Гоблет-присед', 'Выпады', 'Присед в Смите'],
  ohp: ['Жим в тренажёре сидя', 'Жим штанги стоя', 'Махи гантелями в стороны'],
  dbrow: ['Тяга горизонтального блока', 'Тяга в рычажном тренажёре', 'Тяга штанги в наклоне'],
  lunge: ['Болгарские выпады', 'Зашагивания на платформу', 'Жим ногами одной ногой'],
  crunch: ['Подъём ног в висе', 'Скручивания на блоке', 'Планка'],
  goblet: ['Присед со штангой', 'Жим ногами', 'Присед в Смите'],
  incline: ['Жим в Смите на наклонной', 'Жим штанги на наклонной', 'Отжимания с ногами на возвышении'],
  cablerow: ['Тяга гантели в наклоне', 'Тяга в рычажном тренажёре', 'Тяга Т-грифа'],
  hip: ['Ягодичный мост с гантелью', 'Гиперэкстензия на ягодицы', 'Отведение ноги в кроссовере'],
  curl: ['Молотки с гантелями', 'Сгибания на нижнем блоке', 'Сгибания со штангой'],
  tri: ['Французский жим с гантелью', 'Отжимания узким хватом', 'Разгибание из-за головы на блоке'],
};

// ---------------------------------------------------------------- экспорт для врача
async function exportCsv(env, id, u, info) {
  const map = new Map();
  const row = (d) => { if (!map.has(d)) map.set(d, {}); return map.get(d); };
  u.weights.forEach((x) => (row(x.d).w = x.kg));
  u.waist.forEach((x) => (row(x.d).waist = x.cm));
  (u.days || []).forEach((x) => { row(x.d).k = x.k; row(x.d).p = x.p; });
  const s = foodSum(u, info); if (s.n) { row(info.date).k = s.k; row(info.date).p = s.p; }
  (u.steps || []).forEach((x) => (row(x.d).st = x.n));
  (u.waterDays || []).concat(u.water && u.water.ml ? [u.water] : []).forEach((x) => (row(x.d).wa = x.ml));
  (u.sleepLog || []).forEach((x) => (row(x.d).sl = ['плохо', 'так себе', 'хорошо'][x.q]));
  (u.workoutDates || []).forEach((d) => (row(d).gym = 'да'));
  (u.notes || []).forEach((x) => { const r = row(x.d); r.note = (r.note ? r.note + ' | ' : '') + x.t.replace(/[;\n]/g, ','); });
  const num = (v) => (v == null ? '' : String(v).replace('.', ','));
  const lines = ['Дата;Вес, кг;Талия, см;Ккал;Белок, г;Шаги;Вода, мл;Сон;Зал;Заметки'];
  [...map.keys()].sort().forEach((d) => {
    const r = map.get(d);
    lines.push([d, num(r.w), num(r.waist), num(r.k), num(r.p), num(r.st), num(r.wa), r.sl || '', r.gym || '', r.note || ''].join(';'));
  });
  const c = calc(u);
  const fd = new FormData();
  fd.append('chat_id', String(id));
  fd.append('document', new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }), `progress_${info.date}.csv`);
  fd.append('caption', `Дневник: вес, талия, калории, шаги, вода, сон. Норма сейчас ${c.target} ккал (рост ${u.height}, ${u.age} лет). Открывается в Excel / Google Таблицах.`);
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
}

// ---------------------------------------------------------------- фото еды и штрихкоды (Cloudflare Workers AI + Open Food Facts)
const VISION_MODELS = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/google/gemma-3-12b-it', '@cf/meta/llama-3.2-11b-vision-instruct'];
async function tgFileBytes(env, fileId) {
  const j = await tg(env, 'getFile', { file_id: fileId });
  const p = j.result?.file_path;
  if (!p) return null;
  const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${p}`);
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function visionAsk(env, bytes, prompt) {
  if (!env.AI) throw new Error('no AI binding');
  const url = 'data:image/jpeg;base64,' + b64(bytes);
  let lastErr = null;
  for (const m of VISION_MODELS) {
    try {
      let r;
      if (m.includes('llama-3.2')) {
        try { await env.AI.run(m, { prompt: 'agree' }); } catch { /* лицензия уже принята */ }
        r = await env.AI.run(m, { messages: [{ role: 'user', content: prompt }], image: [...bytes], max_tokens: 700 });
      } else {
        r = await env.AI.run(m, { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url } }] }], max_tokens: 700, temperature: 0.2 });
      }
      const out = typeof r === 'string' ? r
        : typeof r?.response === 'string' ? r.response
        : r?.response ? JSON.stringify(r.response)
        : r?.choices?.[0]?.message?.content || '';
      if (out) { try { await env.DB.put('lastai', JSON.stringify({ at: new Date().toISOString(), model: m, out: out.slice(0, 800) })); } catch { /* ignore */ } return out; }
    } catch (e) {
      lastErr = e; console.error('vision', m, e?.message);
      try { await env.DB.put('lasterr', JSON.stringify({ at: new Date().toISOString(), model: m, err: String(e?.message || e).slice(0, 500) })); } catch { /* ignore */ }
    }
  }
  throw lastErr || new Error('empty');
}
const FOOD_PROMPT = 'Ты диетолог. На фото еда. Определи каждое блюдо или продукт и оцени вес порции в граммах по фото (по размеру тарелки, ложки, упаковки). ' +
  'Ответь ТОЛЬКО JSON без пояснений и без markdown: {"items":[{"name":"гречка","grams":200,"kcal":220,"protein":8,"fat":2,"carbs":42}]}. ' +
  'Названия коротко по-русски. Если еды на фото нет — {"items":[]}.';
function parseAiItems(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j;
  try { j = JSON.parse(text.slice(a, b + 1)); } catch { return null; }
  const items = Array.isArray(j) ? j : j.items;
  if (!Array.isArray(items)) return null;
  const out = [];
  for (const it of items.slice(0, 10)) {
    const name = String(it.name || '').slice(0, 40).trim();
    const g = Math.round(+it.grams || 0);
    if (!name || !(g > 0 && g <= 1500)) continue;
    const hit = findFood(norm(name).replace(/ё/g, 'е'));
    if (hit) {
      const f = hit.f, x = g / 100;
      out.push({ name: `${name} (${f.n})`, g, u: f.ml ? 'мл' : 'г', k: Math.round(f.k * x), p: Math.round(f.p * x), fat: Math.round(f.f * x), c: Math.round(f.c * x) });
    } else {
      const k = Math.round(+it.kcal || 0);
      if (!(k >= 0 && k <= 3000)) continue;
      out.push({ name, g, u: 'г', k, p: Math.round(+it.protein || 0), fat: Math.round(+it.fat || 0), c: Math.round(+it.carbs || 0) });
    }
  }
  return out;
}
async function offLookup(code) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_ru,brands,nutriments,product_quantity`, { headers: { 'User-Agent': 'stol8-bot/1.0 (telegram bot)' } });
    if (!r.ok) return null;
    const j = await r.json();
    const p = j.product, n = p?.nutriments;
    if (!n) return null;
    const k = n['energy-kcal_100g'] ?? (n.energy_100g ? n.energy_100g / 4.184 : null);
    if (k == null) return null;
    const name = (p.product_name_ru || p.product_name || 'Продукт') + (p.brands ? ` (${String(p.brands).split(',')[0]})` : '');
    return { code, n: name.slice(0, 60), k: +k, p: +(n.proteins_100g || 0), f: +(n.fat_100g || 0), c: +(n.carbohydrates_100g || 0), q: +p.product_quantity || null };
  } catch { return null; }
}
function productAsk(pr) {
  const r1 = (x) => Math.round(x * 10) / 10;
  const btns = [50, 100, 150, 200].map((g) => ({ text: `${g} г`, callback_data: `og|${g}` }));
  const rows = [btns];
  if (pr.q && pr.q > 0 && pr.q <= 3000) rows.push([{ text: `Вся упаковка (${pr.q} г)`, callback_data: `og|${Math.round(pr.q)}` }]);
  return {
    text: `🏷 <b>${esc(pr.n)}</b>\nНа 100 г: <b>${Math.round(pr.k)} ккал</b> · Б ${r1(pr.p)} · Ж ${r1(pr.f)} · У ${r1(pr.c)}\n\nСколько съел? Нажми кнопку или напиши число граммов.`,
    kb: { inline_keyboard: rows },
  };
}
function productItem(pr, g) {
  const x = g / 100;
  return { name: pr.n, g, u: 'г', k: Math.round(pr.k * x), p: Math.round(pr.p * x), fat: Math.round(pr.f * x), c: Math.round(pr.c * x) };
}
async function analyzePhoto(env, id, u, info, mode) {
  const ph = u.pendingPhoto;
  if (!ph) return send(env, id, 'Фото не нашёл — пришли его ещё раз.');
  if (!env.AI) return send(env, id, 'Распознавание фото не подключено (нужен Workers AI). Пока пиши текстом: <code>гречка 250, курица 180</code>');
  await tg(env, 'sendChatAction', { chat_id: id, action: 'typing' });
  const bytes = await tgFileBytes(env, ph.f);
  if (!bytes) return send(env, id, 'Не смог скачать фото из Telegram. Попробуй ещё раз.');
  try {
    if (mode === 'bar') {
      const t = await visionAsk(env, bytes, 'На фото штрихкод товара. Выпиши только цифры под штрихкодом (EAN-13 или EAN-8) подряд, без пробелов и пояснений. Если цифр не видно — ответь NONE.');
      const code = (t.replace(/\s/g, '').match(/\d{8,14}/) || [])[0];
      if (!code) return send(env, id, 'Не разглядел цифры штрихкода 😕 Сфотографируй ближе, при хорошем свете — или просто напиши цифры под штрихкодом сообщением.');
      return barcodeFlow(env, id, u, info, code);
    }
    const t = await visionAsk(env, bytes, FOOD_PROMPT + (ph.cap ? ` Подсказка от пользователя: «${ph.cap}».` : ''));
    const items = parseAiItems(t);
    if (!items || !items.length) return send(env, id, 'Не понял, что на фото 😕 Напиши текстом: <code>гречка 250, курица 180</code>');
    u.pendingMeal = items;
    await saveUser(env, id, u);
    return send(env, id, `🔎 <b>Вижу на фото</b> (оценка на глаз, ±20 %):\n${mealSummary(items)}\n\nЗаписать?`,
      { reply_markup: { inline_keyboard: [[{ text: '✅ Записать', callback_data: 'pm|ok' }, { text: '✏️ Не то', callback_data: 'pm|no' }]] } });
  } catch (e) {
    console.error('analyzePhoto', e);
    return send(env, id, 'Нейросеть сейчас не ответила 😕 Попробуй ещё раз чуть позже или напиши текстом: <code>гречка 250, курица 180</code>');
  }
}
async function barcodeFlow(env, id, u, info, code) {
  const pr = await offLookup(code);
  if (!pr) return send(env, id, `Штрихкод <code>${code}</code> не нашёл в базе Open Food Facts 😕\nЗапиши вручную по этикетке: <code>/el 250 название</code>`);
  u.pendingProduct = { ...pr, at: info.date + ' ' + info.min };
  await saveUser(env, id, u);
  const a = productAsk(pr);
  return send(env, id, a.text, { reply_markup: a.kb });
}

// ---------------------------------------------------------------- свои продукты
function parseMyFood(args) {
  const toks = args.trim().split(/\s+/);
  const i = toks.findIndex((t) => /^\d+$/.test(t));
  if (i < 1) return null;
  const n = toks.slice(0, i).join(' ').slice(0, 40), k = +toks[i];
  if (!(k > 0 && k <= 3000)) return null;
  const get = (ch) => { const t = toks.slice(i + 1).find((x) => new RegExp('^' + ch + '\\d+$', 'i').test(x)); return t ? +t.slice(1) : 0; };
  return { n, key: norm(n).replace(/ё/g, 'е'), k, p: get('б'), f: get('ж'), c: get('у') };
}
function myFoodPart(t, u) {
  const list = (u?.myFoods || []).slice().sort((a, b) => b.key.length - a.key.length);
  for (const m of list) {
    if (!t.includes(m.key)) continue;
    const rest = t.replace(m.key, ' ');
    const nm = rest.match(/(\d+(?:[.,]\d+)?)/);
    const cnt = nm ? parseFloat(nm[1].replace(',', '.')) : /(^|\s)пол(\s|$)/.test(rest) ? 0.5 : 1;
    if (!(cnt > 0 && cnt <= 20)) return { bad: t };
    return { name: m.n, g: cnt, u: 'порц.', k: Math.round(m.k * cnt), p: Math.round(m.p * cnt), fat: Math.round(m.f * cnt), c: Math.round(m.c * cnt) };
  }
  return null;
}

// ---------------------------------------------------------------- ИИ для текста и голоса (Workers AI)
const TEXT_MODELS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];
const WHISPER_MODELS = ['@cf/openai/whisper-large-v3-turbo', '@cf/openai/whisper'];
const aiOut = (r) => (typeof r === 'string' ? r
  : typeof r?.response === 'string' ? r.response
  : r?.response ? JSON.stringify(r.response)
  : r?.choices?.[0]?.message?.content || '');
async function aiLog(env, key, obj) { try { await env.DB.put(key, JSON.stringify({ at: new Date().toISOString(), ...obj })); } catch { /* ignore */ } }
async function textAsk(env, prompt) {
  if (!env.AI) throw new Error('no AI binding');
  let lastErr = null;
  for (const m of TEXT_MODELS) {
    try {
      const out = aiOut(await env.AI.run(m, { messages: [{ role: 'user', content: prompt }], max_tokens: 700, temperature: 0.2 }));
      if (out) { await aiLog(env, 'lastai', { model: m, out: out.slice(0, 800) }); return out; }
    } catch (e) { lastErr = e; await aiLog(env, 'lasterr', { model: m, err: String(e?.message || e).slice(0, 500) }); }
  }
  throw lastErr || new Error('empty');
}
async function transcribe(env, bytes) {
  if (!env.AI) throw new Error('no AI binding');
  let lastErr = null;
  for (const m of WHISPER_MODELS) {
    try {
      const r = m.includes('turbo')
        ? await env.AI.run(m, { audio: b64(bytes), language: 'ru' })
        : await env.AI.run(m, { audio: [...bytes] });
      const t = (r?.text || '').trim();
      if (t) return t;
    } catch (e) { lastErr = e; await aiLog(env, 'lasterr', { model: m, err: String(e?.message || e).slice(0, 500) }); }
  }
  throw lastErr || new Error('empty');
}
const TEXT_FOOD_PROMPT = 'Ты диетолог. Человек описал, что съел. Разбери на продукты/блюда и оцени вес каждой порции в граммах (если не указан — обычная порция). ' +
  'Ответь ТОЛЬКО JSON без пояснений и без markdown: {"items":[{"name":"шаурма","grams":350,"kcal":770,"protein":35,"fat":35,"carbs":77}]}. ' +
  'Названия коротко по-русски. Если это не про еду — {"items":[]}. Текст: ';
async function aiMealConfirm(env, id, u, text, title) {
  let items = null;
  try { items = parseAiItems(await textAsk(env, TEXT_FOOD_PROMPT + JSON.stringify(text.slice(0, 400)))); } catch (e) { console.error('aiMeal', e); }
  if (!items || !items.length) return false;
  u.pendingMeal = items;
  await saveUser(env, id, u);
  await send(env, id, `${title}\n${mealSummary(items)}\n\nЗаписать?`,
    { reply_markup: { inline_keyboard: [[{ text: '✅ Записать', callback_data: 'pm|ok' }, { text: '✏️ Не то', callback_data: 'pm|no' }]] } });
  return true;
}

// ---------------------------------------------------------------- умное меню под остаток
function smartMeal(u, info, slot) {
  const c = calc(u), s = foodSum(u, info);
  const leftK = c.target - s.k, leftP = Math.max(0, 150 - s.p);
  const pool = [...MENU.dinner, ...MENU.lunch, ...MENU.snack2, ...MENU.late].map((v) => ({ ...v }));
  if (leftK < 150) {
    return { leftK, leftP, text: `Сегодня уже ${s.k} из ${c.target} ккал — норма почти закрыта.${leftK < -300 ? ' Это ок, завтра обычный день.' : ''} Если голоден — кефир или творог 100 г (100–120 ккал), без голодовок.` };
  }
  const rest = buildDay(u, info).filter((e) => e.kind === 'meal' && e.t >= info.min - 30).length || 1;
  const want = slot === 'late' ? Math.min(leftK, 300) : Math.round(leftK / rest);
  const opts = [];
  for (const v of pool) {
    for (const f of [0.5, 0.75, 1, 1.25, 1.5]) {
      const k = Math.round(v.k * f), p = Math.round(v.p * f);
      if (k > want + 100) continue;
      const score = Math.abs(want - k) / 100 + Math.max(0, Math.min(leftP, 60) - p) / 10;
      opts.push({ t: v.t, f, k, p, score });
    }
  }
  opts.sort((a, b) => a.score - b.score);
  const seen = new Set(), best = [];
  for (const o of opts) { if (seen.has(o.t)) continue; seen.add(o.t); best.push(o); if (best.length === 3) break; }
  const portion = (f) => (f === 1 ? '' : f < 1 ? ` <i>(порция ×${String(f).replace('.', ',')} — поменьше)</i>` : ` <i>(порция ×${String(f).replace('.', ',')} — побольше)</i>`);
  return {
    leftK, leftP,
    text: `🎯 Осталось <b>${leftK} ккал</b>${leftP ? ` и ~${leftP} г белка` : ''}${rest > 1 && slot !== 'late' ? ` на ${rest} приёма — на ближайший ~${want}` : ''}. Подойдёт:\n` +
      best.map((o, i) => `${i + 1}. ${esc(o.t)}${portion(o.f)} — ${o.k} ккал, белок ${o.p} г`).join('\n'),
  };
}

// ---------------------------------------------------------------- подстройка времени еды
const median = (a) => { const d = [...a].sort((x, y) => x - y); return d[Math.floor(d.length / 2)]; };
function mealShift(u, slot) {
  const l = (u.mealShift || {})[slot];
  if (!l || l.length < 3) return 0;
  const m = median(l);
  return Math.abs(m) < 10 ? 0 : Math.max(-60, Math.min(60, r5(m)));
}
function learnMeal(u, info, slot) {
  // запоминаем, во сколько реально ешь относительно расписания
  const evs = buildDay(u, info, true).filter((e) => e.kind === 'meal');
  let e = slot ? evs.find((x) => x.slot === slot) : null;
  if (!e) {
    let bd = 1e9;
    for (const x of evs) { const d = Math.abs(info.min - x.t); if (d < bd) { bd = d; e = x; } }
    if (!e || bd > 90) return;
  }
  u.mealSeen = u.mealSeen || {};
  if (u.mealSeen[e.slot] === info.date) return;
  u.mealSeen[e.slot] = info.date;
  const diff = info.min - e.t;
  if (Math.abs(diff) > 120) return;
  u.mealShift = u.mealShift || {};
  u.mealShift[e.slot] = (u.mealShift[e.slot] || []).concat(diff).slice(-10);
}

// ---------------------------------------------------------------- настройки напоминаний
const REMIND_GROUPS = {
  meals: ['🍽 Еда', ['meal']], water: ['💧 Вода', ['water']], bus: ['🚌 Автобус', ['bus10', 'busgo', 'buscheck']],
  gym: ['🏋️ Зал', ['gym']], exercise: ['🤸 Зарядка', ['exercise']], bed: ['😴 Отбой', ['bed30', 'bed']],
  prep: ['🧺 Заготовка', ['prep', 'prep2']], progress: ['📈 Вес, замеры, отчёт', ['weigh', 'month', 'weekly']],
  evening: ['🧾 Итог дня', ['foodcheck']],
};
const KIND_GROUP = Object.fromEntries(Object.entries(REMIND_GROUPS).flatMap(([g, [, ks]]) => ks.map((k) => [k, g])));
function inQuiet(u, t) {
  const q = u.quiet;
  if (!q || q.from == null || q.to == null) return false;
  const m = ((t % 1440) + 1440) % 1440;
  return q.from <= q.to ? m >= q.from && m < q.to : m >= q.from || m < q.to;
}
function eventMuted(u, e) {
  const g = KIND_GROUP[e.kind];
  if (g && (u.off || []).includes(g)) return true;
  if (['wake', 'bus10', 'busgo', 'buscheck'].includes(e.kind)) return false; // подъём и автобус — всегда
  return inQuiet(u, e.t);
}
function remindKb(u) {
  const off = u.off || [];
  const rows = [], keys = Object.keys(REMIND_GROUPS);
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(keys.slice(i, i + 2).map((k) => ({ text: `${off.includes(k) ? '🔕' : '🔔'} ${REMIND_GROUPS[k][0]}`, callback_data: `n|${k}` })));
  }
  return { inline_keyboard: rows };
}
const remindText = (u) => '🔔 <b>Напоминания</b> — нажми, чтобы включить/выключить.\n' +
  `Тихие часы: ${u.quiet ? `<b>${fmt(u.quiet.from)}–${fmt(u.quiet.to)}</b> (кроме подъёма и автобуса)` : 'нет'} — <code>/tishina 22:30 7:00</code> или <code>/tishina нет</code>`;

// ---------------------------------------------------------------- дневник с удалением
function diaryText(u, info) {
  const items = u.food.date === info.date ? u.food.items : [];
  if (!items.length) return { text: '📒 Сегодня записей нет. Пиши текстом, голосом 🎤 или пришли фото 📷' };
  const s = foodSum(u, info), c = calc(u);
  const text = `📒 <b>Дневник за сегодня</b>\n` + items.map((x, i) => `${i + 1}. <code>${fmt(x.at)}</code> ${esc(x.name)} — <b>${x.k}</b>`).join('\n') +
    `\n\nИтого ${s.k} из ${c.target} ккал. Нажми номер, чтобы удалить. Граммы удобнее менять в приложении 📊`;
  const btns = items.map((_, i) => ({ text: `❌ ${i + 1}`, callback_data: `dl|${i}` })).slice(-24);
  const rows = []; for (let i = 0; i < btns.length; i += 6) rows.push(btns.slice(i, i + 6));
  return { text, kb: { inline_keyboard: rows } };
}
function bar(v, max, n = 10) {
  const f = Math.max(0, Math.min(n, Math.round((v / (max || 1)) * n)));
  return '▰'.repeat(f) + '▱'.repeat(n - f);
}

// ---------------------------------------------------------------- подходы в зале (общая логика для чата и приложения)
function logSets(u, info, key, sets) {
  if (u.lastWorkoutDate !== info.date) {
    const w = Object.keys(PROG).find((k) => PROG[k].includes(key)) || u.nextWorkout;
    u.curWorkout = w; u.nextWorkout = NEXT_W[w]; u.lastWorkoutDate = info.date;
    u.workoutDates = (u.workoutDates || []).filter((d) => d !== info.date).concat(info.date).slice(-300);
  }
  if (u.timer !== false) u.restAt = { d: info.date, m: info.min + (u.timerMin || 2) };
  const hist = (u.lifts[key] = u.lifts[key] || []);
  const prev = hist.length && hist[hist.length - 1].d !== info.date ? hist[hist.length - 1] : (hist.length > 1 ? hist[hist.length - 2] : null);
  if (hist.length && hist[hist.length - 1].d === info.date) hist[hist.length - 1].sets.push(...sets);
  else hist.push({ d: info.date, sets });
  if (hist.length > 20) hist.shift();
  return { today: hist[hist.length - 1], prev };
}

// ---------------------------------------------------------------- мини-приложение: авторизация Telegram WebApp
const APP_PATH = '/app';
const appUrl = (origin) => origin + APP_PATH;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
async function checkInitData(env, initData) {
  if (!initData || typeof initData !== 'string') return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', env.BOT_TOKEN);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  const age = Date.now() / 1000 - +(p.get('auth_date') || 0);
  if (!(age < 7 * 86400)) return null;
  try { return JSON.parse(p.get('user') || 'null'); } catch { return null; }
}

// ---------------------------------------------------------------- мини-приложение: данные
function appState(u, info) {
  const c = calc(u), s = foodSum(u, info);
  const pT = 150, fT = 90, cT = Math.max(150, Math.round((c.target - pT * 4 - fT * 9) / 4));
  const items = (u.food.date === info.date ? u.food.items : []).map((x, i) => ({
    i, name: x.base || x.name, g: x.g ?? null, u: x.u ?? null, k: x.k, p: x.p || 0, f: x.fat || 0, c: x.c || 0, at: x.at,
  }));
  const days = (u.days || []).slice(-60).map((x) => ({ d: x.d, k: x.k, p: x.p || 0 }));
  if (s.n) days.push({ d: info.date, k: s.k, p: s.p, today: true });
  const which = u.lastWorkoutDate === info.date ? u.curWorkout : u.nextWorkout;
  const workout = PROG[which].map((key) => {
    const h = u.lifts[key] || [], e = EX[key];
    const todayRec = h.length && h[h.length - 1].d === info.date ? h[h.length - 1] : null;
    const last = h.filter((x) => x.d !== info.date).slice(-1)[0] || null;
    return { key, n: e.n, s: e.s, r: e.r, bw: !!e.bw, step: e.step || 0, last, today: todayRec ? todayRec.sets : [], hint: last ? nextHint(key, last.sets).replace(/<[^>]+>/g, '') : '', subs: SUBS[key] };
  });
  const lifts = Object.entries(u.lifts).filter(([k, h]) => EX[k] && h.length).map(([k, h]) => ({
    key: k, n: EX[k].n, bw: !!EX[k].bw, hist: h.map((x) => ({ d: x.d, v: EX[k].bw ? Math.max(...x.sets.map((s2) => s2[1])) : maxW(x.sets) })),
  }));
  const meals = buildDay(u, info).filter((e) => e.kind === 'meal').map((e) => ({ t: e.t, slot: e.slot, n: SLOT_NAMES[e.slot] }));
  return {
    name: u.name || '', date: info.date, dow: info.dow, min: info.min, holiday: holidayName(info.date),
    target: c.target, tdee: c.tdee, act: c.act, eaten: { k: s.k, p: s.p, f: s.fat, c: s.c }, macros: { p: pT, f: fT, c: cT },
    items, days, meals,
    water: { ml: u.water && u.water.d === info.date ? u.water.ml : 0, goal: WATER_GOAL },
    waterDays: (u.waterDays || []).slice(-30),
    steps: (u.steps || []).slice(-30), sleep: (u.sleepLog || []).slice(-30),
    weights: u.weights.slice(-120), waist: u.waist.slice(-36), startWeight: u.startWeight,
    streak: foodStreak(u, info),
    workout: { which, list: workout, timerMin: u.timerMin || 2, timer: u.timer !== false, gymDays: u.gymDays, gymTime: u.gymTime },
    lifts,
    ach: ACH.map(([k, t]) => ({ k, t, got: (u.ach || []).includes(k) })),
    settings: { off: u.off || [], quiet: u.quiet || null, groups: Object.fromEntries(Object.entries(REMIND_GROUPS).map(([k, v]) => [k, v[0]])), autoHol: u.autoHol !== false, holidays: !!u.holidays },
    myFoods: (u.myFoods || []).map((m) => ({ key: m.key, n: m.n, k: m.k, p: m.p, f: m.f, c: m.c })),
    recent: (u.recent || []).slice(0, 15),
    foods: FOODS.map((f) => ({ n: f.n, k: f.k, p: f.p, f: f.f, c: f.c, pc: f.pc || null, d: f.d || null, ml: !!f.ml })),
    photos: u.photos.length ? [u.photos[0], u.photos[u.photos.length - 1]].filter((x, i, a) => i === 0 || x !== a[0]).map((x) => ({ d: x.d, f: x.f })) : [],
    notes: (u.notes || []).slice(-15).reverse(),
    smart: smartMeal(u, info, 'dinner').text.replace(/<[^>]+>/g, ''),
  };
}
function itemFromFood(f, g) {
  const x = g / 100;
  return { name: f.n, g: Math.round(g), u: f.ml ? 'мл' : 'г', k: Math.round(f.k * x), p: Math.round(f.p * x), fat: Math.round(f.f * x), c: Math.round(f.c * x) };
}
async function apiHandle(env, req, origin) {
  let body = {};
  try { body = await req.json(); } catch { /* пусто */ }
  const user = await checkInitData(env, body.initData);
  if (!user) return Response.json({ error: 'auth' }, { status: 401 });
  const id = user.id;
  if (!(await allowed(env, id))) return Response.json({ error: 'forbidden' }, { status: 403 });
  const { u, exists } = await loadUser(env, id);
  if (!exists) return Response.json({ error: 'start' }, { status: 404 });
  const info = nowMsk();
  const a = body.action;
  let msg = '';
  let changed = true;
  if (a === 'state') changed = false;
  else if (a === 'add') {
    let items = [];
    if (body.fi != null && FOODS[body.fi] && body.g > 0 && body.g <= 3000) items = [itemFromFood(FOODS[body.fi], +body.g)];
    else if (body.mine) {
      const m = (u.myFoods || []).find((x) => x.key === body.mine);
      const cnt = +body.cnt || 1;
      if (m && cnt > 0 && cnt <= 20) items = [{ name: m.n, g: cnt, u: 'порц.', k: Math.round(m.k * cnt), p: Math.round(m.p * cnt), fat: Math.round(m.f * cnt), c: Math.round(m.c * cnt) }];
    } else if (body.recent != null && (u.recent || [])[body.recent]) {
      const r = u.recent[body.recent], f = (+body.g > 0 && r.g) ? +body.g / r.g : 1;
      items = [{ ...r, g: Math.round(r.g * f * 10) / 10, k: Math.round(r.k * f), p: Math.round(r.p * f), fat: Math.round(r.fat * f), c: Math.round(r.c * f) }];
    } else if (body.text) {
      const pm = parseMeal(String(body.text).slice(0, 300), u);
      items = pm.ok;
      if (pm.bad.length) {
        let ai = null;
        try { ai = parseAiItems(await textAsk(env, TEXT_FOOD_PROMPT + JSON.stringify(pm.bad.join(', ')))); } catch { /* нет ИИ */ }
        if (ai && ai.length) items = items.concat(ai);
        else msg = 'Не узнал: ' + pm.bad.join(', ');
      }
    }
    if (items.length) { addItems(u, info, items); learnMeal(u, info); } else if (!msg) msg = 'Не понял, что добавить';
  } else if (a === 'edit') {
    const it = u.food.date === info.date ? u.food.items[body.i] : null;
    const g = +body.g;
    if (it && it.g && g > 0 && g <= 3000) {
      const f = g / it.g;
      Object.assign(it, { g: Math.round(g * 10) / 10, k: Math.round(it.k * f), p: Math.round((it.p || 0) * f), fat: Math.round((it.fat || 0) * f), c: Math.round((it.c || 0) * f) });
      it.name = `${it.base || it.name} ${it.g} ${it.u}`;
    } else msg = 'Эту запись можно только удалить';
  } else if (a === 'del') {
    if (u.food.date === info.date && u.food.items[body.i]) u.food.items.splice(body.i, 1);
  } else if (a === 'water') addWater(u, info, Math.max(-1000, Math.min(1000, +body.ml || 0)));
  else if (a === 'steps') { const n = +body.n; if (n >= 0 && n <= 80000) u.steps = setDaily(u.steps, info, { n }); }
  else if (a === 'weight') { const v = +body.kg; if (v > 30 && v < 300) recordWeight(u, info, v); else msg = 'Странный вес'; }
  else if (a === 'waist') { const v = +body.cm; if (v > 40 && v < 200) { u.waist = u.waist.filter((x) => x.d !== info.date); u.waist.push({ d: info.date, cm: v }); } }
  else if (a === 'sleep') u.sleepLog = setDaily(u.sleepLog, info, { q: Math.max(0, Math.min(2, +body.q)) });
  else if (a === 'set') {
    const key = body.key, w = +body.w || 0, r = +body.r;
    if (EX[key] && r > 0 && r <= 300 && w >= 0 && w <= 500) logSets(u, info, key, [[w, r]]);
    else msg = 'Проверь вес и повторы';
  } else if (a === 'unset') {
    const h = u.lifts[body.key] || [];
    if (h.length && h[h.length - 1].d === info.date) { h[h.length - 1].sets.pop(); if (!h[h.length - 1].sets.length) h.pop(); }
  } else if (a === 'note') {
    const t = String(body.t || '').trim().slice(0, 300);
    if (t) { u.notes = (u.notes || []).concat({ d: info.date, m: info.min, t }).slice(-200); }
  } else if (a === 'remind') {
    if (REMIND_GROUPS[body.g]) { const off = new Set(u.off || []); off.has(body.g) ? off.delete(body.g) : off.add(body.g); u.off = [...off]; }
  } else if (a === 'quiet') {
    const f = parseTime(body.from), t = parseTime(body.to);
    u.quiet = f != null && t != null && f !== t ? { from: f, to: t } : null;
  } else if (a === 'timer') { const n = +body.n; if (n >= 1 && n <= 5) { u.timerMin = n; u.timer = true; } else if (n === 0) u.timer = false; }
  else if (a === 'export') { await exportCsv(env, id, u, info); changed = false; msg = 'Таблица отправлена в чат'; }
  else { changed = false; msg = 'Неизвестное действие'; }
  if (changed) { await saveUser(env, id, u); await checkAch(env, id, info); }
  const fresh = changed ? (await loadUser(env, id)).u : u;
  return Response.json({ ok: true, msg, state: appState(fresh, info) });
}
async function photoProxy(env, url) {
  const user = await checkInitData(env, url.searchParams.get('a'));
  if (!user || !(await allowed(env, user.id))) return new Response('forbidden', { status: 403 });
  const { u } = await loadUser(env, user.id);
  const f = url.searchParams.get('f');
  if (!u.photos.some((x) => x.f === f)) return new Response('not found', { status: 404 });
  const bytes = await tgFileBytes(env, f);
  if (!bytes) return new Response('not found', { status: 404 });
  return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
}

// ---------------------------------------------------------------- расписание
function buildDay(u, info, raw = false) {
  const ev = [];
  const work = isWorkday(u, info);
  const wake = work ? u.wakeWd : u.wakeWe;
  const next = shiftDay(info, 1);
  const wakeNext = isWorkday(u, next) ? u.wakeWd : u.wakeWe;
  const bed = wakeNext + 1440 - Math.round(u.sleepH * 60);

  ev.push({ t: wake, kind: 'wake' });
  ev.push({ t: wake + 10, kind: 'exercise' });

  const slots = SLOTS_BY_N[u.meals] || SLOTS_BY_N[6];
  const n = slots.length, start = wake + 30, end = Math.max(bed - 120, start + 60 * (n - 1));
  const times = slots.map((_, i) => r5(start + ((end - start) * i) / (n - 1)));
  if (work && u.home != null && n >= 4) {
    // обед подстраиваем под «пришёл домой»
    const target = r5(u.home + 15);
    let best = 1, bd = 1e9;
    for (let i = 1; i < n - 1; i++) { const d = Math.abs(times[i] - target); if (d < bd) { bd = d; best = i; } }
    if (target > times[best - 1] + 90 && target < times[best + 1] - 90) times[best] = target;
  }
  if (!raw) {
    // подстройка под то, когда ты реально ешь (медиана последних отметок)
    slots.forEach((slot, i) => { times[i] += mealShift(u, slot); });
    for (let i = 1; i < n; i++) if (times[i] < times[i - 1] + 60) times[i] = times[i - 1] + 60;
  }
  const gymToday = u.gymTime != null && u.gymDays.includes(info.dow);
  if (gymToday) {
    // не едим за час до зала и во время тренировки — переносим на после
    for (let i = 0; i < n; i++) {
      if (times[i] > u.gymTime - 60 && times[i] < u.gymTime + 90) times[i] = r5(u.gymTime + 105);
    }
    for (let i = 1; i < n; i++) if (times[i] < times[i - 1] + 75) times[i] = times[i - 1] + 75;
  }
  slots.forEach((slot, i) => {
    if (i > 0 && times[i] > bed - 60) return; // не впихиваем еду прямо перед сном
    ev.push({ t: times[i], kind: 'meal', slot });
  });

  if (work && u.busTime != null) {
    const bt = u.busToday && u.busToday.date === info.date ? u.busToday.t : u.busTime;
    const leave = bt - u.walk - u.buffer - busEarly(u);
    ev.push({ t: leave - 30, kind: 'buscheck', bt });
    ev.push({ t: leave - 10, kind: 'bus10', bt });
    ev.push({ t: leave, kind: 'busgo', bt });
  }
  if (gymToday) ev.push({ t: u.gymTime - 60, kind: 'gym' });
  if (info.dow === 0) {
    ev.push({ t: wake + 5, kind: 'weigh' });
    ev.push({ t: Math.max(720, wake + 120), kind: 'prep' });
  }
  if (info.dow === 3) ev.push({ t: Math.min(1140, bed - 150), kind: 'prep2' });
  if (info.dom === 1) ev.push({ t: wake + 15, kind: 'month' });
  if (info.dow === 0) ev.push({ t: bed - 90, kind: 'weekly' });
  const wEnd = bed - 120;
  for (const t of [wake + 180, wake + 360, wake + 540]) {
    if (t < wEnd - 30) ev.push({ t, kind: 'water', frac: Math.min(1, (t - wake) / (wEnd - wake)) });
  }
  ev.push({ t: bed - 60, kind: 'foodcheck' });
  ev.push({ t: bed - 30, kind: 'bed30' });
  ev.push({ t: bed, kind: 'bed' });
  return ev.filter((e) => e.t >= 0).sort((a, b) => a.t - b.t);
}

function scheduleText(u, info, title) {
  const rows = [];
  for (const e of buildDay(u, info)) {
    let s = null, t = e.t;
    switch (e.kind) {
      case 'wake': s = '☀️ Подъём'; break;
      case 'exercise': s = '🤸 Зарядка'; break;
      case 'meal': s = '🍽 ' + SLOT_NAMES[e.slot]; break;
      case 'busgo': s = `🚌 Выйти к автобусу${u.busNumber ? ' №' + esc(u.busNumber) : ''} (отправление ${fmt(e.bt)})`; break;
      case 'gym': s = '🏋️ Зал'; t = u.gymTime; break;
      case 'prep': case 'prep2': s = '🧺 Заготовка еды'; break;
      case 'weigh': s = '⚖️ Взвешивание натощак'; break;
      case 'month': s = '📏 Замеры: талия и фото'; break;
      case 'bed': s = `😴 Отбой (сон ${String(u.sleepH).replace('.', ',')} ч)`; break;
    }
    if (s) rows.push([t, `<code>${fmt(t).padStart(5, ' ')}</code>  ${s}`]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  return [title, ...rows.map((r) => r[1])].join('\n');
}

// ---------------------------------------------------------------- хранилище
async function loadUser(env, id) {
  const raw = await env.DB.get('u:' + id);
  const u = Object.assign(structuredClone(DEFAULTS), raw ? JSON.parse(raw) : {});
  return { u, exists: !!raw };
}
async function saveUser(env, id, u) { await env.DB.put('u:' + id, JSON.stringify(u)); }
async function addToIndex(env, id) {
  const ids = JSON.parse((await env.DB.get('users')) || '[]');
  if (!ids.includes(id)) { ids.push(id); await env.DB.put('users', JSON.stringify(ids)); }
}

// ---------------------------------------------------------------- Telegram API
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}
const KEYBOARD = {
  keyboard: [
    [{ text: '📅 Сегодня' }, { text: '🍽 Меню' }, { text: '🏋️ Тренировка' }],
    [{ text: '🔥 Калории' }, { text: '📈 Прогресс' }, { text: '⚙️ Настройки' }],
  ],
  resize_keyboard: true, is_persistent: true,
};
const BUTTONS = {
  '📅 Сегодня': 'segodnya', '🍽 Меню': 'menu', '🏋️ Тренировка': 'trenirovka',
  '🔥 Калории': 'kkal', '📈 Прогресс': 'progress', '⚙️ Настройки': 'nastroiki',
};
function send(env, chat, text, extra = {}) {
  return tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}

// ---------------------------------------------------------------- приёмы пищи
function mealText(slot, i, t) {
  const v = MENU[slot][i % MENU[slot].length];
  return `🍽 <b>${SLOT_NAMES[slot]}</b>${t != null ? ' · ' + fmt(t) : ''}\n${esc(v.t)}\n≈ ${v.k} ккал · белок ${v.p} г`;
}
function mealButtons(slot, i, t) {
  return { inline_keyboard: [[
    { text: '✅ Съел', callback_data: `e|${slot}|${i}` },
    { text: '🔁 Другой вариант', callback_data: `a|${slot}|${i}|${t ?? ''}` },
  ], [
    { text: '📷 Фото', callback_data: 'mf|photo' }, { text: '🎤 / ✏️ Другое', callback_data: 'mf|text' },
  ]] };
}
function variantFor(info, slot) {
  return (dayOfYear(info) + Object.keys(MENU).indexOf(slot)) % MENU[slot].length;
}
function dayMenuText(u, info, off) {
  const evs = buildDay(u, info).filter((e) => e.kind === 'meal');
  let total = 0, prot = 0;
  const lines = [`🍽 <b>Меню на день</b> (стол №8, почти без готовки)\n`];
  for (const e of evs) {
    const arr = MENU[e.slot], v = arr[(variantFor(info, e.slot) + off) % arr.length];
    total += v.k; prot += v.p;
    lines.push(`<b>${fmt(e.t)} ${SLOT_NAMES[e.slot]}</b> — ${esc(v.t)} <i>(${v.k} ккал)</i>`);
  }
  const target = calc(u).target;
  lines.push(`\nИтого ≈ <b>${total} ккал</b>, белок ~${prot} г. Твоя норма: ${target} ккал.`);
  if (target - total > 150) lines.push(`Не хватает ~${target - total} ккал — добавь ломтик хлеба, фрукт или кефир.`);
  lines.push('\nЗамены — /zameny · покупки — /pokupki');
  return lines.join('\n');
}

// ---------------------------------------------------------------- прогресс
function weeklyRate(ws) {
  if (ws.length < 2) return null;
  const lastD = Date.parse(ws[ws.length - 1].d);
  const pts = ws.filter((x) => lastD - Date.parse(x.d) <= 49 * 86400000).map((x) => [(Date.parse(x.d) - lastD) / 86400000, x.kg]);
  if (pts.length < 2 || pts[pts.length - 1][0] - pts[0][0] < 6) return null;
  const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  const num = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  const den = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  return den ? (num / den) * 7 : null;
}
function progressText(u) {
  const ws = u.weights;
  if (!ws.length) return '📈 Пока нет взвешиваний. Раз в неделю утром натощак: <code>/ves 117.6</code>';
  const lines = ['📈 <b>Прогресс</b>\n'];
  const last = ws.slice(-8), min = Math.min(...last.map((x) => x.kg)), max = Math.max(...last.map((x) => x.kg));
  for (let i = 0; i < last.length; i++) {
    const idx = ws.length - last.length + i;
    const avg = ws.slice(Math.max(0, idx - 2), idx + 1).reduce((a, x) => a + x.kg, 0) / Math.min(3, idx + 1);
    const bar = '▇'.repeat(1 + Math.round(((avg - min) / (max - min || 1)) * 9));
    lines.push(`<code>${ddmm(last[i].d)} ${kg(last[i].kg).padStart(5)} │ ср ${kg(avg).padStart(5)}</code> ${bar}`);
  }
  const avg3 = ws.slice(-3).reduce((a, x) => a + x.kg, 0) / Math.min(3, ws.length);
  lines.push(`\nСреднее за 3 взвешивания: <b>${kg(avg3)} кг</b> (смотри на него, а не на дневные скачки)`);
  lines.push(`С начала: ${kg(ws[ws.length - 1].kg - ws[0].kg)} кг`);
  const rate = weeklyRate(ws);
  if (rate != null) {
    lines.push(`Темп: <b>${rate > 0 ? '+' : ''}${kg(rate)} кг/нед</b>`);
    if (rate < -0.7) lines.push('⚠️ Худеешь быстрее нормы. Ешь чуть больше — +200 ккал в день (например, ещё творог или бутерброд с курицей): <code>/kkal +200</code>');
    else if (rate <= -0.2) lines.push('👍 Отличный, здоровый темп. Так и держи.');
    else if (rate <= 0.2) lines.push('Вес стоит. Это бывает: вода, растут мышцы. Если так ещё 1–2 недели — можно убрать ~150 ккал (<code>/kkal -150</code>), но не ниже 2700.');
    else lines.push('Вес чуть растёт. Без паники и без голодовок: проверь перекусы и напитки. Резко урезать еду не надо.');
  }
  if (u.waist.length) {
    const w = u.waist;
    lines.push(`\n📏 Талия: ${kg(w[w.length - 1].cm)} см${w.length > 1 ? ` (с начала ${kg(w[w.length - 1].cm - w[0].cm)} см)` : ''}`);
  }
  if (u.photos.length) lines.push(`📸 Фото: ${u.photos.length} — сравнить: /foto`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- автобус (Яндекс.Расписания)
const depMin = (s) => { const m = String(s || '').match(/T(\d\d):(\d\d)/); return m ? +m[1] * 60 + +m[2] : null; };
async function yandexDepartures(env, u, info) {
  if (!env.YANDEX_KEY || !u.station) return null;
  const url = `https://api.rasp.yandex.net/v3.0/schedule/?apikey=${encodeURIComponent(env.YANDEX_KEY)}&station=${encodeURIComponent(u.station)}&date=${info.date}&transport_types=bus&format=json&lang=ru_RU&limit=500`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    return (j.schedule || [])
      .filter((s) => !u.busNumber || norm(String(s.thread?.number || '')) === norm(u.busNumber))
      .map((s) => depMin(s.departure))
      .filter((t) => t != null)
      .sort((a, b) => a - b);
  } catch { return null; }
}
function pickBus(deps, want) {
  if (!deps || !deps.length) return null;
  const before = deps.filter((t) => t <= want + 3 && t >= want - 25);
  if (before.length) return before[before.length - 1];
  const near = deps.filter((t) => Math.abs(t - want) <= 20).sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
  return near.length ? near[0] : null;
}

// ---------------------------------------------------------------- автобус: статистика по отметкам
function busStats(u) {
  const log = (u.busLog || []).slice(-10);
  if (log.length < 3) return null;
  const d = log.map((x) => x.diff).sort((a, b) => a - b);
  const med = d[Math.floor(d.length / 2)];
  const early = log.filter((x) => x.diff <= -1).length;
  return { n: log.length, med, early, min: d[0], max: d[d.length - 1] };
}
// если автобус часто приходит раньше — выходим раньше на столько минут (максимум 5)
function busEarly(u) {
  const s = busStats(u);
  if (!s) return 0;
  if (s.med < 0) return Math.min(5, -s.med);
  if (s.early >= 2 && s.early >= Math.ceil(s.n / 3)) return Math.min(5, Math.max(1, -s.min));
  return 0;
}
function busStatsLine(u) {
  const s = busStats(u);
  if (!s) return '';
  const how = s.med > 0 ? `обычно приходит на ~${s.med} мин <b>позже</b>` : s.med < 0 ? `обычно приходит на ~${-s.med} мин <b>раньше</b>` : 'обычно приходит вовремя';
  const sh = busEarly(u);
  const why = !sh ? '' : s.med < 0 ? `, поэтому зову выходить на ${sh} мин раньше` : `, но ${s.early} раз приходил раньше — зову выходить на ${sh} мин раньше`;
  return `\n📊 По твоим отметкам (${s.n}) ${how}${why}.`;
}
function busDiffText(t, usual) {
  const d = t - usual;
  return d < 0 ? `на ${-d} мин <b>раньше</b> обычного` : `на ${d} мин <b>позже</b> обычного`;
}

// ---------------------------------------------------------------- напоминания (cron)
async function fire(env, id, u, e, info) {
  const work = isWorkday(u, info);
  switch (e.kind) {
    case 'wake': {
      let busLine = '';
      if (work && u.busTime != null && env.YANDEX_KEY && u.station) {
        const t = pickBus(await yandexDepartures(env, u, info), u.busTime);
        if (t != null) {
          u.busToday = { date: info.date, t };
          await saveUser(env, id, u);
          busLine = t === u.busTime ? `\n🚌 По расписанию Яндекса автобус в ${fmt(t)}, как обычно.`
            : `\n⚠️ Автобус сегодня в <b>${fmt(t)}</b> — ${busDiffText(t, u.busTime)}. Выходи в ${fmt(t - u.walk - u.buffer - busEarly(u))}.`;
        }
      }
      const plan = buildDay(u, info).filter((x) => ['meal', 'busgo', 'gym', 'bed'].includes(x.kind));
      const short = plan.map((x) => x.kind === 'meal' ? `${fmt(x.t)} ${SLOT_NAMES[x.slot].toLowerCase()}`
        : x.kind === 'busgo' ? `${fmt(x.t)} выход` : x.kind === 'gym' ? `${fmt(u.gymTime)} зал` : `${fmt(x.t)} отбой`);
      const hol = !work && info.dow >= 1 && info.dow <= 5 && holidayName(info.date);
      return send(env, id, `☀️ <b>Доброе утро${u.name ? ', ' + esc(u.name) : ''}!</b> Подъём — выпей стакан воды.${hol ? ` Сегодня ${hol} — живём по выходному расписанию 🙂` : ''}${busLine}\n\nСегодня: ${short.join(' · ')}\n\nКак спалось?`, { reply_markup: sleepKb });
    }
    case 'exercise': return send(env, id, EXERCISE_TEXT);
    case 'meal': {
      const i = variantFor(info, e.slot);
      const s = foodSum(u, info);
      const smart = (e.slot === 'dinner' || e.slot === 'late') && s.n ? '\n\n' + smartMeal(u, info, e.slot).text : '';
      return send(env, id, mealText(e.slot, i, e.t) + smart, { reply_markup: mealButtons(e.slot, i, e.t) });
    }
    case 'buscheck': {
      // за 30 мин до выхода перепроверяем расписание Яндекса на сегодня
      if (!env.YANDEX_KEY || !u.station) return;
      const t = pickBus(await yandexDepartures(env, u, info), u.busTime);
      if (t == null || t === e.bt) return;
      u.busToday = { date: info.date, t };
      await saveUser(env, id, u);
      const leave = t - u.walk - u.buffer - busEarly(u);
      return send(env, id, `⚠️ <b>Автобус${u.busNumber ? ' №' + esc(u.busNumber) : ''} сегодня в ${fmt(t)}</b> — ${busDiffText(t, e.bt)} (${fmt(e.bt)}).\nВыходи в <b>${fmt(leave)}</b>. Напомню за 10 минут и в момент выхода.`);
    }
    case 'bus10': return send(env, id, `🚌 Через 10 минут выходить к автобусу${u.busNumber ? ' №' + esc(u.busNumber) : ''} (отправление ${fmt(e.bt)}, идти ${u.walk} мин).${busStatsLine(u)}`);
    case 'busgo': return send(env, id, `🏃 <b>Выходи!</b> Автобус${u.busNumber ? ' №' + esc(u.busNumber) : ''} в ${fmt(e.bt)}.\nКогда он подъедет к остановке — нажми кнопку, я запомню, опаздывает ли он обычно.`,
      { reply_markup: { inline_keyboard: [[
        { text: '🚏 Автобус пришёл', callback_data: `b|${info.date}|${e.bt}` },
        { text: '🚫 Уехал без меня', callback_data: `x|${info.date}|${e.bt}` },
      ]] } });
    case 'gym': return send(env, id, `🏋️ Через час зал (${fmt(u.gymTime)}).\n\n${workoutText(u, u.nextWorkout)}\n\nВозьми воду и форму. Если не ел 3+ часа — перекуси сейчас (полдник).`);
    case 'prep': return send(env, id, PREP_SUN);
    case 'prep2': return send(env, id, PREP_WED);
    case 'weigh': return send(env, id, '⚖️ Воскресенье — взвешивание. Утром натощак, после туалета, без одежды. Нажми свой вес или пришли точно: <code>/ves 117.4</code>\nСмотрим на тренд, а не на одну цифру 🙂', { reply_markup: weightKb(u) });
    case 'weekly': return send(env, id, weeklyReport(u, info));
    case 'water': {
      if (u.waterOff) return;
      const w = u.water && u.water.d === info.date ? u.water.ml : 0;
      if (w >= WATER_GOAL * e.frac * 0.75) return;
      return send(env, id, `💧 Попей воды! Сегодня выпито ${w} из ${WATER_GOAL} мл.`, { reply_markup: waterKb });
    }
    case 'month': return send(env, id, '📏 Новый месяц — замеры!\n1. Талия на уровне пупка, на выдохе: <code>/talia 108</code>\n2. Фото в полный рост (спереди и сбоку) при одинаковом свете — просто пришли сюда, я сохраню для сравнения.');
    case 'foodcheck': {
      const s = foodSum(u, info), target = calc(u).target;
      const askSteps = !(u.steps || []).some((x) => x.d === info.date);
      const stepsQ = askSteps ? '\n\n👣 Сколько примерно шагов сегодня? (или <code>/shagi 12345</code>)' : '';
      const appBtn = env.APP_URL ? [[{ text: '📊 Открыть дневник', web_app: { url: env.APP_URL } }]] : [];
      const kb = { reply_markup: { inline_keyboard: (askSteps ? stepsKb.inline_keyboard : []).concat(appBtn) } };
      if (s.n === 0) return send(env, id, '🍽 Сегодня ничего не записано. Если не лень — напиши, что ел, одним сообщением: <code>гречка 250, курица 180, 2 яйца, кефир</code> или пришли фото еды. Не обязательно точно, примерно тоже полезно.' + stepsQ, kb);
      const wml = u.water && u.water.d === info.date ? u.water.ml : 0;
      let t = `🧾 <b>Итог дня</b>\n<code>ккал  ${bar(s.k, target)} ${s.k}/${target}</code>\n<code>белок ${bar(s.p, 150)} ${s.p}/150 г</code>\n<code>вода  ${bar(wml, WATER_GOAL)} ${(wml / 1000).toFixed(1).replace('.', ',')}/${WATER_GOAL / 1000} л</code>\n🔥 серия ${foodStreak(u, info)} дн.`;
      if (s.k < target - 900) t += '\n\nЕсли ты правда мало поел — съешь творог или выпей кефир, не ложись голодным. Недоедание мешает расти и тормозит прогресс.';
      else if (s.k <= target + 400) t += '\nОтличный день 👍';
      else t += '\nЧуть больше нормы — ничего страшного, завтра просто обычный день по меню.';
      return send(env, id, t + '\nНеделя — /nedelya' + stepsQ, kb);
    }
    case 'bed30': {
      const next = shiftDay(info, 1);
      return send(env, id, `🌙 Через 30 минут отбой. Убери телефон, собери вещи на завтра.\nЗавтра подъём в ${fmt(isWorkday(u, next) ? u.wakeWd : u.wakeWe)}.`);
    }
    case 'bed': return send(env, id, `😴 Отбой. Сон ${String(u.sleepH).replace('.', ',')} ч — тоже часть похудения: меньше тянет на сладкое и лучше растут мышцы.`);
  }
}

async function cron(env) {
  const ids = JSON.parse((await env.DB.get('users')) || '[]');
  const today = nowMsk(), yest = shiftDay(today, -1);
  for (const id of ids) {
    try {
      const { u } = await loadUser(env, id);
      if (u.paused || u.wiz != null && !u.wakeWdSet) continue;
      const evs = buildDay(u, today).filter((e) => e.t === today.min)
        .concat(buildDay(u, yest).filter((e) => e.t - 1440 === today.min));
      for (const e of evs) if (!eventMuted(u, e)) await fire(env, id, u, e, today);
      if (u.restAt && u.restAt.d === today.date && u.restAt.m <= today.min) {
        const late = today.min - u.restAt.m;
        const fresh = (await loadUser(env, id)).u;
        fresh.restAt = null;
        await saveUser(env, id, fresh);
        if (late <= 1) await send(env, id, '⏱ Отдых закончился — следующий подход 💪');
      }
    } catch (err) { console.error('cron', id, err); }
  }
}

// ---------------------------------------------------------------- мастер настройки
const WIZ = [
  { q: 'Во сколько ты встаёшь в <b>будни</b>? Например: <code>6:30</code>',
    set: (u, s) => { const t = parseTime(s); if (t == null) return false; u.wakeWd = t; u.wakeWdSet = true; } },
  { q: 'А в <b>выходные</b>?',
    set: (u, s) => { const t = parseTime(s); if (t == null) return false; u.wakeWe = t; } },
  { q: 'Во сколько начинаются уроки?',
    set: (u, s) => { const t = parseTime(s); if (t == null) return false; u.schoolStart = t; } },
  { q: 'Во сколько обычно отправляется <b>твой автобус</b> с остановки? Например <code>7:42</code>. Если не ездишь — напиши «нет».',
    set: (u, s) => { if (/^нет/i.test(s)) { u.busTime = null; return; } const t = parseTime(s); if (t == null) return false; u.busTime = t; } },
  { q: 'Сколько минут идти от дома до остановки?', skip: (u) => u.busTime == null,
    set: (u, s) => { const n = parseInt(s, 10); if (!(n >= 0 && n <= 90)) return false; u.walk = n; } },
  { q: 'Номер автобуса и куда едешь? Например: <code>123 до школы</code>', skip: (u) => u.busTime == null,
    set: (u, s) => { u.busInfo = s.slice(0, 80); u.busNumber = s.trim().split(/\s+/)[0].slice(0, 10); } },
  { q: 'Дни и время зала? Например: <code>пн ср пт 17:00</code>. Если зала нет — «нет».',
    set: (u, s) => setGym(u, s) },
  { q: 'Во сколько ты обычно <b>дома</b> после уроков? Например <code>15:00</code>',
    set: (u, s) => { const t = parseTime(s); if (t == null) return false; u.home = t; } },
];
function setGym(u, s) {
  if (/^нет/i.test(s.trim())) { u.gymTime = null; return; }
  const toks = norm(s).split(/[\s,]+/);
  const days = toks.filter((t) => t in DAYS).map((t) => DAYS[t]);
  const time = toks.map(parseTime).find((t) => t != null);
  if (!days.length || time == null) return false;
  u.gymDays = [...new Set(days)]; u.gymTime = time;
}
async function wizAsk(env, id, u) {
  while (u.wiz < WIZ.length && WIZ[u.wiz].skip && WIZ[u.wiz].skip(u)) u.wiz++;
  if (u.wiz >= WIZ.length) {
    u.wiz = null;
    const info = nowMsk();
    await send(env, id, '✅ Готово! Вот твоё расписание:\n\n' +
      scheduleText(u, nextDow(info, 1), '<b>Будни</b>') + '\n\n' + scheduleText(u, nextDow(info, 6), '<b>Выходные</b>') +
      '\n\nНапоминания уже включены. Поменять что-то — /nastroiki, все команды — /help', { reply_markup: KEYBOARD });
    return;
  }
  await send(env, id, `<i>Вопрос ${u.wiz + 1} из ${WIZ.length}</i>\n${WIZ[u.wiz].q}`);
}

// ---------------------------------------------------------------- тексты
const HELP = `<b>Что я умею</b>

📅 <b>Расписание</b>
/segodnya — план на сегодня
/raspisanie — будни и выходные
/nastroika — пройти настройку заново
/nastroiki — все настройки и как их менять

🍽 <b>Питание (стол №8)</b>
/menu — меню на день
/kkal — норма и сколько съел сегодня
Просто напиши, что съел: <code>гречка 250, курица 180, 2 яйца</code> — посчитаю ккал и БЖУ
/el 350 бутерброд — записать вручную (с белком: <code>/el 350 б20 бутерброд</code>)
/nedelya — калории за 7 дней
/produkt гречка — калорийность продукта
📷 <b>Фото еды</b> — пришли фото тарелки, я оценю ккал и БЖУ (подпись помогает: «гречка с котлетой»)
🏷 <b>Штрихкод</b> — фото штрихкода или просто цифры под ним
⭐ /moe — свои продукты и блюда (<code>/moe сырники мамы 220 б12</code>)
🔁 /povtor — съел то же, что в прошлый раз
🎤 <b>Голосом</b> — «съел тарелку гречки и две котлеты»
📒 /dnevnik — записи за сегодня (удалить любую)
🎯 /uzhin — что съесть под оставшиеся калории
📝 /zametka — самочувствие (для врача)
📊 /app — приложение: дневник, графики, зал
/otmena — удалить последнюю запись
/zameny — чем заменить
/pokupki — список покупок на неделю
/zagotovka — как сделать заготовку
/sryv — если сорвался

🏋️ <b>Зал</b>
/trenirovka — какая сегодня (или <code>/trenirovka B</code>)
/programma — вся программа
Запись подходов: <code>присед 60x8 60x8 60x7</code> или <code>жим 50x10x3</code>
/istoriya присед — история упражнения
/zamena жим — чем заменить, если занято
/taimer — таймер отдыха между подходами (по умолчанию 2 мин)

📈 <b>Прогресс</b>
/ves 117.4 — вес (раз в неделю утром натощак)
/talia 108 — талия (раз в месяц)
Фото — просто пришли картинку
/progress — тренд · /foto — сравнить фото
/grafik вес — график (вес, талия, ккал, присед…)
/otchet — итоги недели (приходят сами в вс вечером)
/dostizheniya — достижения и серия
/eksport — таблица для врача (Excel)

💧 <b>Вода, шаги, сон</b>
«вода 500» или /voda — учёт воды (напомню, если отстаёшь)
/shagi 12000 — шаги (вечером спрошу сам)
Сон — утром кнопками в «Доброе утро»

/pauza — выключить/включить напоминания
/kanikuly — режим каникул вручную · <code>/kanikuly авто</code> — учитывать каникулы и праздники Москвы самому
/dostup — кто может пользоваться ботом
/napominaniya — какие напоминания присылать · /tishina 22:30 7:00 — тихие часы`;

function settingsText(u) {
  const c = calc(u);
  return `⚙️ <b>Настройки</b>

Подъём: будни <b>${fmt(u.wakeWd)}</b>, выходные <b>${fmt(u.wakeWe)}</b> — <code>/podem 6:30 9:00</code>
Сон: <b>${String(u.sleepH).replace('.', ',')} ч</b> (отбой считается от подъёма) — <code>/son 9</code>
Уроки с ${fmt(u.schoolStart)} — <code>/uroki 8:30</code> · дома в ${u.home != null ? fmt(u.home) : '—'} — <code>/doma 15:00</code>
Автобус: ${u.busTime != null ? `<b>${fmt(u.busTime)}</b>${u.busNumber ? ' №' + esc(u.busNumber) : ''}, идти ${u.walk} мин` : 'нет'} — <code>/avtobus 7:42 7</code> (или <code>/avtobus нет</code>), номер: <code>/avtobus_nomer 123</code>
Остановка Яндекса: ${u.station ? esc(u.stationTitle || u.station) : 'не задана'} — пришли геопозицию 📍 или <code>/ostanovka s9xxxxxx</code>
Зал: ${u.gymTime != null ? `<b>${u.gymDays.map((d) => DAYNAMES[d]).join(' ')} ${fmt(u.gymTime)}</b>` : 'нет'} — <code>/zal пн ср пт 17:00</code>
Приёмов пищи: <b>${u.meals}</b> — <code>/priemy 6</code> (4–6)
Рост/возраст: ${u.height} см, ${u.age} лет — <code>/rost 191</code>, <code>/vozrast 16</code>
Норма: <b>${c.target} ккал</b> — /kkal
Напоминания: ${u.paused ? '⏸ на паузе' : '▶️ включены'} · Каникулы: ${u.holidays ? 'да' : 'нет'} (авто: ${u.autoHol === false ? 'выкл' : 'вкл'}) — /kanikuly
Вода: ${u.waterOff ? 'без напоминаний' : 'напоминаю'} — /voda · Таймер отдыха: ${u.timer === false ? 'выкл' : (u.timerMin || 2) + ' мин'} — /taimer`;
}

// ---------------------------------------------------------------- запись еды текстом
// strict=false (обычное сообщение): если ни один продукт не узнан — возвращает false, чтобы бот ответил «не понял»
async function logMealText(env, id, u, info, text, strict) {
  const { ok, bad } = parseMeal(text, u);
  if (!ok.length && env.AI && /[а-яё]{3}/i.test(text) && text.length <= 400) {
    // в базе ничего — пробуем понять свободный текст нейросетью (с подтверждением)
    if (await aiMealConfirm(env, id, u, text, '🤖 <b>Понял так</b> (оценка, ±20 %):')) return true;
  }
  if (!ok.length) {
    if (!strict) return false;
    return send(env, id, `Не нашёл в базе: ${esc(bad.join(', ') || text)}.\nЗапиши вручную: <code>/el 300 ${esc(bad[0] || 'название')}</code> · что есть в базе — /produkt`);
  }
  const before = foodSum(u, info).k, target = calc(u).target;
  addItems(u, info, ok);
  learnMeal(u, info);
  const after = foodSum(u, info);
  await saveUser(env, id, u);
  if (bad.length && env.AI) await aiMealConfirm(env, id, u, bad.join(', '), `🤖 Остальное (${esc(bad.join(', '))}) понял так:`);
  let t = `✅ Записал:\n${mealSummary(ok)}\n\nСегодня: <b>${after.k}</b> из ${target} ккал · белок ${after.p} г`;
  if (bad.length && !env.AI) t += `\n\n❓ Не узнал: ${esc(bad.join(', '))} — запиши вручную: <code>/el 300 ${esc(bad[0])}</code>`;
  if (before <= target + 400 && after.k > target + 400) t += '\n\nСегодня вышло больше нормы — это нормально, так бывает. Ничего не «отрабатывай» и не пропускай еду: следующий приём пищи просто сделай обычным 💪';
  t += `\n<i>Ошибся — /otmena (удаляет последнюю позицию)</i>`;
  return send(env, id, t, { reply_markup: repeatKb });
}
const repeatKb = { inline_keyboard: [[{ text: '🔁 Съел это ещё раз', callback_data: 'r' }]] };
function addItems(u, info, items) {
  todayFood(u, info);
  for (const x of items) {
    u.food.items.push({ name: `${x.name} ${x.g} ${x.u}`, base: x.name, g: x.g, u: x.u, k: x.k, p: x.p, fat: x.fat, c: x.c, at: info.min });
    u.recent = [{ name: x.name, g: x.g, u: x.u, k: x.k, p: x.p, fat: x.fat, c: x.c }].concat((u.recent || []).filter((r) => r.name !== x.name)).slice(0, 15);
  }
  if (u.food.items.length > 60) u.food.items.splice(0, u.food.items.length - 60);
  u.lastMeal = items;
}
async function logItems(env, id, u, info, items, title) {
  const before = foodSum(u, info).k, target = calc(u).target;
  addItems(u, info, items);
  learnMeal(u, info);
  const after = foodSum(u, info);
  await saveUser(env, id, u);
  let t = `${title}\n${mealSummary(items)}\n\nСегодня: <b>${after.k}</b> из ${target} ккал · белок ${after.p} г`;
  if (before <= target + 400 && after.k > target + 400) t += '\n\nСегодня вышло больше нормы — это нормально, так бывает. Ничего не «отрабатывай» и не пропускай еду: следующий приём пищи просто сделай обычным 💪';
  return send(env, id, t + '\n<i>Ошибся — /otmena</i>', { reply_markup: repeatKb });
}

// ---------------------------------------------------------------- команды
async function command(env, id, u, cmd, args, info) {
  const say = (t, x) => send(env, id, t, x);
  switch (cmd) {
    case 'start':
      await say(`Привет${u.name ? ', ' + esc(u.name) : ''}! 👋 Я помогу спокойно худеть по столу №8: расписание с напоминаниями, меню из магазинных продуктов почти без готовки, зал и прогресс.\n\nТон у меня простой: срыв — не провал. Давай настроим расписание (8 коротких вопросов).`, { reply_markup: KEYBOARD });
      u.wiz = 0; return wizAsk(env, id, u);
    case 'nastroika': u.wiz = 0; return wizAsk(env, id, u);
    case 'help': return say(HELP, { reply_markup: KEYBOARD });
    case 'nastroiki': return say(settingsText(u));
    case 'segodnya': {
      const s = foodSum(u, info);
      return say(scheduleText(u, info, `📅 <b>Сегодня, ${DAYNAMES[info.dow]} ${ddmm(info.date)}</b>${isWorkday(u, info) ? '' : ` (${(info.dow >= 1 && info.dow <= 5 && holidayName(info.date)) || 'выходной'})`}`) +
        `\n\n🔥 Съедено: ${s.k} из ${calc(u).target} ккал · 💧 ${u.water && u.water.d === info.date ? u.water.ml : 0} мл`);
    }
    case 'raspisanie':
      return say(scheduleText(u, nextDow(info, 1), '<b>Будни</b>') + '\n\n' + scheduleText(u, nextDow(info, 6), '<b>Выходные</b>'));
    case 'podem': {
      const [a, b] = args.split(/\s+/).map(parseTime);
      if (a == null) return say('Например: <code>/podem 6:30 9:00</code> (будни, выходные)');
      u.wakeWd = a; if (b != null) u.wakeWe = b; u.wakeWdSet = true;
      return say(`Ок. Подъём: будни ${fmt(u.wakeWd)}, выходные ${fmt(u.wakeWe)}. Отбой в будни ${fmt(u.wakeWd - u.sleepH * 60)}.`);
    }
    case 'son': {
      const h = parseFloat(args.replace(',', '.'));
      if (!(h >= 8 && h <= 10)) return say('Сон для подростка — 8–10 часов. Например: <code>/son 9</code>');
      u.sleepH = h; return say(`Ок, сон ${String(h).replace('.', ',')} ч. Отбой в будни — ${fmt(u.wakeWd - h * 60)}.`);
    }
    case 'uroki': { const t = parseTime(args); if (t == null) return say('Например: <code>/uroki 8:30</code>'); u.schoolStart = t; return say('Ок.'); }
    case 'doma': { const t = parseTime(args); if (t == null) return say('Например: <code>/doma 15:00</code>'); u.home = t; return say(`Ок, обед подстрою под ${fmt(t + 15)}.`); }
    case 'avtobus': {
      if (!args) {
        if (u.busTime == null) return say('Автобус не задан. Например: <code>/avtobus 7:42 7</code> — время отправления и сколько минут идти.');
        let text = `🚌 Автобус${u.busNumber ? ' №' + esc(u.busNumber) : ''} в ${fmt(u.busTime)}, идти ${u.walk} мин → выход в ${fmt(u.busTime - u.walk - u.buffer - busEarly(u))}.`;
        const deps = await yandexDepartures(env, u, info);
        if (deps && deps.length) {
          const near = deps.filter((t) => Math.abs(t - u.busTime) <= 40).map(fmt);
          text += `\nЯндекс.Расписания сегодня рядом с этим временем: ${near.join(', ') || 'ничего'}`;
        } else if (env.YANDEX_KEY && u.station) {
          text += '\nЯндекс не вернул рейсы для этой остановки/номера — использую твоё время.';
        }
        return say(text + busStatsLine(u) + '\n\nКак я слежу: за 30 мин до выхода проверяю расписание Яндекса (если подключён) и пишу, если сегодня автобус раньше или позже. А по кнопке «🚏 Автобус пришёл» запоминаю, насколько он обычно опаздывает.\n<i>Где автобус едет прямо сейчас, я не вижу — открытых данных о движении автобусов в Москве нет.</i>');
      }
      if (/^нет/i.test(args)) { u.busTime = null; return say('Ок, напоминания об автобусе выключены.'); }
      const [t, w] = args.split(/\s+/);
      const tm = parseTime(t); if (tm == null) return say('Например: <code>/avtobus 7:42 7</code>');
      u.busTime = tm; if (w && +w >= 0) u.walk = +w;
      return say(`Ок: автобус ${fmt(tm)}, идти ${u.walk} мин. Напомню в ${fmt(tm - u.walk - u.buffer - 10)} и в ${fmt(tm - u.walk - u.buffer)}.`);
    }
    case 'avtobus_nomer': if (!args) return say('Например: <code>/avtobus_nomer 123</code>'); u.busNumber = args.split(/\s+/)[0]; return say(`Ок, автобус №${esc(u.busNumber)}.`);
    case 'ostanovka': if (!/^s\d+$/.test(args)) return say('Код остановки выглядит как <code>s9876543</code>. Проще — пришли геопозицию 📍 возле остановки, я найду её сам.'); u.station = args; u.stationTitle = args; return say('Ок, остановка сохранена. Проверить: /avtobus');
    case 'zal': if (setGym(u, args) === false) return say('Например: <code>/zal пн ср пт 17:00</code> или <code>/zal нет</code>'); return say(u.gymTime == null ? 'Ок, без зала.' : `Ок: ${u.gymDays.map((d) => DAYNAMES[d]).join(' ')} в ${fmt(u.gymTime)}. Напомню за час.`);
    case 'priemy': { const n = parseInt(args, 10); if (!(n >= 4 && n <= 6)) return say('От 4 до 6. Врач советует дробно — лучше 5–6.'); u.meals = n; return say(`Ок, ${n} приёмов пищи.`); }
    case 'rost': { const n = parseInt(args, 10); if (!(n > 100 && n < 230)) return say('Например: <code>/rost 191</code>'); u.height = n; return say('Ок.'); }
    case 'vozrast': { const n = parseInt(args, 10); if (!(n >= 10 && n < 100)) return say('Например: <code>/vozrast 16</code>'); u.age = n; return say('Ок.'); }
    case 'pauza': u.paused = !u.paused; return say(u.paused ? '⏸ Напоминания на паузе. Включить — /pauza' : '▶️ Напоминания снова включены.');
    case 'kanikuly':
      if (/^(авто|avto)/i.test(args.trim())) { u.autoHol = u.autoHol === false; return say(u.autoHol ? '📅 Каникулы и праздники Москвы учитываю сам (даты примерные).' : '📅 Автоканикулы выключены — только вручную /kanikuly.'); }
      u.holidays = !u.holidays; return say(u.holidays ? '🏖 Режим каникул: все дни как выходные, без автобуса.' : '📚 Учёба: будни снова по будничному расписанию.');

    case 'menu': {
      return say(dayMenuText(u, info, 0), { reply_markup: { inline_keyboard: [[{ text: '🔁 Другое меню', callback_data: 'm|1' }]] } });
    }
    case 'zameny': return say(SWAPS);
    case 'pokupki': return say(SHOPPING);
    case 'zagotovka': return say(PREP_SUN + '\n\n' + PREP_WED);
    case 'sryv': return say('Срыв — не провал. Один день ничего не ломает: важна неделя и месяц.\n\n✅ Следующий приём пищи просто сделай обычным, по меню.\n❌ Не голодай и не «отрабатывай» в зале — от этого только новый срыв.\n\nЗапиши, что съел (<code>/el 600 пицца</code>), чтобы видеть картину, и идём дальше 💪');
    case 'kkal': {
      const a = args.trim();
      if (/^[+-]\d+$/.test(a)) {
        u.kcalAdjust = Math.max(-500, Math.min(800, (u.kcalAdjust || 0) + parseInt(a, 10)));
        const c = calc(u);
        return say(`Ок. Поправка ${u.kcalAdjust > 0 ? '+' : ''}${u.kcalAdjust} ккал → норма <b>${c.target} ккал</b>.${c.target === KCAL_FLOOR ? ` (Ниже ${KCAL_FLOOR} не опускаю — ты растёшь.)` : ''}`);
      }
      if (/^\d{4}$/.test(a)) {
        const n = +a;
        if (n < 2200) return say('Так мало ставить не буду — для растущего организма с залом это опасно. Если врач правда назначил такую цифру, уточни у него ещё раз.');
        u.kcalOverride = n; return say(`Ок, норма <b>${n} ккал</b> (как назначил врач). Вернуть расчёт — <code>/kkal сброс</code>`);
      }
      if (/^сброс/i.test(a)) { u.kcalOverride = null; u.kcalAdjust = 0; return say(`Ок, норма снова по расчёту: ${calc(u).target} ккал.`); }
      const c = calc(u), s = foodSum(u, info);
      const items = u.food.date === info.date ? u.food.items : [];
      return say(`🔥 <b>Норма: ${c.target} ккал</b>
Съедено: <b>${s.k}</b> ккал (Б ~${s.p} г${s.fat || s.c ? ` · Ж ~${s.fat} · У ~${s.c}` : ''}) · осталось ~${Math.max(0, c.target - s.k)}
${items.length ? '\n' + items.map((x) => `• ${fmt(x.at)} ${esc(x.name)} — ${x.k}`).join('\n') + '\n' : ''}
Ориентиры: белок от 150 г · жиры 85–100 г · углеводы — остальное (крупы, хлеб, овощи, фрукты).

<i>Как считается: вес ${kg(c.w)} кг, рост ${u.height}, ${u.age} лет → обмен ~${c.bmr}, × активность ${String(c.act.f).replace('.', ',')}${c.act.avg ? ` (шаги в среднем ${c.act.avg})` : ' (зал + шаги)'} = ~${c.tdee}, минус ~500. Ниже ${KCAL_FLOOR} не опускаю — ты растёшь. Это прикидка, финальную цифру согласуй с эндокринологом.</i>
Поправить: <code>/kkal +200</code> · <code>/kkal -150</code> · цифра от врача: <code>/kkal 2900</code>
Записать еду — просто напиши: <code>гречка 250, курица 180</code> · неделя — /nedelya`);
    }
    case 'el': {
      const toks = args.split(/\s+/).filter(Boolean);
      const k = parseInt(toks[0], 10);
      if (!/^\d+$/.test(toks[0] || '') && args.trim()) return logMealText(env, id, u, info, args, true);
      if (!(k > 0 && k <= 3000)) return say('Например: <code>/el гречка 250, курица 180</code> или вручную <code>/el 350 бутерброд</code> (с белком: <code>/el 350 б20 бутерброд</code>)');
      let p = 0, rest = toks.slice(1);
      if (rest[0] && /^б\d+$/i.test(rest[0])) { p = parseInt(rest[0].slice(1), 10); rest = rest.slice(1); }
      const r = logFood(u, info, { k, p, name: rest.join(' ').slice(0, 60) || 'еда' });
      return say(`✅ Записал ${k} ккал. Сегодня ${r.after} из ${r.target}.${r.extra}`);
    }
    case 'nedelya': return say(weekText(u, info));
    case 'otchet': return say(weeklyReport(u, info));
    case 'app': case 'prilozhenie':
      if (!env.APP_URL) return say('Приложение ещё не настроено.');
      return say('📊 Дневник, графики и зал — в приложении:', { reply_markup: { inline_keyboard: [[{ text: '📊 Открыть', web_app: { url: env.APP_URL } }]] } });
    case 'dnevnik': { const d = diaryText(u, info); return say(d.text, d.kb ? { reply_markup: d.kb } : {}); }
    case 'uzhin': return say(smartMeal(u, info, info.min > 1200 ? 'late' : 'dinner').text);
    case 'zametka': {
      const t = args.trim().slice(0, 300);
      if (!t) {
        const l = (u.notes || []).slice(-10);
        return say(l.length ? '📝 <b>Заметки</b>\n' + l.map((x) => `${ddmm(x.d)} — ${esc(x.t)}`).join('\n') : '📝 Заметки о самочувствии попадут в таблицу для врача.\nНапример: <code>/zametka болел живот после обеда</code>');
      }
      u.notes = (u.notes || []).concat({ d: info.date, m: info.min, t }).slice(-200);
      return say('📝 Записал. Попадёт в таблицу для врача (/eksport).');
    }
    case 'napominaniya': return say(remindText(u), { reply_markup: remindKb(u) });
    case 'tishina': {
      if (/^(нет|выкл|off)/i.test(args.trim())) { u.quiet = null; return say('Ок, тихих часов нет.'); }
      const [a1, b1] = args.split(/[\s\-–—]+/).map(parseTime);
      if (a1 == null || b1 == null || a1 === b1) return say('Например: <code>/tishina 22:30 7:00</code> — в это время не пишу (кроме подъёма и автобуса).');
      u.quiet = { from: a1, to: b1 };
      return say(`🤫 Тихие часы: ${fmt(a1)}–${fmt(b1)}. Подъём и автобус всё равно напомню.`);
    }
    case 'dostizheniya': return say(achText(u, info));
    case 'eksport': return exportCsv(env, id, u, info);
    case 'povtor':
      if (!u.lastMeal || !u.lastMeal.length) return say('Пока нечего повторять — сначала запиши еду.');
      return logItems(env, id, u, info, u.lastMeal, '🔁 Записал ещё раз:');
    case 'moe': {
      const a = args.trim();
      if (!a) {
        const l = u.myFoods || [];
        return say(l.length ? '⭐ <b>Мои продукты</b> (на 1 порцию)\n' + l.map((m) => `• ${esc(m.n)} — ${m.k} ккал${m.p ? ` · Б ${m.p}` : ''}${m.f ? ` · Ж ${m.f}` : ''}${m.c ? ` · У ${m.c}` : ''}`).join('\n') + '\n\nЗаписать: просто напиши название (можно с количеством порций: <code>' + esc(l[0].n) + ' 2</code>)\nУдалить: <code>/moe удалить название</code>'
          : '⭐ Свои продукты и блюда — один раз задал, дальше пишешь только название.\n\nДобавить (ккал на порцию, белки/жиры/углеводы — по желанию):\n<code>/moe сырники мамы 220 б12 ж8 у20</code>\nПотом просто: <code>сырники мамы 2</code>');
      }
      const del = a.match(/^удали\S*\s+(.+)$/i);
      if (del) {
        const key = norm(del[1]).replace(/ё/g, 'е');
        const n0 = (u.myFoods || []).length;
        u.myFoods = (u.myFoods || []).filter((m) => m.key !== key);
        return say(u.myFoods.length < n0 ? 'Удалил.' : 'Такого нет. Список — /moe');
      }
      const m = parseMyFood(a);
      if (!m) return say('Например: <code>/moe сырники мамы 220 б12 ж8 у20</code> — название, потом ккал на одну порцию.');
      u.myFoods = (u.myFoods || []).filter((x) => x.key !== m.key);
      u.myFoods.push(m);
      if (u.myFoods.length > 50) u.myFoods.shift();
      return say(`⭐ Запомнил: <b>${esc(m.n)}</b> — ${m.k} ккал на порцию. Теперь просто пиши «${esc(m.n)}» или «${esc(m.n)} 2».`);
    }
    case 'voda': {
      const a = norm(args);
      if (/^(выкл|off|нет)/.test(a)) { u.waterOff = true; return say('Ок, напоминания о воде выключены. Включить — <code>/voda вкл</code>'); }
      if (/^(вкл|on|да)/.test(a)) { u.waterOff = false; return say('Ок, напомню попить, если будешь отставать.'); }
      const n = parseInt(a, 10);
      if (n > 0 && n <= 3000) return say(addWater(u, info, n), { reply_markup: waterKb });
      return say(addWater(u, info, 0) + '\nДобавить — кнопкой или <code>/voda 300</code>. Можно просто написать «вода 500».', { reply_markup: waterKb });
    }
    case 'shagi': {
      const n = parseInt(args.replace(/\s/g, ''), 10);
      if (!(n >= 0 && n <= 80000)) return say('Например: <code>/shagi 12000</code>');
      u.steps = setDaily(u.steps, info, { n });
      const a = activity(u);
      return say(`👣 Записал ${n} шагов.${a.avg ? ` В среднем за последние дни ${a.avg} — норма считается с активностью ×${String(a.f).replace('.', ',')}: ${calc(u).target} ккал.` : ''}`);
    }
    case 'grafik': {
      const url = chartFor(u, args);
      if (url === undefined) return say('Например: <code>/grafik вес</code>, <code>/grafik талия</code>, <code>/grafik ккал</code>, <code>/grafik присед</code>');
      if (url === null) return say('Пока мало данных для графика — нужно хотя бы 2 записи.');
      const r = await tg(env, 'sendPhoto', { chat_id: id, photo: url });
      if (!r.ok) return say('Не получилось построить график, попробуй позже.');
      return;
    }
    case 'zamena': {
      const f = findExercise(args || '');
      if (!f) return say('Например: <code>/zamena жим</code> — чем заменить, если тренажёр занят.\nУпражнения: ' + Object.values(EX).map((e) => e.a[0]).join(', '));
      return say(`🔁 <b>${EX[f.key].n}</b> — если занято, можно:\n` + SUBS[f.key].map((x) => '• ' + x).join('\n') + '\n\nВес подбирай так, чтобы попасть в тот же диапазон повторов. Записывай как обычно — в то же упражнение.');
    }
    case 'taimer': {
      const n = parseInt(args, 10);
      if (n >= 1 && n <= 5) { u.timer = true; u.timerMin = n; return say(`⏱ Таймер отдыха: ${n} мин после каждой записи подхода.`); }
      u.timer = !u.timer;
      return say(u.timer ? `⏱ Таймер отдыха включён (${u.timerMin || 2} мин). Время: <code>/taimer 3</code>` : '⏱ Таймер отдыха выключен.');
    }
    case 'dostup': case 'dobavit': case 'ubrat': {
      const owner = await env.DB.get('owner');
      if (String(id) !== owner) return say('Это может только владелец бота.');
      const guests = JSON.parse((await env.DB.get('guests')) || '[]');
      const gid = (args.match(/-?\d+/) || [])[0];
      if (cmd === 'dobavit' && gid) { if (!guests.includes(gid)) guests.push(gid); await env.DB.put('guests', JSON.stringify(guests)); return say(`✅ ${gid} теперь может пользоваться ботом.`); }
      if (cmd === 'ubrat' && gid) { await env.DB.put('guests', JSON.stringify(guests.filter((g) => g !== gid))); return say(`Убрал ${gid}.`); }
      return say(`🔒 Бот личный: отвечает только тебе${guests.length ? ' и ' + guests.join(', ') : ''}.\nТвой ID: <code>${id}</code>\nДобавить человека: <code>/dobavit 123456789</code> · убрать: <code>/ubrat 123456789</code>`);
    }
    case 'produkt': return say(productText(args));
    case 'otmena': {
      const f = todayFood(u, info);
      if (!f.items.length) return say('Сегодня ещё нечего отменять.');
      const x = f.items.pop(); return say(`Удалил: ${esc(x.name)} — ${x.k} ккал. Сегодня ${foodSum(u, info).k}.`);
    }

    case 'trenirovka': {
      const w = args.trim().toUpperCase().replace('А', 'A').replace('В', 'B').replace('С', 'C');
      const which = PROG[w] ? w : (u.lastWorkoutDate === info.date ? u.curWorkout : u.nextWorkout);
      return say('🏋️ ' + workoutText(u, which));
    }
    case 'programma':
      return say(`🏋️ <b>Программа фул-бади, 3 дня</b> — тренировки идут по кругу A → B → C\n\n` +
        Object.entries(PROG).map(([w, list]) => `<b>${w}:</b> ` + list.map((k) => `${EX[k].n} ${EX[k].s}×${EX[k].r[0]}–${EX[k].r[1]}`).join('; ')).join('\n\n') +
        `\n\n<b>Прогрессия:</b> раз в 1–2 недели добавляй вес или повтор. Когда во всех подходах сделал верх диапазона — прибавь вес и начни с низа. Последние 1–2 повтора тяжёлые, техника важнее веса.\nОтдых между подходами 1,5–2 мин (в базовых — до 3).`);
    case 'istoriya': {
      const f = findExercise(args || '');
      if (!f) return say('Например: <code>/istoriya присед</code>');
      const h = u.lifts[f.key] || [];
      if (!h.length) return say(`По «${EX[f.key].n}» пока нет записей.`);
      return say(`📒 <b>${EX[f.key].n}</b>\n` + h.slice(-10).map((x) => `${ddmm(x.d)}: ${setsText(x.sets)}`).join('\n') + `\n\n→ ${nextHint(f.key, h[h.length - 1].sets)}`);
    }

    case 'ves': {
      const v = parseFloat(args.replace(',', '.'));
      if (!(v > 30 && v < 300)) return say('Например: <code>/ves 117.4</code> — утром натощак.');
      recordWeight(u, info, v);
      return say(`✅ Записал ${kg(v)} кг.\n\n` + progressText(u));
    }
    case 'talia': {
      const v = parseFloat(args.replace(',', '.'));
      if (!(v > 40 && v < 200)) return say('Например: <code>/talia 108</code> — на уровне пупка, на выдохе.');
      u.waist = u.waist.filter((x) => x.d !== info.date);
      u.waist.push({ d: info.date, cm: v });
      return say(`✅ Талия ${kg(v)} см${u.waist.length > 1 ? `, с начала ${kg(v - u.waist[0].cm)} см` : ''}.`);
    }
    case 'progress': return say(progressText(u));
    case 'foto': {
      if (!u.photos.length) return say('Фото пока нет. Раз в месяц пришли фото в полный рост — я сохраню.');
      const first = u.photos[0], last = u.photos[u.photos.length - 1];
      await tg(env, 'sendPhoto', { chat_id: id, photo: first.f, caption: `Первое фото — ${ddmm(first.d)}` });
      if (u.photos.length > 1) await tg(env, 'sendPhoto', { chat_id: id, photo: last.f, caption: `Последнее — ${ddmm(last.d)}` });
      return;
    }
    case 'proverka': {
      const i = variantFor(info, 'lunch');
      return say('Проверка напоминания 👇\n\n' + mealText('lunch', i, info.min), { reply_markup: mealButtons('lunch', i, info.min) });
    }
    default:
      return say('Не знаю такую команду. Все команды — /help');
  }
}

// ---------------------------------------------------------------- обработка апдейтов
async function onCallback(env, cq) {
  await onCallbackInner(env, cq);
  await checkAch(env, cq.message.chat.id, nowMsk());
}
async function onCallbackInner(env, cq) {
  const id = cq.message.chat.id, mid = cq.message.message_id;
  const { u } = await loadUser(env, id);
  const info = nowMsk();
  const [type, a, b, c] = cq.data.split('|');
  let toast = '';
  if (type === 'e' && MENU[a]) {
    const v = MENU[a][+b % MENU[a].length];
    const r = logFood(u, info, { k: v.k, p: v.p, name: SLOT_NAMES[a] });
    learnMeal(u, info, a);
    await saveUser(env, id, u);
    toast = `Записал ✅ ${v.k} ккал`;
    await tg(env, 'editMessageText', { chat_id: id, message_id: mid, parse_mode: 'HTML',
      text: cq.message.text ? esc(cq.message.text) + `\n\n✅ Съел · сегодня ${r.after} из ${r.target} ккал${r.extra}` : '✅' });
  } else if (type === 'a' && MENU[a]) {
    const i = (+b + 1) % MENU[a].length, t = c === '' ? null : +c;
    await tg(env, 'editMessageText', { chat_id: id, message_id: mid, parse_mode: 'HTML', text: mealText(a, i, t), reply_markup: mealButtons(a, i, t) });
  } else if (type === 'm') {
    const off = +a;
    await tg(env, 'editMessageText', { chat_id: id, message_id: mid, parse_mode: 'HTML', text: dayMenuText(u, info, off),
      reply_markup: { inline_keyboard: [[{ text: '🔁 Другое меню', callback_data: `m|${off + 1}` }]] } });
  } else if (type === 'dl') {
    const items = u.food.date === info.date ? u.food.items : [];
    const it = items[+a];
    if (it) { items.splice(+a, 1); await saveUser(env, id, u); toast = 'Удалил'; }
    const d = diaryText(u, info);
    await tg(env, 'editMessageText', { chat_id: id, message_id: mid, parse_mode: 'HTML', text: d.text, reply_markup: d.kb || { inline_keyboard: [] } });
  } else if (type === 'n') {
    if (REMIND_GROUPS[a]) {
      const off = new Set(u.off || []); off.has(a) ? off.delete(a) : off.add(a); u.off = [...off];
      await saveUser(env, id, u);
      toast = `${REMIND_GROUPS[a][0]}: ${off.has(a) ? 'выкл' : 'вкл'}`;
      await tg(env, 'editMessageText', { chat_id: id, message_id: mid, parse_mode: 'HTML', text: remindText(u), reply_markup: remindKb(u) });
    }
  } else if (type === 'mf') {
    await send(env, id, a === 'photo' ? '📷 Пришли фото тарелки — посчитаю.' : '✏️ Напиши, что съел (например <code>гречка 250, котлета</code>) или скажи голосом 🎤');
  } else if (type === 'r') {
    if (u.lastMeal && u.lastMeal.length) { await logItems(env, id, u, info, u.lastMeal, '🔁 Записал ещё раз:'); toast = 'Записал ✅'; }
  } else if (type === 'pm') {
    if (a === 'ok' && u.pendingMeal && u.pendingMeal.length) {
      const items = u.pendingMeal; u.pendingMeal = null;
      await tg(env, 'editMessageReplyMarkup', { chat_id: id, message_id: mid, reply_markup: { inline_keyboard: [] } });
      await logItems(env, id, u, info, items, '✅ Записал по фото:');
      toast = 'Записал ✅';
    } else {
      u.pendingMeal = null; await saveUser(env, id, u);
      await tg(env, 'editMessageReplyMarkup', { chat_id: id, message_id: mid, reply_markup: { inline_keyboard: [] } });
      await send(env, id, 'Ок, не записываю. Напиши текстом, что съел: <code>гречка 250, курица 180</code>');
    }
  } else if (type === 'ph') {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: a === 'prog' ? 'Сохраняю' : 'Смотрю…' });
    await tg(env, 'editMessageReplyMarkup', { chat_id: id, message_id: mid, reply_markup: { inline_keyboard: [] } });
    if (a === 'prog') {
      if (u.pendingPhoto) { u.photos.push({ d: info.date, f: u.pendingPhoto.f }); if (u.photos.length > 36) u.photos.splice(1, 1); u.pendingPhoto = null; await saveUser(env, id, u); }
      await send(env, id, '📸 Фото прогресса сохранил. Сравнить первое и последнее — /foto');
    } else await analyzePhoto(env, id, u, info, a);
    return;
  } else if (type === 'og') {
    const g = +a;
    if (u.pendingProduct && g > 0) {
      const pr = u.pendingProduct; u.pendingProduct = null;
      await tg(env, 'editMessageReplyMarkup', { chat_id: id, message_id: mid, reply_markup: { inline_keyboard: [] } });
      await logItems(env, id, u, info, [productItem(pr, g)], '✅ Записал:');
      toast = 'Записал ✅';
    }
  } else if (type === 'v') {
    const t = addWater(u, info, +a || 0);
    await saveUser(env, id, u);
    toast = `+${a} мл`;
    await tg(env, 'editMessageText', { chat_id: id, message_id: mid, parse_mode: 'HTML', text: t, reply_markup: waterKb });
  } else if (type === 'w') {
    const v = +a;
    if (v > 30 && v < 300) {
      recordWeight(u, info, v);
      await saveUser(env, id, u);
      toast = `Записал ${kg(v)} кг`;
      await tg(env, 'editMessageReplyMarkup', { chat_id: id, message_id: mid, reply_markup: { inline_keyboard: [] } });
      await send(env, id, `✅ Записал ${kg(v)} кг.\n\n` + progressText(u));
    }
  } else if (type === 'st') {
    u.steps = setDaily(u.steps, info, { n: +a });
    await saveUser(env, id, u);
    toast = `👣 ${a} шагов`;
    await tg(env, 'editMessageReplyMarkup', { chat_id: id, message_id: mid, reply_markup: { inline_keyboard: [] } });
  } else if (type === 'sl') {
    u.sleepLog = setDaily(u.sleepLog, info, { q: +a });
    await saveUser(env, id, u);
    toast = ['Сочувствую — сегодня полегче, и ляг пораньше', 'Ок, записал', 'Отлично! 😃'][+a] || 'Ок';
    await tg(env, 'editMessageReplyMarkup', { chat_id: id, message_id: mid, reply_markup: { inline_keyboard: [] } });
  } else if (type === 'b' || type === 'x') {
    const date = a, planned = +b;
    if (date !== info.date) toast = 'Это была вчерашняя поездка';
    else if (type === 'x') {
      toast = 'Понял, учту';
      u.busLog = (u.busLog || []).filter((x) => x.d !== date);
      u.busLog.push({ d: date, diff: -3 }); // ушёл раньше, чем ты дошёл — считаем как «раньше»
      if (u.busLog.length > 30) u.busLog.shift();
      await saveUser(env, id, u);
      await tg(env, 'editMessageText', { chat_id: id, message_id: mid, parse_mode: 'HTML',
        text: `😕 Автобус уехал без тебя. Запомнил — если так будет повторяться, начну звать выходить раньше.${busStatsLine(u)}` });
    } else {
      const diff = Math.max(-30, Math.min(60, info.min - planned));
      u.busLog = (u.busLog || []).filter((x) => x.d !== date);
      u.busLog.push({ d: date, diff });
      if (u.busLog.length > 30) u.busLog.shift();
      await saveUser(env, id, u);
      const t = diff === 0 ? 'точно по расписанию' : diff > 0 ? `на ${diff} мин позже расписания` : `на ${-diff} мин раньше расписания`;
      toast = 'Записал ✅';
      await tg(env, 'editMessageText', { chat_id: id, message_id: mid, parse_mode: 'HTML',
        text: `🚏 Автобус пришёл в ${fmt(info.min)} — ${t}.${busStatsLine(u) || '\nЕщё пару отметок — и я пойму, опаздывает ли он обычно.'}` });
    }
  } else if (type === 's') {
    u.station = a; u.stationTitle = (cq.message.reply_markup?.inline_keyboard || []).flat().find((x) => x.callback_data === cq.data)?.text || a;
    await saveUser(env, id, u);
    toast = 'Остановка сохранена';
    await send(env, id, `🚏 Остановка: ${esc(u.stationTitle)}. Теперь укажи номер автобуса (<code>/avtobus_nomer 123</code>) и проверь: /avtobus`);
  }
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: toast });
}

async function onMessage(env, msg) {
  await onMessageInner(env, msg);
  await checkAch(env, msg.chat.id, nowMsk());
}
async function onMessageInner(env, msg) {
  const id = msg.chat.id;
  const { u, exists } = await loadUser(env, id);
  if (!exists) await addToIndex(env, id);
  const from = msg.from || {};
  const nm = (from.first_name || (from.username ? '@' + from.username : '') || '').slice(0, 40);
  if (nm && u.name !== nm) { u.name = nm; await saveUser(env, id, u); }
  const info = nowMsk();
  const say = (t, x) => send(env, id, t, x);

  if (msg.photo) {
    const f = msg.photo[msg.photo.length - 1].file_id;
    const cap = (msg.caption || '').trim().slice(0, 100);
    if (/(форм|прогресс|замер|тело|фигур)/i.test(cap)) {
      u.photos.push({ d: info.date, f });
      if (u.photos.length > 36) u.photos.splice(1, 1); // первое фото храним всегда
      await saveUser(env, id, u);
      return say('📸 Фото прогресса сохранил. Сравнить первое и последнее — /foto');
    }
    u.pendingPhoto = { f, d: info.date, cap };
    await saveUser(env, id, u);
    if (/(штрих|код|barcode)/i.test(cap)) return analyzePhoto(env, id, u, info, 'bar');
    if (cap) return analyzePhoto(env, id, u, info, 'food');
    return say('Что это за фото?', { reply_markup: { inline_keyboard: [
      [{ text: '🍽 Посчитать еду', callback_data: 'ph|food' }, { text: '🏷 Штрихкод', callback_data: 'ph|bar' }],
      [{ text: '📸 Фото прогресса (тело)', callback_data: 'ph|prog' }],
    ] } });
  }
  if (msg.voice || msg.audio) {
    const v = msg.voice || msg.audio;
    if (!env.AI) return say('Голосовые пока не подключены. Напиши текстом: <code>гречка 250, курица 180</code>');
    if ((v.duration || 0) > 60) return say('Слишком длинное голосовое — давай до минуты 🙂');
    await tg(env, 'sendChatAction', { chat_id: id, action: 'typing' });
    const bytes = await tgFileBytes(env, v.file_id);
    if (!bytes) return say('Не смог скачать голосовое, попробуй ещё раз.');
    let text = '';
    try { text = await transcribe(env, bytes); } catch (e) { console.error('voice', e); }
    if (!text) return say('Не разобрал голосовое 😕 Попробуй ещё раз или напиши текстом.');
    await say(`🎤 «${esc(text.slice(0, 300))}»`);
    const pm = parseMeal(text, u);
    if (pm.ok.length && !pm.bad.length) return logItems(env, id, u, info, pm.ok, '✅ Записал:');
    if (await aiMealConfirm(env, id, u, text, '🤖 <b>Понял так</b> (оценка, ±20 %):')) return;
    if (pm.ok.length) return logItems(env, id, u, info, pm.ok, '✅ Записал, что узнал:');
    return say('Не понял, что из этого еда 🙂 Попробуй: «тарелка гречки и две котлеты».');
  }
  if (msg.location) {
    if (!env.YANDEX_KEY) return say('Чтобы искать остановки, добавь ключ Яндекс.Расписаний (секрет YANDEX_KEY) — см. инструкцию. А пока бот работает по времени, которое ты указал в /avtobus.');
    const { latitude: lat, longitude: lng } = msg.location;
    try {
      const r = await fetch(`https://api.rasp.yandex.net/v3.0/nearest_stations/?apikey=${encodeURIComponent(env.YANDEX_KEY)}&lat=${lat}&lng=${lng}&distance=1&transport_types=bus&format=json&lang=ru_RU&limit=8`);
      const j = await r.json();
      const st = (j.stations || []).slice(0, 8);
      if (!st.length) return say('Рядом не нашёл автобусных остановок в базе Яндекс.Расписаний. Часто городских автобусов Москвы там нет — тогда просто используй своё время: <code>/avtobus 7:42 7</code>');
      return say('Выбери свою остановку:', { reply_markup: { inline_keyboard: st.map((s) => [{ text: `${s.title} (${Math.round(s.distance * 1000)} м)`.slice(0, 60), callback_data: `s|${s.code}` }]) } });
    } catch { return say('Не получилось связаться с Яндекс.Расписаниями. Попробуй позже.'); }
  }
  const text = (msg.text || '').trim();
  if (!text) return;

  let cmd = null, args = '';
  if (text.startsWith('/')) {
    const [c, ...rest] = text.split(/\s+/);
    cmd = c.slice(1).split('@')[0].toLowerCase(); args = rest.join(' ');
  } else if (BUTTONS[text]) cmd = BUTTONS[text];

  if (cmd) {
    if (cmd !== 'start' && cmd !== 'nastroika') u.wiz = null;
    await command(env, id, u, cmd, args, info);
    return saveUser(env, id, u);
  }

  if (u.wiz != null) {
    const step = WIZ[u.wiz];
    if (step.set(u, text) === false) { await say('Не понял 🙂 ' + step.q); return; }
    u.wiz++;
    await wizAsk(env, id, u);
    return saveUser(env, id, u);
  }

  // штрихкод цифрами
  if (/^\d{8,14}$/.test(text)) return barcodeFlow(env, id, u, info, text);
  // граммы для продукта по штрихкоду
  if (u.pendingProduct && /^\d{1,4}\s*(г|гр|грамм\S*)?$/i.test(text)) {
    const g = parseInt(text, 10);
    if (g > 0 && g <= 3000) {
      const pr = u.pendingProduct; u.pendingProduct = null;
      return logItems(env, id, u, info, [productItem(pr, g)], '✅ Записал:');
    }
  }
  // вода
  const wm = norm(text).match(/^(?:выпил[аи]?\s+)?вод[аыуе]\s*(\d{2,4})?\s*(мл)?$/);
  if (wm) {
    const t = addWater(u, info, wm[1] ? +wm[1] : 250);
    await saveUser(env, id, u);
    return say(t, { reply_markup: waterKb });
  }

  const ex = findExercise(text);
  if (ex) {
    const sets = parseSets(ex.rest);
    if (!sets) return say(`Формат: <code>${esc(EX[ex.key].a[0])} 60x8 60x8 60x7</code> (вес×повторы) или <code>${esc(EX[ex.key].a[0])} 60x8x3</code>`);
    const { today, prev } = logSets(u, info, ex.key, sets);
    await saveUser(env, id, u);
    return say(`✅ <b>${EX[ex.key].n}</b>: ${setsText(today.sets)}` +
      (prev ? `\nПрошлый раз (${ddmm(prev.d)}): ${setsText(prev.sets)}` : '') +
      `\n→ ${nextHint(ex.key, today.sets)}` + (u.timer !== false ? `\n⏱ Напомню через ${u.timerMin || 2} мин` : ''));
  }

  if (!/^\d+([.,]\d)?$/.test(text)) {
    const handled = await logMealText(env, id, u, info, text, false);
    if (handled !== false) return;
  }

  if (/^\d+([.,]\d)?$/.test(text)) {
    return say(`Это вес? Тогда так: <code>/ves ${esc(text)}</code>. Калории: <code>/el ${esc(text)} название</code>`);
  }
  return say('Не понял 🙂 Кнопки внизу или /help. Подходы пиши так: <code>присед 60x8 60x8</code>', { reply_markup: KEYBOARD });
}

// Личный бот: первый пользователь — владелец, остальным нужен /dobavit
async function allowed(env, id) {
  if (env.ALLOWED_IDS) return String(env.ALLOWED_IDS).split(/[\s,]+/).includes(String(id));
  let owner = await env.DB.get('owner');
  if (!owner) {
    const ids = JSON.parse((await env.DB.get('users')) || '[]');
    owner = String(ids[0] ?? id);
    await env.DB.put('owner', owner);
  }
  if (String(id) === owner) return true;
  return JSON.parse((await env.DB.get('guests')) || '[]').includes(String(id));
}
async function stranger(env, msg) {
  const id = msg.chat.id;
  await send(env, id, `🔒 Это личный бот. Твой ID: <code>${id}</code> — попроси владельца добавить тебя.`);
  if (await env.DB.get('asked:' + id)) return;
  await env.DB.put('asked:' + id, '1');
  const owner = await env.DB.get('owner');
  const f = msg.from || {};
  if (owner) await send(env, owner, `👤 Ботом хотел воспользоваться ${esc(f.first_name || '')}${f.username ? ' @' + esc(f.username) : ''} (ID <code>${id}</code>).\nРазрешить: <code>/dobavit ${id}</code>`);
}

// ---------------------------------------------------------------- точка входа
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/setup') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('Нужен ?key=WEBHOOK_SECRET', { status: 403 });
      const hook = await tg(env, 'setWebhook', { url: `${url.origin}/webhook`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      const cmds = await tg(env, 'setMyCommands', { commands: [
        ['segodnya', 'План на сегодня'], ['menu', 'Меню на день'], ['kkal', 'Калории сегодня'], ['el', 'Записать еду: /el гречка 250'],
        ['nedelya', 'Калории за неделю'], ['produkt', 'Калорийность продукта'], ['moe', 'Мои продукты'], ['povtor', 'Съел то же ещё раз'],
        ['voda', 'Вода'], ['shagi', 'Шаги'], ['otchet', 'Итоги недели'], ['grafik', 'Графики'], ['dostizheniya', 'Достижения'], ['eksport', 'Таблица для врача'],
        ['zamena', 'Замена упражнения'], ['taimer', 'Таймер отдыха'],
        ['app', 'Приложение'], ['dnevnik', 'Дневник за сегодня'], ['uzhin', 'Что съесть под остаток'], ['zametka', 'Заметка о самочувствии'],
        ['napominaniya', 'Настроить напоминания'], ['tishina', 'Тихие часы'],
        ['trenirovka', 'Тренировка'], ['ves', 'Вес: /ves 117.4'], ['progress', 'Прогресс'], ['raspisanie', 'Расписание'],
        ['avtobus', 'Автобус'], ['pokupki', 'Список покупок'], ['zameny', 'Замены'], ['sryv', 'Если сорвался'],
        ['nastroiki', 'Настройки'], ['help', 'Все команды'],
      ].map(([command, description]) => ({ command, description })) });
      await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: '📊 Дневник', web_app: { url: appUrl(url.origin) } } });
      const me = await tg(env, 'getMe', {});
      return new Response(JSON.stringify({ webhook: hook, commands: cmds, bot: me.result?.username }, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    env = { ...env, APP_URL: env.APP_URL || appUrl(url.origin) };
    if (url.pathname === APP_PATH) return new Response(APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
    if (url.pathname === '/api' && req.method === 'POST') return apiHandle(env, req, url.origin);
    if (url.pathname === '/api/photo') return photoProxy(env, url);
    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const upd = await req.json();
      try {
        const chatId = upd.message?.chat?.id ?? upd.callback_query?.message?.chat?.id;
        if (chatId != null && await allowed(env, chatId)) {
          if (upd.message) await onMessage(env, upd.message);
          else if (upd.callback_query) await onCallback(env, upd.callback_query);
        } else if (chatId != null && upd.message) await stranger(env, upd.message);
      } catch (e) { console.error(e); }
      return new Response('ok');
    }
    return new Response('Бот «Стол №8» работает ✅', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cron({ ...env, APP_URL: env.APP_URL || 'https://stol8-bot.sq1zyx.workers.dev' + APP_PATH }));
  },
};
