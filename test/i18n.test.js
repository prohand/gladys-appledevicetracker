// -----------------------------------------------------------------------------
// The languages of the user-facing messages.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, localize } from '../src/i18n.js';

test('the messages are written in English, French, German and Spanish', () => {
  // English first: it is the language Gladys falls back on.
  assert.deepEqual(LANGUAGES, ['en', 'fr', 'de', 'es']);
});

test('localize builds one entry per language', () => {
  assert.deepEqual(
    localize((lang) => `[${lang}]`),
    { en: '[en]', fr: '[fr]', de: '[de]', es: '[es]' },
  );
});
