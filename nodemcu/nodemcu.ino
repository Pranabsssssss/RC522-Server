/*
  =============================================================================
  ESP8266 / ESP32 NodeMCU + RC522 RFID 0-Latency Live Relay Client
  =============================================================================
  
  Dual Compatibility:
  - Automatically detects whether compiling for ESP8266 (NodeMCU 1.0) or ESP32!
  - Transmits full hardware UID (4-byte, 7-byte, or 10-byte) to rfid.pranab.space/host
  - Server encrypts the UID into a 20-character discriminant string before routing
  
  Pinout Mapping:
  -----------------------------------------------------------------------------
  RC522 Pin  | ESP8266 (NodeMCU) | ESP32 (DevKit V1)
  -----------------------------------------------------------------------------
  SDA (SS)   | D8 (GPIO 15)      | GPIO 5  (VSPI SS)
  SCK        | D5 (GPIO 14)      | GPIO 18 (VSPI SCK)
  MOSI       | D7 (GPIO 13)      | GPIO 23 (VSPI MOSI)
  MISO       | D6 (GPIO 12)      | GPIO 19 (VSPI MISO)
  IRQ        | (Not connected)   | (Not connected)
  GND        | GND               | GND
  RST        | D3 (GPIO 0)       | GPIO 22
  3.3V       | 3V3               | 3V3 (CRITICAL: Do NOT connect to 5V!)
  -----------------------------------------------------------------------------
  
  Required Arduino Libraries:
  1. MFRC522 by GithubCommunity
  2. WebSockets by Markus Sattler
  3. ESP8266WiFi / WiFi (included with board core)
  =============================================================================
*/

#if defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266mDNS.h>
  #include <ESP8266HTTPClient.h>
  #include <WiFiClientSecure.h>
  #define SS_PIN   D8
  #define RST_PIN  D3
  #define LED_PIN  LED_BUILTIN
  #define BOARD_TYPE "ESP8266 NodeMCU"
#elif defined(ESP32)
  #include <WiFi.h>
  #include <ESPmDNS.h>
  #include <HTTPClient.h>
  #include <WiFiClientSecure.h>
  #define SS_PIN   5
  #define RST_PIN  22
  #ifndef LED_BUILTIN
    #define LED_PIN 2
  #else
    #define LED_PIN LED_BUILTIN
  #endif
  #define BOARD_TYPE "ESP32 DevKit"
#else
  #error "This code requires either an ESP8266 or ESP32 board selected in Arduino IDE."
#endif

#include <SPI.h>
#include <MFRC522.h>
#include <WebSocketsClient.h>

// ----------------- Wi-Fi Configuration -----------------
const char* WIFI_SSID     = "Excitel_Saini's 4G";
const char* WIFI_PASSWORD = "00000000";

// ---------------- Server Configuration -----------------
const char* SERVER_HOST   = "rfid.pranab.space";
const uint16_t SERVER_PORT = 443; 
const bool USE_SSL        = true; 
const char* AUTH_PASSWORD = "00000000";

// Server endpoint path
String hostPath = String("/host?auth=") + AUTH_PASSWORD;

// ---------------- Hardware Objects ---------------------
MFRC522 mfrc522(SS_PIN, RST_PIN);
WebSocketsClient webSocket;

// State management
bool isWsConnected = false;
unsigned long lastScanTime = 0;
String lastScannedUid = "";

// ---------------- WebSocket Event Handler --------------
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      isWsConnected = false;
      Serial.println("[WS] Disconnected from server");
      break;

    case WStype_CONNECTED:
      isWsConnected = true;
      Serial.printf("[WS] Connected to live relay on %s\n", SERVER_HOST);
      // Double flash LED on connection
      digitalWrite(LED_PIN, LOW); delay(80); digitalWrite(LED_PIN, HIGH); delay(80);
      digitalWrite(LED_PIN, LOW); delay(80); digitalWrite(LED_PIN, HIGH);
      break;

    case WStype_TEXT: {
      String msg = String((char*)payload);
      Serial.printf("[WS RECV 2-WAY] %s\n", msg.c_str());
      // Momentary LED indicator when server returns ACK or 2-way node message
      digitalWrite(LED_PIN, LOW);
      delay(60);
      digitalWrite(LED_PIN, HIGH);
      break;
    }

    case WStype_BIN:
      Serial.println("[WS] Received binary data");
      break;

    case WStype_ERROR:
      Serial.println("[WS] WebSocket Error occurred");
      break;

    default:
      break;
  }
}

// ---------------- Connect to Wi-Fi ---------------------
void connectWiFi() {
  Serial.print("\n[WiFi] Connecting to: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    digitalWrite(LED_PIN, !digitalRead(LED_PIN)); // Flash LED during connect
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(LED_PIN, HIGH); // Turn off LED
    Serial.println("\n[WiFi] Connected successfully!");
    Serial.print("[WiFi] IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n[WiFi] Connection failed. Retrying in background...");
  }
}

// ---------------- Setup mDNS Responder -----------------
void setupMDNS() {
  if (MDNS.begin("rfid-nodemcu")) {
    Serial.println("[mDNS] Responder started: http://rfid-nodemcu.local");
  } else {
    Serial.println("[mDNS] Error setting up MDNS responder!");
  }
}

