// Scribe Cloud — browser app. Auth (Supabase) + live (Web Speech) + record (Gemini) + storage + notes.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const $ = (id) => document.getElementById(id);
const LANGNAME = { ja: "Japanese", en: "English", ms: "Malay", my: "Burmese", zh: "Chinese", ta: "Tamil" };
const WSLANG = { ja: "ja-JP", en: "en-US", ms: "ms-MY", my: "my-MM", zh: "zh-CN", ta: "ta-IN" };

let sb = null, user = null, asrUrl = "";
let running = false, webrec = null, mediaRec = null, recChunks = [], lastWavB64 = null, lastNotes = "";
let lines = [];   // [{raw, translation, speaker?}]
let liveStream = null, liveCtx = null, liveSrc = null, liveProc = null, liveBuf = [], liveBufLen = 0, liveSeq = 0;

// ---------- UI helpers ----------
function setState(txt, on, busy) {
  $("stxt").textContent = txt;
  $("dot").className = "dot" + (on ? (busy ? " busy" : " on") : "");
  $("start").disabled = on; $("stop").disabled = !on; running = on;
}
function esc(t) { const d = document.createElement("div"); d.textContent = t; return d.innerHTML; }
function clearBoxes() { lines = []; lastWavB64 = null; $("srcbox").innerHTML = ""; $("enbox").innerHTML = ""; }
function boxLines(id) { return [...$(id).querySelectorAll("p")].filter((p) => !p.classList.contains("hint") && p.id !== "interim").map((p) => p.textContent.trim()).filter(Boolean); }
function clearBox() { lines = []; lastWavB64 = null; $("srcbox").innerHTML = '<p class="hint">Cleared.</p>'; $("enbox").innerHTML = ""; setState("Cleared", false); }   // either Clear button wipes both boxes
function renderLine(l) {
  const lbl = (l.speaker != null) ? `Speaker ${l.speaker + 1}: ` : "";
  const ps = document.createElement("p"); ps.textContent = lbl + (l.raw || ""); $("srcbox").appendChild(ps);
  if (l.translation) { const pe = document.createElement("p"); pe.textContent = lbl + l.translation; $("enbox").appendChild(pe); }
  $("srcbox").scrollTop = $("srcbox").scrollHeight; $("enbox").scrollTop = $("enbox").scrollHeight;
}
function addLine(raw, translation, speaker) {
  const h = $("srcbox").querySelector(".hint"); if (h) h.remove();
  const l = { raw, translation: translation || "", speaker }; lines.push(l); renderLine(l);
}
function setEnHead() { const h = $("enhead"); if (!h) return; const t = $("target"); h.textContent = t.value === "off" ? "Translation (off)" : "Translation — " + t.options[t.selectedIndex].textContent; }
function rerender() {
  $("srcbox").innerHTML = ""; $("enbox").innerHTML = "";
  if (!lines.length) { $("srcbox").innerHTML = '<p class="hint">Pick a language and press Start.</p>'; return; }
  lines.forEach(renderLine);
}
function swap() {                                  // DeepL-style: flip spoken<->translation languages AND the text
  const t2l = { "zh-CN": "zh", ja: "ja", en: "en", ms: "ms", my: "my", ta: "ta" };
  const l2t = { zh: "zh-CN", ja: "ja", en: "en", ms: "ms", my: "my", ta: "ta" };
  const L = $("lang").value, T = $("target").value, nl = t2l[T];
  if (!nl) return setState('Set "Translate to" to a spoken language (JA/ZH/MS/MY/EN/TA) to swap', false);
  const src = boxLines("srcbox"), en = boxLines("enbox");   // read current text from the boxes
  $("lang").value = nl; if (l2t[L]) $("target").value = l2t[L];
  $("srcbox").innerHTML = ""; $("enbox").innerHTML = "";
  en.forEach((t) => { const p = document.createElement("p"); p.textContent = t; $("srcbox").appendChild(p); });
  src.forEach((t) => { const p = document.createElement("p"); p.textContent = t; $("enbox").appendChild(p); });
  if (!en.length) $("srcbox").innerHTML = '<p class="hint">Pick a language and press Start.</p>';
  setEnHead();
}

