// Captures tab audio and transcribes it in rolling ~8s chunks (near-real-time), streaming results to the panel.
const SPACE_URL = "https://singapore2026123-scribe-burmese-asr.hf.space/transcribe";   // Burmese (SeamlessM4T)
const CF_URL = "https://scribe-cloud.pages.dev/transcribe";                            // others (Cloudflare Workers AI Whisper — fast/accurate)
const CHUNK_SEC = 8;

let ctx = null, srcNode = null, proc = null, stream = null;
let cfg = {}, buf = [], bufLen = 0, running = false, seq = 0, pending = 0;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "offscreen-stop") stop();
});

async function start(streamId, lang, target) {
  cfg = { lang, target }; buf = []; bufLen = 0; running = true; seq = 0;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    });
  } catch (e) { return panel("status", "capture failed: " + e.message); }
  ctx = new AudioContext();
  try { await ctx.resume(); } catch {}
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
  pending++;
  try {
    const { lang: src, target } = cfg;
    // Burmese -> SeamlessM4T Space; everything else -> Cloudflare Workers AI Whisper. No Gemini, no quota.
    const url = src === "my" ? SPACE_URL : CF_URL;
    const d = await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio: b64, src, target }) })).json();
    if ((d.transcript || "").trim() || (d.translation || "").trim())
      panel("line", "", { transcript: d.transcript || "", translation: d.translation || "" });
    else
      panel("status", `chunk ${n}: no speech${d.error ? " — " + d.error : ""}`);
  } catch (e) { panel("status", `chunk ${n} error: ${e.message}`); }
  finally {
    pending--;
    // Stop only halts capture — report when the last in-flight chunk finishes processing.
    if (!running) panel("status", pending > 0 ? `capture stopped — ${pending} chunk(s) still transcribing…` : "done — all captured audio transcribed");
  }
}

function stop() {
  running = false;
  flush();                                                   // queue the final partial chunk for transcription
  // Stop AUDIO CAPTURE only — any chunks already captured keep transcribing/translating in the background.
  try { if (proc) { proc.onaudioprocess = null; proc.disconnect(); } } catch {}
  try { if (srcNode) srcNode.disconnect(); } catch {}
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (ctx) ctx.close(); } catch {}
  proc = srcNode = stream = ctx = null;
  panel("status", pending > 0 ? `capture stopped — ${pending} chunk(s) still transcribing…` : "stopped");
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

// On load: read the job from this document's URL (set by background at creation) and start.
const _p = new URLSearchParams(location.search);
const _streamId = _p.get("streamId"), _lang = _p.get("lang"), _target = _p.get("target");
if (_streamId) {
  panel("status", "offscreen: got job (" + _lang + ") — requesting tab audio…");
  start(_streamId, _lang, _target);
} else {
  panel("status", "offscreen loaded but no job in URL");
}
