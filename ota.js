/**
 * STM32 OTA via ESP32 WiFi
 * ─────────────────────────────────────────────────────────────────
 *  Browser  ─── HTTP POST ──▶  ESP32 (HTTP Server)  ─── UART ──▶  STM32
 * ─────────────────────────────────────────────────────────────────
 *
 *  ESP32 phải expose các endpoint sau (port 80):
 *    GET  /ping              → 200 "PONG"
 *    POST /ota/start         → body: {size, version, crc32}  → 200 "ACK" | "NAK"
 *    POST /ota/chunk         → body: binary (chunk + CRC16)  → 200 "ACK" | "NAK"
 *    GET  /ota/done          → 200 "ACK" khi STM32 xác nhận xong
 */

// ─── CONSTANTS ────────────────────────────────────────────────────
const CHUNK_SIZE = 256;          // bytes mỗi chunk gửi UART
const HTTP_TIMEOUT = 8000;       // ms
const RETRY_MAX = 3;

// ─── STATE ────────────────────────────────────────────────────────
let esp32Reachable = false;

// ─── HELPERS: CRC ─────────────────────────────────────────────────
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++)
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xEDB88320) : (crc >>> 1);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function crc16(buf) {
  let crc = 0xFFFF;
  for (let b of buf) {
    crc ^= (b << 8);
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc;
}

// ─── HELPERS: VERSION ─────────────────────────────────────────────
function getVersion() {
  const major = Math.min(255, Math.max(0, parseInt(document.getElementById('v_major').value) || 1));
  const minor = Math.min(255, Math.max(0, parseInt(document.getElementById('v_minor').value) || 0));
  const patch = Math.min(255, Math.max(0, parseInt(document.getElementById('v_patch').value) || 0));
  return { major, minor, patch, encoded: (major << 16) | (minor << 8) | patch };
}

function autoPatch() {
  const el = document.getElementById('v_patch');
  el.value = (parseInt(el.value) || 0) + 1;
}

// ─── HELPERS: FILE ────────────────────────────────────────────────
function onFileChange() {
  const f = document.getElementById('fileInput').files[0];
  const el = document.getElementById('fileName');
  if (f) {
    el.textContent = `📄 ${f.name}  (${formatBytes(f.size)})`;
    updateOtaButton();
  } else {
    el.textContent = '';
  }
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function updateOtaButton() {
  const btn = document.getElementById('btnOTA');
  const hasFile = document.getElementById('fileInput').files.length > 0;
  btn.disabled = !(esp32Reachable && hasFile);
}

// ─── HELPERS: LOG ─────────────────────────────────────────────────
function clearLog() {
  document.getElementById('log').innerHTML = '';
}

function log(msg, cls = '') {
  const el = document.getElementById('log');
  const t = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  const line = document.createElement('div');
  if (cls) line.classList.add(cls);
  line.textContent = `[${t}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ─── HELPERS: PROGRESS ────────────────────────────────────────────
function showProgress(visible) {
  document.getElementById('progressWrap').classList.toggle('visible', visible);
}

function setProgress(sent, total) {
  const pct = total > 0 ? Math.round(sent / total * 100) : 0;
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressPct').textContent = pct + '%';
  document.getElementById('progressLabel').textContent =
    `Chunk ${sent}/${total} — ${formatBytes(sent * CHUNK_SIZE)} / ${formatBytes(total * CHUNK_SIZE)}`;
}

// ─── HTTP UTIL ────────────────────────────────────────────────────
function getBaseUrl() {
  return `http://${document.getElementById('esp32ip').value.trim()}`;
}

async function httpFetch(path, options = {}, timeoutMs = HTTP_TIMEOUT) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(getBaseUrl() + path, { ...options, signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function httpText(path, options = {}) {
  const res = await httpFetch(path, options);
  const text = await res.text();
  return { ok: res.ok, status: res.status, text: text.trim() };
}

// ─── PING ─────────────────────────────────────────────────────────
async function pingESP32() {
  const pill = document.getElementById('statusPill');
  pill.className = 'checking';
  pill.innerHTML = '<span class="dot pulse"></span> Đang kiểm tra...';
  esp32Reachable = false;
  updateOtaButton();

  try {
    const { ok, text } = await httpText('/ping', {}, 4000);
    if (ok && text === 'PONG') {
      pill.className = 'connected';
      pill.innerHTML = '<span class="dot"></span> Đã kết nối ESP32';
      esp32Reachable = true;
      log('✅ ESP32 phản hồi: ' + getBaseUrl(), 'ok');
    } else {
      throw new Error(`Unexpected: ${text}`);
    }
  } catch (e) {
    pill.className = 'disconnected';
    pill.innerHTML = '<span class="dot"></span> Không kết nối được';
    log('❌ Ping thất bại: ' + e.message, 'err');
  }
  updateOtaButton();
}

// ─── OTA ──────────────────────────────────────────────────────────
async function startOTA() {
  if (!esp32Reachable) { alert('Chưa kết nối với ESP32!'); return; }

  const fileEl = document.getElementById('fileInput');
  if (!fileEl.files.length) { alert('Chưa chọn file firmware!'); return; }

  clearLog();
  showProgress(true);

  const btnOTA = document.getElementById('btnOTA');
  btnOTA.disabled = true;
  btnOTA.innerHTML = '⏳ Đang OTA...';

  try {
    const file = fileEl.files[0];
    const fw   = new Uint8Array(await file.arrayBuffer());
    const size = fw.length;
    const crc  = crc32(fw);
    const v    = getVersion();

    log(`📦 File: ${file.name}  (${formatBytes(size)})`, 'info');
    log(`🔢 Version: ${v.major}.${v.minor}.${v.patch}  (0x${v.encoded.toString(16).toUpperCase()})`, 'info');
    log(`🔐 CRC32: 0x${crc.toString(16).toUpperCase().padStart(8,'0')}`, 'info');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'dim');

    // ── 1. START ──
    log('📡 Gửi lệnh OTA START...');
    const startBody = new DataView(new ArrayBuffer(12));
    startBody.setUint32(0, size, true);
    startBody.setUint32(4, v.encoded, true);
    startBody.setUint32(8, crc, true);

    const startRes = await httpText('/ota/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: startBody.buffer
    });

    if (!startRes.ok || startRes.text !== 'ACK')
      throw new Error(`START thất bại: ${startRes.text}`);

    log('✅ ACK START — STM32 đã sẵn sàng', 'ok');

    // ── 2. CHUNKS ──
    const total = Math.ceil(size / CHUNK_SIZE);
    log(`📤 Gửi ${total} chunks (${CHUNK_SIZE} bytes/chunk)...`);

    for (let i = 0; i < total; i++) {
      const chunk = fw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const c16   = crc16(chunk);

      // packet = chunk + CRC16 (little-endian 2 bytes)
      const packet = new Uint8Array(chunk.length + 2);
      packet.set(chunk);
      new DataView(packet.buffer).setUint16(chunk.length, c16, true);

      let success = false;
      for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
        const r = await httpText('/ota/chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: packet
        });

        if (r.ok && r.text === 'ACK') { success = true; break; }

        log(`⚠️ Chunk ${i+1}: lần ${attempt+1} NAK — thử lại...`, 'err');
        await delay(300);
      }

      if (!success) throw new Error(`Chunk ${i+1}/${total} thất bại sau ${RETRY_MAX} lần`);

      setProgress(i + 1, total);

      // Log mỗi 16 chunks để tránh spam
      if ((i + 1) % 16 === 0 || i + 1 === total)
        log(`   ✔ Chunk ${i+1}/${total}`, 'ok');
    }

    // ── 3. DONE ──
    log('');
    log('⏳ Chờ STM32 xác nhận hoàn tất...');
    const doneRes = await httpText('/ota/done', {}, 30000);

    if (!doneRes.ok || doneRes.text !== 'ACK')
      throw new Error(`DONE thất bại: ${doneRes.text}`);

    log('');
    log('🎉 ══════════════════════════════', 'ok');
    log('🎉  OTA THÀNH CÔNG!               ', 'ok');
    log('🎉 ══════════════════════════════', 'ok');
    log(`   STM32 sẽ khởi động firmware v${v.major}.${v.minor}.${v.patch}`, 'ok');

  } catch (e) {
    log('');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'dim');
    log('❌ LỖI: ' + e.message, 'err');
  } finally {
    btnOTA.disabled = false;
    btnOTA.innerHTML = '🚀 Bắt đầu OTA Update';
    updateOtaButton();
  }
}

// ─── UTIL ─────────────────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── INIT ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  updateOtaButton();
  log('Giao diện OTA sẵn sàng. Nhập IP ESP32 và nhấn "Kiểm tra kết nối".', 'dim');
});