// Maker Sumo RP2350 Configurator
// Talks to the RcSumo (protocol 2) and AutoRcSumo (protocol 6) firmware from the
// MakerSumoRP2350 Arduino library over Web Serial. No build step, no dependencies.

"use strict";

const APP_VERSION = "1.0.0";
const BAUD = 115200;
const SUPPORTED_DEVICES = ["MAKER_SUMO_RP2350"];
const SUPPORTED_PROTOCOLS = [2, 6];
const SENSOR_INTERVAL_MS = 250;

// ---- Field definitions (order matches the firmware's GET/SAVE lines) --------
const AUTO_FIELDS = [
  { key: "searchL",       label: "Search, left motor",       unit: "%",  min: -100, max: 100 },
  { key: "searchR",       label: "Search, right motor",      unit: "%",  min: -100, max: 100 },
  { key: "backSpeed",     label: "Edge escape speed",        unit: "%",  min: 0,    max: 100 },
  { key: "backMs",        label: "Edge escape reverse time", unit: "ms", min: 0,    max: 10000 },
  { key: "turnSpeed",     label: "Edge escape turn speed",   unit: "%",  min: 0,    max: 100 },
  { key: "turnMs",        label: "Edge escape turn time",    unit: "ms", min: 0,    max: 10000 },
  { key: "attackInitial", label: "Attack, initial speed",    unit: "%",  min: 0,    max: 100 },
  { key: "attackMs",      label: "Attack, ramp time",        unit: "ms", min: 0,    max: 10000 },
  { key: "attackMax",     label: "Attack, full speed",       unit: "%",  min: 0,    max: 100 },
];
const DEF_FIELDS = [
  { key: "reps",   label: "Repetitions",        unit: "",   min: 0, max: 100 },
  { key: "waitMs", label: "Wait before moving", unit: "ms", min: 1, max: 10000 },
  { key: "left",   label: "Move, left motor",   unit: "%",  min: 0, max: 100 },
  { key: "right",  label: "Move, right motor",  unit: "%",  min: 0, max: 100 },
  { key: "moveMs", label: "Move time",          unit: "ms", min: 1, max: 10000 },
];
const STRATEGIES = [
  { id: 0, dip: "OFF OFF OFF" },
  { id: 1, dip: "OFF OFF ON" },
  { id: 2, dip: "OFF ON OFF" },
  { id: 3, dip: "OFF ON ON" },
  { id: 4, dip: "ON OFF OFF" },
  { id: 6, dip: "ON ON OFF" },
];
const STEP_ROWS = 5;

// ---- Serial API: native Web Serial, or the WebUSB-based polyfill on Android --
let serialApi = null;        // navigator.serial, or an adapter over the WebUSB polyfill
let usingPolyfill = false;
const BOARD_USB_VID = 0x2E8A;   // Raspberry Pi (Cytron Maker Sumo RP2350 = 2E8A:112F)

async function pickSerialApi() {
  if ("serial" in navigator) { serialApi = navigator.serial; return true; }
  if ("usb" in navigator) {
    try {
      const mod = await import("./vendor/web-serial-polyfill.js");
      usingPolyfill = true;
      // Ask Android for the board by vendor id (or any CDC device), then wrap
      // it with the polyfill's SerialPort. Avoids the class-only filter, which
      // some Android builds fail to match on composite (class 0xEF) devices.
      serialApi = {
        async requestPort() {
          const device = await navigator.usb.requestDevice({
            filters: [{ vendorId: BOARD_USB_VID }, { classCode: 2 }],
          });
          return new mod.SerialPort(device);
        },
      };
      return true;
    } catch (err) {
      console.error("polyfill failed to load", err);
    }
  }
  return false;
}

// ---- State ------------------------------------------------------------------
let port = null, reader = null, writer = null, readLoop = null;
let pending = null;          // { prefix, resolve, reject, timer }
let queue = Promise.resolve();
let firmware = null;         // { device, fw, version, protocol, lib }
let sensorTimer = null;
let currentStrategy = 0;
const strategyCache = {};    // id -> array of 20 numbers
let robotMode = null;        // "rc" | "auto" | null (unknown / not connected)
let robotDip = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---- Logging / status -------------------------------------------------------
const logBox = $("#logBox");
function log(direction, text) {
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  logBox.textContent += `${stamp} ${direction} ${text}\n`;
  const lines = logBox.textContent.split("\n");
  if (lines.length > 200) logBox.textContent = lines.slice(-200).join("\n");
  logBox.scrollTop = logBox.scrollHeight;
}
function status(text, kind = "") {
  const el = $("#status");
  el.textContent = text;
  el.className = "status " + kind;
}

