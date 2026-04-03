/**
 * ESP32 OTA Dashboard — ota.js
 * URL tự động = window.location.origin (cùng server host trang)
 */

// ── State ──────────────────────────────────────────────────────
let pollTimer  = null;
let selectedId = null;
let lastList   = [];

// ── Server URL: cùng origin với trang web ──────────────────────
const SERVER = () => window.location.origin;

// ── Helpers ────────────────────────────────────────────────────
const fmtBytes = n => {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
  return (n/1048576).toFixed(2) + ' MB';
};

const timeSince = ms => {
  if (!ms) return '—';
  const s = Math.round((Date.now()-ms)/1000);
  if (s < 5)    return 'vừa xong';
  if (s < 60)   return s + 's trước';
  if (s < 3600) return Math.floor(s/60) + 'm trước';
  return Math.floor(s/3600) + 'h trước';
};

const esc = s => String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ── Log ────────────────────────────────────────────────────────
const logEl = () => document.getElementById('log');
function clearLog() { logEl().innerHTML = ''; }

function log(msg, cls = '') {
  const el   = logEl();
  const t    = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${t}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ── File ───────────────────────────────────────────────────────
function onFileChange() {
  const f = document.getElementById('fileInput').files[0];
  document.getElementById('fileName').textContent =
    f ? `📄 ${f.name}  (${fmtBytes(f.size)})` : '';
  syncButtons();
}

// ── Fetch wrapper ──────────────────────────────────────────────
async function api(path, opts = {}, timeout = 10000) {
  const ctrl = new AbortController();
  const tm   = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(SERVER() + path, { ...opts, signal: ctrl.signal });
    clearTimeout(tm);
    return res;
  } catch(e) { clearTimeout(tm); throw e; }
}

// ── Server health check ────────────────────────────────────────
async function checkServer() {
  const pill   = document.getElementById('serverPill');
  const status = document.getElementById('serverStatus');
  const urlLbl = document.getElementById('serverUrlLabel');

  urlLbl.textContent = SERVER();

  try {
    const res = await api('/health', {}, 5000);
    if (!res.ok) throw new Error('HTTP ' + res.status);

    pill.className = 'server-pill online';
    status.textContent = 'Server online';
    log('✅ Kết nối server: ' + SERVER(), 'ok');
    startPolling();
  } catch(e) {
    pill.className = 'server-pill offline';
    status.textContent = 'Mất kết nối';
    log('❌ Không kết nối server: ' + e.message, 'err');
    setTimeout(checkServer, 5000);
  }
}

