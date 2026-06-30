const $ = (id) => document.getElementById(id);
function setRecording(on) { $("start").disabled = on; $("stop").disabled = !on; }
function render(r) {
  if (!r) return;
  $("src").textContent = r.transcript || "";
  $("tr").textContent = r.translation || (r.error ? "(error: " + r.error + ")" : "");
}

async function load() {
  const s = await chrome.storage.local.get(["recording", "status", "result", "lang", "target"]);
  if (s.lang) $("lang").value = s.lang;
  if (s.target) $("target").value = s.target;
  setRecording(!!s.recording);
  if (s.status) $("status").textContent = s.status;
  render(s.result);
}

$("start").onclick = async () => {
  const lang = $("lang").value, target = $("target").value;
  await chrome.storage.local.set({ lang, target });
  setRecording(true); $("src").textContent = ""; $("tr").textContent = "";
  $("status").textContent = "starting…";
  const resp = await chrome.runtime.sendMessage({ type: "start", lang, target });
  if (!resp || !resp.ok) { $("status").textContent = "error: " + ((resp && resp.error) || "failed"); setRecording(false); }
  else $("status").textContent = "recording this tab… (you can switch to the tab; press Stop here when done)";
};

$("stop").onclick = async () => {
  setRecording(false); $("status").textContent = "transcribing…";
  await chrome.runtime.sendMessage({ type: "stop" });
};

$("copysrc").onclick = () => navigator.clipboard.writeText($("src").textContent || "");

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "popup") return;
  if (msg.type === "status") $("status").textContent = msg.status;
  if (msg.type === "result") { $("status").textContent = "done"; render(msg.result); }
});

load();
