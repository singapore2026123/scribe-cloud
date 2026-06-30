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
  const h = $("srcbox").querySelector(".hint"); if (h) h.remove();
  if (transcript) { const p = document.createElement("p"); p.className = "o"; p.textContent = transcript; $("srcbox").appendChild(p); $("srcbox").scrollTop = $("srcbox").scrollHeight; }
  if (translation) { const p = document.createElement("p"); p.className = "t"; p.textContent = translation; $("enbox").appendChild(p); $("enbox").scrollTop = $("enbox").scrollHeight; }
}
function clearBox(id) {
  $(id).innerHTML = id === "srcbox" ? '<p class="hint">Cleared.</p>' : "";
  setStatus("Cleared " + (id === "srcbox" ? "original" : "translation"));
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

function exportDoc() {                             // no Gemini — just the captured transcript + translation
  const src = boxLines("srcbox"), en = boxLines("enbox");
  if (!src.length && !en.length) return setStatus("Nothing to export");
  const n = Math.max(src.length, en.length); let rows = "";
  for (let i = 0; i < n; i++) rows += (en[i] ? `<p>${esc(en[i])}</p>` : "") + (src[i] ? `<p style="color:#666;font-size:13px">${esc(src[i])}</p>` : "");
  const html = `<html><head><meta charset="utf-8"><title>Scribe transcript</title></head>
    <body style="font-family:Segoe UI,Arial;max-width:760px;margin:24px auto;line-height:1.6">
    <h2>Scribe — Transcript &amp; Translation</h2>${rows}</body></html>`;
  if ($("fmt").value === "pdf") {
    const w = window.open("", "_blank");
    if (!w) return setStatus("Allow pop-ups to export PDF");
    w.document.write(html); w.document.close(); w.focus(); w.print();
  } else {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([html], { type: "application/msword" }));
    a.download = "scribe-transcript.doc"; a.click(); URL.revokeObjectURL(a.href);
  }
  setStatus("Exported");
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
