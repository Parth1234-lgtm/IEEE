/* ===================================================================
   Popup Script (schemas.py-aligned)
   - Sends explicit RequestSchema via fetch to http://127.0.0.1:8000/process
   - Supports user_text, user_audio (.wav base64), and selected page text
   - Explicit responses are applied immediately on the active tab
   - Shows currently applied adaptations and provides Reset
   =================================================================== */

const BACKEND_URL = "http://127.0.0.1:8000/process";

const elUserText = document.getElementById("userText");
const btnGetSelection = document.getElementById("btnGetSelection");
const btnClearSelection = document.getElementById("btnClearSelection");
const elSelectionPreview = document.getElementById("selectionPreview");

const btnRecord = document.getElementById("btnRecord");
const btnClearAudio = document.getElementById("btnClearAudio");
const elAudioStatus = document.getElementById("audioStatus");

const btnSendExplicit = document.getElementById("btnSendExplicit");
const btnReset = document.getElementById("btnReset");
const btnRefreshApplied = document.getElementById("btnRefreshApplied");

const elAppliedUi = document.getElementById("appliedUi");
const elAppliedContent = document.getElementById("appliedContent");
const elStatus = document.getElementById("status");

let selectionText = "";
let audioBase64 = "";

function showStatus(msg) {
  elStatus.textContent = msg;
  elStatus.style.display = "block";
}
function clearStatus() {
  elStatus.style.display = "none";
  elStatus.textContent = "";
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      const tab = tabs && tabs[0];
      if (!tab || typeof tab.id !== "number") return reject(new Error("No active tab"));
      resolve(tab);
    });
  });
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(resp);
    });
  });
}

async function getSelectionFromActiveTab() {
  const tab = await getActiveTab();
  const results = await new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId: tab.id },
        func: () => (window.getSelection ? String(window.getSelection() || "").toString() : "").trim()
      },
      (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(res);
      }
    );
  });
  const text = (results && results[0] && results[0].result) ? String(results[0].result) : "";
  return { tabId: tab.id, text };
}

function renderSelectionPreview() {
  if (!selectionText) {
    elSelectionPreview.textContent = "No selection captured.";
    elSelectionPreview.classList.add("muted");
    return;
  }
  elSelectionPreview.textContent = selectionText.length > 500 ? (selectionText.slice(0, 500) + "…") : selectionText;
  elSelectionPreview.classList.remove("muted");
}

function renderAudioStatus() {
  if (!audioBase64) {
    elAudioStatus.textContent = "No audio recorded.";
    elAudioStatus.classList.add("muted");
    return;
  }
  elAudioStatus.textContent = `Audio ready (${Math.round(audioBase64.length / 4)} bytes base64)`;
  elAudioStatus.classList.remove("muted");
}

function renderApplied(applied) {
  const ui = (applied && applied.ui_actions) ? applied.ui_actions : {};
  const ca = (applied && applied.content_actions) ? applied.content_actions : {};

  const uiLines = [];
  if (typeof ui.font_scale === "number") uiLines.push(`font_scale: ${ui.font_scale}`);
  if (typeof ui.line_spacing === "number") uiLines.push(`line_spacing: ${ui.line_spacing}`);
  if (ui.contrast) uiLines.push(`contrast: ${ui.contrast}`);
  if (ui.simplify_layout === true) uiLines.push("simplify_layout: true");
  if (ui.hide_distractions === true) uiLines.push("hide_distractions: true");
  if (ui.highlight_focus === true) uiLines.push("highlight_focus: true");
  elAppliedUi.textContent = uiLines.length ? uiLines.join("\n") : "No UI adaptations applied.";

  const caLines = [];
  if (ca.summary && ca.summary.enabled === true) caLines.push("summary: enabled");
  if (ca.audio && ca.audio.enabled === true) caLines.push("audio: enabled");
  if (ca.flashcards && ca.flashcards.enabled === true) caLines.push("flashcards: enabled");
  elAppliedContent.textContent = caLines.length ? caLines.join("\n") : "No content actions applied.";
}

async function refreshApplied() {
  try {
    const tab = await getActiveTab();
    const resp = await sendToTab(tab.id, { type: "GET_APPLIED" });
    if (resp && resp.ok) renderApplied(resp.applied);
  } catch (err) {
    renderApplied(null);
  }
}

