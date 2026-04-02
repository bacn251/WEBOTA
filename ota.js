/**
 * STM32 Cloud OTA Dashboard — ota.js
 * Browser (GitHub Pages) ── HTTPS ──▶ Cloud Server ◀── ESP32 poll
 */

// ─── STATE ────────────────────────────────────────────────────
let pollTimer    = null;
let selectedId   = null;   // deviceId đang được chọn

// ─── HELPERS ──────────────────────────────────────────────────
function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function timeSince(ms) {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5)  return 'vừa xong';
  if (s < 60) return s + 's trước';
  if (s < 3600) return Math.floor(s / 60) + 'm trước';
  return Math.floor(s / 3600) + 'h trước';
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('vi-VN');
}

// ─── LOG ──────────────────────────────────────────────────────
function clearLog() { document.getElementById('log').innerHTML = ''; }

function log(msg, cls = '') {
  const el   = document.getElementById('log');
  const t    = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  const line = document.createElement('div');
  if (cls) line.classList.add(cls);
  line.textContent = `[${t}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ─── FILE ─────────────────────────────────────────────────────
function onFileChange() {
  const f  = document.getElementById('fileInput').files[0];
  const el = document.getElementById('fileName');
  el.textContent = f ? `📄 ${f.name}  (${formatBytes(f.size)})` : '';
  updateUploadBtn();
}

function updateUploadBtn() {
  const hasFile   = document.getElementById('fileInput').files.length > 0;
  const hasDevice = !!selectedId;
  document.getElementById('btnUpload').disabled = !(hasFile && hasDevice);
}

// ─── SERVER URL ───────────────────────────────────────────────
function getServerUrl() {
  return document.getElementById('serverUrl').value.trim().replace(/\/$/, '');
}

// ─── FETCH ────────────────────────────────────────────────────
async function apiFetch(path, opts = {}, timeout = 10000) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(getServerUrl() + path, { ...opts, signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) { clearTimeout(id); throw e; }
}

// ─── CONNECT ──────────────────────────────────────────────────
async function connectServer() {
  const pill = document.getElementById('serverPill');
  pill.className = 'status-pill checking';
  pill.innerHTML = '<span class="dot pulse"></span> Đang kết nối...';

  try {
    const res = await apiFetch('/health', {}, 5000);
    if (!res.ok) throw new Error('HTTP ' + res.status);

    pill.className = 'status-pill connected';
    pill.innerHTML = '<span class="dot"></span> Server online';
    log('✅ Kết nối server: ' + getServerUrl(), 'ok');
    startPolling();
  } catch (e) {
    pill.className = 'status-pill disconnected';
    pill.innerHTML = '<span class="dot"></span> Không kết nối được';
    log('❌ Lỗi kết nối: ' + e.message, 'err');
    log('   → Kiểm tra URL server, đảm bảo server đang chạy và có CORS', 'dim');
  }
}

// ─── DEVICE LIST POLLING ──────────────────────────────────────
function startPolling() {
  stopPolling();
  fetchDevices();
  pollTimer = setInterval(fetchDevices, 3000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function fetchDevices() {
  try {
    const res  = await apiFetch('/api/devices', {}, 4000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const list = await res.json();
    renderDevices(list);
  } catch (e) {
    /* silent — server might be momentarily unavailable */
  }
}

// ─── RENDER DEVICE LIST ───────────────────────────────────────
function renderDevices(list) {
  const container = document.getElementById('deviceList');
  const emptyMsg  = document.getElementById('deviceEmpty');

  if (!list || list.length === 0) {
    container.innerHTML = '';
    emptyMsg.style.display = 'block';
    selectedId = null;
    updateUploadBtn();
    document.getElementById('btnTrigger').disabled = true;
    return;
  }

  emptyMsg.style.display = 'none';

  // Giữ lại selection nếu device vẫn tồn tại
  const ids = list.map(d => d.id);
  if (selectedId && !ids.includes(selectedId)) selectedId = null;

  container.innerHTML = list.map(dev => {
    const isSelected = dev.id === selectedId;
    const onlineCls  = dev.online ? 'online' : 'offline';

    let statusBadge = '';
    if (dev.otaTrigger && dev.otaStatus === 'pending')
      statusBadge = '<span class="dev-badge pending">⏳ OTA đang chờ</span>';
    else if (dev.otaStatus === 'done')
      statusBadge = '<span class="dev-badge success">✅ OTA thành công</span>';
    else if (dev.otaStatus === 'error')
      statusBadge = '<span class="dev-badge error">❌ OTA lỗi</span>';

    const fwVersion = dev.firmware ? `Server: v${dev.firmware.version}` : 'Chưa có FW';

    return `
      <div class="device-card ${onlineCls} ${isSelected ? 'selected' : ''}"
           onclick="selectDevice('${dev.id}')" id="dev-${dev.id}">
        <div class="dev-top">
          <div class="dev-info">
            <div class="dev-name">
              <span class="dev-dot ${onlineCls}"></span>
              ${escHtml(dev.name)}
            </div>
            <div class="dev-id">${escHtml(dev.id)}</div>
          </div>
          <div class="dev-right">
            <div class="dev-ver">STM32: v${escHtml(dev.version)}</div>
            <div class="dev-ver dim">${fwVersion}</div>
          </div>
        </div>
        <div class="dev-bottom">
          <span class="dev-meta">${dev.online ? '⬤ Online' : '○ Offline'} · ${timeSince(dev.lastSeen)}</span>
          ${statusBadge}
        </div>
      </div>
    `;
  }).join('');

  updateTriggerBtn(list);
  updateUploadBtn();
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function selectDevice(id) {
  selectedId = (selectedId === id) ? null : id;
  // Re-render highlight
  document.querySelectorAll('.device-card').forEach(el => el.classList.remove('selected'));
  if (selectedId) {
    const el = document.getElementById('dev-' + selectedId);
    if (el) el.classList.add('selected');
  }
  updateUploadBtn();
  updateTriggerBtn();
}

function updateTriggerBtn(list = null) {
  const btn = document.getElementById('btnTrigger');
  if (!selectedId) { btn.disabled = true; return; }
  if (list) {
    const dev = list.find(d => d.id === selectedId);
    const hasFw   = dev && dev.firmware;
    const isOnline = dev && dev.online;
    const pending  = dev && dev.otaTrigger;
    btn.disabled = !(hasFw && isOnline && !pending);
  }
}

// ─── UPLOAD FIRMWARE ──────────────────────────────────────────
async function uploadFirmware() {
  if (!selectedId) { alert('Chọn thiết bị trước!'); return; }
  const fileEl = document.getElementById('fileInput');
  if (!fileEl.files.length) { alert('Chọn file .bin trước!'); return; }

  const file  = fileEl.files[0];
  const major = parseInt(document.getElementById('v_major').value) || 1;
  const minor = parseInt(document.getElementById('v_minor').value) || 0;
  const patch = parseInt(document.getElementById('v_patch').value) || 0;

  const form = new FormData();
  form.append('firmware', file);
  form.append('deviceId', selectedId);
  form.append('major', major);
  form.append('minor', minor);
  form.append('patch', patch);

  const btn = document.getElementById('btnUpload');
  btn.disabled = true; btn.innerHTML = '⏳ Đang upload...';
  log(`📤 Upload v${major}.${minor}.${patch} → thiết bị "${selectedId}"...`);

  try {
    const res  = await apiFetch('/api/upload', { method: 'POST', body: form }, 30000);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload lỗi');
    log(`✅ Upload OK! Firmware v${data.meta.version} (${formatBytes(data.meta.size)}) đã lưu trên server`, 'ok');
    log(`   → Nhấn "Trigger OTA" để ra lệnh ESP32 tải về và flash STM32`, 'dim');
    // Auto tăng patch
    document.getElementById('v_patch').value = patch + 1;
    fetchDevices();
  } catch (e) {
    log('❌ Upload thất bại: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.innerHTML = '☁️ Upload lên Server';
    updateUploadBtn();
  }
}

// ─── TRIGGER OTA ──────────────────────────────────────────────
async function triggerOTA() {
  if (!selectedId) { alert('Chọn thiết bị trước!'); return; }
  if (!confirm(`Trigger OTA cho thiết bị "${selectedId}"?\n\nESP32 sẽ tải firmware và flash STM32 qua UART.`)) return;

  const btn = document.getElementById('btnTrigger');
  btn.disabled = true; btn.innerHTML = '⏳ Đang trigger...';
  log(`🚀 Trigger OTA → "${selectedId}"...`);

  try {
    const res  = await apiFetch('/api/trigger-ota', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ deviceId: selectedId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Trigger lỗi');
    log('✅ ' + data.message, 'ok');
    log('⏳ Theo dõi trạng thái thiết bị bên dưới...', 'dim');
    fetchDevices();
  } catch (e) {
    log('❌ Trigger thất bại: ' + e.message, 'err');
    btn.disabled = false; btn.innerHTML = '🚀 Trigger OTA';
  }
}

// ─── INIT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  log('Cloud OTA Dashboard sẵn sàng.', 'dim');
  log('1. Nhập URL cloud server → Kết nối', 'dim');
  log('2. Danh sách ESP32 online sẽ hiện bên dưới', 'dim');
  log('3. Chọn thiết bị → Upload firmware → Trigger OTA', 'dim');
  updateUploadBtn();
});