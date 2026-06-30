const $ = (id) => document.getElementById(id);
function rec(on) { $("start").disabled = on; $("stop").disabled = !on; }
function esc(t) { const d = document.createElement("div"); d.textContent = t; return d.innerHTML; }
function setStatus(t) { $("status").textContent = t; }
const NOTES_URL = "https://scribe-cloud.singapore2026123.workers.dev/notes";   // Workers AI meeting notes

// Spoken<->translation language code maps (for swap), covering all 12 languages.
const T2L = { en: "en", "zh-CN": "zh", ms: "ms", ta: "ta", ja: "ja", my: "my", ko: "ko", th: "th", id: "id", vi: "vi", hi: "hi", fr: "fr" };
const L2T = { en: "en", zh: "zh-CN", ms: "ms", ta: "ta", ja: "ja", my: "my", ko: "ko", th: "th", id: "id", vi: "vi", hi: "hi", fr: "fr" };

function boxLines(id) {
  return [...$(id).querySelectorAll("p")].filter((p) => !p.classList.contains("hint")).map((p) => p.textContent.trim()).filter(Boolean);
}
function addLine(transcript, translation) {
  const h = $("srcbox").querySelector(".hint"); if (h) h.remove();
  if (transcript) { const p = document.createElement("p"); p.className = "o"; p.textContent = transcript; $("srcbox").appendChild(p); $("srcbox").scrollTop = $("srcbox").scrollHeight; }
  if (translation) { const p = document.createElement("p"); p.className = "t"; p.textContent = translation; $("enbox").appendChild(p); $("enbox").scrollTop = $("enbox").scrollHeight; }
}
function clearBox() {                              // either Clear button wipes both boxes
  $("srcbox").innerHTML = '<p class="hint">Cleared.</p>';
  $("enbox").innerHTML = "";
  setStatus("Cleared all");
}
function copyBox(id) { navigator.clipboard.writeText(boxLines(id).join("\n")); setStatus("Copied"); }

function swap() {                                  // flip spoken<->translation languages AND the text
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

async function exportDoc() {                       // meeting notes (Workers AI) + transcript -> Word, like the web app
  const src = boxLines("srcbox"), en = boxLines("enbox");
  if (!src.length && !en.length) return setStatus("Nothing to export");
  setStatus("generating meeting notes for export…");
  let notesHtml = "";
  try {
    const d = await (await fetch(NOTES_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript: src.join("\n") }) })).json();
    if (d.notes) notesHtml = mdToHtml(d.notes);
  } catch (_) { /* notes best-effort; still export the transcript */ }
  const n = Math.max(src.length, en.length); let rows = "";
  for (let i = 0; i < n; i++) rows += (en[i] ? `<p>${esc(en[i])}</p>` : "") + (src[i] ? `<p style="color:#666;font-size:13px">${esc(src[i])}</p>` : "");
  const html = `<html><head><meta charset="utf-8"><title>Meeting Notes</title></head><body style="font-family:Segoe UI,Arial;max-width:760px;margin:24px auto;line-height:1.6">${notesHtml ? notesHtml + "<hr>" : ""}<h2>Full Transcript</h2>${rows}</body></html>`;
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([html], { type: "application/msword" }));
  a.download = "meeting-notes.doc"; a.click(); URL.revokeObjectURL(a.href);
  setStatus(notesHtml ? "Exported meeting notes + transcript" : "Notes unavailable — exported transcript only");
}
function mdToHtml(md) {
  return (md || "").split(/\r?\n/).map((ln) => {
    if (/^\s*##\s+/.test(ln)) return `<h2>${esc(ln.replace(/^\s*##\s+/, ""))}</h2>`;
    if (/^\s*[-*]\s+/.test(ln)) return `<li>${esc(ln.replace(/^\s*[-*]\s+/, ""))}</li>`;
    if (/^\s*$/.test(ln)) return "";
    return `<p>${esc(ln)}</p>`;
  }).join("");
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

// ---------- streamed results from the offscreen recorder ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "panel") return;
  if (msg.type === "status") setStatus(msg.status);
  if (msg.type === "line") addLine(msg.line.transcript || "", msg.line.translation || "");
});

// Live status from the icon-click (proves whether onClicked fired and grabbed the tab stream).
chrome.storage.onChanged.addListener((ch, area) => { if (area === "session" && ch.status) setStatus(ch.status.newValue); });
(async () => { const s = await chrome.storage.session.get(["status"]); if (s && s.status) setStatus(s.status); })();