// ---------- auth ----------
async function boot() {
  let cfg;
  // Static config (no serverless needed — all values are public; anon key is protected by RLS).
  try { cfg = await (await fetch(new URL("config.json", import.meta.url))).json(); } catch { cfg = {}; }
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    $("loginstatus").textContent = "Config missing — set supabaseUrl + supabaseAnonKey in public/config.json.";
    return;
  }
  sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  asrUrl = cfg.asrUrl || "";   // public Burmese ASR Space — browser calls it directly (dodges Netlify timeout)
  const { data: { session } } = await sb.auth.getSession();
  setLogged(session);
  sb.auth.onAuthStateChange((event, s) => { if (event === "PASSWORD_RECOVERY") return promptNewPassword(); setLogged(s); });
  setEnHead(); $("target").addEventListener("change", setEnHead);
}
function setLogged(session) {
  user = session?.user || null;
  $("login").classList.toggle("hidden", !!user);
  $("app").classList.toggle("hidden", !user);
  $("logout").classList.toggle("hidden", !user);
  $("who").textContent = user ? user.email : "";
  if (user) loadHistory();
}
async function signIn() {
  const email = $("email").value.trim(), password = $("password").value;
  if (!email || !password) return ($("loginstatus").textContent = "Enter your email and password.");
  $("loginstatus").textContent = "Signing in…";
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) $("loginstatus").textContent = "Error: " + error.message;   // onAuthStateChange shows the app on success
}
async function signUp() {
  const email = $("email").value.trim(), password = $("password").value;
  if (!email || password.length < 6) return ($("loginstatus").textContent = "Enter your email and a password (min 6 characters).");
  $("loginstatus").textContent = "Creating account…";
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) return ($("loginstatus").textContent = "Error: " + error.message);
  $("loginstatus").textContent = data.session
    ? "Account created — signing you in…"
    : "Account created. Confirm via email if prompted, otherwise click Sign in.";
}
async function logout() { await sb.auth.signOut(); clearBoxes(); }
async function resetPassword() {
  const email = $("email").value.trim();
  if (!email) return ($("loginstatus").textContent = "Enter your email above, then click Forgot password.");
  $("loginstatus").textContent = "Sending reset email…";
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split("#")[0] });
  $("loginstatus").textContent = error ? "Error: " + error.message : "Reset email sent — open the link in it, then you'll be asked for a new password.";
}
async function promptNewPassword() {
  const pw = window.prompt("Enter a new password (min 6 characters):");
  if (!pw || pw.length < 6) { $("loginstatus").textContent = "Password reset cancelled (min 6 characters)."; return; }
  const { error } = await sb.auth.updateUser({ password: pw });
  $("loginstatus").textContent = error ? "Reset failed: " + error.message : "Password updated — you're signed in.";
}

