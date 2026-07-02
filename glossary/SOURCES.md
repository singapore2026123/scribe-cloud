# Care-terms glossary — sources & status

`care-terms.csv` — multilingual care/medical terminology for the Singapore eldercare PoC.

## Status by language
- **English / Japanese** — filled (project vocabulary + standard clinical terms).
- **Chinese (zh)** — filled (Simplified); to be cross-checked against a clinical source.
- **Malay (ms)** — filled; care/vital terms cross-referenced with the project's `Care-Term-Glossary-MM-MS-DRAFT`.
- **Burmese (my)** — filled where the term exists in the project's native-sourced `Care-Term-Glossary-MM-MS-DRAFT`
  (bathing, partial bath, body wiping, transfer, blood pressure, pulse, body temperature, oxygen saturation,
  medication, vital signs). Remaining `my` cells pending.
- **Tamil (ta)** — filled from standard Tamil clinical vocabulary + sourced common terms; compound/technical
  entries are flagged with **(?)** for native review before clinical use.

## Authoritative sources to use for the Tamil (and Chinese verification) pass
- Commission for Scientific & Technical Terminology, Govt. of India — Tamil Medical Science glossary:
  http://cstt.education.gov.in/glossary-tamil-medical-science
- JIPMER — "Tamil for Medicos" manual (PDF): https://jipmer.edu.in/sites/default/files/Tamil-for-Medicos.pdf
- Preply — Tamil medical terminology guide: https://preply.com/en/blog/tamil-medical-terminology/
- Lexicool — Tamil medical/health/personal-care dictionary: https://www.lexicool.com/online-dictionary.asp?FSP=A31C25

## Comprehensive per-language glossaries (medical + everyday)
`japanese-glossary.csv`, `chinese-glossary.csv`, `malay-glossary.csv`, `tamil-glossary.csv` — each combines a
`medical` block + an `everyday` block, columns `english,<lang>,category`. Sourced from Learn Entry
(`healthcare-in-<lang>` for medical, `verbs-in-<lang>` for everyday).

**Quality caveat — read before wiring into the app:** the Learn Entry everyday pages are auto-generated and
frequently give the wrong sense (a noun where a verb is meant, e.g. MS `patient→sabar`, ZH `bear→熊`, TA
`would→என்று`). Every such row is flagged with a trailing **(?)** in the native cell. Treat `(?)` rows as
review-required and do NOT feed them into ASR biasing or the correction map until a native speaker confirms them.
Common everyday words (be/have/go…) don't improve ASR anyway — Whisper/Google Translate already handle them; the
real accuracy levers are the domain/**medical** terms (biasing) and observed `wrong -> correct` pairs.

## Notes
- Terms remain human-reviewable (native review recommended before clinical use).
- ASR-correction pairs (observed `wrong -> correct`) live separately in `worker.js` (GLOSSARY) + `glossary_ja.csv`;
  this file is the reference/translation table + basis for Whisper biasing prompts.
