# Care-terms glossary — sources & status

`care-terms.csv` — multilingual care/medical terminology for the Singapore eldercare PoC.

## Status by language
- **English / Japanese** — filled (project vocabulary + standard clinical terms).
- **Chinese (zh)** — filled (Simplified); to be cross-checked against a clinical source.
- **Malay (ms)** — filled; care/vital terms cross-referenced with the project's `Care-Term-Glossary-MM-MS-DRAFT`.
- **Burmese (my)** — filled where the term exists in the project's native-sourced `Care-Term-Glossary-MM-MS-DRAFT`
  (bathing, partial bath, body wiping, transfer, blood pressure, pulse, body temperature, oxygen saturation,
  medication, vital signs). Remaining `my` cells pending.
- **Tamil (ta)** — PENDING a sourced pass. Do NOT fill from guesswork.

## Authoritative sources to use for the Tamil (and Chinese verification) pass
- Commission for Scientific & Technical Terminology, Govt. of India — Tamil Medical Science glossary:
  http://cstt.education.gov.in/glossary-tamil-medical-science
- JIPMER — "Tamil for Medicos" manual (PDF): https://jipmer.edu.in/sites/default/files/Tamil-for-Medicos.pdf
- Preply — Tamil medical terminology guide: https://preply.com/en/blog/tamil-medical-terminology/
- Lexicool — Tamil medical/health/personal-care dictionary: https://www.lexicool.com/online-dictionary.asp?FSP=A31C25

## Notes
- Terms remain human-reviewable (native review recommended before clinical use).
- ASR-correction pairs (observed `wrong -> correct`) live separately in `worker.js` (GLOSSARY) + `glossary_ja.csv`;
  this file is the reference/translation table + basis for Whisper biasing prompts.