// ---- Serial transport --------------------------------------------------------
async function openPort() {
  port = await serialApi.requestPort();
  await port.open({ baudRate: BAUD });
  writer = port.writable.getWriter();
  const decoder = new TextDecoderStream();
  port.readable.pipeTo(decoder.writable).catch(() => {});
  reader = decoder.readable.getReader();
  readLoop = (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (line) handleLine(line);
        }
      }
    } catch (err) {
      log("!!", `read error: ${err.message}`);
    }
    if (port) disconnect("The board went away.");
  })();
}

function handleLine(line) {
  log("<<", line);
  if (pending && (line.startsWith(pending.prefix) || line.startsWith("ERROR"))) {
    clearTimeout(pending.timer);
    const p = pending;
    pending = null;
    if (line.startsWith("ERROR")) p.reject(new Error(describeError(line)));
    else p.resolve(line);
  }
}

function describeError(line) {
  const code = line.slice(6).trim();
  const known = {
    VALUE: "The board rejected a value as out of range.",
    CONFIG_REQUIRED: "The board is not in configuration mode.",
    COMMAND: "The board did not understand the command.",
    TOO_LONG: "The command was too long for the board.",
    INVALID_VALUE: "The board rejected a value as out of range.",
    UNKNOWN_COMMAND: "The board did not understand the command.",
    STRATEGY: "That strategy number is not editable.",
  };
  return known[code] || `The board replied ${line}`;
}

// Send one command and wait for a reply starting with `prefix`. Calls are
// serialised so replies can never be matched to the wrong request.
function request(command, prefix, timeoutMs = 1500) {
  const run = () => new Promise(async (resolve, reject) => {
    if (!writer) return reject(new Error("Not connected."));
    pending = { prefix, resolve, reject, timer: null };
    pending.timer = setTimeout(() => {
      if (pending) { pending = null; reject(new Error(`No reply to ${command}.`)); }
    }, timeoutMs);
    log(">>", command);
    try {
      await writer.write(new TextEncoder().encode(command + "\n"));
    } catch (err) {
      clearTimeout(pending.timer); pending = null; reject(err);
    }
  });
  queue = queue.then(run, run);
  return queue;
}

