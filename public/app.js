// Scribe Cloud — browser app. Auth (Supabase) + live (Web Speech) + record (Gemini) + storage + notes.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const $ = (id) => document.getElementById(id);
const LANGNAME = { ja: "Japanese", en: "English", ms: "Malay", my: "Burmese", zh: "Chinese", ta: "Tamil" };
const WSLANG = { ja: "ja-JP", en: "en-US", ms: "ms-MY", my: "my-MM", zh: "zh-CN", ta: "ta-IN" };

let sb = null, user = null, asrUrl = "";
let running = false, webrec = null, mediaRec = null, recChunks = [], lastWavB64 = null, lastNotes = "";
let lines = [];   // [{raw, translation, speaker?}]
let liveStream = null, liveCtx = null, liveSrc = null, liveProc = null, liveBuf = [], liveBufLen = 0, liveSeq = 0, liveSil = 0, liveSpeech = false, livePending = 0, autoExport = false;
// Pause-based chunking: end a chunk at a natural silence so each chunk is a whole utterance/sentence
// (coherent transcription + translation), not an arbitrary time slice. MAX_SEC caps continuous speech.
const SIL_THRESH = 0.008, SIL_HOLD = 0.7, MIN_SEC = 2.0, MAX_SEC = 16.0;

// ---------- UI helpers ----------
function setState(txt, on, busy) {
  $("stxt").textContent = txt;
  $("dot").className = "dot" + (on ? (busy ? " busy" : " on") : "");
  $("start").disabled = on; $("stop").disabled = !on; running = on;
}
function esc(t) { const d = document.createElement("div"); d.textContent = t; return d.innerHTML; }
function clearBoxes() { lines = []; lastWavB64 = null; lastNotes = ""; $("srcbox").innerHTML = ""; $("enbox").innerHTML = ""; }
function boxLines(id) { return [...$(id).querySelectorAll("p")].filter((p) => !p.classList.contains("hint") && p.id !== "interim").map((p) => p.textContent.trim()).filter(Boolean); }
function clearBox() { snap(); lines = []; lastWavB64 = null; $("srcbox").innerHTML = '<p class="hint">Cleared.</p>'; $("enbox").innerHTML = ""; setState("Cleared", false); }   // either Clear button wipes both boxes (undoable)
function renderLine(l) {
  const lbl = (l.speaker != null) ? `Speaker ${l.speaker + 1}: ` : "";
  const ps = document.createElement("p"); ps.textContent = lbl + (l.raw || ""); $("srcbox").appendChild(ps);
  if (l.translation) { const pe = document.createElement("p"); pe.textContent = lbl + l.translation; $("enbox").appendChild(pe); }
  $("srcbox").scrollTop = $("srcbox").scrollHeight; $("enbox").scrollTop = $("enbox").scrollHeight;
}
function addLine(raw, translation, speaker) {
  snap();
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
  snap();
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
  $("who").textContent = user ? user.email : "";
  if ($("pavatar")) $("pavatar").textContent = user && user.email ? user.email[0].toUpperCase() : "";
  if (user) { try { if (localStorage.getItem("sbCollapsed") === "1") $("app").classList.add("sb-collapsed"); } catch {} loadLibrary(); }
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

// ---------- live (chunked -> Space/Cloudflare): mic AND system/tab audio, every language, no Gemini ----------
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
  liveBuf = []; liveBufLen = 0; liveSeq = 0; liveSil = 0; liveSpeech = false;
  liveProc.onaudioprocess = (e) => {
    if (!running) return;
    const data = e.inputBuffer.getChannelData(0);
    liveBuf.push(new Float32Array(data));
    liveBufLen += data.length;
    let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length), sr = liveCtx.sampleRate;
    if (rms >= SIL_THRESH) { liveSpeech = true; liveSil = 0; } else { liveSil += data.length; }
    const secs = liveBufLen / sr, sil = liveSil / sr;
    if (liveSpeech && secs >= MIN_SEC && sil >= SIL_HOLD) { flushLive(); liveSil = 0; liveSpeech = false; }
    else if (secs >= MAX_SEC) { if (liveSpeech) flushLive(); else { liveBuf = []; liveBufLen = 0; } liveSil = 0; liveSpeech = false; }   // drop pure-silence buffers
  };
  liveSrc.connect(liveProc); liveProc.connect(liveCtx.destination);
  setState("listening — chunks end at natural pauses…", true, false);
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
  livePending++;
  try {
    const d = await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio: b64, src, target }) })).json();
    if ((d.transcript || "").trim() || (d.translation || "").trim()) addLine(d.transcript || "", d.translation || "");
    else if (running) setState(`listening… (chunk ${n}: no speech${d.error ? " — " + d.error : ""})`, true, false);
  } catch (e) { if (running) setState(`listening… (chunk ${n} error: ${e.message})`, true, false); }
  finally {
    livePending--;
    if (!running && livePending === 0) { setState("Stopped", false); maybeAutosave(); }
  }
}
function stopLive() {
  running = false;
  flushLive();   // queue the final partial chunk — Stop halts capture only, transcription keeps finishing
  try { if (liveProc) { liveProc.onaudioprocess = null; liveProc.disconnect(); } } catch {}
  try { if (liveSrc) liveSrc.disconnect(); } catch {}
  try { if (liveStream) liveStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (liveCtx) liveCtx.close(); } catch {}
  liveProc = liveSrc = liveStream = liveCtx = null;
  // Stop = capture only; remaining chunks keep transcribing. No auto-organise/notes popup — user clicks Export.
  setState(livePending ? `capture stopped — finishing ${livePending} chunk(s)…` : "Stopped", false);
  if (livePending === 0) maybeAutosave();
}
async function organiseOnStop() {
  const src = boxLines("srcbox");
  if (!src.length && !boxLines("enbox").length) { setState("Stopped", false); return; }
  setState("organising meeting notes…", true, true);
  try {
    const d = await (await fetch("/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript: src.join("\n"), target: $("target").value }) })).json();
    lastNotes = d.notes || "";
  } catch (_) { lastNotes = ""; }
  $("notesBody").innerHTML = lastNotes ? mdToHtml(lastNotes) : '<p class="hint">Notes unavailable — you can still Export the full record.</p>';
  $("notesModal").style.display = "flex";
  setState(lastNotes ? "Meeting organised — review, then Export" : "Stopped — notes unavailable", false);
}
function copyNotes() { navigator.clipboard.writeText(lastNotes || ""); setState("Notes copied", false); }

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
  maybeAutosave();
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
  setEnHead(); clearBoxes(); autosaved = false;
  if ($("mode").value === "record") { running = true; startRecord(); return; }
  running = true; startLive();   // chunked capture -> Space (all languages, mic or tab, no Web Speech / no Gemini)
}
function stop() {
  if ($("mode").value === "record") { if (mediaRec && mediaRec.state !== "inactive") mediaRec.stop(); running = false; $("stop").disabled = true; return; }
  stopLive();
}

// ---------- Library: exported documents + folders (Supabase) ----------
let currentDocId = null, autosaved = false;
function rawDocBody() {   // plain transcript+translation (no AI notes) — for silent autosave
  const src = boxLines("srcbox"), en = boxLines("enbox");
  if (!src.length && !en.length) return null;
  let body = "";
  if (en.length) body += `<h2>Translation</h2>` + en.map((t) => `<p>${esc(t)}</p>`).join("");
  if (src.length) body += `<hr style="margin:24px 0"><h2>Original</h2>` + src.map((t) => `<p style="color:#667">${esc(t)}</p>`).join("");
  return body;
}
async function maybeAutosave() {   // silently save the transcription once per session (no download, no AI-notes call)
  if (autosaved || !user) return;
  const body = rawDocBody(); if (!body) return;
  autosaved = true;
  const { error } = await sb.from("documents").insert({ user_id: user.id, title: defaultTitle(), html: body, folder_id: null });
  if (!error) { loadLibrary(); setState("Auto-saved to library", false); }
}
async function buildDocBody() {   // organised-notes HTML body (translation notes first, then original); null if empty
  const src = boxLines("srcbox"), en = boxLines("enbox");
  if (!src.length && !en.length) return null;
  const enNotes = en.length ? await notesFor(en.join("\n"), $("target").value) : "";
  const srcNotes = src.length ? await notesFor(src.join("\n"), $("lang").value) : "";
  let body = "";
  if (en.length) body += `<h2>Notes — Translation</h2>` + (enNotes ? mdToHtml(enNotes) : en.map((t) => `<p>${esc(t)}</p>`).join(""));
  if (src.length) body += `<hr style="margin:28px 0"><h2>Notes — Original</h2>` + (srcNotes ? mdToHtml(srcNotes) : src.map((t) => `<p style="color:#667">${esc(t)}</p>`).join(""));
  return body;
}
function docWrap(bodyHtml, title) {
  return `<html><head><meta charset="utf-8"><title>${esc(title || "Meeting Notes")}</title></head>` +
    `<body style="font-family:Segoe UI,Arial;max-width:760px;margin:24px auto;line-height:1.55">${bodyHtml}</body></html>`;
}
function defaultTitle() { return `${LANGNAME[$("lang").value] || "Session"} — ${new Date().toLocaleString()}`; }
async function saveDocument(title, bodyHtml) {
  const { error } = await sb.from("documents").insert({ user_id: user.id, title, html: bodyHtml, folder_id: null });
  if (error) { setState("Save failed: " + error.message, false); return false; }
  loadLibrary(); return true;
}
async function save() {   // save current transcript as an organised-notes document (no download)
  const body = await buildDocBody();
  if (!body) return setState("Nothing to save", false);
  setState("organising + saving…", true, true);
  if (await saveDocument(defaultTitle(), body)) setState("Saved to library ✓", false);
}
async function loadLibrary() {
  const box = $("histlist"); if (!box) return;
  const [{ data: folders }, { data: docs }] = await Promise.all([
    sb.from("folders").select("id,name,created_at").order("created_at"),
    sb.from("documents").select("id,title,folder_id,created_at").order("created_at", { ascending: false }),   // by date MADE
  ]);
  const fols = folders || [], list = docs || [];
  box.innerHTML = "";
  const render = (d) => {
    const el = document.createElement("div"); el.className = "hrow doc"; el.draggable = true;
    el.innerHTML = `<span class="doctitle">${esc(d.title)}</span> <span class="hint">${new Date(d.created_at).toLocaleDateString()}</span>
      <span class="docacts"><button class="ghost mini" data-o>Open</button><button class="ghost mini" data-r>✎</button><button class="ghost mini" data-x>✕</button></span>`;
    el.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/id", d.id));
    el.querySelector("[data-o]").onclick = () => openDoc(d.id);
    el.querySelector("[data-r]").onclick = () => renameDoc(d.id, d.title);
    el.querySelector("[data-x]").onclick = () => delDoc(d.id);
    return el;
  };
  const drop = (el, fid) => {
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("dragover"); });
    el.addEventListener("dragleave", () => el.classList.remove("dragover"));
    el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("dragover"); const id = e.dataTransfer.getData("text/id"); if (id) moveDoc(id, fid); });
  };
  for (const f of fols) {
    const fel = document.createElement("div"); fel.className = "folder";
    fel.innerHTML = `<div class="fhead">&#128193; <b>${esc(f.name)}</b> <button class="ghost mini" data-df>&times;</button></div>`;
    fel.querySelector("[data-df]").onclick = () => delFolder(f.id);
    drop(fel, f.id);
    list.filter((d) => d.folder_id === f.id).forEach((d) => fel.appendChild(render(d)));
    box.appendChild(fel);
  }
  const root = document.createElement("div"); root.className = "rootzone"; drop(root, null);
  const rootDocs = list.filter((d) => !d.folder_id);
  if (!fols.length && !rootDocs.length) root.innerHTML = '<p class="hint">No saved documents yet — click Export or Save.</p>';
  rootDocs.forEach((d) => root.appendChild(render(d)));
  box.appendChild(root);
}
async function newFolder() { const name = prompt("Folder name:", "New folder"); if (!name) return; await sb.from("folders").insert({ user_id: user.id, name }); loadLibrary(); }
async function delFolder(id) { if (!confirm("Delete folder? (its documents move to the top level)")) return; await sb.from("folders").delete().eq("id", id); loadLibrary(); }
async function moveDoc(id, fid) { await sb.from("documents").update({ folder_id: fid }).eq("id", id); loadLibrary(); }
async function delDoc(id) { if (!confirm("Delete this document?")) return; await sb.from("documents").delete().eq("id", id); if (currentDocId === id) closeDoc(); loadLibrary(); }
async function renameDoc(id, cur) { const t = prompt("Title:", cur); if (t == null) return; await sb.from("documents").update({ title: t }).eq("id", id); loadLibrary(); }
async function openDoc(id) {
  const { data, error } = await sb.from("documents").select("title,html").eq("id", id).single();
  if (error || !data) return setState("Open failed", false);
  currentDocId = id; $("docTitle").value = data.title; $("docBody").innerHTML = data.html;
  $("feedwrap").classList.add("hidden"); $("docview").classList.remove("hidden");
}
function closeDoc() { currentDocId = null; $("docview").classList.add("hidden"); $("feedwrap").classList.remove("hidden"); }
async function saveDocEdits() {
  if (!currentDocId) return;
  const { error } = await sb.from("documents").update({ title: $("docTitle").value, html: $("docBody").innerHTML }).eq("id", currentDocId);
  setState(error ? "Save failed: " + error.message : "Document saved ✓", false); loadLibrary();
}
function downloadDoc() {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([docWrap($("docBody").innerHTML, $("docTitle").value)], { type: "application/msword" }));
  a.download = ($("docTitle").value || "document").replace(/[^\w.-]+/g, "_") + ".doc"; a.click(); URL.revokeObjectURL(a.href);
}

