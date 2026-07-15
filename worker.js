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
const HALLUC = [
  // Japanese
  "ご視聴ありがとうございました", "ご視聴ありがとうございます", "ご清聴ありがとうございました", "最後までご視聴いただきありがとうございました",
  "チャンネル登録をお願いします", "以上で終わります", "以上で終わります。", "これで終わります", "本日は以上です", "ありがとうございました", "おわり", "終わり", "次回もお楽しみに",
  // English
  "thank you for watching", "thanks for watching", "thank you for watching!", "thanks for watching!", "please subscribe", "please like and subscribe",
  "like and subscribe", "don't forget to subscribe", "see you next time", "see you in the next video", "thank you", "thank you.", "you", "bye", "bye bye", "the end",
  "subtitles by the amara.org community", "transcription by castingwords",
  // Malay / Indonesian
  "terima kasih", "terima kasih kerana menonton", "terima kasih kerana menonton video ini", "jangan lupa like dan subscribe", "sampai jumpa", "sampai jumpa lagi", "terima kasih telah menonton",
  // Chinese
  "谢谢观看", "感谢观看", "谢谢大家观看", "请订阅", "请点赞订阅", "谢谢大家", "谢谢", "下次见", "再见", "我们下期再见", "完",
  "请点赞订阅转发打赏支持明镜与点点栏目", "请不吝点赞订阅转发打赏支持明镜与点点栏目",
  // Tamil
  "நன்றி", "பார்த்ததற்கு நன்றி", "வீடியோவைப் பார்த்ததற்கு நன்றி", "சந்தா செலுத்துங்கள்",
  // Korean
  "시청해주셔서 감사합니다", "시청해 주셔서 감사합니다", "구독과 좋아요 부탁드립니다", "감사합니다", "다음에 또 만나요",
  // Thai
  "ขอบคุณที่รับชม", "ขอบคุณครับ", "ขอบคุณค่ะ", "อย่าลืมกดไลค์กดแชร์",
  // Vietnamese
  "cảm ơn các bạn đã xem", "cảm ơn đã theo dõi", "hãy đăng ký kênh", "hẹn gặp lại",
  // Hindi
  "देखने के लिए धन्यवाद", "सब्सक्राइब करें", "धन्यवाद",
  // French
  "merci d'avoir regardé", "merci", "abonnez-vous", "sous-titres réalisés par la communauté d'amara.org", "n'oubliez pas de vous abonner"];
// YouTube-style like/subscribe hallucination markers — if a chunk contains any, it's a hallucination (never in care speech).
const HALLUC_MARK = ["明镜", "点点栏目", "打赏", "点赞", "订阅", "转发", "字幕组", "字幕由", "amara.org", "castingwords", "subscribe to", "like and subscribe", "구독", "좋아요 부탁", "กดไลค์กดแชร์", "đăng ký kênh", "yoyo television", "television series exclusive"];
// Unambiguous hallucination phrases removed INLINE (they appear mid-chunk alongside real text; not plausible care speech).
const HALLUC_PHRASE = ["ご視聴ありがとうございました", "ご視聴ありがとうございます", "ご清聴ありがとうございました",
  "最後までご視聴いただきありがとうございました", "チャンネル登録をお願いします", "以上で終わります", "これで終わります", "本日は以上です",
  "thanks for watching", "thank you for watching", "please like and subscribe", "please subscribe", "don't forget to subscribe",
  "subtitles by the amara.org community",
  "terima kasih kerana menonton video ini", "terima kasih kerana menonton", "jangan lupa like dan subscribe",
  "请点赞订阅转发打赏支持明镜与点点栏目", "请不吝点赞订阅转发打赏支持明镜与点点栏目",
  "谢谢观看", "感谢观看", "谢谢大家观看", "请点赞订阅", "请订阅",
  "시청해주셔서 감사합니다", "구독과 좋아요 부탁드립니다",
  "ขอบคุณที่รับชม", "cảm ơn các bạn đã xem", "hãy đăng ký kênh",
  "देखने के लिए धन्यवाद", "merci d'avoir regardé", "sous-titres réalisés par la communauté d'amara.org", "n'oubliez pas de vous abonner"];