// ---- Connect / disconnect ---------------------------------------------------
async function connect() {
  const btn = $("#connectBtn");
  btn.disabled = true;
  setChip("Connecting…", "busy");
  try {
    await openPort();
    firmware = await handshake();
    document.body.classList.toggle("fw-rc", firmware.protocol === 2);
    setChip(`${firmware.fw} ${firmware.version} · library ${firmware.lib || "?"}`, "live");
    btn.textContent = "Disconnect";
    if (firmware.protocol === 6) {
      await request("CONFIG ON", "OK CONFIG");
      $("#lockNotice").hidden = false;
    }
    await loadEverything();
    startSensors();
    setEnabled(true);
    status("Connected. Settings loaded from the board.", "ok");
  } catch (err) {
    await disconnect(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function handshake() {
  let lastError = "The board did not answer HELLO.";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const line = await request("HELLO", "OK DEVICE=", 700);
      const fields = Object.fromEntries(
        line.slice(3).trim().split(/\s+/).map((kv) => kv.split("=")));
      const protocol = Number(fields.PROTOCOL);
      if (!SUPPORTED_DEVICES.includes(fields.DEVICE))
        throw new Error(`This is a ${fields.DEVICE || "different"} board, not a Maker Sumo RP2350.`);
      if (!SUPPORTED_PROTOCOLS.includes(protocol))
        throw new Error(`Firmware protocol ${fields.PROTOCOL} is not supported by this configurator (${SUPPORTED_PROTOCOLS.join(", ")}).`);
      return { device: fields.DEVICE, fw: fields.FW || "RC", version: fields.VERSION || "?", protocol, lib: fields.LIB };
    } catch (err) {
      lastError = err.message;
      if (!/No reply/.test(err.message)) break;   // real rejection: stop retrying
    }
  }
  throw new Error(lastError + " Check that the RcSumo or AutoRcSumo sketch is running and the serial monitor is closed.");
}

async function disconnect(reason) {
  stopSensors();
  setEnabled(false);
  // Unlock the robot before closing the port (AutoRC locks the motors in CONFIG ON).
  if (port && writer && firmware && firmware.protocol === 6) {
    try { await request("CONFIG OFF", "OK CONFIG OFF", 500); } catch { /* port may already be gone */ }
  }
  $("#lockNotice").hidden = true;
  const p = port; port = null; firmware = null;
  if (pending) { clearTimeout(pending.timer); pending.reject(new Error("Disconnected.")); pending = null; }
  try { if (reader) await reader.cancel(); } catch {}
  try { if (writer) { writer.releaseLock(); } } catch {}
  reader = null; writer = null;
  try { if (p) await p.close(); } catch {}
  document.body.classList.remove("fw-rc");
  applyMode(null, null);
  setChip("Not connected", "idle");
  $("#connectBtn").textContent = "Connect";
  $("#connectBtn").disabled = false;
  if (reason) status(reason, /Disconnected|went away/.test(reason) ? "" : "err");
}

function setChip(text, kind) {
  const chip = $("#deviceChip");
  chip.textContent = text;
  chip.className = `chip chip-${kind}`;
}

function setEnabled(on) {
  $$(".tab").forEach((t) => { if (!t.classList.contains("is-locked")) t.disabled = !on; });
  $$(".panel button, .panel input").forEach((el) => {
    if (el.classList.contains("needs-autorc") && firmware && firmware.protocol !== 6) el.disabled = true;
    else el.disabled = !on;
  });
  $("#connectBtn").disabled = false;
  $(".live").classList.toggle("offline", !on);
}

// ---- Load settings ----------------------------------------------------------
async function loadEverything() {
  const cfg = await request("GET CONFIG", "CONFIG");
  const m = cfg.match(/F=(-?\d+)\s+B=(-?\d+)/);
  if (m) { setTrim("F", Number(m[1])); setTrim("B", Number(m[2])); }

  const rc = await request("GET RC", "RC MAP=");
  const map = rc.slice(7).trim();
  const radio = document.querySelector(`input[name=rcMap][value="${map}"]`);
  if (radio) radio.checked = true;

  if (firmware.protocol !== 6) return;
  fillFields("#autoFields", AUTO_FIELDS, parseNumbers(await request("GET AUTO", "AUTO")));
  fillFields("#defFields", DEF_FIELDS, parseNumbers(await request("GET DEF", "DEF")));
  for (const s of STRATEGIES) {
    const line = await request(`GET STR ${s.id}`, `STR ${s.id} `);
    strategyCache[s.id] = parseNumbers(line).slice(1);   // drop the id
  }
  showStrategy(currentStrategy);
}

function parseNumbers(line) {
  return line.split(/\s+/).slice(1).map(Number);
}

// ---- Trim -------------------------------------------------------------------
function setTrim(which, value) {
  $(`#trim${which}`).value = value;
  $(`#trim${which}Out`).value = value;
}
$$("#trimF, #trimB").forEach((input) => {
  input.addEventListener("input", () => { $(`#${input.id}Out`).value = input.value; });
});
$$("[data-save]").forEach((btn) => {
  btn.addEventListener("click", () => guarded(async () => {
    const which = btn.dataset.save;
    const value = Number($(`#trim${which}`).value);
    await request(`SAVE ${which} ${value}`, `OK SAVED ${which}=`);
    status(`${which === "F" ? "Forward" : "Backward"} trim saved: ${value}.`, "ok");
  }));
});

// ---- RC mapping -------------------------------------------------------------
$("#saveRc").addEventListener("click", () => guarded(async () => {
  const value = document.querySelector("input[name=rcMap]:checked").value;
  await request(`SAVE RC ${value}`, "OK SAVED RC=");
  status("RC channel mapping saved.", "ok");
}));

// ---- Generic number fields --------------------------------------------------
function buildFields(containerSel, defs, prefix) {
  const box = $(containerSel);
  box.innerHTML = "";
  for (const d of defs) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const id = `${prefix}-${d.key}`;
    wrap.innerHTML = `<label for="${id}">${d.label}</label>
      <input id="${id}" type="number" inputmode="numeric" min="${d.min}" max="${d.max}" step="1" required>
      <small>${d.min} to ${d.max}${d.unit ? " " + d.unit : ""}</small>`;
    box.appendChild(wrap);
  }
}
function fillFields(containerSel, defs, values) {
  defs.forEach((d, i) => {
    const input = $(`${containerSel} input[id$="-${d.key}"]`);
    if (input && values[i] !== undefined) input.value = values[i];
  });
}
function readFields(containerSel, defs) {
  const out = [];
  for (const d of defs) {
    const input = $(`${containerSel} input[id$="-${d.key}"]`);
    const v = Number(input.value);
    if (input.value === "" || !Number.isInteger(v) || v < d.min || v > d.max) {
      input.focus();
      throw new Error(`"${d.label}" must be a whole number from ${d.min} to ${d.max}.`);
    }
    out.push(v);
  }
  return out;
}
buildFields("#autoFields", AUTO_FIELDS, "auto");
buildFields("#defFields", DEF_FIELDS, "def");

