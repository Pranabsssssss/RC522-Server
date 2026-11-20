# RC522 Relay Server

RC522 Relay Server is a self-hostable event hub for RC522 RFID readers on ESP8266 and ESP32 boards. Readers publish card scans through WebSocket or HTTP, and applications receive the event through WebSocket, server-sent events, or HTTP long polling. The server can also relay commands back to connected readers.

It is suitable for access-control demos, attendance systems, inventory tracking, kiosk experiences, automation, and other RFID projects.

## Features

- ESP8266 and ESP32 firmware for NodeMCU-class boards
- RC522 reader support
- WebSocket and HTTP scan ingestion
- WebSocket, SSE, and HTTP long-polling listeners
- Bidirectional node-to-reader commands
- Deterministic 20-character HMAC-SHA256 RFID discriminants
- In-memory routing with no database or log persistence
- Optional Cloudflare Worker and Durable Object deployment
- Browser dashboard and reusable Node.js listener

## How It Works

```text
RC522 + ESP8266 or ESP32 -> /host -> Relay Server -> /node
                                      |
                                      +-> WebSocket
                                      +-> Server-Sent Events
                                      +-> HTTP long polling
                                      +-> Browser dashboard
```

The physical UID is never written to the relay server's database because no database is used. In connected mode, the server derives a fixed 20-character discriminant with HMAC-SHA256 and forwards that value to nodes. Raw UID handling remains available in host acknowledgements and HTTP responses for integrations that need it.

If no listener is connected, an incoming scan is discarded.

## Requirements

- Node.js 18 or newer
- An ESP8266 or ESP32
- An RC522 RFID module
- Optional: Cloudflare account and Wrangler

## Local Setup

```bash
npm install
cp .env.example .env
```

Set `.env` to a private, randomly generated secret:

```dotenv
PORT=3000
HOST=0.0.0.0
AUTH_PASSWORD=replace-with-a-long-random-secret
```

Generate a strong secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Start the server:

```bash
npm start
```

Open `http://localhost:3000`, then enter the same authorization password configured in `.env`.

## Environment and Git Safety

The server reads `PORT`, `HOST`, and `AUTH_PASSWORD` from `.env` through `dotenv`.

This repository deliberately does not ignore `.env` in `.gitignore`. That makes accidental secret commits more likely, so keep `.env` private and never add real credentials to source control. `.env.example` contains placeholders only.

Before publishing, scan tracked files:

```bash
git grep -n -I -E '(AUTH_PASSWORD|WIFI_PASSWORD|SECRET|TOKEN)'
git add -A
git diff --cached
```

Use secret scanning in CI or a repository hosting provider before every public release.

## Authentication

Every protected endpoint accepts one of these forms:

```text
x-auth-token: your-secret
x-auth-password: your-secret
Authorization: Bearer your-secret
Authorization: your-secret
?auth=your-secret
```

Use headers instead of query parameters when possible. Query parameters may appear in proxy logs.

## API

### Health

```http
GET /health
```

Health is intentionally unauthenticated.

### Publish with HTTP

```bash
curl -X POST "http://localhost:3000/host" \
  -H "x-auth-token: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"uid":"04:A1:22:7B"}'
```

Valid UID formats include colon-separated, dash-separated, or contiguous hexadecimal values:

```text
04:A1:22:7B
04A1227B
04-12-34-56-78-9A-BC
```

### Listen with HTTP Long Polling

```bash
curl "http://localhost:3000/node?wait=true" \
  -H "x-auth-token: your-secret"
```

The request waits up to 25 seconds. If no card is scanned, it returns `{"status":"timeout","message":"No card scanned, re-poll"}`.

### Listen with WebSocket

```text
ws://localhost:3000/node?auth=your-secret
```

The first event is a welcome message. Scan events use this shape:

```json
{
  "type": "rfid",
  "discriminant": "A1B2C3D4E5F60718293A",
  "encryptedKey": "A1B2C3D4E5F60718293A",
  "uid": "A1B2C3D4E5F60718293A",
  "length": 20,
  "timestamp": 1794866627088,
  "timeISO": "2026-11-16T22:03:47.088Z"
}
```

### Listen with Server-Sent Events

Cloudflare mode supports:

```text
GET /node?stream=true
```

### Send a Command to Readers

```bash
curl -X POST "http://localhost:3000/node" \
  -H "x-auth-token: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"command":"flash","action":"access_granted","message":"Welcome"}'
```

Or send JSON over `ws://localhost:3000/node?auth=your-secret`.

## Firmware Setup

Open `nodemcu/nodemcu.ino` in Arduino IDE and set:

```cpp
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_HOST   = "relay.example.com";
const char* AUTH_PASSWORD = "YOUR_RFID_SERVER_AUTH_PASSWORD";
```

Use a production server hostname and HTTPS for deployed use. Do not commit real firmware credentials. The Arduino environment is single-board firmware, so credentials are stored in the sketch rather than `.env`. Add a private copy of the sketch or build-time secrets to your workflow if you need them excluded from source control.

Complete wiring and library instructions are in [nodemcu/README.md](nodemcu/README.md).

## Node.js Listener

```bash
cp .env.example .env
npm start
node test/node-client.js --local
```

Connect to a remote deployment:

```bash
node test/node-client.js --host relay.example.com --auth your-secret
```

You can instead set `AUTH_PASSWORD` in `.env` and omit `--auth`.

## Cloudflare Deployment

`worker.js` and `wrangler.jsonc` provide a Durable Object-backed deployment.

1. Install dependencies.
2. Run `npx wrangler login`.
3. Create the secret:

```bash
npx wrangler secret put AUTH_PASSWORD
```

4. Deploy:

```bash
npm run deploy
```

No domain or zone route is committed. Add routes to your own Cloudflare worker settings or configure `routes` locally when deploying.

## Security

- Generate and keep `AUTH_PASSWORD` secret.
- Use HTTPS and WSS in production.
- Restrict network exposure and add rate limiting if the relay faces the public internet.
- Treat the HMAC discriminant as an identifier, not an irreversible proof.
- Rotate `AUTH_PASSWORD` if it is exposed; all derived discriminants change after rotation.
- Encrypt transport and restrict command permissions.
- Do not use this example alone for safety-critical physical access control.

## Testing

With the server running:

```bash
npm test
```

The test listener expects `.env` and a local server on port 3000.

## Contributing

Contributions are welcome. Keep changes small, avoid personal configuration, and do not introduce secrets or dependencies that require data collection.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
