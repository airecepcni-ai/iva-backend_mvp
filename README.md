# IVA Backend

Backend server pro indexaci webových stránek a vyhledávání v znalostní bázi.

## Instalace

```bash
cd iva-backend
npm install
```

## Konfigurace

1. Zkopírujte `.env` a nastavte hodnoty:
   - `SUPABASE_URL` - URL vašeho Supabase projektu
   - `SUPABASE_SERVICE_ROLE` - Service Role klíč z Supabase Dashboard
   - `PORT` - Port pro server (výchozí: 8787)
   - `OPENAI_API_KEY` - OpenAI API klíč
   - `OPENAI_CHAT_MODEL` - Model pro chat (výchozí: gpt-4o-mini)
   - `GOOGLE_CLIENT_ID` - Google OAuth Client ID
   - `GOOGLE_CLIENT_SECRET` - Google OAuth Client Secret
   - `GOOGLE_REFRESH_TOKEN` - Google OAuth Refresh Token
   - `GOOGLE_CALENDAR_ID` - ID Google Calendar (např. email adresa)
   - `DEFAULT_BUSINESS_ID` - Default business ID for IVA chat/phone calls
   - `VAPI_ASSISTANT_ID` - Vapi assistant ID (defaults to dev assistant if not set)

## Spuštění

```bash
npm run dev
```

Server poběží na `http://localhost:8787`

## API Endpointy

## Vapi debug endpoint (temporary)

This endpoint helps debug what Vapi sends and what tenant/business gets resolved.

- Mounted at **both**: `POST /api/vapi/_debug` and `POST /vapi/_debug`
- **Production safety**: when `NODE_ENV=production`, requires `VAPI_DEBUG_TOKEN` via `x-debug-token` header or `Authorization: Bearer <token>`.

Example (through Vercel proxy):

```bash
## PowerShell (Windows) - recommended (avoids quote-stripping)
$token = "<token>"
$body = '{"hello":"world"}'
$body | curl.exe --ssl-no-revoke -i "https://ivaai.cz/api/vapi/_debug" `
  -X POST `
  -H "Content-Type: application/json" `
  -H "x-debug-token: $token" `
  --data-binary "@-"

## Bash (Linux/macOS)
curl -i "https://ivaai.cz/api/vapi/_debug" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-debug-token: <token>" \
  --data-raw '{"hello":"world"}'
```

### Regression sample: inbound vs caller number (tenant resolution)

When Vapi provides both the business inbound number and the caller/customer number, tenant resolution **must prefer the inbound business number** (the number that was called).

Minimal sample payload:

```json
{
  "message": {
    "type": "conversation-update",
    "call": {
      "phoneNumber": { "number": "+420910928116" },
      "customer": { "number": "+420777228540" }
    }
  }
}
```

Expected tenant resolution: use **`+420910928116`** (from `message.call.phoneNumber.number`), not the caller `+420777228540`.

### Manual test: Vapi conversation-update user speech in `message.messages`

Some Vapi payloads include user speech under `message.messages[].content[].text`. This **must** be treated as the user utterance (and must not incorrectly fall back to “Promiňte, neslyšel jsem vás...”).

Sample payload:

```json
{
  "message": {
    "type": "conversation-update",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "Dobrý den..." }
        ]
      }
    ],
    "call": { "phoneNumber": { "number": "+420910928116" } }
  }
}
```

Expected behavior: the webhook response should be something other than **“Promiňte, neslyšel jsem vás...”** (i.e., IVA should react to `Dobrý den...`).

Curl example using `iva-backend/vapi.json`:

```bash
## PowerShell (Windows)
Get-Content .\\vapi.json | curl.exe --ssl-no-revoke -i "http://localhost:8787/vapi/webhook" `
  -X POST `
  -H "Content-Type: application/json" `
  --data-binary "@-"
```

### `POST /api/ingest`
Indexace webu nebo PDF souborů.

**Request:**
```json
{
  "tenantId": "uuid-business-id",
  "website": "https://example.com",
  "pdfUrls": [],
  "config": {
    "max_depth": 2,
    "max_pages": 30,
    "exclude_paths": [],
    "exclude_selectors": [],
    "respect_robots": true
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Indexace dokončena",
  "chunksCreated": 123,
  "website": {
    "sourceId": "...",
    "pageId": "...",
    "chunks": 123
  }
}
```

### `POST /api/kb_search`
Vyhledávání v znalostní bázi.

**Request:**
```json
{
  "tenantId": "uuid-business-id",
  "query": "Kolik stojí pánský střih?",
  "topK": 5
}
```

**Response:**
```json
[
  {
    "title": "Ceník",
    "text": "...",
    "source_url": "https://example.com/cenik",
    "score": 0.8
  }
]
```

### `DELETE /api/kb_sources`
Smazání zdroje a jeho chunků.

**Request:**
```json
{
  "tenantId": "uuid-business-id",
  "sourceUrl": "https://example.com/page"
}
```

### `POST /api/reindex`
Re-indexace všech zdrojů tenanta.

**Request:**
```json
{
  "tenantId": "uuid-business-id"
}
```

## Railway Deployment

Pro nasazení na Railway je potřeba nastavit tyto proměnné prostředí:

### Povinné
- `PLAYWRIGHT_BROWSERS_PATH=0` - Nutné pro správné fungování Playwright v kontejneru

### Volitelné
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` - NESMÍ být nastaveno na `true`
- `DEBUG_CRAWL=true` - Zapne podrobné logování crawleru
- `DEBUG_SUBSCRIPTION=true` - Zapne logování subscription stavu

### Automatická instalace
`nixpacks.toml` zajišťuje automatickou instalaci Chromium browseru při buildu.
Pokud crawl selhává s "Executable doesn't exist", zkontrolujte:
1. Zda `PLAYWRIGHT_BROWSERS_PATH=0` je nastaveno
2. Zda postinstall script proběhl úspěšně v build logu

## Poznámky

- Backend používá Service Role klíč pro přístup k Supabase
- Text je rozdělen na chunky ~900 znaků s overlap 150 znaků
- Pro produkci doporučujeme přidat autentizaci a rate limiting
- Playwright Chromium se instaluje automaticky při `npm install` (postinstall hook)