$("#saveAuto").addEventListener("click", () => guarded(async () => {
  const values = readFields("#autoFields", AUTO_FIELDS);
  await request(`SAVE AUTO ${values.join(" ")}`, "OK SAVED AUTO");
  status("Fight settings saved.", "ok");
}));
$("#saveDef").addEventListener("click", () => guarded(async () => {
  const values = readFields("#defFields", DEF_FIELDS);
  await request(`SAVE DEF ${values.join(" ")}`, "OK SAVED DEF");
  status("Defense saved.", "ok");
}));

// ---- Strategies -------------------------------------------------------------
function buildStrategyUi() {
  const picker = $("#strPicker");
  for (const s of STRATEGIES) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.id = s.id;
    b.innerHTML = `DIP ${s.id}<small>${s.dip}</small>`;
    b.addEventListener("click", () => { rememberStrategyEdits(); showStrategy(s.id); });
    picker.appendChild(b);
  }
  const rows = $("#strRows");
  for (let r = 0; r < STEP_ROWS; r++) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><input type="checkbox" data-r="${r}" aria-label="Enable move ${r + 1}"></td>
      <td><input type="number" data-r="${r}" data-c="1" min="-100" max="100" step="1" required></td>
      <td><input type="number" data-r="${r}" data-c="2" min="-100" max="100" step="1" required></td>
      <td><input type="number" data-r="${r}" data-c="3" min="1" max="10000" step="1" required></td>`;
    tr.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
      tr.classList.toggle("is-off", !e.target.checked);
    });
    rows.appendChild(tr);
  }
}
buildStrategyUi();

function showStrategy(id) {
  currentStrategy = id;
  $$("#strPicker button").forEach((b) => b.classList.toggle("is-active", Number(b.dataset.id) === id));
  const values = strategyCache[id] || Array.from({ length: 20 }, (_, i) => (i % 4 === 3 ? 100 : 0));
  $$("#strRows tr").forEach((tr, r) => {
    const base = r * 4;
    tr.querySelector("input[type=checkbox]").checked = values[base] === 1;
    tr.classList.toggle("is-off", values[base] !== 1);
    tr.querySelector('[data-c="1"]').value = values[base + 1];
    tr.querySelector('[data-c="2"]').value = values[base + 2];
    tr.querySelector('[data-c="3"]').value = values[base + 3];
  });
}
function readStrategy() {
  const out = [];
  $$("#strRows tr").forEach((tr, r) => {
    const on = tr.querySelector("input[type=checkbox]").checked ? 1 : 0;
    const cells = [1, 2, 3].map((c) => {
      const input = tr.querySelector(`[data-c="${c}"]`);
      const v = Number(input.value);
      const [min, max] = c === 3 ? [1, 10000] : [-100, 100];
      if (input.value === "" || !Number.isInteger(v) || v < min || v > max) {
        input.focus();
        throw new Error(`Move ${r + 1}: ${c === 3 ? "duration" : c === 1 ? "left" : "right"} must be from ${min} to ${max}.`);
      }
      return v;
    });
    out.push(on, ...cells);
  });
  return out;
}
function rememberStrategyEdits() {
  try { strategyCache[currentStrategy] = readStrategy(); } catch {}
}
$("#saveStr").addEventListener("click", () => guarded(async () => {
  const values = readStrategy();
  await request(`SAVE STR ${currentStrategy} ${values.join(" ")}`, `OK SAVED STR ${currentStrategy}`);
  strategyCache[currentStrategy] = values;
  status(`Opening moves for DIP ${currentStrategy} saved.`, "ok");
}));

// ---- Mode lock: follow the DIP switches -------------------------------------
// DIP 7 (ON ON ON) = RC driving; DIP 0-6 = autonomous strategies. The pages
// that don't apply to the current mode are locked so settings can't be edited
// for a mode the robot isn't in. RcSumo firmware is always RC.
function applyMode(mode, dip) {
  if (mode === robotMode && dip === robotDip) return;
  robotMode = mode; robotDip = dip;

  const chip = $("#modeChip");
  const notice = $("#modeNotice");
  if (!mode) {
    chip.hidden = true;
    notice.hidden = true;
    $$(".tab").forEach((t) => { t.classList.remove("is-locked"); t.disabled = !port; t.title = ""; });
    return;
  }
  chip.hidden = false;
  chip.className = `chip chip-mode-${mode}`;
  chip.textContent = mode === "rc" ? "RC mode · DIP 7" : `Auto mode · DIP ${dip}`;

  const lockRc   = mode === "auto";
  const lockAuto = mode === "rc";
  $$(".tab-rc").forEach((t) => setTabLock(t, lockRc, "Set the DIP switches to 7 (ON ON ON) to edit RC settings"));
  $$(".tab-auto").forEach((t) => setTabLock(t, lockAuto && firmware?.protocol === 6, "Set the DIP switches to 0-6 to edit auto settings"));

  notice.hidden = false;
  notice.textContent = mode === "rc"
    ? "Robot is in RC mode (DIP 7). Fight, Defense and Opening moves are locked; set DIP 0-6 to edit them."
    : `Robot is in Auto mode (DIP ${dip}). RC channels is locked; set DIP 7 (ON ON ON) to edit it.`;

  // If the open page just got locked, move to the first usable one.
  const active = $(".tab.is-active");
  if (active && active.disabled) {
    const next = $$(".tab").find((t) => !t.disabled && t.offsetParent !== null);
    if (next) next.click();
  }
}

function setTabLock(tab, locked, hint) {
  tab.classList.toggle("is-locked", locked);
  tab.disabled = locked;
  tab.title = locked ? hint : "";
}

// ---- Live sensors -----------------------------------------------------------
function startSensors() {
  stopSensors();
  const tick = async () => {
    if (!port) return;
    try {
      const line = await request("GET SENSOR", "SENSOR", 800);
      renderSensors(parseNumbers(line));
    } catch { /* keep polling; the transport reports persistent failures */ }
    if (port) sensorTimer = setTimeout(tick, SENSOR_INTERVAL_MS);
  };
  tick();
}
function stopSensors() { clearTimeout(sensorTimer); sensorTimer = null; }

function renderSensors(v) {
  // protocol 6: opp edgeL edgeR pot rcT rcS start dip state batt
  // protocol 2: opp edgeL edgeR start dip 98 batt
  const six = v.length >= 10;
  const opp = v[0], edgeL = v[1], edgeR = v[2];
  const start = six ? v[6] : v[3];
  const dip = six ? v[7] : v[4];
  const batt = six ? v[9] : v[6];
  applyMode(six ? (dip === 7 ? "rc" : "auto") : "rc", dip);
  ["L", "FL", "FC", "FR", "R"].forEach((name, i) => {
    $(`#beam${name}`).classList.toggle("on", Boolean(opp & (1 << i)));
  });
  $("#rdEdgeL").textContent = edgeL;
  $("#rdEdgeR").textContent = edgeR;
  $("#rdStart").textContent = start === 0 ? "pressed" : "released";
  $("#rdDip").textContent = `${dip} (${dip.toString(2).padStart(3, "0").replace(/1/g, "ON ").replace(/0/g, "OFF ").trim()})`;
  const battEl = $("#rdBatt");
  battEl.textContent = `${Number(batt).toFixed(2)} V`;
  battEl.classList.toggle("warn", Number(batt) > 0 && Number(batt) < 6.4);
  if (six) {
    $("#rdPot").textContent = v[3];
    $("#rdRcT").textContent = v[4] ? `${v[4]} µs` : "no signal";
    $("#rdRcS").textContent = v[5] ? `${v[5]} µs` : "no signal";
  }
  // Edge sensors have no fixed threshold in the UI; show as "lit" when the
  // reading is in the lower third of the ADC range (white line under a dark ring).
  $("#edgeL").classList.toggle("on", edgeL < 340);
  $("#edgeR").classList.toggle("on", edgeR < 340);
}

