/*
  =============================================================================
  ESP8266 NodeMCU + RC522 RFID 0-Latency Live Relay Client
  =============================================================================
  
  Features:
  - Connects to Wi-Fi: "Excitel_Saini's 4G"
  - Advertises on local network via mDNS: "rfid-nodemcu.local"
  - Live 2-way data stream to rfid.pranab.space/host via WebSockets
  - Secondary HTTP POST fallback if WebSocket is momentarily reconnecting
  - 0-latency instant transmission when an RFID card/tag is scanned
  - Visual feedback on built-in LED
  
  RC522 -> NodeMCU ESP8266 SPI Pinout:
  ------------------------------------
  RC522 Pin  | NodeMCU Pin | ESP8266 GPIO
  ------------------------------------
  SDA (SS)   | D8          | GPIO15  (Note: Pull-down resistor on board)
  SCK        | D5          | GPIO14
  MOSI       | D7          | GPIO13
  MISO       | D6          | GPIO12
  IRQ        | (Not used)  | -
  GND        | GND         | GND
  RST        | D3          | GPIO0
  3.3V       | 3V3         | 3.3V    (CRITICAL: Do NOT connect to 5V!)
  ------------------------------------
  
  Required Arduino Libraries:
  1. MFRC522 by GithubCommunity (install via Arduino Library Manager)
  2. WebSockets by Markus Sattler (install via Arduino Library Manager)
  3. ESP8266WiFi & ESP8266mDNS (included in ESP8266 Board package)
  =============================================================================
*/

#include <ESP8266WiFi.h>
#include <ESP8266mDNS.h>
#include <SPI.h>
#include <MFRC522.h>
#include <WebSocketsClient.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>

// ----------------- Wi-Fi Configuration -----------------
const char* WIFI_SSID     = "Excitel_Saini's 4G";
const char* WIFI_PASSWORD = "00000000";

// ---------------- Server Configuration -----------------
// Set to "rfid.pranab.space" for Cloudflare Pages, or your PC local IP (e.g. "192.168.1.X")
const char* SERVER_HOST   = "rfid.pranab.space";

// For Cloudflare HTTPS/WSS: port 443 with USE_SSL = true
// For Local Node.js server or plain HTTP: port 3000 (or 80) with USE_SSL = false
const uint16_t SERVER_PORT = 443; 
const bool USE_SSL        = true; 
const char* AUTH_PASSWORD = "00000000";

// Server endpoint path
String hostPath = String("/host?auth=") + AUTH_PASSWORD;

// ----------------- Pin Definitions ---------------------
#define SS_PIN  D8  // GPIO 15
#define RST_PIN D3  // GPIO 0
#define LED_PIN LED_BUILTIN // D4 on most NodeMCUs

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
      // Blink LED twice on successful connection
      digitalWrite(LED_PIN, LOW); delay(100); digitalWrite(LED_PIN, HIGH); delay(100);
      digitalWrite(LED_PIN, LOW); delay(100); digitalWrite(LED_PIN, HIGH);
      break;

    case WStype_TEXT: {
      String msg = String((char*)payload);
      Serial.printf("[WS RECV 2-WAY] %s\n", msg.c_str());
      // Handle incoming command from nodes (e.g. beep, led)
      if (msg.indexOf("beep") >= 0 || msg.indexOf("flash") >= 0) {
        digitalWrite(LED_PIN, LOW);
        delay(200);
        digitalWrite(LED_PIN, HIGH);
      }
      break;
    }

    case WStype_BIN:
      Serial.println("[WS] Received binary data");
      break;

    case WStype_ERROR:
      Serial.println("[WS] Error occurred");
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
    digitalWrite(LED_PIN, !digitalRead(LED_PIN)); // Toggle LED
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(LED_PIN, HIGH); // LED off
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
    MDNS.addService("rfid", "tcp", 80);
    MDNS.addServiceTxt("rfid", "tcp", "device", "RC522-NodeMCU");
  } else {
    Serial.println("[mDNS] Error setting up MDNS responder!");
  }
}

// ---------------- Send RFID UID ------------------------
void transmitRfid(String uid) {
  unsigned long now = millis();
  // Prevent duplicate double-scans within 800ms for same tag
  if (uid == lastScannedUid && (now - lastScanTime) < 800) {
    return;
  }
  lastScanTime = now;
  lastScannedUid = uid;

  Serial.println("\n-------------------------------------------");
  Serial.print("[RFID SCAN] Card Detected! UID: ");
  Serial.println(uid);

  // Flash LED for scan confirmation
  digitalWrite(LED_PIN, LOW); // Active LOW on NodeMCU

  // Format JSON payload
  String payload = "{\"type\":\"rfid\",\"uid\":\"" + uid + "\",\"device\":\"nodemcu_rc522\",\"timestamp\":" + String(now) + "}";

  bool transmitted = false;

  // 1. Primary transmission: Live 0-latency WebSocket
  if (isWsConnected) {
    transmitted = webSocket.sendTXT(payload);
    if (transmitted) {
      Serial.println("[WS 0-LATENCY] UID transmitted instantly via WebSocket");
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

  delay(80);
  digitalWrite(LED_PIN, HIGH); // LED off
  Serial.println("-------------------------------------------");
}

// ---------------- Arduino Setup -------------------------
void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH); // Off initially

  Serial.begin(115200);
  delay(500);
  Serial.println("\n===========================================");
  Serial.println(" ESP8266 NodeMCU RC522 RFID Live Hub Client");
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
  Serial.print("[WS] Initializing WebSocket client for: ");
  Serial.println(SERVER_HOST);

  if (USE_SSL) {
    webSocket.beginSSL(SERVER_HOST, SERVER_PORT, hostPath.c_str());
  } else {
    webSocket.begin(SERVER_HOST, SERVER_PORT, hostPath.c_str());
  }
  
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(2000); // Reconnect every 2 seconds if connection drops
  webSocket.enableHeartbeat(15000, 3000, 2); // 15s ping heartbeat
}

// ---------------- Arduino Main Loop ---------------------
void loop() {
  // Service mDNS
  MDNS.update();

  // Maintain WebSocket Connection
  webSocket.loop();

  // Auto-reconnect Wi-Fi if lost
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

  // Format Card UID as hex string e.g. "A1:B2:C3:D4"
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

  // Transmit UID to server
  transmitRfid(uidString);

  // Halt PICC and stop crypto to prepare for next scan
  mfrc522.PICC_HaltA();
  mfrc522.PCD_StopCrypto1();
}
