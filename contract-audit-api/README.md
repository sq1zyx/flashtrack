# contract-audit-api

Загрузка договора → извлечение текста или OCR → разбивка на части (если нужно) → аудит в Claude → проверенный JSON.

## Установка и запуск

Нужен Node.js 20+. Системные пакеты не нужны: у `sharp` и `@napi-rs/canvas` готовые бинарники, а `tesseract.js` работает на WebAssembly.

```bash
npm install @anthropic-ai/sdk express multer mammoth pdf-parse tesseract.js sharp file-type zod node-html-parser dotenv
npm install -D typescript tsx vitest @types/express @types/multer @types/node
# или, в этом каталоге, просто: npm install

cp .env.example .env   # впишите ANTHROPIC_API_KEY
npm run dev            # http://localhost:3000
npm test               # 15 тестов, Claude не вызывается
```

При первом OCR `tesseract.js` скачивает языковые модели `rus` и `eng` (~30 МБ) в `.ocr-cache/`. Если у сервера нет интернета, положите файлы `*.traineddata` в каталог и укажите его в `OCR_LANG_PATH`.

## API

### `POST /api/audit` (multipart/form-data)

| Поле | | |
|---|---|---|
| `file` | обязательно | PDF, DOCX, JPG, PNG, WEBP, TIFF, TXT; до 20 МБ |
| `client_party` | обязательно | чью сторону защищаем: «Арендатор», «Покупатель», … |
| `jurisdiction` | | по умолчанию «Российская Федерация» |
| `deep` | | `true`: больше effort (дороже и медленнее) |
| `include_text` | | `true`: вернуть абзацы с ID, чтобы подсветить `clause_refs` в UI |

```bash
curl -F file=@contract.pdf -F client_party=Арендатор http://localhost:3000/api/audit
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
| 413 | `file_too_large`, `too_many_pages`, `too_many_scanned_pages` | превышены лимиты |
| 415 | `unsupported_type`, `legacy_doc`, `heic_unsupported` | формат не поддерживается |
| 422 | `pdf_corrupted`, `pdf_encrypted`, `docx_corrupted`, `image_corrupted`, `file_corrupted`, `no_text`, `ocr_failed`, `llm_refused` | файл не читается или в нём нет текста |
| 502 | `llm_invalid_output`, `llm_error` | Claude вернул некорректный ответ даже после повтора |
| 503 / 504 | `llm_unavailable`, `llm_rate_limited`, `llm_timeout`, `ocr_unavailable` | временная недоступность; SDK уже сделал 3 повтора с паузами |
| 500 | `llm_misconfigured` | нет или неверный `ANTHROPIC_API_KEY` |

## Как устроено

```
src/
  server.ts          Express: маршруты, лимиты загрузки, обработчик ошибок
  pipeline.ts        файл → извлечение → нормализация
  extract/
    index.ts         тип файла определяется по сигнатуре (file-type), а не по расширению
    pdf.ts           pdf-parse: текстовый слой; страницы без текста рендерятся и уходят в OCR
    docx.ts          mammoth → HTML → текст с восстановленной автонумерацией Word (1.1., 2.3.)
    ocr.ts           sharp (поворот, ч/б, контраст, увеличение) + tesseract.js rus+eng
  text/
    normalize.ts     колонтитулы, номера страниц, переносы, склейка строк PDF, ID абзацев [P-001]
    chunk.ts         разбивка по разделам договора, общий контекст (преамбула + термины) и оглавление
  llm/
    prompts.ts       системный промпт аудита + промпты map/reduce
    schema.ts        zod-схема ответа (уходит в API как structured output)
    call.ts          вызов Claude: стриминг, кэш промпта, fallback, повтор, учёт стоимости
    audit.ts         один проход или map-reduce
    verify.ts        сверка цитат с текстом, отбрасывание несуществующих clause_refs
```

**Разбивка на части.** Договор до `SINGLE_PASS_MAX_TOKENS` токенов (по умолчанию 150k, это примерно 200 страниц; токены считает `count_tokens`) анализируется одним запросом, так модель видит все перекрёстные ссылки. Более длинный документ режется по границам разделов на части по ~40k токенов. Раздел, который не помещается в одну часть, делится по абзацам с перекрытием в 2 абзаца, так что отдельный пункт никогда не разрезается. Каждая часть получает одинаковый общий префикс (преамбула, раздел терминов, оглавление с диапазонами абзацев): он кэшируется, и поэтому части 2…N платят за него около 10% цены. Затем отдельный вызов сводит находки всех частей в одно заключение.

**Кэширование.** Системный промпт и текст договора помечены `cache_control`. Повтор после обрезанного ответа и будущий чат по документу читают договор из кэша.