// ---- Backup -----------------------------------------------------------------
$("#exportBtn").addEventListener("click", () => guarded(async () => {
  const data = {
    app: APP_VERSION, firmware,
    trim: { forward: Number($("#trimF").value), backward: Number($("#trimB").value) },
    rcMapping: Number(document.querySelector("input[name=rcMap]:checked").value),
  };
  if (firmware.protocol === 6) {
    rememberStrategyEdits();
    data.fight = readFields("#autoFields", AUTO_FIELDS);
    data.defense = readFields("#defFields", DEF_FIELDS);
    data.strategies = strategyCache;
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `maker-sumo-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  $("#backupStatus").textContent = "Settings file downloaded.";
}));

$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  await guarded(async () => {
    const data = JSON.parse(await file.text());
    if (!data.trim) throw new Error("That file is not a Maker Sumo settings file.");
    let written = 0;
    await request(`SAVE F ${data.trim.forward}`, "OK SAVED F="); written++;
    await request(`SAVE B ${data.trim.backward}`, "OK SAVED B="); written++;
    if (data.rcMapping !== undefined) { await request(`SAVE RC ${data.rcMapping}`, "OK SAVED RC="); written++; }
    if (firmware.protocol === 6 && data.fight) {
      await request(`SAVE AUTO ${data.fight.join(" ")}`, "OK SAVED AUTO"); written++;
      await request(`SAVE DEF ${data.defense.join(" ")}`, "OK SAVED DEF"); written++;
      for (const s of STRATEGIES) {
        const values = data.strategies?.[s.id];
        if (!values) continue;
        await request(`SAVE STR ${s.id} ${values.join(" ")}`, `OK SAVED STR ${s.id}`); written++;
      }
    }
    await loadEverything();
    $("#backupStatus").textContent = `Loaded ${file.name}: ${written} settings written to the board.`;
    status("Settings file written to the board.", "ok");
  });
});

// ---- Tabs -------------------------------------------------------------------
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
    $$(".panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === tab.dataset.tab));
  });
});

// ---- Helpers ----------------------------------------------------------------
async function guarded(fn) {
  if (!port) { status("Connect to the board first.", "err"); return; }
  try {
    status("Working…");
    await fn();
  } catch (err) {
    status(err.message, "err");
  }
}

// ---- Boot -------------------------------------------------------------------
setEnabled(false);
pickSerialApi().then((ok) => {
  if (!ok) {
    $("#unsupported").hidden = false;
    $("#connectBtn").disabled = true;
    return;
  }
  $("#connectBtn").addEventListener("click", () => (port ? disconnect("Disconnected.") : connect()));
  if (usingPolyfill) {
    // Android: WebUSB through the polyfill. Unplug detection comes from the USB layer.
    $("#androidNote").hidden = false;
    navigator.usb.addEventListener("disconnect", () => { if (port) disconnect("The board was unplugged."); });
    // Diagnostic: show every USB device Android offers, with no class filter.
    $("#usbDiag").addEventListener("click", async () => {
      const out = $("#usbDiagOut");
      try {
        const dev = await navigator.usb.requestDevice({ filters: [] });
        const hex = (n) => n.toString(16).padStart(4, "0").toUpperCase();
        const ifaces = (dev.configurations?.[0]?.interfaces || [])
          .map((i) => `if${i.interfaceNumber}:class ${i.alternates?.[0]?.interfaceClass}`).join(", ");
        out.textContent = `Picked: ${hex(dev.vendorId)}:${hex(dev.productId)} ${dev.manufacturerName || ""} ${dev.productName || ""}` +
          ` | device class ${dev.deviceClass} | ${ifaces || "no interface info"}`;
      } catch (err) {
        out.textContent = `Picker: ${err.message}`;
      }
    });
  } else {
    navigator.serial.addEventListener("disconnect", (e) => { if (port && e.target === port) disconnect("The board was unplugged."); });
  }
});
