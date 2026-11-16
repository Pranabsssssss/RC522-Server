# NodeMCU ESP8266 + RC522 RFID Live Client

This sketch enables your ESP8266 NodeMCU with an RC522 RFID reader to stream RFID card scans with **0-latency** to `rfid.pranab.space/host`.

---

## 1. Hardware Pin Connections (SPI)

> [!CAUTION]
> The RC522 RFID module operates on **3.3V logic**. Connecting RC522 VCC to 5V (Vin) will permanently damage the module. Always connect VCC to the **3V3** pin of NodeMCU.

| RC522 Pin | NodeMCU Pin | ESP8266 GPIO | Description |
|-----------|-------------|--------------|-------------|
| **SDA (SS)** | **D8** | GPIO15 | SPI Slave Select |
| **SCK** | **D5** | GPIO14 | SPI Clock |
| **MOSI** | **D7** | GPIO13 | SPI Master Out Slave In |
| **MISO** | **D6** | GPIO12 | SPI Master In Slave Out |
| **IRQ** | *Unconnected* | - | Interrupt (Not required) |
| **GND** | **GND** | GND | Ground |
| **RST** | **D3** | GPIO0 | Reset pin |
| **3.3V** | **3V3** | 3.3V | Power Supply (3.3V ONLY) |

---

## 2. Arduino IDE Setup

1. **Install ESP8266 Board Package**:
   - Go to `File` > `Preferences`.
   - Add this URL to **Additional Boards Manager URLs**:
     `http://arduino.esp8266.com/stable/package_esp8266com_index.json`
   - Open `Tools` > `Board` > `Boards Manager...`, search for `esp8266` and click **Install**.

2. **Install Required Libraries**:
   - Open `Sketch` > `Include Library` > `Manage Libraries...`
   - Search and install:
     - **MFRC522** (by GithubCommunity)
     - **WebSockets** (by Markus Sattler)

3. **Select Board & Settings**:
   - Board: `NodeMCU 1.0 (ESP-12E Module)`
   - Upload Speed: `115200` or `921600`
   - CPU Frequency: `80 MHz` (or `160 MHz`)
   - Flash Size: `4MB (FS:2MB OTA:~1019KB)`
   - Port: Select your COM port

---

## 3. Wi-Fi & Server Settings (Pre-configured)

The sketch is pre-configured with:
- **SSID**: `Excitel_Saini's 4G`
- **Wi-Fi Password**: `00000000`
- **Relay Server**: `rfid.pranab.space`
- **Auth Password**: `00000000`
- **mDNS Hostname**: `rfid-nodemcu.local`

---

## 4. Flash and Monitor

1. Connect NodeMCU via micro-USB.
2. Click **Upload** in Arduino IDE.
3. Open **Serial Monitor** at **115200 baud**.
4. You will see:
   ```text
   ===========================================
    ESP8266 NodeMCU RC522 RFID Live Hub Client
   ===========================================
   [RC522] RFID Reader Initialized.
   [WiFi] Connected successfully!
   [mDNS] Responder started: http://rfid-nodemcu.local
   [WS] Connected to live relay on rfid.pranab.space
   ```
5. Scan an RFID tag/card. The onboard LED will flash, and the UID will be streamed instantly with zero latency to all connected nodes!
