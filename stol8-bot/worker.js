// =====================================================================
//  Телеграм-бот «Стол №8» — расписание, питание, тренировки, прогресс
//  Cloudflare Worker + Workers KV (binding: DB) + Cron (каждую минуту)
//  Секреты: BOT_TOKEN, WEBHOOK_SECRET. Необязательно: YANDEX_KEY, ALLOWED_IDS
// =====================================================================

const TZ_OFFSET_MIN = 180; // Москва, UTC+3 (перехода на летнее время нет)
const KCAL_FLOOR = 2700;   // ниже бот не опускает норму: подросток, ещё растёт

const DEFAULTS = {
  wakeWd: 390, wakeWe: 540, sleepH: 9, meals: 6,
  schoolStart: 510, busTime: null, walk: 7, buffer: 2,
  busInfo: '', busNumber: '', station: '', stationTitle: '', busToday: null,
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
const isWorkday = (u, info) => !u.holidays && info.dow >= 1 && info.dow <= 5;
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
  return lines.join('\n');
}

// ---------------------------------------------------------------- калории
function lastWeight(u) { return u.weights.length ? u.weights[u.weights.length - 1].kg : u.startWeight; }
function calc(u) {
  const w = lastWeight(u);
  const bmr = 10 * w + 6.25 * u.height - 5 * u.age + 5;
  const tdee = bmr * 1.55;
  let target = Math.round((tdee - 500) / 50) * 50 + (u.kcalAdjust || 0);
  target = Math.max(target, KCAL_FLOOR);
  if (u.kcalOverride) target = u.kcalOverride;
  return { w, bmr: Math.round(bmr / 50) * 50, tdee: Math.round(tdee / 50) * 50, target };
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
  { n: 'Чай / кофе без сахара', ml: 1, s: ['чай', 'кофе', 'вода'], k: 1, p: 0, f: 0, c: 0, d: 250 },
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
function parseFoodPart(part) {
  const t = norm(part).replace(/ё/g, 'е').replace(/\d+(?:[.,]\d+)?\s*%/g, ' ').trim();
  if (!t) return null;
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
function parseMeal(text) {
  const parts = text.split(/[,;\n+]|\s+и\s+|\s+на\s+(?=молок|кефир|вод)|\s+с\s+(?=\D)|\s+со\s+/i).map((s) => s.trim()).filter(Boolean)
    .map((s) => s.split(/\s+/).filter((w, i, arr) => !(i === 0 && arr.length > 1 && FILLER.test(norm(w)))).join(' '));
  const ok = [], bad = [];
  for (const p of parts) {
    if (FILLER.test(norm(p))) continue;
    const r = parseFoodPart(p);
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

// ---------------------------------------------------------------- расписание
function buildDay(u, info) {
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
    const leave = bt - u.walk - u.buffer;
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
          busLine = `\n🚌 По расписанию Яндекса автобус в ${fmt(t)}.`;
        }
      }
      const plan = buildDay(u, info).filter((x) => ['meal', 'busgo', 'gym', 'bed'].includes(x.kind));
      const short = plan.map((x) => x.kind === 'meal' ? `${fmt(x.t)} ${SLOT_NAMES[x.slot].toLowerCase()}`
        : x.kind === 'busgo' ? `${fmt(x.t)} выход` : x.kind === 'gym' ? `${fmt(u.gymTime)} зал` : `${fmt(x.t)} отбой`);
      return send(env, id, `☀️ <b>Доброе утро!</b> Подъём — выпей стакан воды.${busLine}\n\nСегодня: ${short.join(' · ')}`, { reply_markup: KEYBOARD });
    }
    case 'exercise': return send(env, id, EXERCISE_TEXT);
    case 'meal': {
      const i = variantFor(info, e.slot);
      return send(env, id, mealText(e.slot, i, e.t), { reply_markup: mealButtons(e.slot, i, e.t) });
    }
    case 'bus10': return send(env, id, `🚌 Через 10 минут выходить к автобусу${u.busNumber ? ' №' + esc(u.busNumber) : ''} (отправление ${fmt(e.bt)}, идти ${u.walk} мин).\n<i>Пробки и опоздания я не вижу — это по расписанию.</i>`);
    case 'busgo': return send(env, id, `🏃 <b>Выходи!</b> Автобус${u.busNumber ? ' №' + esc(u.busNumber) : ''} в ${fmt(e.bt)}.`);
    case 'gym': return send(env, id, `🏋️ Через час зал (${fmt(u.gymTime)}).\n\n${workoutText(u, u.nextWorkout)}\n\nВозьми воду и форму. Если не ел 3+ часа — перекуси сейчас (полдник).`);
    case 'prep': return send(env, id, PREP_SUN);
    case 'prep2': return send(env, id, PREP_WED);
    case 'weigh': return send(env, id, '⚖️ Воскресенье — взвешивание. Утром натощак, после туалета, без одежды. Пришли так: <code>/ves 117.4</code>\nСмотрим на тренд, а не на одну цифру 🙂');
    case 'month': return send(env, id, '📏 Новый месяц — замеры!\n1. Талия на уровне пупка, на выдохе: <code>/talia 108</code>\n2. Фото в полный рост (спереди и сбоку) при одинаковом свете — просто пришли сюда, я сохраню для сравнения.');
    case 'foodcheck': {
      const s = foodSum(u, info), target = calc(u).target;
      if (s.n === 0) return send(env, id, '🍽 Сегодня ничего не записано. Если не лень — напиши, что ел, одним сообщением: <code>гречка 250, курица 180, 2 яйца, кефир</code>. Не обязательно точно, примерно тоже полезно.');
      let t = `🧾 <b>Итог дня:</b> ${s.k} из ${target} ккал · белок ${s.p} г${s.p < 150 ? ' (цель от 150)' : ' ✅'}`;
      if (s.k < target - 900) t += '\n\nЕсли ты правда мало поел — съешь творог или выпей кефир, не ложись голодным. Недоедание мешает расти и тормозит прогресс.';
      else if (s.k <= target + 400) t += '\nОтличный день 👍';
      else t += '\nЧуть больше нормы — ничего страшного, завтра просто обычный день по меню.';
      return send(env, id, t + '\nНеделя — /nedelya');
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
      for (const e of evs) await fire(env, id, u, e, today);
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

📈 <b>Прогресс</b>
/ves 117.4 — вес (раз в неделю утром натощак)
/talia 108 — талия (раз в месяц)
Фото — просто пришли картинку
/progress — тренд · /foto — сравнить фото

/pauza — выключить/включить напоминания
/kanikuly — режим каникул (все дни как выходные)`;

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
Напоминания: ${u.paused ? '⏸ на паузе' : '▶️ включены'} · Каникулы: ${u.holidays ? 'да' : 'нет'}`;
}

// ---------------------------------------------------------------- запись еды текстом
// strict=false (обычное сообщение): если ни один продукт не узнан — возвращает false, чтобы бот ответил «не понял»
async function logMealText(env, id, u, info, text, strict) {
  const { ok, bad } = parseMeal(text);
  if (!ok.length) {
    if (!strict) return false;
    return send(env, id, `Не нашёл в базе: ${esc(bad.join(', ') || text)}.\nЗапиши вручную: <code>/el 300 ${esc(bad[0] || 'название')}</code> · что есть в базе — /produkt`);
  }
  const before = foodSum(u, info).k, target = calc(u).target;
  todayFood(u, info);
  for (const x of ok) u.food.items.push({ name: `${x.name} ${x.g} ${x.u}`, k: x.k, p: x.p, fat: x.fat, c: x.c, at: info.min });
  if (u.food.items.length > 60) u.food.items.splice(0, u.food.items.length - 60);
  const after = foodSum(u, info);
  await saveUser(env, id, u);
  let t = `✅ Записал:\n${mealSummary(ok)}\n\nСегодня: <b>${after.k}</b> из ${target} ккал · белок ${after.p} г`;
  if (bad.length) t += `\n\n❓ Не узнал: ${esc(bad.join(', '))} — запиши вручную: <code>/el 300 ${esc(bad[0])}</code>`;
  if (before <= target + 400 && after.k > target + 400) t += '\n\nСегодня вышло больше нормы — это нормально, так бывает. Ничего не «отрабатывай» и не пропускай еду: следующий приём пищи просто сделай обычным 💪';
  t += `\n<i>Ошибся — /otmena (удаляет последнюю позицию)</i>`;
  return send(env, id, t);
}

// ---------------------------------------------------------------- команды
async function command(env, id, u, cmd, args, info) {
  const say = (t, x) => send(env, id, t, x);
  switch (cmd) {
    case 'start':
      await say('Привет, Степан! 👋 Я помогу спокойно худеть по столу №8: расписание с напоминаниями, меню из магазинных продуктов почти без готовки, зал и прогресс.\n\nТон у меня простой: срыв — не провал. Давай настроим расписание (8 коротких вопросов).', { reply_markup: KEYBOARD });
      u.wiz = 0; return wizAsk(env, id, u);
    case 'nastroika': u.wiz = 0; return wizAsk(env, id, u);
    case 'help': return say(HELP, { reply_markup: KEYBOARD });
    case 'nastroiki': return say(settingsText(u));
    case 'segodnya': {
      const s = foodSum(u, info);
      return say(scheduleText(u, info, `📅 <b>Сегодня, ${DAYNAMES[info.dow]} ${ddmm(info.date)}</b>${isWorkday(u, info) ? '' : ' (выходной)'}`) +
        `\n\n🔥 Съедено: ${s.k} из ${calc(u).target} ккал`);
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
        let text = `🚌 Автобус${u.busNumber ? ' №' + esc(u.busNumber) : ''} в ${fmt(u.busTime)}, идти ${u.walk} мин → выход в ${fmt(u.busTime - u.walk - u.buffer)}.`;
        const deps = await yandexDepartures(env, u, info);
        if (deps && deps.length) {
          const near = deps.filter((t) => Math.abs(t - u.busTime) <= 40).map(fmt);
          text += `\nЯндекс.Расписания сегодня рядом с этим временем: ${near.join(', ') || 'ничего'}`;
        } else if (env.YANDEX_KEY && u.station) {
          text += '\nЯндекс не вернул рейсы для этой остановки/номера — использую твоё время.';
        }
        return say(text + '\n<i>Пробки и опоздания я не вижу.</i>');
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
    case 'kanikuly': u.holidays = !u.holidays; return say(u.holidays ? '🏖 Режим каникул: все дни как выходные, без автобуса.' : '📚 Учёба: будни снова по будничному расписанию.');

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
        if (n < 2200) return say('Так мало ставить не буду — для растущего парня с залом это опасно. Если врач правда назначил такую цифру, уточни у него ещё раз.');
        u.kcalOverride = n; return say(`Ок, норма <b>${n} ккал</b> (как назначил врач). Вернуть расчёт — <code>/kkal сброс</code>`);
      }
      if (/^сброс/i.test(a)) { u.kcalOverride = null; u.kcalAdjust = 0; return say(`Ок, норма снова по расчёту: ${calc(u).target} ккал.`); }
      const c = calc(u), s = foodSum(u, info);
      const items = u.food.date === info.date ? u.food.items : [];
      return say(`🔥 <b>Норма: ${c.target} ккал</b>
Съедено: <b>${s.k}</b> ккал (Б ~${s.p} г${s.fat || s.c ? ` · Ж ~${s.fat} · У ~${s.c}` : ''}) · осталось ~${Math.max(0, c.target - s.k)}
${items.length ? '\n' + items.map((x) => `• ${fmt(x.at)} ${esc(x.name)} — ${x.k}`).join('\n') + '\n' : ''}
Ориентиры: белок от 150 г · жиры 85–100 г · углеводы — остальное (крупы, хлеб, овощи, фрукты).

<i>Как считается: вес ${kg(c.w)} кг, рост ${u.height}, ${u.age} лет → обмен ~${c.bmr}, с залом и шагами ~${c.tdee}, минус ~500. Ниже ${KCAL_FLOOR} не опускаю — ты растёшь. Это прикидка, финальную цифру согласуй с эндокринологом.</i>
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
      u.weights = u.weights.filter((x) => x.d !== info.date);
      u.weights.push({ d: info.date, kg: v });
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
  const id = cq.message.chat.id, mid = cq.message.message_id;
  const { u } = await loadUser(env, id);
  const info = nowMsk();
  const [type, a, b, c] = cq.data.split('|');
  let toast = '';
  if (type === 'e' && MENU[a]) {
    const v = MENU[a][+b % MENU[a].length];
    const r = logFood(u, info, { k: v.k, p: v.p, name: SLOT_NAMES[a] });
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
  } else if (type === 's') {
    u.station = a; u.stationTitle = (cq.message.reply_markup?.inline_keyboard || []).flat().find((x) => x.callback_data === cq.data)?.text || a;
    await saveUser(env, id, u);
    toast = 'Остановка сохранена';
    await send(env, id, `🚏 Остановка: ${esc(u.stationTitle)}. Теперь укажи номер автобуса (<code>/avtobus_nomer 123</code>) и проверь: /avtobus`);
  }
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: toast });
}

async function onMessage(env, msg) {
  const id = msg.chat.id;
  const { u, exists } = await loadUser(env, id);
  if (!exists) await addToIndex(env, id);
  const info = nowMsk();
  const say = (t, x) => send(env, id, t, x);

  if (msg.photo) {
    const f = msg.photo[msg.photo.length - 1].file_id;
    u.photos.push({ d: info.date, f });
    if (u.photos.length > 36) u.photos.splice(1, 1); // первое фото храним всегда
    await saveUser(env, id, u);
    return say('📸 Фото сохранил. Сравнить первое и последнее — /foto');
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

  const ex = findExercise(text);
  if (ex) {
    const sets = parseSets(ex.rest);
    if (!sets) return say(`Формат: <code>${esc(EX[ex.key].a[0])} 60x8 60x8 60x7</code> (вес×повторы) или <code>${esc(EX[ex.key].a[0])} 60x8x3</code>`);
    if (u.lastWorkoutDate !== info.date) {
      const w = Object.keys(PROG).find((k) => PROG[k].includes(ex.key)) || u.nextWorkout;
      u.curWorkout = w; u.nextWorkout = NEXT_W[w]; u.lastWorkoutDate = info.date;
    }
    const hist = (u.lifts[ex.key] = u.lifts[ex.key] || []);
    const prev = hist.length && hist[hist.length - 1].d !== info.date ? hist[hist.length - 1] : (hist.length > 1 ? hist[hist.length - 2] : null);
    if (hist.length && hist[hist.length - 1].d === info.date) hist[hist.length - 1].sets.push(...sets);
    else hist.push({ d: info.date, sets });
    if (hist.length > 20) hist.shift();
    const today = hist[hist.length - 1];
    await saveUser(env, id, u);
    return say(`✅ <b>${EX[ex.key].n}</b>: ${setsText(today.sets)}` +
      (prev ? `\nПрошлый раз (${ddmm(prev.d)}): ${setsText(prev.sets)}` : '') +
      `\n→ ${nextHint(ex.key, today.sets)}`);
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

function allowed(env, id) {
  if (!env.ALLOWED_IDS) return true;
  return String(env.ALLOWED_IDS).split(/[\s,]+/).includes(String(id));
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
        ['nedelya', 'Калории за неделю'], ['produkt', 'Калорийность продукта'],
        ['trenirovka', 'Тренировка'], ['ves', 'Вес: /ves 117.4'], ['progress', 'Прогресс'], ['raspisanie', 'Расписание'],
        ['avtobus', 'Автобус'], ['pokupki', 'Список покупок'], ['zameny', 'Замены'], ['sryv', 'Если сорвался'],
        ['nastroiki', 'Настройки'], ['help', 'Все команды'],
      ].map(([command, description]) => ({ command, description })) });
      const me = await tg(env, 'getMe', {});
      return new Response(JSON.stringify({ webhook: hook, commands: cmds, bot: me.result?.username }, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const upd = await req.json();
      try {
        const chatId = upd.message?.chat?.id ?? upd.callback_query?.message?.chat?.id;
        if (chatId != null && allowed(env, chatId)) {
          if (upd.message) await onMessage(env, upd.message);
          else if (upd.callback_query) await onCallback(env, upd.callback_query);
        }
      } catch (e) { console.error(e); }
      return new Response('ok');
    }
    return new Response('Бот «Стол №8» работает ✅', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cron(env));
  },
};
