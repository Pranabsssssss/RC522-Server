# ESP8266 and ESP32 RC522 Firmware

This sketch reads RC522 cards and sends their hardware UID to the relay server through WebSocket. HTTP POST is used when WebSocket is unavailable.

## Wiring

RC522 operates at 3.3V. Never connect VCC to 5V.

| RC522 | ESP8266 NodeMCU | ESP32 |
|---|---|---|
| SDA/SS | D8, GPIO15 | GPIO5 |
| SCK | D5, GPIO14 | GPIO18 |
| MOSI | D7, GPIO13 | GPIO23 |
| MISO | D6, GPIO12 | GPIO19 |
| RST | D3, GPIO0 | GPIO22 |
| GND | GND | GND |
| 3.3V | 3V3 | 3V3 |

## Arduino IDE

Install the ESP8266 or ESP32 board package and these libraries:

- MFRC522
- WebSockets

Select the matching board, compile `nodemcu.ino`, and upload it.

## Configuration

Edit the placeholders in `nodemcu.ino`:

```cpp
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_HOST   = "relay.example.com";
const char* AUTH_PASSWORD = "YOUR_RFID_SERVER_AUTH_PASSWORD";
```

Set `USE_SSL` to `true` for HTTPS/WSS deployments. Set `SERVER_PORT` to the external HTTPS port, normally `443`.

These values belong in firmware because Arduino IDE does not read the Node.js `.env` file. Keep real values out of public commits and use private firmware copies or build-time secret injection when distributing builds.

Open the Serial Monitor at 115200 baud after upload. The onboard LED indicates connection and scan activity.
