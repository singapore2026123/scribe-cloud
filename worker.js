// Cloudflare Worker: serves the static site in public/ AND handles POST /transcribe.
// /transcribe runs Workers AI — Whisper large-v3-turbo (non-Burmese ASR) + m2m100 (translation).
// Burmese is handled by the HF Space directly from the client, not here.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
// Whisper/m2m100 use ISO-639-1 codes; our target "zh-CN" -> "zh".
const M2M = { en: "en", ja: "ja", "zh-CN": "zh", zh: "zh", ms: "ms", ta: "ta", ko: "ko", th: "th", id: "id", vi: "vi", hi: "hi", fr: "fr", my: "my" };
const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });

async function transcribe(request, env) {
  try {
    const { audio, src, target } = await request.json();
    if (!audio) return j({ transcript: "", translation: "" });
    if (!env.AI) return j({ transcript: "", translation: "", error: "Workers AI binding 'AI' is not configured on this Worker" });

    const asr = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio, language: src, task: "transcribe" });
    const transcript = (asr.text || "").trim();

    let translation = "";
    if (transcript && target && target !== "off" && M2M[target] && M2M[target] !== M2M[src]) {
      try {
        const tr = await env.AI.run("@cf/meta/m2m100-1.2b", { text: transcript, source_lang: M2M[src] || "en", target_lang: M2M[target] });
        translation = (tr.translated_text || "").trim();
      } catch (_) { /* translation best-effort; keep the transcript */ }
    }
    return j({ transcript, translation });
  } catch (e) {
    return j({ transcript: "", translation: "", error: e.message });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/transcribe") {
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (request.method === "POST") return transcribe(request, env);
      return j({ error: "POST only" }, 405);
    }
    return env.ASSETS.fetch(request);   // everything else -> static site in public/
  },
};
