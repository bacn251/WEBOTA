/**
 * ESP32 OTA Bridge — STM32 OTA via WiFi
 * ══════════════════════════════════════════════════════════════════
 *  Web Browser  ──HTTP──▶  ESP32 (HTTP Server)  ──UART──▶  STM32
 * ══════════════════════════════════════════════════════════════════
 *
 *  Endpoints:
 *    GET  /ping        →  "PONG"
 *    POST /ota/start   →  body: 12 bytes (size[4] + version[4] + crc32[4])
 *                         Gửi CMD_OTA_START + metadata qua UART, chờ ACK
 *    POST /ota/chunk   →  body: chunk data + CRC16 (2 bytes LE)
 *                         Gửi qua UART, chờ ACK/NAK
 *    GET  /ota/done    →  Chờ ACK cuối từ STM32 (reboot)
 *
 *  Cài đặt:
 *    Board: ESP32 Dev Module (Arduino IDE)
 *    Thư viện: WiFi.h, WebServer.h (có sẵn trong ESP32 core)
 *
 * ══════════════════════════════════════════════════════════════════
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>

// ─── CẤU HÌNH ── Sửa theo môi trường của bạn ──────────────────────
#define WIFI_SSID     "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// UART kết nối tới STM32 (TX2=GPIO17, RX2=GPIO16 trên ESP32 DevKit)
#define STM32_SERIAL  Serial2
#define BAUD_STM32    115200

// Nếu cần RESET STM32 trước OTA, kết nối chân NRST STM32 vào GPIO này
// #define PIN_STM32_RESET  4   // bỏ comment nếu dùng
// ──────────────────────────────────────────────────────────────────

// OTA Protocol constants (phải khớp với STM32 bootloader)
#define CMD_OTA_START 0xA5
#define ACK           0x06
#define NAK           0x15

#define UART_TIMEOUT_MS   5000   // timeout chờ ACK từ STM32
#define UART_DONE_TIMEOUT 30000  // timeout chờ ACK cuối (STM32 ghi flash xong)

WebServer server(80);

// ─── CORS helper ──────────────────────────────────────────────────
void setCORSHeaders() {
  server.sendHeader("Access-Control-Allow-Origin",  "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ─── UART helpers ─────────────────────────────────────────────────
void stm32Flush() {
  while (STM32_SERIAL.available()) STM32_SERIAL.read();
}

/**
 * Đọc 1 byte từ STM32 với timeout.
 * Trả về byte nhận được, hoặc -1 nếu timeout.
 */
int stm32ReadByte(uint32_t timeoutMs = UART_TIMEOUT_MS) {
  uint32_t start = millis();
  while (!STM32_SERIAL.available()) {
    if (millis() - start > timeoutMs) return -1;
    delay(1);
  }
  return STM32_SERIAL.read();
}

/**
 * Gửi bytes qua UART rồi chờ ACK.
 * Trả về true nếu nhận ACK, false nếu NAK/timeout.
 */
bool stm32Send(const uint8_t* data, size_t len, uint32_t timeoutMs = UART_TIMEOUT_MS) {
  STM32_SERIAL.write(data, len);
  STM32_SERIAL.flush();  // chờ TX hoàn tất

  int b = stm32ReadByte(timeoutMs);
  Serial.printf("[UART] TX %d bytes → RX: 0x%02X\n", len, (uint8_t)b);

  return (b == ACK);
}

// ─── RESET STM32 (tuỳ chọn) ───────────────────────────────────────
void resetSTM32() {
#ifdef PIN_STM32_RESET
  pinMode(PIN_STM32_RESET, OUTPUT);
  digitalWrite(PIN_STM32_RESET, LOW);
  delay(50);
  digitalWrite(PIN_STM32_RESET, HIGH);
  delay(200);
  Serial.println("[OTA] STM32 reset done");
#endif
}

// ══════════════════════════════════════════════════════════════════
//  ENDPOINT HANDLERS
// ══════════════════════════════════════════════════════════════════

// OPTIONS pre-flight (cho CORS)
void handleOptions() {
  setCORSHeaders();
  server.send(204, "text/plain", "");
}

// GET /ping
void handlePing() {
  setCORSHeaders();
  server.send(200, "text/plain", "PONG");
  Serial.println("[HTTP] GET /ping");
}

