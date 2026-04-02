const CMD_OTA_START = 0xA5;
const ACK = 0x06;
const NAK = 0x15;
const CHUNK_SIZE = 256;

// ---------- STATE ----------
let port = null;
let reader = null;
let writer = null;
let isConnected = false;

// ---------- UI ----------
function updateUI() {
  const btn = document.getElementById("btnConnect");
  const status = document.getElementById("status");
  const otaBtn = document.getElementById("btnOTA");

  if (isConnected) {
    btn.textContent = "Disconnect";
    status.textContent = "Connected";
    status.style.color = "green";
    otaBtn.disabled = false;
  } else {
    btn.textContent = "Connect";
    status.textContent = "Disconnected";
    status.style.color = "red";
    otaBtn.disabled = true;
  }
}

// ---------- LOG ----------
function clearLog() {
  document.getElementById("log").textContent = "";
}

function log(msg) {
  const el = document.getElementById("log");
  const t = new Date().toLocaleTimeString();
  el.textContent += `[${t}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

// ---------- VERSION ----------
function encodeVersion(major, minor, patch) {
  return (major << 16) | (minor << 8) | patch;
}

function getVersion() {
  const major = parseInt(v_major.value) || 1;
  const minor = parseInt(v_minor.value) || 0;
  const patch = parseInt(v_patch.value) || 0;

  return {
    major, minor, patch,
    encoded: encodeVersion(major, minor, patch)
  };
}

function autoPatch() {
  v_patch.value = (parseInt(v_patch.value) || 0) + 1;
}

// ---------- CRC ----------
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : (crc >>> 1);
    }
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

// ---------- SERIAL ----------
async function toggleConnection() {
  if (!isConnected) await connect();
  else await disconnect();
}

async function connect() {
  try {
    clearLog();

    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });

    writer = port.writable.getWriter();
    reader = port.readable.getReader();

    isConnected = true;
    updateUI();

    log("Connected");
  } catch (e) {
    log("Connect error: " + e);
  }
}

async function disconnect() {
  try {
    if (reader) {
      await reader.cancel();
      reader.releaseLock();
      reader = null;
    }

    if (writer) {
      writer.releaseLock();
      writer = null;
    }

    if (port) {
      await port.close();
      port = null;
    }

    isConnected = false;
    updateUI();

    log("Disconnected");
  } catch (e) {
    log("Disconnect error: " + e);
  }
}

// ---------- IO ----------
async function readByte(timeout = 5000) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject("Timeout"), timeout)
  );

  const result = await Promise.race([reader.read(), timer]);

  if (result.done) throw "Disconnected";
  return result.value[0];
}

async function expectACK(label = "") {
  const b = await readByte();
  if (b === ACK) log("ACK " + label);
  else if (b === NAK) throw "NAK " + label;
  else throw "Unknown: " + b;
}

// ---------- OTA ----------
async function startOTA() {
  if (!isConnected) {
    alert("Not connected");
    return;
  }

  clearLog();

  try {
    const file = fileInput.files[0];
    if (!file) throw "No firmware file";

    const fw = new Uint8Array(await file.arrayBuffer());
    const size = fw.length;
    const crc = crc32(fw);

    const v = getVersion();

    log("==== OTA START ====");
    log(`Size: ${size}`);
    log(`Version: ${v.major}.${v.minor}.${v.patch}`);
    log(`CRC32: 0x${crc.toString(16)}`);

    // ---- START ----
    await writer.write(Uint8Array.from([CMD_OTA_START]));
    await expectACK("START");

    // ---- METADATA ----
    const meta = new Uint8Array(12);
    const dv = new DataView(meta.buffer);

    dv.setUint32(0, size, true);
    dv.setUint32(4, v.encoded, true);
    dv.setUint32(8, crc, true);

    await writer.write(meta);
    await expectACK("METADATA");

    // ---- CHUNKS ----
    const total = Math.ceil(size / CHUNK_SIZE);

    for (let i = 0; i < total; i++) {
      let chunk = fw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      let c16 = crc16(chunk);

      let packet = new Uint8Array(chunk.length + 2);
      packet.set(chunk);
      new DataView(packet.buffer).setUint16(chunk.length, c16, true);

      for (let retry = 0; retry < 3; retry++) {
        await writer.write(packet);
        let b = await readByte();

        if (b === ACK) break;
        if (b === NAK && retry === 2)
          throw `Chunk ${i} failed`;
      }

      log(`Chunk ${i+1}/${total}`);
    }

    // ---- DONE ----
    await expectACK("DONE");

    log("==== OTA SUCCESS ====");
  } catch (e) {
    log("ERROR: " + e);
  }
}

// ---------- INIT ----------
updateUI();