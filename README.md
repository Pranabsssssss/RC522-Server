# RFID RC522 Real-time Relay Server

A high-performance, **zero-latency**, **zero-persistence** relay server connecting an **ESP8266 NodeMCU + RC522 RFID reader** (`/host`) to listening applications/devices (`/node`) via 2-way WebSockets.

---

## 🏗️ Architecture & Data Flow

```text
 ┌──────────────────────┐                     ┌─────────────────────────┐
 │ ESP8266 + RC522 RFID │                     │  Listening Node / App   │
 │   Wi-Fi + mDNS       │                     │  (CLI / Browser / DB)   │
 └──────────┬───────────┘                     └────────────▲────────────┘
            │                                              │
      WebSocket /host                               WebSocket /node
       (with auth)                                    (with auth)
            │                                              │
            ▼                                              │
  ┌────────────────────────────────────────────────────────┴────────────┐
  │                   RFID RC522 Relay Server                           │
  │                  (Node.js & Cloudflare Pages)                       │
  │                                                                     │
  │  • Card scanned -> Sent to /host                                    │
  │  • Zero-Storage: In-memory routing only (never stored to DB/disk)   │
  │  • If NO nodes connected: RFID key is immediately dropped           │
  │  • If nodes connected: Broadcast live to all nodes (0-latency)     │
  │  • 2-way communication: Nodes can send commands back to NodeMCU     │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Features

- **Live 2-Way 0-Latency Transfer**: Uses WebSockets (`/host` and `/node`) for instant bidirectional communication.
- **Zero-Storage / Zero-Persistence**: The server does NOT store any RFID keys to disk, database, or persistent state.
- **Auto-Drop Policy**: If no listening nodes are connected when a card is scanned, the RFID key is immediately dropped.
- **Authorization Protected**: All `/host` and `/node` connections require the secret authorization password configured in `.env`.
- **Cloudflare Pages & Node.js Ready**:
  - Run as a standalone Node.js server (`server.js`).
  - Deployable on Cloudflare Pages via GitHub repository (`functions/host.js`, `functions/node.js`, `public/index.html`).
- **Interactive Web Dashboard**: `public/index.html` provides a web-based listener node with real-time card logs and audible chimes.
- **NodeMCU Firmware Included**: Complete Arduino sketch (`nodemcu/nodemcu_rfid.ino`) configured for `Excitel_Saini's 4G` Wi-Fi, mDNS (`rfid-nodemcu.local`), and RC522 SPI.

---

## 🔒 Security & Environment Variables

Create `.env` (ignored in `.gitignore`):
```env
PORT=3000
HOST=0.0.0.0
AUTH_PASSWORD=00000000
```

> [!IMPORTANT]
> The authorization password is used by NodeMCU, nodes, and web clients. It is kept in `.env` only on this PC and ignored by git.

---

## 💻 Running Locally

### 1. Start the Relay Server
```bash
npm install
npm start
```
The server will start at:
- Web Dashboard: `http://localhost:3000`
- Host Endpoint: `ws://localhost:3000/host?auth=00000000`
- Node Endpoint: `ws://localhost:3000/node?auth=00000000`

### 2. Connect a Node Listener
Run the dedicated node client:
```bash
# Connect to local server
node test/node-client.js --local

# Or connect to production domain
node test/node-client.js --host rfid.pranab.space --auth 00000000
```

---

## 📡 ESP8266 NodeMCU RC522 Setup

Open `nodemcu/nodemcu_rfid.ino` in Arduino IDE.

### RC522 Pin Wiring (NodeMCU ESP8266)
> [!CAUTION]
> RC522 is **3.3V logic**. Connect VCC to **3V3**, NOT to 5V (Vin)!

| RC522 Pin | NodeMCU Pin | GPIO | Description |
|-----------|-------------|------|-------------|
| **SDA (SS)** | **D8** | GPIO15 | SPI Chip Select |
| **SCK** | **D5** | GPIO14 | SPI Clock |
| **MOSI** | **D7** | GPIO13 | Master Out Slave In |
| **MISO** | **D6** | GPIO12 | Master In Slave Out |
| **RST** | **D3** | GPIO0 | Reset |
| **GND** | **GND** | GND | Ground |
| **3.3V** | **3V3** | 3.3V | Power Supply (3.3V ONLY) |

Pre-configured Wi-Fi:
- **SSID**: `Excitel_Saini's 4G`
- **Password**: `00000000`
- **Target**: `rfid.pranab.space`

---

## ☁️ Cloudflare Pages Deployment

When pushed to the GitHub repository:
- Cloudflare Pages will automatically deploy the repository.
- `public/` is served as the static web app.
- `functions/host.js` and `functions/node.js` handle Edge WebSocket & HTTP routing.
- Set `AUTH_PASSWORD` in Cloudflare Pages Dashboard -> Settings -> Environment Variables.