// ---------- live (Web Speech) ----------
function startBrowser() {
  const SR = window.webkitSpeechRecognition || window.SpeechRecognition;
  if (!SR) { setState("Web Speech not supported in this browser", false); return; }
  const lang = $("lang").value, target = $("target").value;
  function mk() {
    const rec = new SR(); rec.lang = WSLANG[lang] || "en-US"; rec.continuous = true; rec.interimResults = true;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) { const t = (r[0].transcript || "").trim(); if (t) { addLine(t, ""); translateLast(t, lang, target); } }
      }
      if (running) setState("listening (browser)", true, false);
    };
    rec.onerror = (ev) => { if (ev.error === "not-allowed" || ev.error === "service-not-allowed") { setState("Microphone blocked — allow mic access", false); running = false; } };
    rec.onend = () => { if (running) setTimeout(() => { if (running) try { webrec.start(); } catch { try { webrec = mk(); webrec.start(); } catch {} } }, 300); };
    return rec;
  }
  webrec = mk();
  try { webrec.start(); setState("listening (browser)", true, false); } catch { setState("Start failed", false); running = false; }
}
async function translateLast(text, lang, target) {
  if (target === "off") return;
  try {
    const d = await (await fetch("/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, src: lang, target }) })).json();
    if (d.translation) { const l = lines.find((x) => x.raw === text && !x.translation); if (l) { l.translation = d.translation; const pe = document.createElement("p"); pe.textContent = d.translation; $("enbox").appendChild(pe); $("enbox").scrollTop = $("enbox").scrollHeight; } }
  } catch {}
}
function stopBrowser() { running = false; if (webrec) { try { webrec.onend = null; webrec.stop(); } catch {} webrec = null; } setState("Ready", false); }

// ---------- live (chunked -> Space): replaces Web Speech. Works for mic AND system/tab audio, every language, no Gemini ----------
async function startLive() {
  const source = $("source").value;
  let stream;
  try {
    stream = source === "system"
      ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })   // pick a tab/screen + tick "Share audio"
      : await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch { setState(source === "system" ? "Screen/tab share cancelled or blocked" : "Microphone blocked — allow mic access", false); running = false; return; }
  const aud = stream.getAudioTracks();
  if (!aud.length) { stream.getTracks().forEach((t) => t.stop()); setState('No audio captured — when sharing a tab/screen you must tick "Share tab audio"', false); running = false; return; }
  liveStream = stream;
  liveCtx = new (window.AudioContext || window.webkitAudioContext)();
  try { await liveCtx.resume(); } catch {}
  liveSrc = liveCtx.createMediaStreamSource(new MediaStream(aud));
  liveProc = liveCtx.createScriptProcessor(4096, 1, 1);
  liveBuf = []; liveBufLen = 0; liveSeq = 0;
  liveProc.onaudioprocess = (e) => {
    if (!running) return;
    liveBuf.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    liveBufLen += e.inputBuffer.length;
    if (liveBufLen >= 8 * liveCtx.sampleRate) flushLive();   // ~8s chunks
  };
  liveSrc.connect(liveProc); liveProc.connect(liveCtx.destination);
  setState("listening — transcribing every ~8s…", true, false);
}
function flushLive() {
  if (!liveBufLen) return;
  const merged = new Float32Array(liveBufLen); let o = 0;
  for (const b of liveBuf) { merged.set(b, o); o += b.length; }
  const sr = liveCtx ? liveCtx.sampleRate : 48000;
  liveBuf = []; liveBufLen = 0;
  const ratio = sr / 16000, outLen = Math.floor(merged.length / ratio), out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = merged[Math.floor(i * ratio)];
  transcribeChunkLive(encodeWavB64(out, 16000), ++liveSeq);
}
function asrEndpoint(src) {   // Burmese -> HF Space (SeamlessM4T); others -> Cloudflare Pages Function (Workers AI Whisper)
  return src === "my" ? (asrUrl ? asrUrl.replace(/\/+$/, "") + "/transcribe" : "") : "/transcribe";
}
async function transcribeChunkLive(b64, n) {
  const src = $("lang").value, target = $("target").value, url = asrEndpoint(src);
  if (!url) { if (running) setState("Burmese engine not configured (SCRIBE_ASR_URL).", true, false); return; }
  try {
    const d = await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio: b64, src, target }) })).json();
    if ((d.transcript || "").trim() || (d.translation || "").trim()) addLine(d.transcript || "", d.translation || "");
    else if (running) setState(`listening… (chunk ${n}: no speech${d.error ? " — " + d.error : ""})`, true, false);
  } catch (e) { if (running) setState(`listening… (chunk ${n} error: ${e.message})`, true, false); }
}
function stopLive() {
  running = false;
  flushLive();   // queue the final partial chunk — Stop halts capture only, transcription keeps finishing
  try { if (liveProc) { liveProc.onaudioprocess = null; liveProc.disconnect(); } } catch {}
  try { if (liveSrc) liveSrc.disconnect(); } catch {}
  try { if (liveStream) liveStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (liveCtx) liveCtx.close(); } catch {}
  liveProc = liveSrc = liveStream = liveCtx = null;
  setState("capture stopped — finishing transcription…", false);
}