async function postProcess(requestBody) {
  const res = await fetch(BACKEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Backend error ${res.status}: ${txt || res.statusText}`);
  }
  return await res.json();
}

/* ---------------------------------------------------------------
   WAV recording (base64)
--------------------------------------------------------------- */
class WavRecorder {
  constructor() {
    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.samples = [];
    this.sampleRate = 44100;
    this.recording = false;
  }

  async start() {
    if (this.recording) return;
    this.samples = [];
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.sampleRate = this.audioContext.sampleRate || 44100;
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    // ScriptProcessorNode is deprecated but still supported in Chrome extension pages.
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      this.samples.push(new Float32Array(input));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
    this.recording = true;
  }

  async stop() {
    if (!this.recording) return "";
    this.recording = false;

    try { this.processor && this.processor.disconnect(); } catch (_) {}
    try { this.source && this.source.disconnect(); } catch (_) {}
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { this.audioContext && this.audioContext.close(); } catch (_) {}
    if (this.samples.length === 0) {
    return "";
    }
    const wav = encodeWav(this.samples, this.sampleRate);
    return arrayBufferToBase64(wav);
  }
}

function encodeWav(chunks, sampleRate) {
  const samples = flattenFloat32(chunks);
  const pcm16 = floatTo16BitPCM(samples);

  const buffer = new ArrayBuffer(44 + pcm16.length * 2);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm16.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM
  view.setUint16(20, 1, true);  // audio format
  view.setUint16(22, 1, true);  // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (sampleRate * blockAlign)
  view.setUint16(32, 2, true);  // block align (channels * bytesPerSample)
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm16.length * 2, true);

  let offset = 44;
  for (let i = 0; i < pcm16.length; i++, offset += 2) {
    view.setInt16(offset, pcm16[i], true);
  }
  return buffer;
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function flattenFloat32(chunks) {
  const total = chunks.reduce((sum, a) => sum + a.length, 0);
  const out = new Float32Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  // chunk to avoid call stack issues
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}

const recorder = new WavRecorder();

async function toggleRecord() {
  clearStatus();
  try {
    if (!recorder.recording) {
      await recorder.start();
      btnRecord.textContent = "Stop recording";
      showStatus("Recording…");
    } else {
      audioBase64 = await recorder.stop();
      btnRecord.textContent = "Record audio";
      renderAudioStatus();
      showStatus(audioBase64 ? "Audio recorded." : "No audio captured.");
    }
  } catch (err) {
    btnRecord.textContent = "Record audio";
    showStatus(`Recording error: ${err && err.message ? err.message : err}`);
  }
}

/* ---------------------------------------------------------------
   UI handlers
--------------------------------------------------------------- */
btnGetSelection.addEventListener("click", async () => {
  clearStatus();
  try {
    const { text } = await getSelectionFromActiveTab();
    selectionText = text || "";
    renderSelectionPreview();
    showStatus(selectionText ? "Selection captured." : "No selection found on page.");
  } catch (err) {
    showStatus(`Selection error: ${err && err.message ? err.message : err}`);
  }
});

btnClearSelection.addEventListener("click", () => {
  selectionText = "";
  renderSelectionPreview();
  clearStatus();
});

btnRecord.addEventListener("click", toggleRecord);

btnClearAudio.addEventListener("click", () => {
  audioBase64 = "";
  renderAudioStatus();
  clearStatus();
});

btnReset.addEventListener("click", async () => {
  clearStatus();
  try {
    const tab = await getActiveTab();
    await sendToTab(tab.id, { type: "RESET_ADAPTATIONS" });
    showStatus("Reset applied.");
    await refreshApplied();
  } catch (err) {
    showStatus(`Reset error: ${err && err.message ? err.message : err}`);
  }
});

btnRefreshApplied.addEventListener("click", refreshApplied);

btnSendExplicit.addEventListener("click", async () => {
  clearStatus();
  const userText = (elUserText.value || "").trim();

  // Build RequestSchema strictly (schemas.py)
  const payload = {};
  if (userText) payload.user_text = userText;
  if (audioBase64 && audioBase64.length > 1000) {
  payload.user_audio = {
    base64: audioBase64,
    format: "wav"
  };
}
  
  if (selectionText) payload.page_text = { content: selectionText };

  if (!payload.user_text && !payload.user_audio && !payload.page_text) {
    showStatus("Add text, record audio, or capture a selection first.");
    return;
  }

  const requestBody = {
    request_type: "explicit",
    payload
  };

  try {
    const tab = await getActiveTab();
    const response = await postProcess(requestBody);

    // Explicit must always result in apply; enforce client-side too.
    response.mode = "apply";

    await sendToTab(tab.id, { type: "APPLY_ACTIONS", response });
    showStatus("Applied.");
    await refreshApplied();
  } catch (err) {
    showStatus(`Send error: ${err && err.message ? err.message : err}`);
  }
});

// Initial render
renderSelectionPreview();
renderAudioStatus();
refreshApplied();
