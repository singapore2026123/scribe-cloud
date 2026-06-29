// POST { transcript, target } -> { notes } : Genspark-style meeting notes via Gemini (one call).
import { LANG, hasKey, geminiCall, geminiText, json } from "./_lib.js";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!hasKey()) return json({ notes: "", error: "GEMINI_API_KEY not set" }, 500);
  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const { transcript = "", target = "en" } = payload || {};
  if (!transcript.trim()) return json({ notes: "" });

  const lang = target && target !== "off" ? (LANG[target] || "English") : "English";
  const prompt =
    `You are an expert meeting-notes assistant. From the transcript below, write clear, well-structured ` +
    `meeting notes in ${lang}, in Markdown, with these sections (omit a section if nothing applies):\n` +
    `## Summary\n## Key Discussion Points\n## Decisions\n## Action Items\n## Next Steps\n` +
    `For Action Items use '- [owner if mentioned] task (due if mentioned)'. Be concise and factual; ` +
    `do not invent details.\n\nTRANSCRIPT:\n${transcript}`;

  try {
    const data = await geminiCall({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    });
    return json({ notes: geminiText(data).trim() });
  } catch (e) {
    return json({ notes: "", error: String(e.message || e) });
  }
};