function stripHalluc(t) {
  for (const h of HALLUC_PHRASE) t = t.split(h).join(" ");   // strip embedded hallucination phrases, keep real text
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([。．、！？,.!?;:])/g, "$1").replace(/。{2,}/g, "。").trim();   // tidy only removes space BEFORE punctuation — never after (keeps Malay/English word spacing)
  const low = t.toLowerCase();
  const n = low.replace(/[。．.!！?？、\s]+$/g, "").trim();
  if (!n) return "";
  if (HALLUC.some((h) => n === h.toLowerCase())) return "";
  if (HALLUC_MARK.some((m) => low.includes(m))) return "";
  return t;
}
function collapseRepeats(t) {   // Whisper degeneration guard: collapse looped tokens/phrases (e.g. "洗衣洗衣…", "laundry laundry…")
  if (!t) return t;                       // linear scan — NO backreference regex (those ReDoS on long loops)
  if (t.length > 8000) t = t.slice(0, 8000);
  const words = t.split(/\s+/);           // collapse 3+ consecutive identical space-separated tokens -> keep 1
  const w = [];
  for (const tok of words) { const n = w.length; if (!(n >= 1 && w[n - 1] === tok)) w.push(tok); }
  t = w.join(" ");
  for (let L = 1; L <= 8; L++) {          // collapse a 1..8-char unit repeated 4+ times contiguously -> keep 1
    let i = 0, out = "";
    while (i < t.length) {
      const unit = t.substr(i, L);
      if (unit.length < L) { out += t.slice(i); break; }
      let c = 1;
      while (t.substr(i + c * L, L) === unit) c++;
      if (c >= 4) { out += unit; i += c * L; } else { out += t[i]; i++; }
    }
    t = out;
  }
  return t.trim();
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
    ["航空", "口腔"], ["口空", "口腔"], ["白内小", "白内障"], ["白内症", "白内障"],
  ],
};
function applyGlossary(text, lang) {
  const pairs = GLOSSARY[lang];
  if (!pairs) return text;
  for (const [w, c] of pairs) if (text.includes(w)) text = text.split(w).join(c);
  return text;
}
// Spoken-symbol -> symbol normalization for numbers/vitals. ASR hears the digits but writes the SPOKEN symbol as a word
// (Malay "128 garis miring 98" -> "128/98", "35 perpuluhan 7" -> "35.7"). Only fires BETWEEN digits, so it's safe on prose.
const NUM_SPOKEN = {
  ms: [["garis miring", "/"], ["garis pisah", "/"], ["perpuluhan", "."]],
  en: [["slash", "/"], ["point", "."]],
};
function normSpokenNumbers(text, lang) {
  const rules = NUM_SPOKEN[lang];
  if (!rules) return text;
  for (const [word, sym] of rules) {
    const re = new RegExp("(\\d)\\s*" + word.replace(/\s+/g, "\\s+") + "\\s*(\\d)", "gi");
    let prev;
    do { prev = text; text = text.replace(re, "$1" + sym + "$2"); } while (text !== prev);   // chained: "1 slash 2 slash 3"
  }
  return text;
}
// Care-term prompts to bias Whisper toward correct in-domain vocabulary (best-effort).
const PROMPTS = {
  ja: "医療・介護記録。用語：気管吸引、口腔吸引、清潔操作、実務者研修、医療的ケア、耳鼻咽喉科、点眼、難聴、感音難聴、鼓室形成術、副鼻腔、言語聴覚士、人工内耳、留置術、経管栄養、清拭、部分浴、移乗介助、排便、循環器内科、不整脈、心房細動、弁置換術、末梢動脈疾患、経カテーテル、咳、くしゃみ、発熱、腫れ、骨折、出血、嘔吐、めまい、発疹、包帯。",
  zh: "医疗护理记录。术语：气管吸引、口腔吸引、清洁操作、鼻胃管喂食、管饲、翻身、口腔护理、导尿管、褥疮、误吸、血压、脉搏、体温、血氧饱和度、血糖、失智症、糖尿病、高血压、中风、吸入性肺炎、便秘、跌倒、护理员、护士、言语治疗师、生命体征、咳嗽、喷嚏、发烧、肿胀、骨折、出血、呕吐、头晕、皮疹、绷带。",
  ms: "Rekod penjagaan perubatan. Istilah: sedutan trakea, sedutan mulut, teknik aseptik, pemakanan tiub, tukar kedudukan, penjagaan mulut, kateter kencing, luka baring, aspirasi, tekanan darah, nadi, suhu badan, ketepuan oksigen, gula darah, demensia, kencing manis, darah tinggi, strok, radang paru-paru aspirasi, sembelit, jatuh, penjaga, jururawat, tanda vital, doktor, pesakit, ubat, demam, batuk, bersin, bengkak, patah tulang, pendarahan, muntah, pening, ruam, pembalut.",
  ta: "மருத்துவ பராமரிப்பு பதிவு. சொற்கள்: இரத்த அழுத்தம், நாடித் துடிப்பு, உடல் வெப்பநிலை, ஆக்ஸிஜன் செறிவு, இரத்த சர்க்கரை, மருந்து, மருந்துச் சீட்டு, ஒவ்வாமை, செவிலியர், மருத்துவர், நீரிழிவு நோய், உயர் இரத்த அழுத்தம், பக்கவாதம், மலச்சிக்கல், நீரிழப்பு, காயம் பராமரிப்பு, படுக்கைப் புண், வாய் பராமரிப்பு, இருமல், தும்மல், காய்ச்சல், வீக்கம், எலும்பு முறிவு, இரத்தப்போக்கு, வாந்தி, தலைச்சுற்றல், தடிப்பு, கட்டு.",
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
    const M = "@cf/openai/whisper-large-v3-turbo";
    const withPrompt = prompt ? { ...base, initial_prompt: prompt } : base;
    try { asr = await env.AI.run(M, withPrompt); }   // biasing prompt
    catch (_) { asr = await env.AI.run(M, base); }   // fallback without prompt

    let transcript = collapseRepeats(applyGlossary((asr.text || "").trim(), src));
    transcript = stripHalluc(transcript);
    transcript = normSpokenNumbers(transcript, src);   // "128 garis miring 98" -> "128/98" (Malay vitals), etc.
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
    const genSys = `You are an expert notes assistant like Genspark. From the meeting content below, produce COMPREHENSIVE, well-organised meeting notes written ENTIRELY in ${lang} — including ALL section headings: translate the heading names into ${lang}, do NOT use English headings. Use Markdown with ## headings. Cover EVERYTHING — do not omit topics or summarise away detail. Structure: start with an overview section, then group into several topical sections with descriptive headings, then a key-points section (bulleted), decisions, action items (use "- [owner if mentioned] task (due if mentioned)"), and next steps. Be detailed and faithful; do not invent.`;

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

// ---- Structured care-record extraction: keyword categorize (deterministic) + LLM entity extraction. ----
// "Propose, human confirms" — the client shows the result as EDITABLE fields; nothing is auto-committed to a record.
const CAT_KEYWORDS = {
  incident: [/\bfell\b/i, /\bfall(en|ing|s)?\b/i, /\binjur/i, /\bbruis/i, /\bbleed/i, /\bwound\b/i, /\bchok/i, /\bcollapse/i, /転倒/, /怪我|けが/, /出血/, /負傷/],
  medication: [/\bmedication\b/i, /\bmedicine\b/i, /\btablet/i, /\bcapsule/i, /\bdose\b/i, /\badminist/i, /\binsulin\b/i, /\bparacetamol\b/i, /\bmg\b/i, /投薬|服薬|薬/],
  vitals: [/\bblood pressure\b/i, /\btemperature\b/i, /\bpulse\b/i, /\bspo2\b/i, /\boxygen\b/i, /\bheart rate\b/i, /\bbp\b/i, /\bsugar\b|\bglucose\b/i, /血圧|体温|脈|血糖/],
};
const CAT_ORDER = ["incident", "medication", "vitals"];
const REC_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["incident", "medication", "vitals", "adl", "general"] },
    summary: { type: "string" },
    vitals: { type: "object", properties: { bp: { type: "string" }, temp: { type: "string" }, pulse: { type: "string" }, spo2: { type: "string" }, resp: { type: "string" } } },
    medications: { type: "array", items: { type: "object", properties: { name: { type: "string" }, dose: { type: "string" }, route: { type: "string" }, time: { type: "string" } } } },
    symptoms: { type: "array", items: { type: "string" } },
    actions: { type: "array", items: { type: "string" } },
  },
  required: ["category", "summary", "vitals", "medications", "symptoms", "actions"],
};
function keywordCategory(t) {
  for (const c of CAT_ORDER) if (CAT_KEYWORDS[c].some((p) => p.test(t))) return c;
  return "general";
}
const _s = (x) => (x == null ? "" : String(x).trim());
function parseJsonLoose(s) {
  if (!s) return null;
  let t = String(s).replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch (_) { return null; }
}
function normalizeRecord(d, kwCat) {
  d = d && typeof d === "object" ? d : {};
  const v = d.vitals && typeof d.vitals === "object" ? d.vitals : {};
  const list = (x) => (Array.isArray(x) ? x : []);
  const cat = ["incident", "medication", "vitals", "adl", "general"].includes(d.category) ? d.category : kwCat;
  return {
    category: cat,
    summary: _s(d.summary),
    vitals: { bp: _s(v.bp), temp: _s(v.temp), pulse: _s(v.pulse), spo2: _s(v.spo2), resp: _s(v.resp) },
    medications: list(d.medications).map((m) => (m && typeof m === "object")
      ? { name: _s(m.name), dose: _s(m.dose), route: _s(m.route), time: _s(m.time) }
      : { name: _s(m), dose: "", route: "", time: "" }).filter((m) => m.name),
    symptoms: list(d.symptoms).map(_s).filter(Boolean),
    actions: list(d.actions).map(_s).filter(Boolean),
  };
}
async function extract(request, env) {
  try {
    const { transcript, target } = await request.json();
    const text = String(transcript || "").trim();
    if (!text) return j({ record: null });
    const kwCat = keywordCategory(text);
    if (!env.AI) return j({ record: normalizeRecord(null, kwCat), error: "Workers AI binding 'AI' is not configured" });
    const lang = LNAME[target] || "English";
    const sys = `You extract a STRUCTURED care-record entry from a nursing/eldercare voice note. Fill the JSON schema using ONLY what the note states — NEVER invent or infer a value that was not said; leave a field "" or [] if not mentioned. Write vitals as digits (bp like "130/80", temp like "37.2"). Write all human-readable text values in ${lang}. "category" is the single best fit of incident/medication/vitals/adl/general. If nothing structured is present, use "general" with just a summary.`;
    const messages = [{ role: "system", content: sys }, { role: "user", content: text.slice(0, 12000) }];
    let data = null;
    try {   // guided JSON generation (Workers AI JSON mode) — far more reliable than free-form
      const r = await env.AI.run(NOTES_MODEL, { messages, max_tokens: 900, response_format: { type: "json_schema", json_schema: REC_SCHEMA } });
      data = (r.response && typeof r.response === "object") ? r.response : parseJsonLoose(String(r.response || ""));
    } catch (_) {}
    if (!data) {   // fallback: plain call + loose parse, in case the model/endpoint rejects response_format
      try { const r2 = await env.AI.run(NOTES_MODEL, { messages, max_tokens: 900 }); data = parseJsonLoose(r2.response || ""); } catch (_) {}
    }
    return j({ record: normalizeRecord(data, kwCat) });
  } catch (e) {
    return j({ record: null, error: e.message });
  }
}

