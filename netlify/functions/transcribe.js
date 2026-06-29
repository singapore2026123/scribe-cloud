// POST { audio: <base64>, mime: "audio/wav", src: "my", target: "en" }
// -> { transcript, translation } via Gemini (audio understanding). Used for Burmese + record/upload.
import { LANG, hasKey, geminiCall, geminiText, json } from "./_lib.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!hasKey()) return json({ transcript: "", translation: "", error: "GEMINI_API_KEY not set" }, 500);

  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const { audio, mime = "audio/wav", src = "my", target = "en" } = payload || {};
  if (!audio) return json({ transcript: "", translation: "" });

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
