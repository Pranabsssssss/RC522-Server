/**
 * RFID Live Listener Node Client
 * 
 * Connects to the RFID Relay Server at /node and streams live card scans with 0 latency.
 * Supports 2-way live communication back to host (e.g. commands/acknowledgements).
 * 
 * Usage:
 *   node test/node-client.js
 *   node test/node-client.js --local
 *   node test/node-client.js --host rfid.pranab.space --auth 00000000
 */

require('dotenv').config();
const { WebSocket } = require('ws');
const readline = require('readline');

// Parse CLI flags
const args = process.argv.slice(2);
let isLocal = args.includes('--local');
let customHost = null;
let customAuth = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--host' && args[i + 1]) customHost = args[i + 1];
  if (args[i] === '--auth' && args[i + 1]) customAuth = args[i + 1];
}

const AUTH_PASSWORD = customAuth || process.env.AUTH_PASSWORD || '00000000';
const DEFAULT_HOST = isLocal ? 'localhost:3000' : 'rfid.pranab.space';
const TARGET_HOST = customHost || DEFAULT_HOST;
const PROTOCOL = TARGET_HOST.includes('localhost') || TARGET_HOST.includes('127.0.0.1') ? 'ws' : 'wss';
const WS_URL = `${PROTOCOL}://${TARGET_HOST}/node?auth=${encodeURIComponent(AUTH_PASSWORD)}`;

let ws = null;
let reconnectTimer = null;
let scansReceived = 0;

console.clear();
console.log('====================================================');
console.log('       RFID RC522 LIVE LISTENER NODE CLIENT        ');
console.log('====================================================');
console.log(` Target Server : ${PROTOCOL}://${TARGET_HOST}/node`);
console.log(` Auth Key      : ${AUTH_PASSWORD.replace(/./g, '*')}`);
console.log(` Latency Mode  : 0-Latency Live Stream (WebSocket)`);
console.log('====================================================');
console.log(' Type any message + Enter to send 2-way command to NodeMCU');
console.log(' Press Ctrl+C to exit\n');

function connect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);

  console.log(`[CONNECTING] Connecting to ${WS_URL}...`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('\x1b[32m[CONNECTED]\x1b[0m Connected as active node. Listening for RFID scans...\n');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'welcome') {
        console.log(`\x1b[36m[SERVER WELCOME]\x1b[0m ${msg.message}`);
        console.log(`[HOSTS ACTIVE] ${msg.hostsActive || 0} ESP8266 reader(s) currently online.\n`);
        return;
      }

      if (msg.type === 'rfid' && msg.uid) {
        scansReceived++;
        const now = new Date();
        const latency = msg.timestamp ? `${Math.max(0, Date.now() - msg.timestamp)}ms` : 'instant';

        // Terminal Bell sound
        process.stdout.write('\x07');

        console.log('┌────────────────────────────────────────────────────────┐');
        console.log(`│ \x1b[33m⚡ RFID CARD SCANNED\x1b[0m (#${scansReceived})                           │`);
        console.log(`│   UID       : \x1b[32m\x1b[1m${msg.uid.padEnd(20)}\x1b[0m                 │`);
        console.log(`│   Time      : ${now.toLocaleTimeString().padEnd(20)}                 │`);
        console.log(`│   Stream Lat: ${latency.padEnd(20)}                 │`);
        console.log('└────────────────────────────────────────────────────────┘\n');
        return;
      }

      console.log(`[RECV]`, msg);
    } catch {
      console.log(`[RAW RECV] ${data.toString()}`);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`\x1b[31m[DISCONNECTED]\x1b[0m Connection closed (Code: ${code}, Reason: ${reason || 'None'}).`);
    if (code === 4401 || code === 1008 || String(reason).includes('401')) {
      console.error('\x1b[31m[AUTH ERROR]\x1b[0m Authentication failed. Please check AUTH_PASSWORD in .env');
    }
    console.log('[RETRY] Reconnecting in 3 seconds...');
    reconnectTimer = setTimeout(connect, 3000);
  });

  ws.on('error', (err) => {
    console.error(`\x1b[31m[ERROR]\x1b[0m ${err.message}`);
  });
}

// Setup interactive CLI input for 2-way data transfer back to NodeMCU
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'command',
      action: trimmed,
      from: 'node-client-cli',
      timestamp: Date.now()
    }));
    console.log(`\x1b[34m[2-WAY SENT -> NODEMCU]\x1b[0m Command: "${trimmed}"`);
  } else {
    console.log('\x1b[33m[OFFLINE]\x1b[0m Cannot send message: Node is not connected.');
  }
});

connect();
