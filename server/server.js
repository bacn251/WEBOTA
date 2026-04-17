/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║        ESP32 Cloud OTA Relay Server — Node.js              ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  • Serve giao diện Web UI từ /public                       ║
 * ║  • Nhận heartbeat từ ESP32                                  ║
 * ║  • Lưu firmware .bin                                        ║
 * ║  • Trigger OTA cho từng ESP32 cụ thể                       ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 *  Cách dùng:
 *    npm install
 *    npm start          → chạy server tại localhost:3000
 *    ngrok http 3000    → lấy URL public → nhét vào ESP32
 */

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Paths ──────────────────────────────────────────────────────
const STORE_DIR  = path.join(__dirname, 'firmware_store');
const PUBLIC_DIR = path.join(__dirname, 'public');

[STORE_DIR, PUBLIC_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Middleware ─────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Không cache các API route (tránh 304)
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// ── Serve Web UI ───────────────────────────────────────────────
app.use(express.static(PUBLIC_DIR));

// ── Device Registry (in-memory) ───────────────────────────────
const devices = new Map();

// ── Sensor Data Store (in-memory, giữ 60 điểm gần nhất) ───────
const sensorStore = new Map(); // deviceId → array of {ts, temp, humi, ...}
const SENSOR_MAX  = 60;

function pushSensor(id, payload) {
  if (!sensorStore.has(id)) sensorStore.set(id, []);
  const arr = sensorStore.get(id);
  arr.push({ ts: Date.now(), ...payload });
  if (arr.length > SENSOR_MAX) arr.shift();
}

function getDevice(id) {
  if (!devices.has(id)) {
    devices.set(id, {
      id,
      name      : id,
      lastSeen  : null,
      ip        : null,
      version   : '0.0.0',
      otaStatus : 'idle',   // idle | pending | done | error
      otaTrigger: false,
      lastResult: null
    });
  }
  return devices.get(id);
}

function isOnline(dev) {
  return dev.lastSeen && (Date.now() - dev.lastSeen < 90_000); // 90s timeout
}

// ── Firmware helpers ───────────────────────────────────────────
const fwBin  = id => path.join(STORE_DIR, `${id}.bin`);
const fwMeta = id => path.join(STORE_DIR, `${id}.json`);

function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(fwMeta(id), 'utf8')); }
  catch { return null; }
}
function saveMeta(id, meta) {
  fs.writeFileSync(fwMeta(id), JSON.stringify(meta, null, 2));
}

// ── Multer upload ──────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: STORE_DIR,
    filename: (req, _f, cb) => cb(null, `${req.body.deviceId || 'default'}.bin`)
  }),
  limits: { fileSize: 4 * 1024 * 1024 } // 4 MB max
});

// ══════════════════════════════════════════════════════════════
//  API dành cho Browser (Web UI)
// ══════════════════════════════════════════════════════════════

/** GET /api/devices → danh sách thiết bị */
app.get('/api/devices', (_req, res) => {
  const list = [...devices.values()].map(dev => ({
    id        : dev.id,
    name      : dev.name,
    online    : isOnline(dev),
    lastSeen  : dev.lastSeen,
    ip        : dev.ip ? dev.ip.replace('::ffff:', '') : null,
    version   : dev.version,
    otaStatus : dev.otaStatus,
    otaTrigger: dev.otaTrigger,
    lastResult: dev.lastResult,
    firmware  : readMeta(dev.id)
  }));
  list.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
  res.json(list);
});

/** POST /api/upload → upload firmware .bin */
app.post('/api/upload', upload.single('firmware'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không có file firmware' });

  const id    = req.body.deviceId || 'default';
  const major = parseInt(req.body.major) || 1;
  const minor = parseInt(req.body.minor) || 0;
  const patch = parseInt(req.body.patch) || 0;

  const meta = {
    deviceId  : id,
    major, minor, patch,
    version   : `${major}.${minor}.${patch}`,
    size      : req.file.size,
    uploadedAt: new Date().toISOString()
  };

  // multer đã lưu đúng tên rồi (deviceId.bin)
  const dest = fwBin(id);
  if (req.file.path !== dest && fs.existsSync(req.file.path)) {
    fs.renameSync(req.file.path, dest);
  }

  saveMeta(id, meta);

  // reset trigger nếu upload lại
  if (devices.has(id)) {
    const d = devices.get(id);
    d.otaStatus  = 'idle';
    d.otaTrigger = false;
  }

  console.log(`[UPLOAD] ${id} → v${meta.version} (${req.file.size} bytes)`);
  res.json({ ok: true, meta });
});

