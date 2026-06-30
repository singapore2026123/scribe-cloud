// Returns public client config (Supabase URL + anon key) to the browser at runtime.
// These are public-by-design (anon key is safe with RLS). The Gemini key is NOT exposed here.
import { json } from "./_lib.js";

export default async () =>
  json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    hasGemini: !!process.env.GEMINI_API_KEY,
    asrUrl: process.env.SCRIBE_ASR_URL || "",   // public Burmese ASR Space (browser calls it directly)
  });
