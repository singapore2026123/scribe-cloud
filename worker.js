// Cloudflare Worker: serves the static site in public/ + POST /transcribe (Workers AI Whisper + care-term
// glossary + m2m100 translation) + POST /notes (Workers AI Llama meeting notes). Burmese ASR is handled by
// the HF Space directly from the client, not here.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
// Whisper/m2m100 use ISO-639-1 codes; our target "zh-CN" -> "zh".
const M2M = { en: "en", ja: "ja", "zh-CN": "zh", zh: "zh", ms: "ms", ta: "ta", ko: "ko", th: "th", id: "id", vi: "vi", hi: "hi", fr: "fr", my: "my" };

// Care-term glossary (from the desktop glossary_ja.csv) — deterministic wrong->correct fixes for JA medical
// terms. Applied in order; only replaces known non-word errors. Extend as Cloudflare-Whisper errors surface.
const GLOSSARY = {
  ja: [
    ["転眼", "点眼"], ["自備院効果", "耳鼻咽喉科"], ["自備院講科", "耳鼻咽喉科"], ["自備医工科", "耳鼻咽喉科"],
    ["自備員効果", "耳鼻咽喉科"], ["自備因果", "耳鼻咽喉科"], ["言語聴覚師", "言語聴覚士"], ["固執形成術", "鼓室形成術"],
    ["腹鼻空", "副鼻腔"], ["電音難聴", "感音難聴"], ["肝音難聴", "感音難聴"], ["軟腸", "難聴"], ["南腸", "難聴"], ["南朝", "難聴"],
    ["自備院高科", "耳鼻咽喉科"], ["自秘院工科", "耳鼻咽喉科"], ["自秘院効果", "耳鼻咽喉科"], ["言語聴覚紙", "言語聴覚士"],
    ["純学内科", "循環器内科"], ["純学医内科", "循環器内科"], ["不正脈", "不整脈"], ["心房再動", "心房細動"],
    ["面痴漢術", "弁置換術"], ["末小動脈疾患", "末梢動脈疾患"], ["軽カテーテル", "経カテーテル"], ["人工内治", "人工内耳"],
    ["流地術", "留置術"], ["軽感栄養", "経管栄養"], ["経間栄養", "経管栄養"], ["航空吸引", "口腔吸引"], ["口空吸引", "口腔吸引"],
    ["正式で対応", "清拭で対応"], ["部分翼", "部分浴"], ["異常解除", "移乗介助"], ["移乗解除", "移乗介助"], ["配便", "排便"],
    ["機関吸引", "気管吸引"], ["基幹吸引", "気管吸引"], ["器官吸引", "気管吸引"], ["口腔ビッグ", "口腔吸引"], ["清潔ソース", "清潔操作"],
    ["航空", "口腔"], ["口空", "口腔"],
  ],
};
function applyGlossary(text, lang) {
  const pairs = GLOSSARY[lang];
  if (!pairs) return text;
  for (const [w, c] of pairs) if (text.includes(w)) text = text.split(w).join(c);
  return text;
}
// Care-term prompts to bias Whisper toward correct in-domain vocabulary (best-effort).
const PROMPTS = {
  ja: "医療・介護記録。用語：気管吸引、口腔吸引、清潔操作、実務者研修、医療的ケア、耳鼻咽喉科、点眼、難聴、感音難聴、鼓室形成術、副鼻腔、言語聴覚士、人工内耳、留置術、経管栄養、清拭、部分浴、移乗介助、排便、循環器内科、不整脈、心房細動、弁置換術、末梢動脈疾患、経カテーテル。",
};

const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });

async function transcribe(request, env) {
  try {
    const { audio, src, target } = await request.json();
    if (!audio) return j({ transcript: "", translation: "" });
    if (!env.AI) return j({ transcript: "", translation: "", error: "Workers AI binding 'AI' is not configured on this Worker" });

    const base = { audio, language: src, task: "transcribe" };
    const prompt = PROMPTS[src];
    let asr;
    try { asr = await env.AI.run("@cf/openai/whisper-large-v3-turbo", prompt ? { ...base, initial_prompt: prompt } : base); }
    catch (_) { asr = await env.AI.run("@cf/openai/whisper-large-v3-turbo", base); }   // biasing is best-effort

    const transcript = applyGlossary((asr.text || "").trim(), src);

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

const LNAME = { en: "English", ja: "Japanese", "zh-CN": "Chinese", zh: "Chinese", ms: "Malay", ta: "Tamil", my: "Burmese", off: "English" };
async function notes(request, env) {
  try {
    const { transcript, target } = await request.json();
    if (!transcript || !String(transcript).trim()) return j({ notes: "" });
    if (!env.AI) return j({ notes: "", error: "Workers AI binding 'AI' is not configured on this Worker" });
    const lang = LNAME[target] || "English";
    const r = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: `You are an expert meeting-notes assistant. From the transcript below, write clear, well-structured meeting notes in ${lang}, in Markdown, with these sections (omit a section only if nothing applies):\n## Summary\n## Key Discussion Points\n## Decisions\n## Action Items\n## Next Steps\nFor Action Items use "- [owner if mentioned] task (due if mentioned)". Be factual, do not invent, and cover the ENTIRE transcript.` },
        { role: "user", content: String(transcript).slice(0, 16000) },
      ],
      max_tokens: 2048,
    });
    return j({ notes: (r.response || "").trim() });
  } catch (e) {
    return j({ notes: "", error: e.message });
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
    if (url.pathname === "/notes") {
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (request.method === "POST") return notes(request, env);
      return j({ error: "POST only" }, 405);
    }
    return env.ASSETS.fetch(request);   // everything else -> static site in public/
  },
};
