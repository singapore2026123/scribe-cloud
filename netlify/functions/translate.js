// POST { text, src, target } -> { raw, translation }. Used to translate Web Speech (live) transcripts.
import { LANG, hasKey, geminiCall, geminiText, json } from "./_lib.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const { text = "", src = "auto", target = "en" } = payload || {};
  if (!text.trim() || target === "off") return json({ raw: text, translation: "" });
  if (!hasKey()) return json({ raw: text, translation: "", error: "GEMINI_API_KEY not set" });

  const tgtName = LANG[target] || "English";
  const srcName = LANG[src] || "";
  const prompt =
    `Translate this ${srcName} elderly-care transcription into ${tgtName}. ` +
    `Fix obvious speech-to-text slips silently. Reply with ONLY the translation, no quotes or notes.\n\n${text}`;

  try {
    const data = await geminiCall({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
    });
    return json({ raw: text, translation: geminiText(data).trim() });
  } catch (e) {
    return json({ raw: text, translation: "", error: String(e.message || e) });
  }
};
