/**
 * ESP32 Control Panel — ota.js  v5.0
 * Gồm: OTA Manager logic + Dashboard sensor logic
 */

// ── Shared state ────────────────────────────────────────────────
let pollTimer  = null;
let selectedId = null;   // OTA selected device
let lastList   = [];

const SERVER = () => window.location.origin;

// ── Helpers ─────────────────────────────────────────────────────
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

// ── Log (OTA tab) ────────────────────────────────────────────────
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

// ── Fetch wrapper ────────────────────────────────────────────────
async function api(path, opts = {}, timeout = 10000) {
  const ctrl = new AbortController();
  const tm   = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(SERVER() + path, { ...opts, signal: ctrl.signal });
    clearTimeout(tm);
    return res;
  } catch(e) { clearTimeout(tm); throw e; }
}

// ── Server health check ─────────────────────────────────────────
async function checkServer() {
  const pill   = document.getElementById('serverPill');
  const status = document.getElementById('serverStatus');
  try {
    const res = await api('/health', {}, 5000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    pill.className = 'topbar-pill online';
    status.textContent = 'Server online';
    log('✅ Kết nối server: ' + SERVER(), 'ok');
    startPolling();
  } catch(e) {
    pill.className = 'topbar-pill offline';
    status.textContent = 'Mất kết nối';
    log('❌ Không kết nối server: ' + e.message, 'err');
    setTimeout(checkServer, 5000);
  }
}

// ── Polling ──────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  fetchAll();
  pollTimer = setInterval(fetchAll, 3000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

let tickCount = 0;
async function fetchAll() {
  tickCount++;
  const lbl = document.getElementById('refreshTick');
  if (lbl) lbl.textContent = `Lần ${tickCount} · làm mới mỗi 3s`;

  try {
    const res = await api('/api/devices', {}, 4000);
    if (!res.ok) return;
    lastList = await res.json();
    renderDevices(lastList);
    populateDashSelector(lastList);
  } catch { /* silent */ }

  fetchDashboard();
}

// ═══════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════

let dashDeviceId = null;
let sparkData    = {};  // key → array of values for sparklines
let sparkCtx     = {};  // key → {canvas, ctx, color}

const METRICS_CFG = [
  { key: 'temp',  label: 'Nhiệt độ',  unit: '°C', icon: '🌡️', color: '#f47067', max: 100 },
  { key: 'humi',  label: 'Độ ẩm',     unit: '%',  icon: '💧', color: '#4f9cf9', max: 100 },
  { key: 'pres',  label: 'Áp suất',   unit: 'hPa', icon: '🌀', color: '#bd7cf6', max: 1100, min: 900 },
  { key: 'light', label: 'Ánh sáng',  unit: 'lux', icon: '☀️', color: '#f0c93a', max: 1000 },
  { key: 'co2',   label: 'CO₂',       unit: 'ppm', icon: '🍃', color: '#34d058', max: 5000 },
  { key: 'vcc',   label: 'Điện áp',   unit: 'V',   icon: '⚡', color: '#39c5cf', max: 5 },
];

function populateDashSelector(list) {
  const sel = document.getElementById('dashDeviceSelect');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Chọn thiết bị —</option>';
  list.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${d.name}${d.online ? ' 🟢' : ' ⚫'}`;
    sel.appendChild(opt);
  });
  if (cur && list.find(d => d.id === cur)) sel.value = cur;
  if (!dashDeviceId && list.length) {
    dashDeviceId = list[0].id;
    sel.value = dashDeviceId;
  }
}

function onDashDeviceChange() {
  const sel = document.getElementById('dashDeviceSelect');
  dashDeviceId = sel.value || null;
  sparkData = {};
  sparkCtx  = {};
  document.getElementById('sparkRow').innerHTML = '';
  document.getElementById('metricGrid').innerHTML = '';
  fetchDashboard();
}

async function fetchDashboard() {
  if (!dashDeviceId) {
    document.getElementById('dashEmpty').style.display = 'block';
    document.getElementById('dashContent').style.display = 'none';
    return;
  }
  const tick = document.getElementById('dashTick');
  if (tick) tick.textContent = `Cập nhật lần ${tickCount}`;

  try {
    const res = await api(`/api/sensor?id=${encodeURIComponent(dashDeviceId)}`, {}, 5000);
    if (!res.ok) return;
    const history = await res.json();   // array of {ts, temp, humi, ...}

    // update online badge
    const dev = lastList.find(d => d.id === dashDeviceId);
    const badge = document.getElementById('dashOnlineBadge');
    if (badge && dev) {
      badge.innerHTML = dev.online
        ? `<span class="badge badge-green"><span class="dot" style="background:currentColor"></span>Online</span>`
        : `<span class="badge" style="color:var(--dim);border:1px solid var(--border);">Offline</span>`;
    }

    if (!history.length) {
      document.getElementById('dashEmpty').style.display = 'block';
      document.getElementById('dashContent').style.display = 'none';
      document.getElementById('dashEmpty').innerHTML = '<span class="emo">📭</span>Thiết bị chưa gửi dữ liệu cảm biến nào.';
      return;
    }

    document.getElementById('dashEmpty').style.display = 'none';
    document.getElementById('dashContent').style.display = 'block';

    const latest = history[history.length - 1];
    renderMetricTiles(latest);
    updateSparklines(history);
    renderInfoRow(dev, latest);
  } catch { /* silent */ }
}

function renderMetricTiles(latest) {
  const grid = document.getElementById('metricGrid');
  const activeKeys = METRICS_CFG.filter(m => latest[m.key] !== undefined);
  if (!activeKeys.length) return;

  grid.innerHTML = activeKeys.map(m => {
    const val  = parseFloat(latest[m.key]);
    const min  = m.min || 0;
    const pct  = Math.max(0, Math.min(100, ((val - min) / ((m.max||100) - min)) * 100));
    const disp = isNaN(val) ? '—' : val.toFixed(m.key === 'vcc' ? 2 : 1);
    return `
    <div class="metric-tile" style="--tile-color:${m.color}">
      <div class="metric-icon">${m.icon}</div>
      <div class="metric-label">${m.label}</div>
      <div class="metric-value">${disp}<span class="metric-unit"> ${m.unit}</span></div>
      <div class="metric-bar"><div class="metric-bar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}

function updateSparklines(history) {
  const row = document.getElementById('sparkRow');
  const activeKeys = METRICS_CFG.filter(m => history.some(h => h[m.key] !== undefined));

  activeKeys.forEach(m => {
    const vals = history.map(h => parseFloat(h[m.key])).filter(v => !isNaN(v));
    if (!vals.length) return;

    // Create card if not exists
    if (!sparkCtx[m.key]) {
      const card = document.createElement('div');
      card.className = 'spark-card';
      card.id = `spark-${m.key}`;
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="spark-label">${m.icon} ${m.label}</span>
          <span class="spark-cur" id="scur-${m.key}" style="color:${m.color}">—</span>
        </div>
        <canvas id="scanv-${m.key}" height="70"></canvas>`;
      row.appendChild(card);
      const canvas = document.getElementById(`scanv-${m.key}`);
      sparkCtx[m.key] = { canvas, ctx: canvas.getContext('2d'), color: m.color, unit: m.unit };
    }

    // Update current value
    const cur = vals[vals.length - 1];
    document.getElementById(`scur-${m.key}`).textContent =
      cur.toFixed(m.key === 'vcc' ? 2 : 1) + ' ' + m.unit;

    // Draw sparkline
    drawSparkline(sparkCtx[m.key], vals);
  });
}

function drawSparkline({ canvas, ctx, color }, vals) {
  const W = canvas.offsetWidth || canvas.parentElement.offsetWidth || 300;
  const H = 70;
  canvas.width  = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const pad = 6;
  const toX = i => pad + (i / (vals.length - 1 || 1)) * (W - pad*2);
  const toY = v => H - pad - ((v - min) / range) * (H - pad*2);

  ctx.clearRect(0, 0, W, H);

  // gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, color + '44');
  grad.addColorStop(1, color + '00');
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(vals[0]));
  vals.forEach((v, i) => { if (i) ctx.lineTo(toX(i), toY(v)); });
  ctx.lineTo(toX(vals.length-1), H);
  ctx.lineTo(toX(0), H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // line
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.moveTo(toX(0), toY(vals[0]));
  vals.forEach((v, i) => { if (i) ctx.lineTo(toX(i), toY(v)); });
  ctx.stroke();

  // dot at latest
  const lx = toX(vals.length-1), ly = toY(vals[vals.length-1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 4, 0, Math.PI*2);
  ctx.fillStyle = color;
  ctx.fill();
}

function renderInfoRow(dev, latest) {
  const row = document.getElementById('dashInfoRow');
  if (!row) return;
  const ts = latest.ts ? new Date(latest.ts).toLocaleTimeString('vi-VN') : '—';
  const lastSeen = dev ? timeSince(dev.lastSeen) : '—';
  row.innerHTML = `
    <div class="info-item">🕐 Cập nhật lúc: <strong>${ts}</strong></div>
    <div class="info-item">📡 Heartbeat: <strong>${lastSeen}</strong></div>
    <div class="info-item">🔖 STM32 ver: <strong>${dev?.version || '—'}</strong></div>
    <div class="info-item">🌐 IP: <strong>${dev?.ip || '—'}</strong></div>`;
}

// ═══════════════════════════════════════════════════════════════
//  OTA MANAGER
// ═══════════════════════════════════════════════════════════════

function onFileChange() {
  const f = document.getElementById('fileInput').files[0];
  document.getElementById('fileName').textContent =
    f ? `📄 ${f.name}  (${fmtBytes(f.size)})` : '';
  syncButtons();
}

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
  if (selectedId && !list.find(d => d.id === selectedId)) {
    selectedId = null; updateSelLabel();
  }
  container.innerHTML = list.map((dev, i) => {
    const isOn  = dev.online;
    const isSel = dev.id === selectedId;
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
          <div class="dev-id" style="color:var(--dim);">IP: ${dev.ip || '—'}</div>
        </div>
        <div class="dev-right">
          <span class="badge badge-blue" style="font-family:monospace;">STM32 v${esc(dev.version)}</span>
          <span style="font-size:10px;color:var(--dim);font-family:monospace;">${fwVer}</span>
        </div>
      </div>
      <div class="dev-row2">
        <span class="dev-meta">${timeSince(dev.lastSeen)}</span>
        <div style="display:flex;gap:6px;align-items:center;">${badge}</div>
      </div>
    </div>`;
  }).join('');
  syncButtons();
}

function selectDevice(id) {
  selectedId = (selectedId === id) ? null : id;
  document.querySelectorAll('.dev-card').forEach(el => el.classList.remove('is-selected'));
  if (selectedId) {
    const el = document.getElementById('dcard-' + selectedId);
    if (el) el.classList.add('is-selected');
  }
  updateSelLabel(); syncButtons();
}

function updateSelLabel() {
  const lbl = document.getElementById('selectedLabel');
  if (selectedId) { lbl.className = 'sel-tag'; lbl.textContent = selectedId; }
  else { lbl.className = 'sel-none'; lbl.textContent = '— Chưa chọn —'; }
}

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

async function uploadFirmware() {
  if (!selectedId) { alert('Chọn thiết bị trước!'); return; }
  const fileEl = document.getElementById('fileInput');
  if (!fileEl.files.length) { alert('Chọn file .bin trước!'); return; }
  const file  = fileEl.files[0];
  const major = parseInt(document.getElementById('v_major').value) || 1;
  const minor = parseInt(document.getElementById('v_minor').value) || 0;
  const patch = parseInt(document.getElementById('v_patch').value) || 0;
  const form  = new FormData();
  form.append('firmware', file);
  form.append('deviceId', selectedId);
  form.append('major', major); form.append('minor', minor); form.append('patch', patch);
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
    fetchAll();
  } catch(e) {
    log('❌ Upload thất bại: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '☁️ Upload lên Server';
    syncButtons();
  }
}

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
    fetchAll();
  } catch(e) {
    log('❌ Trigger thất bại: ' + e.message, 'err');
    btn.disabled = false;
    btn.innerHTML = '🚀 Kích hoạt OTA cho thiết bị đang chọn';
  }
}

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  log('ESP32 Control Panel v5.0 — khởi động...', 'info');
  log(`Server: ${SERVER()}`, 'info');
  checkServer();
  syncButtons();
});
