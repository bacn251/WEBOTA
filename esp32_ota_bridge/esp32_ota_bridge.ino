/**
 * ESP32 OTA Bridge — ESP32 → STM32 OTA via Cloud Server
 * ════════════════════════════════════════════════════════════════
 *
 *  ESP32 chủ động kết nối ra internet đến Cloud Server.
 *  Browser (GitHub Pages) thấy danh sách thiết bị trên Cloud Server
 *  và chọn thiết bị để trigger OTA.
 *
 *  Luồng:
 *    1. ESP32 boot → kết nối WiFi
 *    2. ESP32 gửi POST /api/esp32-status mỗi 20s (heartbeat)
 *    3. ESP32 gửi GET /api/check-update?id=DEVICE_ID mỗi 30s
 *    4. Nếu server báo update=true → tải firmware → flash STM32 qua UART
 *    5. Báo kết quả lên POST /api/ota-result
 *
 * ════════════════════════════════════════════════════════════════
 *  CẤU HÌNH:  Sửa 3 dòng bên dưới
 * ════════════════════════════════════════════════════════════════
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>

// ══════════════════════════════════════════════════════════════
//  ★ CẤU HÌNH — SỬA THEO MÔI TRƯỜNG CỦA BẠN
// ══════════════════════════════════════════════════════════════
#define WIFI_SSID       "noname"
#define WIFI_PASSWORD   "tamvemot"

// URL cloud server của bạn
// Ví dụ Railway: "https://webota-server.up.railway.app"
// Ví dụ EC2 HTTP: "http://18.228.223.47:3000"
#define SERVER_BASE_URL "https://webota-production.up.railway.app/"

// ID + Tên hiển thị cho thiết bị này (phải unique nếu có nhiều ESP32)
#define DEVICE_ID       "esp32-001"
#define DEVICE_NAME     "ESP32 Phòng khách"

// Phiên bản firmware STM32 hiện tại
#define CURRENT_VERSION "1.0.0"

// Poll server mỗi N giây
#define POLL_INTERVAL_S  30

// UART kết nối STM32 (TX2=GPIO17, RX2=GPIO16)
#define STM32_SERIAL     Serial2
#define BAUD_STM32       115200
// ══════════════════════════════════════════════════════════════

// OTA Protocol (phải khớp STM32 bootloader)
#define CMD_OTA_START   0xA5
#define ACK             0x06
#define NAK             0x15

#define UART_TIMEOUT_MS      5000
#define UART_DONE_TIMEOUT_MS 30000
#define CHUNK_SIZE           256

String currentVersion = CURRENT_VERSION;
bool   otaInProgress  = false;

// ─── CRC ──────────────────────────────────────────────────────
uint16_t crc16(const uint8_t* data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= ((uint16_t)data[i] << 8);
    for (int j = 0; j < 8; j++)
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
  }
  return crc;
}

uint32_t crc32buf(const uint8_t* data, size_t len) {
  uint32_t crc = 0xFFFFFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int j = 0; j < 8; j++)
      crc = (crc & 1) ? ((crc >> 1) ^ 0xEDB88320) : (crc >> 1);
  }
  return crc ^ 0xFFFFFFFF;
}

// ─── UART helpers ─────────────────────────────────────────────
void stm32Flush() { while (STM32_SERIAL.available()) STM32_SERIAL.read(); }

int stm32ReadByte(uint32_t tms = UART_TIMEOUT_MS) {
  uint32_t t = millis();
  while (!STM32_SERIAL.available()) {
    if (millis() - t > tms) return -1;
    delay(1);
  }
  return STM32_SERIAL.read();
}

// ─── Báo heartbeat lên server ─────────────────────────────────
void reportHeartbeat() {
  HTTPClient http;
  http.begin(String(SERVER_BASE_URL) + "/api/esp32-status");
  http.addHeader("Content-Type", "application/json");
  String body = "{\"id\":\"" DEVICE_ID "\","
                "\"name\":\"" DEVICE_NAME "\","
                "\"version\":\"" + currentVersion + "\"}";
  int code = http.POST(body);
  Serial.printf("[HB] POST /api/esp32-status → HTTP %d\n", code);
  http.end();
}

// ─── Báo kết quả OTA ──────────────────────────────────────────
void reportResult(bool success, const String& ver = "", const String& err = "") {
  HTTPClient http;
  http.begin(String(SERVER_BASE_URL) + "/api/ota-result");
  http.addHeader("Content-Type", "application/json");
  String body;
  if (success)
    body = "{\"id\":\"" DEVICE_ID "\",\"success\":true,\"version\":\"" + ver + "\"}";
  else
    body = "{\"id\":\"" DEVICE_ID "\",\"success\":false,\"error\":\"" + err + "\"}";
  http.POST(body);
  http.end();
}

// ─── OTA: Tải firmware + Flash STM32 ─────────────────────────
bool performOTA(uint32_t expectedSize, uint32_t major, uint32_t minor, uint32_t patch) {
  Serial.println("\n[OTA] ═══ Bắt đầu OTA ═══");

  // 1. Tải firmware từ server
  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/firmware?id=" DEVICE_ID;
  http.begin(url);
  http.setTimeout(30000);
  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    Serial.printf("[OTA] Tải firmware thất bại: HTTP %d\n", code);
    http.end();
    return false;
  }

  int fwSize = http.getSize();
  if (fwSize <= 0) fwSize = (int)expectedSize;
  Serial.printf("[OTA] Firmware: %d bytes\n", fwSize);

  // 2. Đọc toàn bộ vào RAM
  uint8_t* buf = (uint8_t*)malloc(fwSize);
  if (!buf) {
    Serial.println("[OTA] ❌ Không đủ RAM!");
    http.end(); return false;
  }

  WiFiClient* stream   = http.getStreamPtr();
  int         received = 0;
  uint32_t    dlStart  = millis();

  while (http.connected() && received < fwSize) {
    if (stream->available()) {
      int n = stream->readBytes(buf + received, min(512, fwSize - received));
      received += n;
    }
    if (millis() - dlStart > 60000) break; // timeout 60s
    delay(1);
  }
  http.end();

  if (received < fwSize) {
    Serial.printf("[OTA] Tải thiếu: %d/%d\n", received, fwSize);
    free(buf); return false;
  }
  Serial.printf("[OTA] Tải xong. CRC32 đang tính...\n");

  // 3. Tính CRC32
  uint32_t fwCrc32   = crc32buf(buf, fwSize);
  uint32_t fwVersion = ((uint32_t)major << 16) | ((uint32_t)minor << 8) | patch;
  Serial.printf("[OTA] CRC32=0x%08X  v%u.%u.%u\n", fwCrc32, major, minor, patch);

  // 4. Gửi CMD_OTA_START tới STM32
  stm32Flush();
  uint8_t cmd = CMD_OTA_START;
  STM32_SERIAL.write(&cmd, 1);
  STM32_SERIAL.flush();
  if (stm32ReadByte() != ACK) {
    Serial.println("[OTA] STM32 START NAK");
    free(buf); return false;
  }
  Serial.println("[OTA] STM32 START ACK ✓");

  // 5. Gửi metadata (12 bytes LE: size + version + crc32)
  uint8_t meta[12];
  meta[0]=(fwSize>>0)&0xFF; meta[1]=(fwSize>>8)&0xFF; meta[2]=(fwSize>>16)&0xFF; meta[3]=(fwSize>>24)&0xFF;
  meta[4]=(fwVersion>>0)&0xFF; meta[5]=(fwVersion>>8)&0xFF; meta[6]=(fwVersion>>16)&0xFF; meta[7]=(fwVersion>>24)&0xFF;
  meta[8]=(fwCrc32>>0)&0xFF; meta[9]=(fwCrc32>>8)&0xFF; meta[10]=(fwCrc32>>16)&0xFF; meta[11]=(fwCrc32>>24)&0xFF;

  STM32_SERIAL.write(meta, 12); STM32_SERIAL.flush();
  if (stm32ReadByte() != ACK) {
    Serial.println("[OTA] STM32 META NAK");
    free(buf); return false;
  }
  Serial.println("[OTA] STM32 META ACK ✓");

  // 6. Gửi từng chunk + CRC16
  int totalChunks = (fwSize + CHUNK_SIZE - 1) / CHUNK_SIZE;
  Serial.printf("[OTA] Gửi %d chunks...\n", totalChunks);

  for (int i = 0; i < totalChunks; i++) {
    int     offset   = i * CHUNK_SIZE;
    int     chunkLen = min(CHUNK_SIZE, fwSize - offset);
    uint8_t* chunk   = buf + offset;
    uint16_t c16     = crc16(chunk, chunkLen);

    uint8_t pkt[CHUNK_SIZE + 2];
    memcpy(pkt, chunk, chunkLen);
    pkt[chunkLen + 0] = (c16 >> 0) & 0xFF;
    pkt[chunkLen + 1] = (c16 >> 8) & 0xFF;

    bool ok = false;
    for (int t = 0; t < 3 && !ok; t++) {
      STM32_SERIAL.write(pkt, chunkLen + 2);
      STM32_SERIAL.flush();
      ok = (stm32ReadByte() == ACK);
      if (!ok)
        Serial.printf("[OTA] Chunk %d NAK — retry %d\n", i+1, t+1);
    }
    if (!ok) {
      Serial.printf("[OTA] Chunk %d thất bại!\n", i+1);
      free(buf); return false;
    }
    if ((i+1) % 16 == 0 || i+1 == totalChunks)
      Serial.printf("[OTA] ✔ Chunk %d/%d\n", i+1, totalChunks);
  }
  free(buf);

  // 7. Chờ ACK cuối từ STM32
  Serial.println("[OTA] Chờ STM32 xác nhận flash...");
  if (stm32ReadByte(UART_DONE_TIMEOUT_MS) != ACK) {
    Serial.println("[OTA] DONE NAK / timeout");
    return false;
  }
  Serial.println("[OTA] ✅ STM32 flash hoàn tất!");
  return true;
}

// ─── Poll server ──────────────────────────────────────────────
void pollServer() {
  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/check-update?id=" DEVICE_ID;
  http.begin(url);
  int code = http.GET();

  if (code != HTTP_CODE_OK) {
    Serial.printf("[POLL] HTTP %d\n", code);
    http.end(); return;
  }

  String payload = http.getString();
  http.end();
  Serial.printf("[POLL] %s\n", payload.c_str());

  if (payload.indexOf("\"update\":true") < 0) return;

  // Parse version/size từ JSON
  auto getNum = [&](const String& key) -> uint32_t {
    int i = payload.indexOf("\"" + key + "\":");
    if (i < 0) return 0;
    return payload.substring(i + key.length() + 3).toInt();
  };

  uint32_t major = getNum("major");
  uint32_t minor = getNum("minor");
  uint32_t patch = getNum("patch");
  uint32_t size  = getNum("size");

  Serial.printf("[POLL] Firmware mới: v%u.%u.%u (%u bytes)\n", major, minor, patch, size);

  otaInProgress = true;
  bool ok = performOTA(size, major, minor, patch);
  otaInProgress = false;

  if (ok) {
    currentVersion = String(major) + "." + String(minor) + "." + String(patch);
    reportResult(true, currentVersion);
  } else {
    reportResult(false, "", "OTA failed");
  }
}

// ─── Setup ────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  STM32_SERIAL.begin(BAUD_STM32, SERIAL_8N1, 16, 17);

  Serial.println("\n=== ESP32 Cloud OTA Bridge ===");
  Serial.printf("Device: %s (%s)\n", DEVICE_NAME, DEVICE_ID);
  Serial.printf("Server: %s\n\n", SERVER_BASE_URL);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Kết nối WiFi: %s\n", WIFI_SSID);

  uint32_t t = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500); Serial.print(".");
    if (millis() - t > 20000) { Serial.println("\n⚠ Timeout!"); ESP.restart(); }
  }
  Serial.printf("\n✅ WiFi OK! IP: %s\n", WiFi.localIP().toString().c_str());

  delay(500);
  reportHeartbeat();
}

// ─── Loop ─────────────────────────────────────────────────────
void loop() {
  static uint32_t lastPoll = 0, lastHB = 0;

  if (!otaInProgress) {
    if (millis() - lastHB > 20000) {
      lastHB = millis();
      reportHeartbeat();
    }
    if (millis() - lastPoll > (uint32_t)POLL_INTERVAL_S * 1000) {
      lastPoll = millis();
      pollServer();
    }
  }
  delay(100);
}
