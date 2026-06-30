// Captures the tab audio (via the streamId), records it, and on stop transcribes via the Scribe backends.
const SPACE_URL = "https://singapore2026123-scribe-burmese-asr.hf.space/transcribe";   // Burmese (SeamlessM4T)
const NETLIFY_TRANSCRIBE = "https://kanamic-scribe.netlify.app/api/transcribe";        // others (Gemini)

let rec = null, chunks = [], audioCtx = null, cfg = {};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "offscreen-start") startCapture(msg.streamId, msg.lang, msg.target);
  else if (msg.type === "offscreen-stop") stopCapture();
});

async function startCapture(streamId, lang, target) {
  cfg = { lang, target };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    });
  } catch (e) { return report("status", "capture failed: " + e.message); }
  audioCtx = new AudioContext();                                   // keep the tab audible while capturing
  audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
  chunks = [];
  rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    await transcribe();
  };
  rec.start();
}

function stopCapture() { if (rec && rec.state !== "inactive") rec.stop(); }

async function transcribe() {
  report("status", "transcribing…");
  try {
    const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
    const b64 = await blobToWav16kB64(blob);
    const { lang: src, target } = cfg;
    let d;
    if (src === "my") {
      d = await (await fetch(SPACE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio: b64, src, target }) })).json();
    } else {
      d = await (await fetch(NETLIFY_TRANSCRIBE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio: b64, mime: "audio/wav", src, target }) })).json();
    }
    report("result", "done", { transcript: d.transcript || "", translation: d.translation || "", error: d.error || "" });
  } catch (e) { report("status", "error: " + e.message); }
}

function report(type, status, result) {
  const payload = { status };
  if (type === "result") { payload.result = result; payload.recording = false; }
  chrome.storage.local.set(payload);
  chrome.runtime.sendMessage({ target: "popup", type, status, result }).catch(() => {});
}

// ---- WAV (16k mono) encoder ----
async function blobToWav16kB64(blob) {
  const ab = await blob.arrayBuffer();
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ac.decodeAudioData(ab);
  const len = buf.length, ch = buf.numberOfChannels, mono = new Float32Array(len);
  for (let c = 0; c < ch; c++) { const dd = buf.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += dd[i] / ch; }
  const ratio = buf.sampleRate / 16000, outLen = Math.floor(len / ratio), out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = mono[Math.floor(i * ratio)];
  ac.close();
  return encodeWavB64(out, 16000);
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
