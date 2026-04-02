/**
 * Cloud OTA Relay Server — Multi-device ESP32 → STM32
 * ═══════════════════════════════════════════════════════════════
 *
 *  Browser (GitHub Pages) ──HTTPS──▶ [This Server] ◀── ESP32 polls
 *
 *  Browser Endpoints:
 *    GET  /api/devices             → Danh sách ESP32 đang online
 *    POST /api/upload              → Upload firmware + chọn deviceId
 *    POST /api/trigger-ota         → Trigger OTA cho thiết bị cụ thể
 *    GET  /health                  → Health check
 *
 *  ESP32 Endpoints:
 *    POST /api/esp32-status        → Heartbeat (báo online)
 *    GET  /api/check-update?id=xx  → Poll firmware mới
 *    GET  /api/firmware?id=xx      → Tải firmware binary
 *    POST /api/ota-result          → Báo kết quả OTA
 *
 * ═══════════════════════════════════════════════════════════════
 */

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Storage ──────────────────────────────────────────────────
const STORE = path.join(__dirname, 'firmware_store');
if (!fs.existsSync(STORE)) fs.mkdirSync(STORE, { recursive: true });

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── In-memory device registry ────────────────────────────────
// Map<deviceId, DeviceState>
const devices = new Map();

function getDevice(id) {
  if (!devices.has(id)) {
    devices.set(id, {
      id,
      name        : id,
      online      : false,
      lastSeen    : null,
      ip          : null,
      version     : '0.0.0',
      otaStatus   : 'idle',   // idle | pending | downloading | done | error
      otaTrigger  : false,
      lastResult  : null
    });
  }
  return devices.get(id);
}

function isOnline(dev) {
  return dev.lastSeen && (Date.now() - dev.lastSeen < 90_000);
}

// ─── Firmware store per-device ────────────────────────────────
function fwPath(deviceId)  { return path.join(STORE, `${deviceId}.bin`); }
function metaPath(deviceId){ return path.join(STORE, `${deviceId}.json`); }

function readMeta(deviceId) {
  try { return JSON.parse(fs.readFileSync(metaPath(deviceId), 'utf8')); }
  catch { return null; }
}

function saveMeta(deviceId, meta) {
  fs.writeFileSync(metaPath(deviceId), JSON.stringify(meta, null, 2));
}

// ─── Upload (multer) ──────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: STORE,
    filename   : (req, _file, cb) => cb(null, `${req.body.deviceId || 'default'}.bin`)
  }),
  limits: { fileSize: 4 * 1024 * 1024 }
});

// ═══════════════════════════════════════════════════════════════
//  BROWSER ENDPOINTS
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/devices
 * Danh sách tất cả ESP32 từng kết nối
 */
app.get('/api/devices', (_req, res) => {
  const list = [];
  for (const [id, dev] of devices) {
    const meta = readMeta(id);
    list.push({
      id,
      name      : dev.name,
      online    : isOnline(dev),
      lastSeen  : dev.lastSeen,
      ip        : dev.ip,
      version   : dev.version,
      otaStatus : dev.otaStatus,
      otaTrigger: dev.otaTrigger,
      firmware  : meta
    });
  }
  // Sort: online trước
  list.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
  res.json(list);
});

/**
 * POST /api/upload
 * Multipart: firmware (.bin) + deviceId + major + minor + patch
 * Nếu deviceId = "all" → upload cho tất cả thiết bị đang online
 */
app.post('/api/upload', upload.single('firmware'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No firmware file' });

  const deviceId = req.body.deviceId || 'default';
  const major = parseInt(req.body.major) || 1;
  const minor = parseInt(req.body.minor) || 0;
  const patch = parseInt(req.body.patch) || 0;

  const meta = {
    deviceId, major, minor, patch,
    version   : `${major}.${minor}.${patch}`,
    size      : req.file.size,
    uploadedAt: new Date().toISOString()
  };

  // Nếu file đã được multer lưu với tên deviceId.bin, rename nếu cần
  const dest = fwPath(deviceId);
  if (req.file.path !== dest && fs.existsSync(req.file.path)) {
    fs.renameSync(req.file.path, dest);
  }

  saveMeta(deviceId, meta);

  // Reset trigger nếu đang pending
  if (devices.has(deviceId)) {
    devices.get(deviceId).otaStatus  = 'idle';
    devices.get(deviceId).otaTrigger = false;
  }

  console.log(`[UPLOAD] Device="${deviceId}" fw v${meta.version} — ${req.file.size} bytes`);
  res.json({ ok: true, meta });
});

