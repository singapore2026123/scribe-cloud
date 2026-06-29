// Shared helpers for Scribe Cloud functions. Gemini key is read from env (server-side only).
export const LANG = {
  en: "English", zh: "Chinese", "zh-CN": "Chinese", ms: "Malay", my: "Burmese",
  ja: "Japanese", ta: "Tamil", ko: "Korean", th: "Thai", id: "Indonesian",
  vi: "Vietnamese", hi: "Hindi", fr: "French",
};

const MODEL = () => process.env.GEMINI_MODEL || "gemini-2.0-flash";

export function hasKey() { return !!process.env.GEMINI_API_KEY; }

// Call Gemini generateContent with retry on transient 429/503. Returns parsed JSON response.
export async function geminiCall(body, tries = 3) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if ((r.status === 429 || r.status === 503) && i < tries - 1) {
      await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
      continue;
    }
    if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  throw new Error("gemini retry exhausted (quota?)");
}

export function geminiText(data) {
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
