// Собирает app.html (мини-приложение) в app.js, который импортирует worker.js.
// Запуск: node build.mjs (после правок app.html)
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('./app.html', import.meta.url), 'utf8');
writeFileSync(new URL('./app.js', import.meta.url), '// СГЕНЕРИРОВАНО из app.html командой `node build.mjs` — не править руками\nexport default ' + JSON.stringify(html) + ';\n');
console.log('app.js', html.length, 'bytes');