// POST /ota/start
// Body: 12 bytes = size(4 LE) + version(4 LE) + crc32(4 LE)
void handleOtaStart() {
  setCORSHeaders();
  Serial.println("[HTTP] POST /ota/start");

  if (server.hasArg("plain") == false && server.method() != HTTP_POST) {
    server.send(400, "text/plain", "Bad Request");
    return;
  }

  // Đọc body (12 bytes metadata)
  if (server.arg("plain").length() < 12) {
    // Thử đọc từ stream
  }

  // Với WebServer của ESP32, body nhị phân nằm trong server.arg("plain")
  // nhưng thực tế binary body cần đọc trực tiếp — ta dùng WiFiClient
  // Tuy nhiên WebServer đã buffer sẵn, ta access qua server.arg("plain")
  // (ESP32 WebServer hỗ trợ body lên đến ~16KB mặc định)

  String bodyStr = server.arg("plain");
  if ((int)bodyStr.length() < 12) {
    server.send(400, "text/plain", "NAK - Invalid metadata");
    return;
  }

  const uint8_t* meta = (const uint8_t*)bodyStr.c_str();

  uint32_t fw_size    = ((uint32_t)meta[0])       | ((uint32_t)meta[1] << 8)
                      | ((uint32_t)meta[2] << 16)  | ((uint32_t)meta[3] << 24);
  uint32_t fw_version = ((uint32_t)meta[4])       | ((uint32_t)meta[5] << 8)
                      | ((uint32_t)meta[6] << 16)  | ((uint32_t)meta[7] << 24);
  uint32_t fw_crc32   = ((uint32_t)meta[8])       | ((uint32_t)meta[9] << 8)
                      | ((uint32_t)meta[10] << 16) | ((uint32_t)meta[11] << 24);

  Serial.printf("[OTA] Size: %u  Version: 0x%06X  CRC32: 0x%08X\n",
                fw_size, fw_version, fw_crc32);

  // Reset STM32 nếu cần
  resetSTM32();
  stm32Flush();

  // Gửi CMD_OTA_START
  uint8_t cmd = CMD_OTA_START;
  STM32_SERIAL.write(&cmd, 1);
  STM32_SERIAL.flush();

  int ack = stm32ReadByte();
  if (ack != ACK) {
    Serial.printf("[OTA] START NAK (0x%02X)\n", (uint8_t)ack);
    server.send(502, "text/plain", "NAK");
    return;
  }
  Serial.println("[OTA] START ACK");

  // Gửi metadata (12 bytes)
  STM32_SERIAL.write(meta, 12);
  STM32_SERIAL.flush();

  ack = stm32ReadByte();
  if (ack != ACK) {
    Serial.printf("[OTA] META NAK (0x%02X)\n", (uint8_t)ack);
    server.send(502, "text/plain", "NAK");
    return;
  }
  Serial.println("[OTA] META ACK");

  server.send(200, "text/plain", "ACK");
}

// POST /ota/chunk
// Body: chunk_data (≤256 bytes) + CRC16 (2 bytes LE)
void handleOtaChunk() {
  setCORSHeaders();

  String bodyStr = server.arg("plain");
  int len = bodyStr.length();

  if (len < 3) {  // tối thiểu 1 byte data + 2 byte CRC16
    server.send(400, "text/plain", "NAK - too short");
    return;
  }

  const uint8_t* packet = (const uint8_t*)bodyStr.c_str();

  // Forward packet (data + CRC16) thẳng tới STM32
  STM32_SERIAL.write(packet, len);
  STM32_SERIAL.flush();

  int ack = stm32ReadByte();
  if (ack == ACK) {
    server.send(200, "text/plain", "ACK");
  } else {
    Serial.printf("[OTA] Chunk NAK (0x%02X)\n", (uint8_t)ack);
    server.send(200, "text/plain", "NAK");  // 200 + "NAK" để JS biết retry
  }
}

// GET /ota/done
// Chờ ACK cuối từ STM32 (sau khi ghi flash xong và chuẩn bị boot)
void handleOtaDone() {
  setCORSHeaders();
  Serial.println("[HTTP] GET /ota/done — chờ STM32...");

  int ack = stm32ReadByte(UART_DONE_TIMEOUT);

  if (ack == ACK) {
    Serial.println("[OTA] DONE ACK — STM32 sẽ khởi động firmware mới");
    server.send(200, "text/plain", "ACK");
  } else {
    Serial.printf("[OTA] DONE timeout/NAK (0x%02X)\n", (uint8_t)ack);
    server.send(502, "text/plain", "NAK");
  }
}

// ══════════════════════════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  STM32_SERIAL.begin(BAUD_STM32, SERIAL_8N1, 16, 17);  // RX=16, TX=17

  Serial.println("\n\n=== ESP32 STM32 OTA Bridge ===");

  // Kết nối WiFi
  Serial.printf("Kết nối WiFi: %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t wStart = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (millis() - wStart > 20000) {
      Serial.println("\n⚠ WiFi timeout! Khởi động lại...");
      ESP.restart();
    }
  }

  Serial.println();
  Serial.print("✅ WiFi kết nối! IP: ");
  Serial.println(WiFi.localIP());

  // Đăng ký routes
  server.on("/ping",       HTTP_GET,     handlePing);
  server.on("/ping",       HTTP_OPTIONS, handleOptions);
  server.on("/ota/start",  HTTP_POST,    handleOtaStart);
  server.on("/ota/start",  HTTP_OPTIONS, handleOptions);
  server.on("/ota/chunk",  HTTP_POST,    handleOtaChunk);
  server.on("/ota/chunk",  HTTP_OPTIONS, handleOptions);
  server.on("/ota/done",   HTTP_GET,     handleOtaDone);
  server.on("/ota/done",   HTTP_OPTIONS, handleOptions);

  server.onNotFound([]() {
    setCORSHeaders();
    server.send(404, "text/plain", "Not Found");
  });

  server.begin();
  Serial.println("✅ HTTP Server đang chạy trên port 80");
  Serial.println("   Nhập IP trên vào web browser để bắt đầu OTA");
}

// ══════════════════════════════════════════════════════════════════
//  LOOP
// ══════════════════════════════════════════════════════════════════
void loop() {
  server.handleClient();

  // In IP định kỳ để dễ debug
  static uint32_t lastPrint = 0;
  if (millis() - lastPrint > 30000) {
    lastPrint = millis();
    Serial.printf("[Heartbeat] IP: %s  WiFi: %d\n",
                  WiFi.localIP().toString().c_str(), WiFi.status());
  }
}