// ── Polling ────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  fetchDevices();
  pollTimer = setInterval(fetchDevices, 3000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

let tickCount = 0;
async function fetchDevices() {
  tickCount++;
  const lbl = document.getElementById('refreshTick');
  if (lbl) lbl.textContent = `Lần ${tickCount} · làm mới mỗi 3s`;

  try {
    const res  = await api('/api/devices', {}, 4000);
    if (!res.ok) return;
    lastList = await res.json();
    renderDevices(lastList);
  } catch { /* silent */ }
}

// ── Render devices ─────────────────────────────────────────────
function renderDevices(list) {
  const container = document.getElementById('deviceList');
  const empty     = document.getElementById('deviceEmpty');

  if (!list?.length) {
    container.innerHTML = '';
    empty.style.display = 'block';
    if (selectedId) { selectedId = null; syncButtons(); updateSelLabel(); }
    return;
  }

  empty.style.display = 'none';

  // Giữ selection nếu device vẫn tồn tại
  if (selectedId && !list.find(d => d.id === selectedId)) {
    selectedId = null;
    updateSelLabel();
  }

  container.innerHTML = list.map((dev, i) => {
    const isOn  = dev.online;
    const isSel = dev.id === selectedId;

    // OTA status badge
    let badge = '';
    if (dev.otaTrigger && dev.otaStatus === 'pending')
      badge = `<span class="badge badge-yellow"><span class="dot" style="background:currentColor"></span>OTA đang chờ</span>`;
    else if (dev.otaStatus === 'done')
      badge = `<span class="badge badge-green"><span class="dot" style="background:currentColor"></span>OTA thành công</span>`;
    else if (dev.otaStatus === 'error')
      badge = `<span class="badge badge-red"><span class="dot" style="background:currentColor"></span>OTA lỗi</span>`;
    else if (isOn)
      badge = `<span class="badge badge-green"><span class="dot" style="background:currentColor"></span>Online</span>`;
    else
      badge = `<span class="badge" style="color:var(--dim);border:1px solid var(--border);">Offline</span>`;

    const fwVer = dev.firmware ? `fw: v${dev.firmware.version}` : 'Chưa có firmware';
    const ip    = dev.ip || '—';

    return `
    <div class="dev-card ${isOn?'is-online':''} ${isSel?'is-selected':''} ${!isOn?'is-offline':''}"
         onclick="selectDevice('${esc(dev.id)}')" id="dcard-${esc(dev.id)}"
         style="animation-delay:${i*0.04}s">
      <div class="dev-row1">
        <div class="dev-left">
          <div class="dev-name">
            <span class="dot" style="background:${isOn?'var(--green)':'var(--dim)'}"></span>
            ${esc(dev.name)}
          </div>
          <div class="dev-id">${esc(dev.id)}</div>
          <div class="dev-ip">IP: ${ip}</div>
        </div>
        <div class="dev-right">
          <span class="badge badge-blue" style="font-family:monospace;">STM32 v${esc(dev.version)}</span>
          <span style="font-size:10px;color:var(--dim);font-family:monospace;">${fwVer}</span>
        </div>
      </div>
      <div class="dev-row2">
        <span class="dev-meta">${timeSince(dev.lastSeen)}</span>
        <div style="display:flex;gap:6px;align-items:center;">
          ${badge}
        </div>
      </div>
    </div>`;
  }).join('');

  syncButtons();
}

// ── Select device ──────────────────────────────────────────────
function selectDevice(id) {
  selectedId = (selectedId === id) ? null : id;
  document.querySelectorAll('.dev-card').forEach(el => {
    el.classList.remove('is-selected');
  });
  if (selectedId) {
    const el = document.getElementById('dcard-' + selectedId);
    if (el) el.classList.add('is-selected');
  }
  updateSelLabel();
  syncButtons();
}

function updateSelLabel() {
  const lbl = document.getElementById('selectedLabel');
  if (selectedId) {
    lbl.className   = 'sel-tag';
    lbl.textContent = selectedId;
  } else {
    lbl.className   = 'sel-none';
    lbl.textContent = '— Chưa chọn —';
  }
}

// ── Sync button states ─────────────────────────────────────────
function syncButtons() {
  const hasFile   = document.getElementById('fileInput').files.length > 0;
  const hasDev    = !!selectedId;
  const dev       = lastList.find(d => d.id === selectedId);
  const isOnline  = dev?.online;
  const hasFw     = !!dev?.firmware;
  const isPending = dev?.otaTrigger;

  document.getElementById('btnUpload').disabled  = !(hasFile && hasDev);
  document.getElementById('btnTrigger').disabled = !(hasDev && isOnline && hasFw && !isPending);
}

// ── Upload firmware ────────────────────────────────────────────
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
  btn.disabled = true;
  btn.innerHTML = '<span class="dot dot-pulse" style="background:#fff"></span> Đang upload...';
  log(`📤 Upload v${major}.${minor}.${patch} → "${selectedId}" (${fmtBytes(file.size)})...`);

  try {
    const res  = await api('/api/upload', { method:'POST', body:form }, 30000);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi upload');
    log(`✅ Upload OK! v${data.meta.version} — ${fmtBytes(data.meta.size)}`, 'ok');
    log(`   → Nhấn "Kích hoạt OTA" để ESP32 tải về và flash STM32`, 'info');
    document.getElementById('v_patch').value = patch + 1;
    fetchDevices();
  } catch(e) {
    log('❌ Upload thất bại: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '☁️ Upload lên Server';
    syncButtons();
  }
}

// ── Trigger OTA ────────────────────────────────────────────────
async function triggerOTA() {
  if (!selectedId) { alert('Chọn thiết bị!'); return; }
  if (!confirm(`Kích hoạt OTA cho "${selectedId}"?\n\nESP32 sẽ tải firmware và flash STM32 qua UART.`)) return;

  const btn = document.getElementById('btnTrigger');
  btn.disabled = true;
  btn.innerHTML = '<span class="dot dot-pulse" style="background:#fff"></span> Đang trigger...';
  log(`🚀 Trigger OTA → "${selectedId}"...`);

  try {
    const res  = await api('/api/trigger-ota', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ deviceId: selectedId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi trigger');
    log('✅ ' + data.message, 'ok');
    log('⏳ Đang theo dõi trạng thái ESP32...', 'info');
    fetchDevices();
  } catch(e) {
    log('❌ Trigger thất bại: ' + e.message, 'err');
    btn.disabled = false;
    btn.innerHTML = '🚀 Kích hoạt OTA cho thiết bị đang chọn';
  }
}

// ── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  log('ESP32 OTA Dashboard v4.0 — khởi động...', 'info');
  log(`Server: ${SERVER()}`, 'info');
  checkServer();
  syncButtons();
});
