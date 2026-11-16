# RFID RC522 Real-time Relay Server & AI Agent API

A high-performance, **zero-latency**, **zero-persistence** relay server connecting an **ESP8266 / ESP32 NodeMCU + RC522 RFID reader** (`/host`) to listening applications, dashboards, and **autonomous AI agents** (`/node`).

All scanned RFID keys are deterministically encrypted into an exact **20-character discriminant key** using `AUTH_PASSWORD` on the server before distribution.

---

## 🤖 AI Agent Integration Guide

AI agents can directly integrate with the RFID Relay API as an event listener or tool. The API requires zero complex SDKs—it works over standard HTTP headers and JSON.

### 1. Authentication Headers

Provide the secret authorization password in any of the following standard HTTP headers:

| Header | Example | Description |
|---|---|---|
| `x-auth-token` | `00000000` | Recommended custom header |
| `Authorization` | `Bearer 00000000` | Standard Bearer token format |
| `x-auth-password` | `00000000` | Alternative custom header |

*(Query parameter `?auth=00000000` is also supported).*

---

### 2. Receiving RFID Keys (`/node`)

#### Method A: Long-Polling HTTP Tool (Recommended for AI Agents)
The AI agent sends a request that holds open until a physical card is tapped on the reader, then immediately resolves with the encrypted key.

- **Endpoint**: `GET https://rfid.pranab.space/node?wait=true`
- **Headers**:
  ```http
  x-auth-token: 00000000
  ```

**cURL Command**:
```bash
curl -s -H "x-auth-token: 00000000" "https://rfid.pranab.space/node?wait=true"
```

**JSON Response When Card Is Scanned**:
```json
{
  "type": "rfid",
  "encryptedKey": "325B385EFEA00E8F107A",
  "discriminant": "325B385EFEA00E8F107A",
  "uid": "325B385EFEA00E8F107A",
  "length": 20,
  "timestamp": 1794866627088,
  "timeISO": "2026-11-16T22:03:47.088Z"
}
```

*If no card is tapped within 25 seconds, it returns a timeout status: `{"status": "timeout"}`. The agent simply calls the endpoint again to continue waiting.*

---

#### Method B: Real-Time WebSocket (0-Latency Streaming)
For continuous, event-driven agents:

- **Endpoint**: `wss://rfid.pranab.space/node?auth=00000000`
- **Initial Welcome Message**:
  ```json
  {
    "type": "welcome",
    "role": "node",
    "message": "Connected as live listening node (0 latency)",
    "hostsActive": 1
  }
  ```
- **Incoming Scan Event**:
  ```json
  {
    "type": "rfid",
    "encryptedKey": "325B385EFEA00E8F107A",
    "discriminant": "325B385EFEA00E8F107A",
    "uid": "325B385EFEA00E8F107A",
    "length": 20,
    "timestamp": 1794866627088,
    "timeISO": "2026-11-16T22:03:47.088Z"
  }
  ```

---

### 3. Sending 2-Way Commands Back to the Hardware Reader

An AI agent can trigger hardware actions (e.g. unlock door, flash LED, beep buzzer) by posting back to `/node`:

- **Endpoint**: `POST https://rfid.pranab.space/node`
- **Headers**:
  ```http
  Content-Type: application/json
  x-auth-token: 00000000
  ```
- **Payload**:
  ```json
  {
    "command": "flash",
    "action": "access_granted",
    "cardKey": "325B385EFEA00E8F107A",
    "message": "Welcome User"
  }
  ```

---

### 4. Agent Tool Implementation Examples

#### Python Tool Function (for LangChain, LlamaIndex, or AutoGen)
```python
import requests

def wait_for_rfid_scan(server_url="https://rfid.pranab.space", auth_token="00000000", max_attempts=5):
    """
    Waits for a physical RFID card to be tapped on the RC522 reader.
    Returns the 20-character encrypted RFID key.
    """
    headers = {
        "x-auth-token": auth_token,
        "Accept": "application/json"
    }
    
    for _ in range(max_attempts):
        try:
            response = requests.get(f"{server_url}/node?wait=true", headers=headers, timeout=30)
            if response.status_code == 200:
                data = response.json()
                if data.get("type") == "rfid" and "encryptedKey" in data:
                    return data["encryptedKey"]
        except requests.exceptions.RequestException:
            continue
            
    return None
```

#### Node.js Tool Function
```javascript
async function waitForRfidScan(serverUrl = 'https://rfid.pranab.space', authToken = '00000000') {
  const response = await fetch(`${serverUrl}/node?wait=true`, {
    headers: {
      'x-auth-token': authToken
    }
  });
  
  const data = await response.json();
  if (data && data.type === 'rfid' && data.encryptedKey) {
    return data.encryptedKey;
  }
  return null;
}
```

---

## 🏗️ System Architecture

```text
  ┌──────────────────────────────┐              ┌─────────────────────────────┐
  │   ESP8266 / ESP32 + RC522    │              │       AI Agent / Node       │
  │    (Hardware RFID Reader)    │              │   (Tool / CLI / Browser)    │
  └──────────────┬───────────────┘              └──────────────▲──────────────┘
                 │                                             │
           /host │ (WSS / HTTP)                          /node │ (WSS / HTTP ?wait=true)
                 │                                             │
                 ▼                                             │
  ┌────────────────────────────────────────────────────────────┴──────────────┐
  │                     RFID RC522 Relay Server                               │
  │                   (Cloudflare Worker + Node.js)                           │
  │                                                                           │
  │ • Validates RFID key format                                               │
  │ • Server encrypts key into exact 20-char discriminant string              │
  │ • Zero-Persistence: In-memory live routing only (never stored to DB/disk) │
  │ • Auto-Drop: If no agent/node is connected, scan is immediately dropped    │
  │ • Bidirectional: Nodes & AI agents can send commands back to hardware     │
  └───────────────────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Hardware Setup (ESP8266 & ESP32 Dual Support)

The firmware in [`nodemcu/nodemcu.ino`](file:///f:/PROJECTS/RC522%20Server/nodemcu/nodemcu.ino) automatically detects whether you compile for ESP8266 or ESP32.

### Pinout Connections

> [!CAUTION]
> RC522 is **3.3V logic**. Connect VCC to **3V3**, NOT to 5V (Vin)!

| RC522 Pin | ESP8266 (NodeMCU) | ESP32 (DevKit V1) | Description |
|---|---|---|---|
| **SDA (SS)** | **D8** (GPIO 15) | **GPIO 5** (VSPI SS) | SPI Chip Select |
| **SCK** | **D5** (GPIO 14) | **GPIO 18** (VSPI SCK) | SPI Clock |
| **MOSI** | **D7** (GPIO 13) | **GPIO 23** (VSPI MOSI) | Master Out Slave In |
| **MISO** | **D6** (GPIO 12) | **GPIO 19** (VSPI MISO) | Master In Slave Out |
| **RST** | **D3** (GPIO 0) | **GPIO 22** | Reset |
| **GND** | **GND** | **GND** | Ground |
| **3.3V** | **3V3** | **3V3** | Power (3.3V ONLY) |

---

## 💻 Running & Testing

### 1. Test Node Client CLI
```bash
# Connect to production relay
node test/node-client.js

# Or connect to local server
node test/node-client.js --local
```

### 2. Run Local Relay Server
```bash
npm install
npm start
```
- Web Dashboard: `http://localhost:3000`
- API Health Status: `http://localhost:3000/health?auth=00000000`