// ---------- export ----------
function copyBox(id) {
  const t = [...$(id).querySelectorAll("p")].filter((p) => !p.classList.contains("hint")).map((p) => p.textContent).join("\n");
  navigator.clipboard.writeText(t); setState("Copied", false);
}
async function notesFor(text, tgt) {   // organised (Genspark-style) notes for `text`, written in language `tgt`
  if (!text.trim()) return "";
  try {
    const d = await (await fetch("/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript: text, target: tgt }) })).json();
    return d.notes || "";
  } catch (_) { return ""; }
}
async function exportDoc() {   // organise -> download Word AND auto-save to the library (title editable in the sidebar)
  setState("organising notes…", true, true);
  const body = await buildDocBody();
  if (!body) return setState("Nothing to export", false);
  const title = defaultTitle();
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([docWrap(body, title)], { type: "application/msword" }));
  a.download = "meeting-notes.doc"; a.click(); URL.revokeObjectURL(a.href);
  await saveDocument(title, body);
  setState("Exported + saved to library ✓", false);
}
function mdToHtml(md) {
  return (md || "").split(/\r?\n/).map((ln) => {
    if (/^\s*#{1,3}\s+/.test(ln)) return `<h3 style="margin:16px 0 6px">${esc(ln.replace(/^\s*#{1,3}\s+/, ""))}</h3>`;
    if (/^\s*[-*]\s+/.test(ln)) return `<li style="margin-left:18px">${esc(ln.replace(/^\s*[-*]\s+/, ""))}</li>`;
    if (/^\s*$/.test(ln)) return "";
    return `<p>${esc(ln)}</p>`;
  }).join("");
}

// --- undo/redo for the editable boxes (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z) — covers typing, streamed lines, Clear & swap ---
let _undo = [], _redo = [];
function _snapState() { return { s: $("srcbox").innerHTML, e: $("enbox").innerHTML }; }
function snap() { _undo.push(_snapState()); if (_undo.length > 200) _undo.shift(); _redo = []; }
function _restore(st) { $("srcbox").innerHTML = st.s; $("enbox").innerHTML = st.e; }
document.addEventListener("keydown", (ev) => {
  if (!(ev.ctrlKey || ev.metaKey)) return;
  const k = ev.key.toLowerCase();
  if (k === "z" && !ev.shiftKey) { if (_undo.length) { _redo.push(_snapState()); _restore(_undo.pop()); ev.preventDefault(); } }
  else if (k === "y" || (k === "z" && ev.shiftKey)) { if (_redo.length) { _undo.push(_snapState()); _restore(_redo.pop()); ev.preventDefault(); } }
});
["srcbox", "enbox"].forEach((id) => { const el = $(id); if (el) { let t; el.addEventListener("input", () => { clearTimeout(t); t = setTimeout(snap, 400); }); } });

function toggleSidebar() { const c = $("app").classList.toggle("sb-collapsed"); try { localStorage.setItem("sbCollapsed", c ? "1" : "0"); } catch {} }

// expose for inline handlers
window.scribe = { signIn, signUp, logout, resetPassword, start, stop, save, clearBox, swap, copyBox, exportDoc, copyNotes, toggleSidebar, newFolder, closeDoc, saveDocEdits, downloadDoc };
boot();