// Self-service account deletion: verify the caller's Supabase JWT, then admin-delete the user + their data.
// Requires env vars SUPABASE_URL, SUPABASE_ANON_KEY (public) and SECRET SUPABASE_SERVICE_ROLE (never sent to the client).
async function deleteAccount(request, env) {
  const base = (env.SUPABASE_URL || "").replace(/\/+$/, ""), service = env.SUPABASE_SERVICE_ROLE, anon = env.SUPABASE_ANON_KEY;
  if (!base || !service || !anon) return j({ error: "Account deletion is not configured on the server (missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE)." }, 500);
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return j({ error: "Not authenticated" }, 401);
  let uid;
  try {
    const u = await fetch(base + "/auth/v1/user", { headers: { apikey: anon, Authorization: "Bearer " + token } });
    if (!u.ok) return j({ error: "Invalid or expired session" }, 401);
    uid = (await u.json()).id;
  } catch (e) { return j({ error: "Auth check failed: " + e.message }, 502); }
  if (!uid) return j({ error: "Could not resolve user" }, 401);
  const admin = { apikey: service, Authorization: "Bearer " + service, "Content-Type": "application/json" };
  try {
    await fetch(base + "/rest/v1/documents?user_id=eq." + uid, { method: "DELETE", headers: admin });   // clean data first
    await fetch(base + "/rest/v1/folders?user_id=eq." + uid, { method: "DELETE", headers: admin });
    const d = await fetch(base + "/auth/v1/admin/users/" + uid, { method: "DELETE", headers: admin });
    if (!d.ok) return j({ error: "Delete failed: " + (await d.text()).slice(0, 200) }, 502);
  } catch (e) { return j({ error: "Delete failed: " + e.message }, 502); }
  return j({ ok: true });
}

