// POST { audio: <base64>, mime: "audio/wav", src: "my", target: "en" }
// -> { transcript, translation } via Gemini (audio understanding). Used for Burmese + record/upload.
import { LANG, hasKey, geminiCall, geminiText, json } from "./_lib.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const { audio, mime = "audio/wav", src = "my", target = "en" } = payload || {};
  if (!audio) return json({ transcript: "", translation: "" });

  // Burmese -> self-hosted SeamlessM4T Space (free, unlimited, no Gemini quota) when SCRIBE_ASR_URL is set.
  const ASR_URL = process.env.SCRIBE_ASR_URL;
  if (ASR_URL && src === "my") {
    try {
      const r = await fetch(ASR_URL.replace(/\/+$/, "") + "/transcribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio, src, target }),
      });
      if (r.ok) {
        const d = await r.json();
        if ((d.transcript || "").trim())
          return json({ transcript: d.transcript.trim(), translation: (d.translation || "").trim() });
      }
    } catch { /* fall through to Gemini */ }
  }

  // Gemini path (non-Burmese, or fallback if the Space is unavailable).
  if (!hasKey()) return json({ transcript: "", translation: "", error: "no ASR backend (set SCRIBE_ASR_URL or GEMINI_API_KEY)" }, 500);
  const srcName = LANG[src] || "the spoken language";
  const tgtName = target && target !== "off" ? (LANG[target] || "English") : null;
  const prompt =
    `This is ${srcName} elderly-care speech. Transcribe it accurately in its original script` +
    (tgtName ? `, then translate the transcript into ${tgtName}` : "") +
    `. Render vital-sign numbers as digits. Return ONLY JSON: ` +
    `{"transcript":"...","translation":"..."}. Use empty strings if there is no speech.`;

  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: audio } }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  };

  try {
    const data = await geminiCall(body);
    const obj = JSON.parse(geminiText(data) || "{}");
    return json({ transcript: (obj.transcript || "").trim(), translation: (obj.translation || "").trim() });
  } catch (e) {
    return json({ transcript: "", translation: "", error: String(e.message || e) });
  }
};
