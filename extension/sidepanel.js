const $ = (id) => document.getElementById(id);
function rec(on) { $("start").disabled = on; $("stop").disabled = !on; }
function esc(t) { const d = document.createElement("div"); d.textContent = t; return d.innerHTML; }
function setStatus(t) { $("status").textContent = t; }

// Spoken<->translation language code maps (for swap), covering all 12 languages.
const T2L = { en: "en", "zh-CN": "zh", ms: "ms", ta: "ta", ja: "ja", my: "my", ko: "ko", th: "th", id: "id", vi: "vi", hi: "hi", fr: "fr" };
const L2T = { en: "en", zh: "zh-CN", ms: "ms", ta: "ta", ja: "ja", my: "my", ko: "ko", th: "th", id: "id", vi: "vi", hi: "hi", fr: "fr" };

function boxLines(id) {
  return [...$(id).querySelectorAll("p")].filter((p) => !p.classList.contains("hint")).map((p) => p.textContent.trim()).filter(Boolean);
}
function addLine(transcript, translation) {
  snap();
  const h = $("srcbox").querySelector(".hint"); if (h) h.remove();
  if (transcript) { const p = document.createElement("p"); p.className = "o"; p.textContent = transcript; $("srcbox").appendChild(p); $("srcbox").scrollTop = $("srcbox").scrollHeight; }
  if (translation) { const p = document.createElement("p"); p.className = "t"; p.textContent = translation; $("enbox").appendChild(p); $("enbox").scrollTop = $("enbox").scrollHeight; }
}
function clearBox() {                              // either Clear button wipes both boxes (undoable)
  snap();
  $("srcbox").innerHTML = '<p class="hint">Cleared.</p>';
  $("enbox").innerHTML = "";
  setStatus("Cleared all");
}
function copyBox(id) { navigator.clipboard.writeText(boxLines(id).join("\n")); setStatus("Copied"); }

function swap() {                                  // flip spoken<->translation languages AND the text
  snap();
  const L = $("lang").value, T = $("target").value, nl = T2L[T];
  if (!nl) return setStatus('Set "Translate to" to a real language (not Off) to swap.');
  const src = boxLines("srcbox"), en = boxLines("enbox");
  $("lang").value = nl; if (L2T[L]) $("target").value = L2T[L];
  $("srcbox").innerHTML = ""; $("enbox").innerHTML = "";
  en.forEach((t) => { const p = document.createElement("p"); p.className = "o"; p.textContent = t; $("srcbox").appendChild(p); });
  src.forEach((t) => { const p = document.createElement("p"); p.className = "t"; p.textContent = t; $("enbox").appendChild(p); });
  if (!en.length) $("srcbox").innerHTML = '<p class="hint">Pick a language &rarr; Start.</p>';
  setStatus("Swapped languages & text");
}

function exportDoc() {   // each block = translated paragraph, original underneath — organised like notes -> Word
  const src = boxLines("srcbox"), en = boxLines("enbox");
  if (!src.length && !en.length) return setStatus("Nothing to export");
  const n = Math.max(src.length, en.length); let blocks = "";
  for (let i = 0; i < n; i++) blocks +=
    `<div style="margin:0 0 15px;padding:0 0 12px;border-bottom:1px solid #eee">` +
    (en[i] ? `<p style="margin:0 0 4px;font-size:15px">${esc(en[i])}</p>` : "") +
    (src[i] ? `<p style="margin:0;color:#667;font-size:13px">${esc(src[i])}</p>` : "") +
    `</div>`;
  const html = `<html><head><meta charset="utf-8"><title>Meeting Notes</title></head>` +
    `<body style="font-family:Segoe UI,Arial;max-width:760px;margin:24px auto;line-height:1.5">` +
    `<h1 style="font-size:20px;margin:0 0 12px">Meeting Notes</h1>${blocks}</body></html>`;
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([html], { type: "application/msword" }));
  a.download = "meeting-notes.doc"; a.click(); URL.revokeObjectURL(a.href);
  setStatus("Exported meeting notes");
}

// ---------- start / stop ----------
$("start").onclick = async () => {
  rec(true); $("srcbox").innerHTML = ""; $("enbox").innerHTML = ""; setStatus("starting…");
  const r = await chrome.runtime.sendMessage({ type: "start", lang: $("lang").value, target: $("target").value });
  if (!r || !r.ok) { setStatus("error: " + ((r && r.error) || "failed")); rec(false); }
};
$("stop").onclick = async () => { rec(false); setStatus("stopping capture…"); await chrome.runtime.sendMessage({ type: "stop" }); };

$("clearSrc").onclick = () => clearBox("srcbox");
$("clearEn").onclick = () => clearBox("enbox");
$("copySrc").onclick = () => copyBox("srcbox");
$("copyEn").onclick = () => copyBox("enbox");
$("swapbtn").onclick = swap;
$("export").onclick = exportDoc;

// undo/redo for the editable boxes (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z) — covers typing, streamed lines, Clear & swap
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
["srcbox", "enbox"].forEach((id) => { const el = $(id); let t; el.addEventListener("input", () => { clearTimeout(t); t = setTimeout(snap, 400); }); });

// ---------- streamed results from the offscreen recorder ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "panel") return;
  if (msg.type === "status") setStatus(msg.status);
  if (msg.type === "line") addLine(msg.line.transcript || "", msg.line.translation || "");
});

// Live status from the icon-click (proves whether onClicked fired and grabbed the tab stream).
chrome.storage.onChanged.addListener((ch, area) => { if (area === "session" && ch.status) setStatus(ch.status.newValue); });
(async () => { const s = await chrome.storage.session.get(["status"]); if (s && s.status) setStatus(s.status); })();
