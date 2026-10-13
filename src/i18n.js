// -----------------------------------------------------------------------------
// The languages of the user-facing messages.
//
// Gladys displays a multi-language object `{ en, fr, de, es }` in the language
// of the reader and falls back on `en` for any other: every message this
// integration hands over (connection status, action answers, widget texts)
// carries these four keys.
// -----------------------------------------------------------------------------

/** The languages every user-facing message is written in. `en` is the fallback. */
export const LANGUAGES = ['en', 'fr', 'de', 'es'];

/**
 * Build a multi-language message from a function of the language, for the
 * messages assembled from parts (a list, a sentence plus a suffix).
 *
 * @param {(lang: string) => string} build the text in one language
 * @returns {Record<string, string>} one entry per language of LANGUAGES
 */
export function localize(build) {
  return Object.fromEntries(LANGUAGES.map((lang) => [lang, build(lang)]));
}