// ---------- record -> Gemini ----------
async function startRecord() {
  const source = $("source").value;
  let stream;
  try {
    stream = source === "system"
      ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })   // user picks tab/screen + "Share audio"
      : await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setState(source === "system" ? "Screen/tab share cancelled or blocked" : "Microphone blocked — allow mic access", false);
    running = false; return;
  }
  const aud = stream.getAudioTracks();
  if (!aud.length) {
    stream.getTracks().forEach((t) => t.stop());
    setState('No audio captured — when sharing a tab/screen you must tick "Share tab audio"', false);
    running = false; return;
  }
  recChunks = []; mediaRec = new MediaRecorder(new MediaStream(aud));   // audio only (ignore the video track)
  mediaRec.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  mediaRec.onstop = async () => { stream.getTracks().forEach((t) => t.stop()); await processRecording(); };
  mediaRec.start();
  setState(source === "system" ? "recording tab/system audio — press Stop when done" : "recording — press Stop when done", true, false);
}
async function processRecording() {
  const src = $("lang").value, target = $("target").value;
  try {
    const blob = new Blob(recChunks, { type: recChunks[0]?.type || "audio/webm" });
    lastWavB64 = await blobToWav16kB64(blob);
    const url = asrEndpoint(src);
    if (!url) { setState("Burmese engine not configured (SCRIBE_ASR_URL).", false); return; }
    setState(src === "my" ? "transcribing Burmese on the Space (first run loads the model)…" : "transcribing…", true, true);
    const d = await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio: lastWavB64, src, target }) })).json();
    if (d.transcript) addLine(d.transcript, d.translation || "");
    else setState("No speech / " + (d.error || "empty"), false);
  } catch (e) { setState("Transcribe failed: " + e.message, false); return; }
  setState("Ready", false);
}

// ---------- audio encoding ----------
async function blobToWav16kB64(blob) {
  const ab = await blob.arrayBuffer();
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ac.decodeAudioData(ab);
  const len = buf.length, ch = buf.numberOfChannels, mono = new Float32Array(len);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += d[i] / ch; }
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
function b64ToBlob(b64, type) { const bin = atob(b64), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type }); }

// ---------- start/stop ----------
function start() {
  setEnHead(); clearBoxes();
  if ($("mode").value === "record") { running = true; startRecord(); return; }
  running = true; startLive();   // chunked capture -> Space (all languages, mic or tab, no Web Speech / no Gemini)
}
function stop() {
  if ($("mode").value === "record") { if (mediaRec && mediaRec.state !== "inactive") mediaRec.stop(); running = false; $("stop").disabled = true; return; }
  stopLive();
}

// ---------- Supabase persistence ----------
async function save() {
  const src = boxLines("srcbox"), en = boxLines("enbox");
  if (!src.length && !en.length) return setState("Nothing to save", false);
  setState("saving…", true, true);
  let audio_path = null;
  if (lastWavB64) {
    const path = `${user.id}/${Date.now()}.wav`;
    const up = await sb.storage.from("recordings").upload(path, b64ToBlob(lastWavB64, "audio/wav"), { contentType: "audio/wav" });
    if (!up.error) audio_path = path;
  }
  const { data: sess, error } = await sb.from("sessions").insert({
    user_id: user.id, title: `${LANGNAME[$("lang").value] || ""} — ${new Date().toLocaleString()}`,
    src_lang: $("lang").value, target_lang: $("target").value, audio_path,
  }).select().single();
  if (error) return setState("Save failed: " + error.message, false);
  const n = Math.max(src.length, en.length), rows = [];
  for (let i = 0; i < n; i++) rows.push({ session_id: sess.id, user_id: user.id, idx: i, raw: src[i] || "", translation: en[i] || "" });
  const { error: e2 } = await sb.from("lines").insert(rows);
  setState(e2 ? "Saved session, lines failed: " + e2.message : "Saved ✓", false);
  loadHistory();
}
async function loadHistory() {
  const { data, error } = await sb.from("sessions").select("id,title,created_at").order("created_at", { ascending: false }).limit(50);
  const box = $("histlist");
  if (error) { box.innerHTML = `<p class="hint">${esc(error.message)}</p>`; return; }
  if (!data.length) { box.innerHTML = '<p class="hint">No saved sessions yet.</p>'; return; }
  box.innerHTML = "";
  for (const s of data) {
    const d = document.createElement("div"); d.className = "hrow";
    d.innerHTML = `<b>${esc(s.title)}</b> <span class="hint">${new Date(s.created_at).toLocaleString()}</span><br>
      <button class="ghost" data-open="${s.id}">Open</button> <button class="ghost" data-del="${s.id}">Delete</button>`;
    box.appendChild(d);
  }
  box.querySelectorAll("[data-open]").forEach((b) => b.onclick = () => openSession(b.dataset.open));
  box.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => delSession(b.dataset.del));
}
async function openSession(id) {
  const { data } = await sb.from("lines").select("raw,translation,speaker,idx").eq("session_id", id).order("idx");
  clearBoxes();
  (data || []).forEach((l) => addLine(l.raw, l.translation, l.speaker ?? undefined));
  window.scrollTo({ top: 0, behavior: "smooth" });
}
async function delSession(id) {
  if (!confirm("Delete this session?")) return;
  await sb.from("sessions").delete().eq("id", id); loadHistory();
}