// ---------------- Send RFID UID ------------------------
void transmitRfid(String uid) {
  unsigned long now = millis();
  // Prevent double scans of the same card within 800ms
  if (uid == lastScannedUid && (now - lastScanTime) < 800) {
    return;
  }
  lastScanTime = now;
  lastScannedUid = uid;

  Serial.println("\n-------------------------------------------");
  Serial.printf("[RFID SCAN] Card Detected! Full UID: %s\n", uid.c_str());

  // Flash LED on card scan
  digitalWrite(LED_PIN, LOW);

  // Format JSON payload
  String payload = "{\"type\":\"rfid\",\"uid\":\"" + uid + "\",\"device\":\"" + String(BOARD_TYPE) + "\",\"timestamp\":" + String(now) + "}";

  bool transmitted = false;

  // 1. Primary: 0-Latency WebSocket
  if (isWsConnected) {
    transmitted = webSocket.sendTXT(payload);
    if (transmitted) {
      Serial.println("[WS 0-LATENCY] Full UID transmitted instantly via WebSocket");
    }
  }

  // 2. Secondary fallback: HTTP POST if WS was disconnected
  if (!transmitted) {
    Serial.println("[HTTP FALLBACK] WebSocket not ready, attempting HTTP POST...");
    if (WiFi.status() == WL_CONNECTED) {
      WiFiClientSecure clientSecure;
      WiFiClient clientInsecure;
      HTTPClient http;
      String url;

      if (USE_SSL) {
#if defined(ESP8266)
        clientSecure.setBufferSizes(512, 512); // Squeezes BearSSL into ESP8266 RAM
#endif
        clientSecure.setInsecure(); // Cloudflare SSL certificate verification
        url = String("https://") + SERVER_HOST + hostPath;
        http.begin(clientSecure, url);
      } else {
        url = String("http://") + SERVER_HOST + ":" + String(SERVER_PORT) + hostPath;
        http.begin(clientInsecure, url);
      }

      http.addHeader("Content-Type", "application/json");
      http.addHeader("x-auth-token", AUTH_PASSWORD);

      int httpCode = http.POST(payload);
      if (httpCode > 0) {
        String response = http.getString();
        Serial.printf("[HTTP] Status: %d, Response: %s\n", httpCode, response.c_str());
      } else {
        Serial.printf("[HTTP ERROR] Failed, error: %s\n", http.errorToString(httpCode).c_str());
      }
      http.end();
    }
  }

  delay(60);
  digitalWrite(LED_PIN, HIGH);
  Serial.println("-------------------------------------------");
}

// ---------------- Arduino Setup -------------------------
void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);

  Serial.begin(115200);
  delay(500);
  Serial.println("\n===========================================");
  Serial.printf(" %s RC522 RFID Live Hub Client\n", BOARD_TYPE);
  Serial.println("===========================================");

  // Initialize SPI bus for RC522
  SPI.begin();
  mfrc522.PCD_Init();
  delay(50);
  mfrc522.PCD_DumpVersionToSerial();
  Serial.println("[RC522] RFID Reader Initialized.");

  // Connect to Wi-Fi
  connectWiFi();

  // Setup mDNS
  setupMDNS();

  // Setup WebSocket Client
  Serial.printf("[WS] Initializing WebSocket client for: %s\n", SERVER_HOST);

  if (USE_SSL) {
    webSocket.beginSSL(SERVER_HOST, SERVER_PORT, hostPath.c_str());
  } else {
    webSocket.begin(SERVER_HOST, SERVER_PORT, hostPath.c_str());
  }
  
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(2000); // Auto-reconnect every 2 seconds
  webSocket.enableHeartbeat(15000, 3000, 2); // 15s ping heartbeat
}

// ---------------- Arduino Main Loop ---------------------
void loop() {
#if defined(ESP8266)
  MDNS.update();
#endif

  // Service WebSocket events
  webSocket.loop();

  // Auto-reconnect Wi-Fi if connection drops
  if (WiFi.status() != WL_CONNECTED) {
    static unsigned long lastWiFiCheck = 0;
    if (millis() - lastWiFiCheck > 5000) {
      lastWiFiCheck = millis();
      Serial.println("[WiFi] Reconnecting...");
      WiFi.reconnect();
    }
    return;
  }

  // Check for new RFID cards
  if (!mfrc522.PICC_IsNewCardPresent()) {
    return;
  }

  // Read card serial
  if (!mfrc522.PICC_ReadCardSerial()) {
    return;
  }

  // Format Full Hardware Card UID as hex string e.g. "41:CC:69:06"
  String uidString = "";
  for (byte i = 0; i < mfrc522.uid.size; i++) {
    if (mfrc522.uid.uidByte[i] < 0x10) {
      uidString += "0";
    }
    uidString += String(mfrc522.uid.uidByte[i], HEX);
    if (i < mfrc522.uid.size - 1) {
      uidString += ":";
    }
  }
  uidString.toUpperCase();

  // Transmit full UID to server
  transmitRfid(uidString);

  // Halt PICC and stop crypto to prepare for next scan
  mfrc522.PICC_HaltA();
  mfrc522.PCD_StopCrypto1();
}
