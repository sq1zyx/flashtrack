# contract-audit-api

Загрузка договора → извлечение текста или OCR → разбивка на части (если нужно) → аудит нейросетью → проверенный JSON.

**Запуск на своём компьютере с GigaChat — пошагово, без программирования: [ЗАПУСК.md](ЗАПУСК.md).**

Нейросеть выбирается в `.env` через `LLM_PROVIDER`:
- `gigachat` — GigaChat (Сбер): бесплатный лимит для физлиц, данные остаются в РФ. JSON-схема отчёта передаётся в промпте, ответ проверяется zod; если он не прошёл проверку, модель получает список ошибок и исправляет ответ (до 3 попыток). Корневой сертификат Минцифры для HTTPS лежит в `certs/`.
- `anthropic` — Claude (по умолчанию `claude-sonnet-5-5`): структурированный вывод, кэширование промпта, выше качество анализа. Нужен платный ключ.

## Быстрый старт (локально)

Нужен Node.js 22.13+. Системные пакеты не нужны.

```bash
npm install
cp .env.example .env          # вписать ANTHROPIC_API_KEY и ADMIN_TOKEN (любая строка от 16 символов)
npm test                      # 19 тестов, Claude не вызывается
npm run code -- new 5 "я"     # выдать себе код на 5 проверок → напечатает, например, K7F2-9QXA
npm run dev                   # открыть http://localhost:3000 и ввести код
```

При первом OCR `tesseract.js` скачивает языковые модели `rus` и `eng` (~30 МБ) в `OCR_CACHE_PATH`.

## Как клиент получает доступ

Регистрации и онлайн-оплаты пока нет: клиент платит вам (перевод, счёт, ссылка ЮKassa или Робокассы), а вы выдаёте ему **код доступа** с пакетом проверок.

```bash
# на сервере
node dist/cli.js new 10 "Иванова, АН Метры"   # код на 10 проверок
node dist/cli.js add K7F2-9QXA 10             # докупил ещё 10
node dist/cli.js list                         # все коды и остатки

# или удалённо, по HTTP
curl -X POST https://ваш-домен/api/admin/codes -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "content-type: application/json" -d '{"credits":10,"note":"Иванова"}'
curl https://ваш-домен/api/admin/jobs -H "Authorization: Bearer $ADMIN_TOKEN"   # последние проверки и расходы на API
```

Одна проверка списывает один кредит. Если проверка не удалась (битый файл, сбой API, перезапуск сервера), кредит возвращается автоматически.

## Деплой

Сервису нужны один контейнер и постоянный диск на `/data` (там SQLite-база с кодами и проверками, плюс модели OCR). Сервер должен находиться в стране, где API Anthropic доступен (не в РФ).

**Railway / Render / Fly.io** (проще всего): подключить репозиторий, указать каталог `contract-audit-api` (сборка по `Dockerfile`), добавить Volume с точкой монтирования `/data` и переменные `ANTHROPIC_API_KEY` и `ADMIN_TOKEN`. Выдать код: `node dist/cli.js new 10 "клиент"` в консоли сервиса.

**VPS** (Hetzner, DigitalOcean и т.п., от $5/мес, 2 ГБ RAM):

```bash
docker build -t contract-audit-api .
docker run -d --restart=always -p 3000:3000 -v audit-data:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... -e ADMIN_TOKEN=$(openssl rand -hex 24) contract-audit-api
docker exec <container> node dist/cli.js new 10 "клиент"
```

Перед сервером поставьте HTTPS: Caddy (`caddy reverse-proxy --from ваш-домен --to :3000`) или встроенный HTTPS платформы.

Ограничение: очередь проверок живёт в памяти процесса, поэтому работает одна копия сервера (`JOB_CONCURRENCY` проверок одновременно, по умолчанию 2). Для нагрузки выше пары сотен проверок в день нужно переходить на Postgres и внешнюю очередь (см. архитектуру).

## API

Все запросы, кроме админских, требуют заголовок `X-Access-Code: <код>`.

### `POST /api/jobs` → `202 {job_id}`, затем `GET /api/jobs/:id`

Так работает веб-интерфейс: проверка идёт в фоне, клиент раз в несколько секунд опрашивает статус (`queued` → `running` → `done` | `failed`). В `result` лежат `audit`, `meta`, `extraction` и `paragraphs`. Поля те же, что у `/api/audit` ниже.

### `POST /api/audit` (multipart/form-data, синхронно)

| Поле | | |
|---|---|---|
| `file` | обязательно | PDF, DOCX, JPG, PNG, WEBP, TIFF, TXT; до 20 МБ |
| `client_party` | обязательно | чью сторону защищаем: «Арендатор», «Покупатель», … |
| `jurisdiction` | | по умолчанию «Российская Федерация» |
| `deep` | | `true`: больше effort (дороже и медленнее) |
| `include_text` | | `true`: вернуть абзацы с ID, чтобы подсветить `clause_refs` в UI |

```bash
curl -H "X-Access-Code: K7F2-9QXA" -F file=@contract.pdf -F client_party=Арендатор http://localhost:3000/api/audit
```

Ответ:

