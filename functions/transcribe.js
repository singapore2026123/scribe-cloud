// Cloudflare Pages Function — non-Burmese ASR + translation via Workers AI (free, fast, accurate).
// Whisper large-v3-turbo for transcription + m2m100 for translation. Burmese is handled by the HF Space, not here.
// Needs a Workers AI binding named "AI" on the Pages project (Settings -> Functions -> Bindings).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
// Whisper/m2m100 use ISO-639-1 codes; our target "zh-CN" -> "zh".
const M2M = { en: "en", ja: "ja", "zh-CN": "zh", zh: "zh", ms: "ms", ta: "ta", ko: "ko", th: "th", id: "id", vi: "vi", hi: "hi", fr: "fr", my: "my" };

const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });

export const onRequestOptions = () => new Response(null, { headers: CORS });

export async function onRequestPost({ request, env }) {
  try {
    const { audio, src, target } = await request.json();
    if (!audio) return j({ transcript: "", translation: "" });
    if (!env.AI) return j({ transcript: "", translation: "", error: "Workers AI binding 'AI' not configured on this Pages project" });

    const asr = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio, language: src, task: "transcribe" });
    const transcript = (asr.text || "").trim();

    let translation = "";
    if (transcript && target && target !== "off" && M2M[target] && M2M[target] !== M2M[src]) {
      try {
        const tr = await env.AI.run("@cf/meta/m2m100-1.2b", { text: transcript, source_lang: M2M[src] || "en", target_lang: M2M[target] });
        translation = (tr.translated_text || "").trim();
      } catch (_) { /* translation is best-effort; keep the transcript */ }
    }
    return j({ transcript, translation });
  } catch (e) {
    return j({ transcript: "", translation: "", error: e.message });
  }
}