// ---------- notes / export ----------
async function notes() {
  const text = boxLines("srcbox").join("\n");
  if (!text.trim()) return setState("Nothing to summarize", false);
  setState("generating notes…", true, true);
  try {
    const d = await (await fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript: text, target: $("target").value }) })).json();
    if (d.notes) { lastNotes = d.notes; $("notesBody").textContent = d.notes; $("notesModal").style.display = "flex"; setState("Notes ready", false); }
    else setState("Notes unavailable: " + (d.error || "quota"), false);
  } catch (e) { setState("Notes failed: " + e.message, false); }
}
function copyNotes() { navigator.clipboard.writeText(lastNotes || ""); }
function copyBox(id) {
  const t = [...$(id).querySelectorAll("p")].filter((p) => !p.classList.contains("hint")).map((p) => p.textContent).join("\n");
  navigator.clipboard.writeText(t); setState("Copied", false);
}
function exportDoc() {
  const src = boxLines("srcbox"), en = boxLines("enbox");
  if (!src.length && !en.length) return setState("Nothing to export", false);
  const n = Math.max(src.length, en.length); let rows = "";
  for (let i = 0; i < n; i++) rows += `${en[i] ? `<p>${esc(en[i])}</p>` : ""}${src[i] ? `<p style="color:#666;font-size:13px">${esc(src[i])}</p>` : ""}`;
  const html = `<html><head><meta charset="utf-8"><title>Scribe transcript</title></head><body style="font-family:Segoe UI,Arial;max-width:760px;margin:24px auto;line-height:1.6"><h2>Scribe — Transcript &amp; Translation</h2>${rows}</body></html>`;
  if (($("fmt") || {}).value === "pdf") {
    const w = window.open("", "_blank");
    if (!w) return setState("Allow pop-ups to export PDF", false);
    w.document.write(html); w.document.close(); w.focus(); w.print();
  } else {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([html], { type: "application/msword" })); a.download = "scribe-notes.doc"; a.click(); URL.revokeObjectURL(a.href);
  }
}
function mdToHtml(md) {
  return (md || "").split(/\r?\n/).map((ln) => {
    if (/^\s*##\s+/.test(ln)) return `<h2>${esc(ln.replace(/^\s*##\s+/, ""))}</h2>`;
    if (/^\s*[-*]\s+/.test(ln)) return `<li>${esc(ln.replace(/^\s*[-*]\s+/, ""))}</li>`;
    if (/^\s*$/.test(ln)) return "";
    return `<p>${esc(ln)}</p>`;
  }).join("");
}

// expose for inline handlers
window.scribe = { signIn, signUp, logout, resetPassword, start, stop, save, clearBox, swap, copyBox, exportDoc };
boot();
