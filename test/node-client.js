

require('dotenv').config();
const { WebSocket } = require('ws');
const http = require('http');
const https = require('https');
const readline = require('readline');

const args = process.argv.slice(2);
const isLocal = args.includes('--local');
let customHost = null;
let customAuth = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--host' && args[i + 1]) customHost = args[i + 1];
  if (args[i] === '--auth' && args[i + 1]) customAuth = args[i + 1];
}

const AUTH_PASSWORD = customAuth || process.env.AUTH_PASSWORD;
const DEFAULT_HOST = isLocal ? 'localhost:3000' : 'localhost:3000';
if (!AUTH_PASSWORD) {
  console.error('AUTH_PASSWORD is required. Set it in .env or pass --auth.');
  process.exit(1);
}
const TARGET_HOST = customHost || DEFAULT_HOST;
const isHttps = !TARGET_HOST.includes('localhost') && !TARGET_HOST.includes('127.0.0.1');
const PROTOCOL = isHttps ? 'wss' : 'ws';
const HTTP_PROTOCOL = isHttps ? 'https' : 'http';
const WS_URL = `${PROTOCOL}://${TARGET_HOST}/node?auth=${encodeURIComponent(AUTH_PASSWORD)}`;

let ws = null;
let scansReceived = 0;
let isPolling = false;

console.clear();
console.log('====================================================');
console.log('       RFID RC522 LIVE LISTENER NODE CLIENT        ');
console.log('====================================================');
console.log(` Target Server : ${HTTP_PROTOCOL}://${TARGET_HOST}/node`);
console.log(` Auth Key      : ${AUTH_PASSWORD.replace(/./g, '*')}`);
console.log(` Mode          : Dual Stream (WebSocket + JSON API)`);
console.log('====================================================');
console.log(' Type any command + Enter to send 2-way instruction to NodeMCU');
console.log(' Press Ctrl+C to exit\n');

function connectWs() {
  console.log(`[CONNECTING] Connecting via WebSocket to ${WS_URL}...`);

  try {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
      console.log('\x1b[32m[CONNECTED]\x1b[0m Connected as active node via WebSocket.\n');
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'welcome') {
          console.log(`\x1b[36m[SERVER WELCOME]\x1b[0m ${msg.message}`);
          console.log(`[HOSTS ACTIVE] ${msg.hostsActive || 0} ESP reader(s) currently online.\n`);
          return;
        }

        if (msg.type === 'rfid' && (msg.uid || msg.encryptedKey)) {
          displayRfidScan(msg);
          return;
        }

        console.log(`[RECV]`, msg);
      } catch {
        console.log(`[RAW RECV] ${data.toString()}`);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`\x1b[33m[WS CLOSED]\x1b[0m Code: ${code}. Switching to Live HTTP JSON API polling...\n`);
      ws = null;
      startHttpPolling();
    });

    ws.on('error', (err) => {
      console.warn(`\x1b[33m[WS ERROR]\x1b[0m ${err.message}. Activating HTTP JSON API...\n`);
      if (ws) {
        ws.close();
        ws = null;
      }
      startHttpPolling();
    });
  } catch (e) {
    startHttpPolling();
  }
}

async function startHttpPolling() {
  if (isPolling) return;
  isPolling = true;
  console.log('\x1b[32m[CONNECTED]\x1b[0m Connected via Live HTTP JSON API. Listening for RFID cards...\n');

  while (isPolling) {
    try {
      const url = `${HTTP_PROTOCOL}://${TARGET_HOST}/node?auth=${encodeURIComponent(AUTH_PASSWORD)}&wait=true`;
      const data = await fetchJson(url);

      if (data && data.error) {
        console.error(`\x1b[31m[AUTH ERROR]\x1b[0m ${data.error}`);
        isPolling = false;
        break;
      }

      if (data && data.type === 'rfid' && (data.uid || data.encryptedKey)) {
        displayRfidScan(data);
      }
    } catch (err) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

function fetchJson(urlStr) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(urlStr, { timeout: 30000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ raw: body });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'timeout' });
    });
  });
}

function displayRfidScan(data) {
  scansReceived++;
  const now = new Date();
  const encKey = data.encryptedKey || data.discriminant || data.uid;
  const rawUid = data.rawUid || 'N/A';
  const latency = data.timestamp ? `${Math.max(0, Date.now() - data.timestamp)}ms` : 'instant';

  process.stdout.write('\x07');

  console.log('┌────────────────────────────────────────────────────────┐');
  console.log(`│ \x1b[33m⚡ RFID CARD SCANNED\x1b[0m (#${scansReceived})                           │`);
  console.log(`│   Encrypted Key: \x1b[32m\x1b[1m${encKey.padEnd(20)}\x1b[0m            │`);
  console.log(`│   Raw Card UID : \x1b[36m${rawUid.padEnd(20)}\x1b[0m            │`);
  console.log(`│   Time         : ${now.toLocaleTimeString().padEnd(20)}            │`);
  console.log(`│   Stream Lat   : ${latency.padEnd(20)}            │`);
  console.log('└────────────────────────────────────────────────────────┘\n');
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  console.log(`[SENDING 2-WAY COMMAND] "${trimmed}"...`);

  try {
    const postUrl = `${HTTP_PROTOCOL}://${TARGET_HOST}/node?auth=${encodeURIComponent(AUTH_PASSWORD)}`;
    const parsed = new URL(postUrl);
    const lib = parsed.protocol === 'https:' ? https : http;

    const postData = JSON.stringify({ command: trimmed, from: 'node-cli', time: Date.now() });
    const req = lib.request(postUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        console.log(`\x1b[34m[COMMAND RESPONSE]\x1b[0m ${b}\n`);
      });
    });

    req.on('error', (e) => console.error('Send error:', e.message));
    req.write(postData);
    req.end();
  } catch (err) {
    console.error('Command failed:', err.message);
  }
});

connectWs();
