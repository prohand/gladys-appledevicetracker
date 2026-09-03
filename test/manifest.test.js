// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('every manifest action has a handler registered in index.js', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(
      indexSource.includes(`gladys.onAction('${action.key}'`),
      `manifest action "${action.key}" has no handler`,
    );
  }
});

test('the manifest version matches package.json and the docker image tag', () => {
  assert.equal(manifest.version, packageJson.version);
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    'the image tag must be the released version',
  );
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('every stored config key is known to the code', () => {
  for (const field of manifest.config_schema) {
    if (field.type === 'section') {
      continue;
    }
    assert.ok(
      field.key in DEFAULT_CONFIG,
      `config key "${field.key}" is missing from DEFAULT_CONFIG`,
    );
  }
});

test('the numeric bounds of the manifest are mirrored by the code', () => {
  // The form validates the input, but a config restored from an older version
  // must not be able to poll Apple every second: normalizeConfig clamps too.
  const pollField = manifest.config_schema.find((f) => f.key === 'poll_frequency');
  assert.equal(pollField.min, 60);
  assert.equal(pollField.max, 3600);
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0);
  for (const section of sections) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(section.placeholder, undefined, `section "${section.key}" must not have one`);
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the credentials field is a secret, never a plain string', () => {
  const password = manifest.config_schema.find((f) => f.key === 'apple_password');
  assert.equal(password.type, 'secret');
  assert.equal(password.required, true);
});

test('the iCloud session is an internal key, kept out of the config_schema', () => {
  const keys = manifest.config_schema.map((f) => f.key);
  assert.ok(!keys.includes('icloud_session'), 'the session must never be shown in the UI');
  assert.ok('icloud_session' in DEFAULT_CONFIG);
});

test('dynamic selects declare a source and no static options', () => {
  const allFields = [
    ...manifest.config_schema,
    ...(manifest.actions ?? []).flatMap((a) => a.fields ?? []),
  ];
  const dynamicSelects = allFields.filter((f) => f.source !== undefined);
  assert.ok(dynamicSelects.length > 0, 'the ring action targets one of our own devices');
  for (const field of dynamicSelects) {
    assert.equal(field.source, 'devices', 'the only core-defined source in V1 is "devices"');
    assert.equal(field.options, undefined, 'source and options together reject the manifest');
  }
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(major > 4 || (major === 4 && minor >= 86), `got "${manifest.gladys_version}"`);
});