// Standalone text translation (used by the swap button to re-translate in the flipped direction).
const LANG_NAME = { en: "English", ja: "Japanese", zh: "Chinese", "zh-CN": "Chinese", ms: "Malay", ta: "Tamil", my: "Burmese", ko: "Korean", th: "Thai", id: "Indonesian", vi: "Vietnamese", hi: "Hindi", fr: "French" };
async function translate(request, env) {
  try {
    const { text, sl, tl, llm } = await request.json();
    if (!text || !tl || tl === "off") return j({ translation: "" });
    if (llm && env.AI) {   // higher-quality contextual translation of the full transcript (used on Stop / target change)
      try {
        const sys = `You are a professional translator for eldercare and nursing records. Translate the user's ${LANG_NAME[sl] || sl} text into ${LANG_NAME[tl] || tl}. Output ONLY the translation — natural, accurate and complete, faithful to the source with nothing added or omitted, no notes/labels/quotes. Preserve line breaks.`;
        const r = await env.AI.run(NOTES_MODEL, { messages: [{ role: "system", content: sys }, { role: "user", content: text }], max_tokens: 1500 });
        const o = (r.response || "").trim();
        if (o) return j({ translation: o });
      } catch (_) {}
    }
    let out = "";
    try { out = await gtranslate(text, sl || "auto", tl); } catch (_) {}
    if (!out && env.AI && M2M[tl]) {
      try { const r = await env.AI.run("@cf/meta/m2m100-1.2b", { text, source_lang: M2M[sl] || "en", target_lang: M2M[tl] }); out = r.translated_text || ""; } catch (_) {}
    }
    return j({ translation: out });
  } catch (e) { return j({ error: e.message }, 500); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/translate") {
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (request.method === "POST") return translate(request, env);
      return j({ error: "POST only" }, 405);
    }
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
    if (url.pathname === "/extract") {
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (request.method === "POST") return extract(request, env);
      return j({ error: "POST only" }, 405);
    }
    if (url.pathname === "/account") {
      if (request.method === "OPTIONS") return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Methods": "DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
      if (request.method === "DELETE") return deleteAccount(request, env);
      return j({ error: "DELETE only" }, 405);
    }
    return env.ASSETS.fetch(request);   // everything else -> static site in public/
  },
};
