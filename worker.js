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
// Google Translate free endpoint — no key, NO daily budget, good quality (same engine the desktop app used).
const GT = { en: "en", ja: "ja", zh: "zh-CN", "zh-CN": "zh-CN", ms: "ms", ta: "ta", my: "my", ko: "ko", th: "th", id: "id", vi: "vi", hi: "hi", fr: "fr" };
async function gtranslate(text, src, tgt) {
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" + (GT[src] || "auto") + "&tl=" + GT[tgt] + "&dt=t&q=" + encodeURIComponent(text);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "application/json" } });
  if (!res.ok) return "";
  const data = await res.json();
  return (data[0] || []).map((seg) => (seg && seg[0]) || "").join("").trim();
}
// Whisper hallucinates these on silence/non-speech (YouTube training artifact) — drop chunks that are just these.
const HALLUC = ["ご視聴ありがとうございました", "ご視聴ありがとうございます", "ご清聴ありがとうございました", "最後までご視聴いただきありがとうございました", "チャンネル登録をお願いします",
  "thank you for watching", "thanks for watching", "please subscribe", "thank you",
  "terima kasih", "terima kasih kerana menonton", "terima kasih kerana menonton video ini",
  "谢谢观看", "感谢观看", "谢谢大家观看", "请订阅", "请点赞订阅", "谢谢大家"];
function stripHalluc(t) {
  const n = t.replace(/[。．.!！?？、\s]+$/g, "").trim().toLowerCase();
  return HALLUC.some((h) => n === h.toLowerCase()) ? "" : t;
}

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
  zh: "医疗护理记录。术语：气管吸引、口腔吸引、清洁操作、鼻胃管喂食、管饲、翻身、口腔护理、导尿管、褥疮、误吸、血压、脉搏、体温、血氧饱和度、血糖、失智症、糖尿病、高血压、中风、吸入性肺炎、便秘、跌倒、护理员、护士、言语治疗师、生命体征。",
  ms: "Rekod penjagaan perubatan. Istilah: sedutan trakea, sedutan mulut, teknik aseptik, pemakanan tiub, tukar kedudukan, penjagaan mulut, kateter kencing, luka baring, aspirasi, tekanan darah, nadi, suhu badan, ketepuan oksigen, gula darah, demensia, kencing manis, darah tinggi, strok, radang paru-paru aspirasi, sembelit, jatuh, penjaga, jururawat, tanda vital, doktor, pesakit, ubat, demam.",
  ta: "மருத்துவ பராமரிப்பு பதிவு. சொற்கள்: இரத்த அழுத்தம், நாடித் துடிப்பு, உடல் வெப்பநிலை, ஆக்ஸிஜன் செறிவு, இரத்த சர்க்கரை, மருந்து, மருந்துச் சீட்டு, ஒவ்வாமை, செவிலியர், மருத்துவர், நீரிழிவு நோய், உயர் இரத்த அழுத்தம், பக்கவாதம், மலச்சிக்கல், நீரிழப்பு, காயம் பராமரிப்பு, படுக்கைப் புண், வாய் பராமரிப்பு.",
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

    let transcript = applyGlossary((asr.text || "").trim(), src);
    transcript = stripHalluc(transcript);
    if (!transcript) return j({ transcript: "", translation: "" });

    let translation = "";
    if (target && target !== "off" && GT[target] && GT[target] !== GT[src]) {
      try { translation = await gtranslate(transcript, src, target); } catch (_) {}   // Google Translate (no budget)
      if (!translation) {   // fallback so translation ALWAYS appears (rarely fires -> keeps Workers AI budget light)
        try {
          const tr = await env.AI.run("@cf/meta/m2m100-1.2b", { text: transcript, source_lang: M2M[src] || "en", target_lang: M2M[target] });
          translation = (tr.translated_text || "").trim();
        } catch (_) {}
      }
    }
    return j({ transcript, translation });
  } catch (e) {
    return j({ transcript: "", translation: "", error: e.message });
  }
}

const LNAME = { en: "English", ja: "Japanese", "zh-CN": "Chinese", zh: "Chinese", ms: "Malay", ta: "Tamil", my: "Burmese", off: "English" };
const NOTES_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";   // base 3.1-8b-instruct was deprecated 2026-05-30; -fast stays active
async function notes(request, env) {
  try {
    const { transcript, target } = await request.json();
    const text = String(transcript || "").trim();
    if (!text) return j({ notes: "" });
    if (!env.AI) return j({ notes: "", error: "Workers AI binding 'AI' is not configured on this Worker" });
    const lang = LNAME[target] || "English";
    const genSys = `You are an expert notes assistant like Genspark. From the meeting content below, produce COMPREHENSIVE, well-organised meeting notes in ${lang}, in Markdown. Cover EVERYTHING — do not omit topics or summarise away detail. Structure with ## headings: start with "## Overview", then group into several topical sections with descriptive headings, then "## Key Points" (bulleted), "## Decisions", "## Action Items" (use "- [owner if mentioned] task (due if mentioned)"), and "## Next Steps". Be detailed and faithful; do not invent.`;

    // Long meetings: map (bullet each segment) -> reduce (organise), so notes cover the WHOLE transcript.
    const CHUNK = 9000;
    let source = text;
    if (text.length > CHUNK * 1.4) {
      const parts = [];
      for (let i = 0; i < text.length && parts.length < 12; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
      const partials = [];
      for (const p of parts) {
        const r = await env.AI.run(NOTES_MODEL, {
          messages: [
            { role: "system", content: `Summarise this meeting transcript segment into concise factual bullet points in ${lang}, capturing every topic, decision, and action item. Keep all distinct points.` },
            { role: "user", content: p },
          ],
          max_tokens: 1024,
        });
        partials.push((r.response || "").trim());
      }
      source = partials.join("\n");
    }
    const r2 = await env.AI.run(NOTES_MODEL, {
      messages: [
        { role: "system", content: genSys },
        { role: "user", content: source.slice(0, 14000) },
      ],
      max_tokens: 2048,
    });
    return j({ notes: (r2.response || "").trim() });
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
