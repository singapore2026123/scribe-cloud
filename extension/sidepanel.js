const $ = (id) => document.getElementById(id);
function rec(on) { $("start").disabled = on; $("stop").disabled = !on; }

$("start").onclick = async () => {
  rec(true); $("feed").innerHTML = ""; $("status").textContent = "starting…";
  const r = await chrome.runtime.sendMessage({ type: "start", lang: $("lang").value, target: $("target").value });
  if (!r || !r.ok) { $("status").textContent = "error: " + ((r && r.error) || "failed"); rec(false); }
};

$("stop").onclick = async () => {
  rec(false); $("status").textContent = "finishing…";
  await chrome.runtime.sendMessage({ type: "stop" });
};

$("copy").onclick = () => {
  const t = [...document.querySelectorAll(".o")].map((e) => e.textContent).join("\n");
  navigator.clipboard.writeText(t);
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "panel") return;
  if (msg.type === "status") $("status").textContent = msg.status;
  if (msg.type === "line") {
    const d = document.createElement("div"); d.className = "line";
    const o = document.createElement("div"); o.className = "o"; o.textContent = msg.line.transcript || "";
    const t = document.createElement("div"); t.className = "t"; t.textContent = msg.line.translation || "";
    d.appendChild(o); if (msg.line.translation) d.appendChild(t);
    $("feed").appendChild(d); $("feed").scrollTop = $("feed").scrollHeight;
  }
});