```jsonc
{
  "file": { "name": "contract.pdf", "size": 37182 },
  "extraction": { "sourceKind": "pdf_text", "pageCount": 3, "ocrPages": [], "warnings": [], "paragraph_count": 41 },
  "audit": {
    "document": { … }, "overall": { "risk_score": 9, "verdict": "do_not_sign_without_major_changes", … },
    "findings": [ { "id": "F-1", "clause_refs": ["P-018"], "quote": "…", "risk_score": 8, "quote_verified": true, … } ],
    "missing_clauses": [ … ], "key_dates": [ … ], "questions_to_counterparty": [ … ], "confidence": "high", "limitations": "…"
  },
  "meta": { "mode": "single_pass", "model": "claude-sonnet-5-5", "chunks": 1, "usage": { … }, "cost_usd": 0.12, "duration_ms": 48211 }
}
```

`quote_verified: false` значит, что цитату не удалось найти в тексте договора. Такую находку стоит пометить в интерфейсе как неподтверждённую.

### `POST /api/extract`

То же извлечение без вызова Claude. Возвращает абзацы `[{ id: "P-001", text }]`: пригодится, чтобы показать «что мы распознали», и для отладки.

### Ошибки

Всегда в формате `{"error": {"code", "message"}}`, где `message` можно показывать пользователю.

| HTTP | code | когда |
|---|---|---|
| 400 | `file_required`, `client_party_required`, `empty_file` | неполный запрос |
| 401 | `access_code_required`, `access_code_invalid` | нет кода или код неверный |
| 402 | `no_credits` | проверки по коду закончились |
| 413 | `file_too_large`, `too_many_pages`, `too_many_scanned_pages` | превышены лимиты |
| 415 | `unsupported_type`, `legacy_doc`, `heic_unsupported` | формат не поддерживается |
| 422 | `pdf_corrupted`, `pdf_encrypted`, `docx_corrupted`, `image_corrupted`, `file_corrupted`, `no_text`, `ocr_failed`, `llm_refused` | файл не читается или в нём нет текста |
| 502 | `llm_invalid_output`, `llm_error` | Claude вернул некорректный ответ даже после повтора |
| 503 / 504 | `llm_unavailable`, `llm_rate_limited`, `llm_timeout`, `ocr_unavailable` | временная недоступность; SDK уже сделал 3 повтора с паузами |
| 500 | `llm_misconfigured` | нет или неверный `ANTHROPIC_API_KEY` |

## Как устроено

```
src/
  server.ts          Express: веб-интерфейс, маршруты, коды доступа, админ-API, обработчик ошибок
  jobs.ts            фоновая очередь проверок; при ошибке кредит возвращается
  store.ts           SQLite (встроенный node:sqlite): коды доступа и проверки
  cli.ts             выдача кодов из командной строки (new-code.bat)
  check-llm.ts       проверка, что нейросеть отвечает (запускается из start.bat)
  pipeline.ts        файл → извлечение → нормализация → маскирование ПДн
  extract/
    index.ts         тип файла определяется по сигнатуре (file-type), а не по расширению
    pdf.ts           pdf-parse: текстовый слой; страницы без текста рендерятся и уходят в OCR
    docx.ts          mammoth → HTML → текст с восстановленной автонумерацией Word (1.1., 2.3.)
    ocr.ts           sharp (поворот, ч/б, контраст, увеличение) + tesseract.js rus+eng
  text/
    normalize.ts     колонтитулы, номера страниц, переносы, склейка строк PDF, ID абзацев [P-001]
    chunk.ts         разбивка по разделам договора, общий контекст (преамбула + термины) и оглавление
    pii.ts           маскирование паспорта, СНИЛС, ИНН физлица, телефонов, e-mail, счетов и карт
  llm/
    prompts.ts       системный промпт аудита + промпты map/reduce
    schema.ts        zod-схема ответа (уходит в API как structured output)
    call.ts          вызов Claude: стриминг, кэш промпта, fallback, повтор, учёт стоимости
    gigachat.ts      вызов GigaChat: OAuth-токен, повторы, JSON по схеме с исправлением ошибок
    audit.ts         один проход или map-reduce
    verify.ts        сверка цитат с текстом, отбрасывание несуществующих clause_refs
```

**Разбивка на части.** Договор до `SINGLE_PASS_MAX_TOKENS` токенов (по умолчанию 150k, это примерно 200 страниц; токены считает `count_tokens`) анализируется одним запросом, так модель видит все перекрёстные ссылки. Более длинный документ режется по границам разделов на части по ~40k токенов. Раздел, который не помещается в одну часть, делится по абзацам с перекрытием в 2 абзаца, так что отдельный пункт никогда не разрезается. Каждая часть получает одинаковый общий префикс (преамбула, раздел терминов, оглавление с диапазонами абзацев): он кэшируется, и поэтому части 2…N платят за него около 10% цены. Затем отдельный вызов сводит находки всех частей в одно заключение.

**Персональные данные.** До отправки в нейросеть паспортные данные, СНИЛС, ИНН физлиц, телефоны, e-mail, номера счетов и карт заменяются метками `[ТЕЛЕФОН_1]`. Наименования сторон и реквизиты компаний остаются: они нужны для анализа. Маскирование работает на регулярных выражениях, поэтому это защитная сетка, а не гарантия. Отключается через `PII_MASKING=false`.

**Кэширование.** Системный промпт и текст договора помечены `cache_control`. Повтор после обрезанного ответа и будущий чат по документу читают договор из кэша.