/** POST /api/trigger-ota → ra lệnh ESP32 update */
app.post('/api/trigger-ota', (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const meta = readMeta(deviceId);
  if (!meta) return res.status(400).json({ error: 'Chưa có firmware cho thiết bị này' });

  const dev = getDevice(deviceId);
  if (!isOnline(dev)) return res.status(400).json({ error: 'Thiết bị không online' });

  dev.otaTrigger = true;
  dev.otaStatus  = 'pending';

  console.log(`[TRIGGER] ${deviceId} → OTA pending (v${meta.version})`);
  res.json({ ok: true, message: `OTA triggered cho "${deviceId}". ESP32 sẽ thực hiện trong ≤30s` });
});

// ══════════════════════════════════════════════════════════════
//  API dành cho ESP32
// ══════════════════════════════════════════════════════════════

/** POST /api/esp32-status → heartbeat */
app.post('/api/esp32-status', (req, res) => {
  const { id, name, version } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });

  const dev    = getDevice(id);
  dev.name     = name || id;
  dev.lastSeen = Date.now();
  dev.ip       = req.ip;
  dev.version  = version || dev.version;

  console.log(`[HB] ${id} ("${dev.name}") v${dev.version} — ${dev.ip}`);
  res.json({ ok: true });
});

/** GET /api/check-update?id=xxx → ESP32 poll */
app.get('/api/check-update', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  const dev    = getDevice(id);
  dev.lastSeen = Date.now();
  dev.ip       = req.ip;

  const meta = readMeta(id);
  if (!meta || !dev.otaTrigger) {
    return res.json({ update: false, serverVersion: meta?.version, myVersion: dev.version });
  }

  console.log(`[CHECK] ${id} → triggered! sending v${meta.version}`);
  res.json({
    update : true,
    version: meta.version,
    major  : meta.major,
    minor  : meta.minor,
    patch  : meta.patch,
    size   : meta.size
  });
});

/** GET /api/firmware?id=xxx → tải binary */
app.get('/api/firmware', (req, res) => {
  const id = req.query.id;
  const fp = fwBin(id || 'default');

  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Firmware not found' });

  console.log(`[DOWNLOAD] ${id} downloading firmware...`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${id}.bin"`);
  res.sendFile(fp);
});

/** POST /api/ota-result → kết quả OTA từ ESP32 */
app.post('/api/ota-result', (req, res) => {
  const { id, success, version, error: errMsg } = req.body;
  const dev = getDevice(id || 'unknown');

  if (success) {
    dev.version    = version || dev.version;
    dev.otaStatus  = 'done';
    dev.otaTrigger = false;
    dev.lastResult = { success: true, version, ts: Date.now() };
    console.log(`[OTA] ✅ ${id} → v${version}`);
  } else {
    dev.otaStatus  = 'error';
    dev.otaTrigger = false;
    dev.lastResult = { success: false, error: errMsg, ts: Date.now() };
    console.log(`[OTA] ❌ ${id} → ${errMsg}`);
  }

  res.json({ ok: true });
});

/** POST /api/sensor → ESP32 gửi data cảm biến lên */
app.post('/api/sensor', (req, res) => {
  const { id, ...payload } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  pushSensor(id, payload);
  // cập nhật lastSeen luôn
  const dev = getDevice(id);
  dev.lastSeen = Date.now();
  dev.ip = req.ip;
  console.log(`[SENSOR] ${id} →`, payload);
  res.json({ ok: true });
});

/** GET /api/sensor?id=xxx → Web lấy lịch sử sensor */
app.get('/api/sensor', (req, res) => {
  const id   = req.query.id;
  const data = id ? (sensorStore.get(id) || []) : {};
  if (!id) {
    const all = {};
    sensorStore.forEach((v, k) => { all[k] = v; });
    return res.json(all);
  }
  res.json(data);
});

// ── Health check ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), devices: devices.size, uptime: process.uptime() });
});

// ── SPA fallback → trả index.html ──────────────────────────────
app.get('*', (_req, res) => {
  const idx = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.status(404).send('Web UI not found. Put index.html in server/public/');
});

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  ESP32 OTA Server — http://localhost:${PORT}  ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Web UI  : http://localhost:${PORT}           ║`);
  console.log(`║  ngrok   : ngrok http ${PORT}                 ║`);
  console.log('╚══════════════════════════════════════════╝\n');
});