/**
 * POST /api/trigger-ota
 * Body JSON: { "deviceId": "esp32-living-room" }
 */
app.post('/api/trigger-ota', (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const meta = readMeta(deviceId);
  if (!meta) return res.status(400).json({ error: 'Chưa có firmware cho thiết bị này' });

  const dev = getDevice(deviceId);
  if (!isOnline(dev)) return res.status(400).json({ error: 'Thiết bị không online' });

  dev.otaTrigger = true;
  dev.otaStatus  = 'pending';

  console.log(`[TRIGGER] Device="${deviceId}" OTA trigger set (fw v${meta.version})`);
  res.json({ ok: true, message: `OTA triggered cho "${deviceId}". ESP32 sẽ bắt đầu trong vòng 30s` });
});

// ═══════════════════════════════════════════════════════════════
//  ESP32 ENDPOINTS
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/esp32-status
 * Body JSON: { "id": "esp32-room1", "name": "Living Room", "version": "1.0.0" }
 */
app.post('/api/esp32-status', (req, res) => {
  const { id, name, version } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });

  const dev      = getDevice(id);
  dev.name       = name || id;
  dev.lastSeen   = Date.now();
  dev.online     = true;
  dev.ip         = req.ip;
  dev.version    = version || dev.version;

  console.log(`[STATUS] Device="${id}" name="${dev.name}" v${dev.version} — ${req.ip}`);
  res.json({ ok: true });
});

/**
 * GET /api/check-update?id=xxx
 * ESP32 poll firmware mới
 */
app.get('/api/check-update', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  const dev = getDevice(id);
  dev.lastSeen = Date.now();
  dev.online   = true;
  dev.ip       = req.ip;

  const meta = readMeta(id);
  if (!meta) return res.json({ update: false });

  if (dev.otaTrigger) {
    console.log(`[CHECK] Device="${id}" → OTA triggered → v${meta.version}`);
    res.json({
      update   : true,
      version  : meta.version,
      major    : meta.major,
      minor    : meta.minor,
      patch    : meta.patch,
      size     : meta.size
    });
  } else {
    res.json({
      update        : false,
      serverVersion : meta.version,
      myVersion     : dev.version
    });
  }
});

/**
 * GET /api/firmware?id=xxx
 * ESP32 tải binary
 */
app.get('/api/firmware', (req, res) => {
  const id   = req.query.id;
  const fp   = fwPath(id || 'default');

  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Firmware not found' });

  console.log(`[FIRMWARE] Device="${id}" downloading...`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${id}.bin"`);
  res.sendFile(fp);
});

/**
 * POST /api/ota-result
 * Body JSON: { "id": "...", "success": true, "version": "1.1.0" }
 */
app.post('/api/ota-result', (req, res) => {
  const { id, success, version, error: errMsg } = req.body;
  const dev = getDevice(id || 'default');

  if (success) {
    dev.version    = version || dev.version;
    dev.otaStatus  = 'done';
    dev.otaTrigger = false;
    dev.lastResult = { success: true, version, ts: Date.now() };
    console.log(`[OTA] ✅ Device="${id}" → v${version}`);
  } else {
    dev.otaStatus  = 'error';
    dev.otaTrigger = false;
    dev.lastResult = { success: false, error: errMsg, ts: Date.now() };
    console.log(`[OTA] ❌ Device="${id}" → ${errMsg}`);
  }

  res.json({ ok: true });
});

// ─── Health ───────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now(), devices: devices.size }));

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n=== Cloud OTA Relay Server — port ${PORT} ===\n`);
});
