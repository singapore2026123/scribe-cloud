// Captures tab audio and transcribes it in rolling ~8s chunks (near-real-time), streaming results to the panel.
const SPACE_URL = "https://singapore2026123-scribe-burmese-asr.hf.space/transcribe";   // Burmese (SeamlessM4T)
const NETLIFY_TRANSCRIBE = "https://kanamic-scribe.netlify.app/api/transcribe";        // others (Gemini)
const CHUNK_SEC = 8;

let ctx = null, srcNode = null, proc = null, stream = null;
let cfg = {}, buf = [], bufLen = 0, running = false, seq = 0;

let lastTs = 0;
async function checkJob() {
  const { job } = await chrome.storage.session.get(["job"]);
  if (job && job.ts && job.ts !== lastTs && !running) { lastTs = job.ts; start(job.streamId, job.lang, job.target); }
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "offscreen-go") checkJob();
  else if (msg.type === "offscreen-stop") stop();
});

async function start(streamId, lang, target) {
  cfg = { lang, target }; buf = []; bufLen = 0; running = true; seq = 0;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    });
  } catch (e) { return panel("status", "capture failed: " + e.message); }
  ctx = new AudioContext();
  srcNode = ctx.createMediaStreamSource(stream);
  srcNode.connect(ctx.destination);                          // keep the tab audible
  proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => {
    if (!running) return;
    buf.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    bufLen += e.inputBuffer.length;
    if (bufLen >= CHUNK_SEC * ctx.sampleRate) flush();
  };
  srcNode.connect(proc); proc.connect(ctx.destination);
  panel("status", `listening — transcribing every ${CHUNK_SEC}s…`);
}

function flush() {
  if (bufLen === 0) return;
  const merged = new Float32Array(bufLen);
  let o = 0; for (const b of buf) { merged.set(b, o); o += b.length; }
  const sr = ctx ? ctx.sampleRate : 48000;
  buf = []; bufLen = 0;
  const n = ++seq;
  panel("status", `transcribing chunk ${n}…`);
  const b64 = encodeWavB64(resampleTo16k(merged, sr), 16000);
  transcribeChunk(b64, n);
}

async function transcribeChunk(b64, n) {
  try {
    const { lang: src, target } = cfg;
    let d;
    if (src === "my") {
      d = await (await fetch(SPACE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio: b64, src, target }) })).json();
    } else {
      d = await (await fetch(NETLIFY_TRANSCRIBE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio: b64, mime: "audio/wav", src, target }) })).json();
    }
    if ((d.transcript || "").trim() || (d.translation || "").trim())
      panel("line", "", { transcript: d.transcript || "", translation: d.translation || "" });
    else
      panel("status", `chunk ${n}: no speech${d.error ? " — " + d.error : ""}`);
  } catch (e) { panel("status", `chunk ${n} error: ${e.message}`); }
}

function stop() {
  running = false;
  flush();                                                   // transcribe the final partial chunk
  try { if (proc) { proc.onaudioprocess = null; proc.disconnect(); } } catch {}
  try { if (srcNode) srcNode.disconnect(); } catch {}
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (ctx) ctx.close(); } catch {}
  proc = srcNode = stream = ctx = null;
  panel("status", "stopped");
}

function resampleTo16k(samples, sr) {
  if (sr === 16000) return samples;
  const ratio = sr / 16000, outLen = Math.floor(samples.length / ratio), out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = samples[Math.floor(i * ratio)];
  return out;
}
function encodeWavB64(samples, sr) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, "data"); view.setUint32(40, samples.length * 2, true);
  let o = 44; for (let i = 0; i < samples.length; i++) { let s = Math.max(-1, Math.min(1, samples[i])); view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  let bin = ""; const bytes = new Uint8Array(buffer); for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function panel(type, status, line) { chrome.runtime.sendMessage({ target: "panel", type, status, line }).catch(() => {}); }

// On load: report it + pick up any pending job from storage (robust to the create-then-message race & SW restarts).
panel("status", "offscreen loaded — starting capture…");
checkJob();
