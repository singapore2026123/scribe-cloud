// Shared helpers for Scribe Cloud functions. Gemini key is read from env (server-side only).
export const LANG = {
  en: "English", zh: "Chinese", "zh-CN": "Chinese", ms: "Malay", my: "Burmese",
  ja: "Japanese", ta: "Tamil", ko: "Korean", th: "Thai", id: "Indonesian",
  vi: "Vietnamese", hi: "Hindi", fr: "French",
};

const MODEL = () => process.env.GEMINI_MODEL || "gemini-2.5-flash";

// All configured keys (add GEMINI_API_KEY_2 / _3 / _4 in Netlify to multiply free-tier quota).
function keys() {
  return [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2,
          process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY_4].filter(Boolean);
}

export function hasKey() { return keys().length > 0; }

// Call Gemini, ROTATING keys on quota: 429 -> next key; 503 (overloaded) -> retry once on the same key.
export async function geminiCall(body) {
  const ks = keys();
  if (!ks.length) throw new Error("no GEMINI_API_KEY configured");
  let lastErr;
  for (const key of ks) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent?key=${key}`;
    for (let i = 0; i < 2; i++) {
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (r.ok) return r.json();
      if (r.status === 429) { lastErr = new Error("gemini 429 (quota)"); break; }        // exhausted -> next key
      if (r.status === 503 && i < 1) { await new Promise((s) => setTimeout(s, 1200)); continue; }  // overloaded -> retry once
      lastErr = new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 150)}`); break;
    }
  }
  throw lastErr || new Error("gemini failed");
}

export function geminiText(data) {
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
