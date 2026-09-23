// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import { SCENE_ACTION, SCENE_TRIGGER, positionOutputs, presenceEventData } from '../src/scenes.js';
import { WIDGET, WIDGET_ACTION } from '../src/widgets.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const deviceSource = await readFile(
  new URL('../src/devices/appleDevice.js', import.meta.url),
  'utf8',
);
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

// Keys the store indexer accepts on a config_schema field. An unknown one
// ("step", for instance) rejects the whole manifest, so list them here.
const ALLOWED_FIELD_KEYS = new Set([
  'key',
  'type',
  'label',
  'description',
  'placeholder',
  'required',
  'default',
  'min',
  'max',
  'options',
  'source',
  'links',
]);

/** Every form field of the manifest: config, actions, widgets and scenes. */
const allFields = [
  ...manifest.config_schema,
  ...(manifest.actions ?? []).flatMap((a) => a.fields ?? []),
  ...(manifest.widgets ?? []).flatMap((w) => w.settings ?? []),
  ...(manifest.scene_triggers ?? []).flatMap((t) => t.fields ?? []),
  ...(manifest.scene_actions ?? []).flatMap((a) => a.fields ?? []),
];

test('config_schema fields only use keys the manifest schema knows', () => {
  for (const field of allFields) {
    for (const key of Object.keys(field)) {
      assert.ok(ALLOWED_FIELD_KEYS.has(key), `unknown field "${key}" on "${field.key}"`);
    }
  }
});

test('the home coordinates are text fields, so decimals survive the form', () => {
  // A `number` input without a `step` rounds 48.8566 to 49, and `step` is not
  // part of the manifest schema: the coordinates are typed as text and parsed
  // by normalizeConfig. They are optional: left empty, index.js fills them with
  // the position of the Gladys house.
  for (const key of ['home_latitude', 'home_longitude']) {
    const field = manifest.config_schema.find((f) => f.key === key);
    assert.equal(field.type, 'string', `"${key}" must stay a text field`);
    assert.equal(field.required, false, `"${key}" is pre-filled, so it cannot be required`);
    assert.equal(field.min, undefined, 'min/max are for number fields only');
    assert.equal(field.max, undefined, 'min/max are for number fields only');
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
  const dynamicSelects = allFields.filter((f) => f.source !== undefined);
  assert.ok(dynamicSelects.length > 0, 'the ring action targets one of our own devices');
  for (const field of dynamicSelects) {
    assert.equal(field.source, 'devices', 'the only core-defined source in V1 is "devices"');
    assert.equal(field.options, undefined, 'source and options together reject the manifest');
  }
});

test('widgets and scene declarations require Gladys >= 5.1.0', () => {
  // An older Gladys refuses the whole manifest over the unknown `widgets`,
  // `scene_triggers` and `scene_actions` fields. 5.1 also covers the catalog
  // categories (4.86).
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(major > 5 || (major === 5 && minor >= 1), `got "${manifest.gladys_version}"`);
});

const keysOf = (list) => (list ?? []).map((entry) => entry.key).sort();

test('every scene action of the manifest has its handler, and only those', () => {
  assert.deepEqual(keysOf(manifest.scene_actions), Object.values(SCENE_ACTION).sort());
  for (const key of Object.values(SCENE_ACTION)) {
    assert.ok(
      indexSource.includes(`gladys.onSceneAction('${key}'`),
      `scene action "${key}" has no handler`,
    );
  }
});

test('every scene trigger the code fires is declared in the manifest', () => {
  // Gladys answers 404 on an undeclared key: the scene would never start.
  assert.deepEqual(keysOf(manifest.scene_triggers), Object.values(SCENE_TRIGGER).sort());
});

test('the arrival and departure data match their trigger card', () => {
  const data = presenceEventData('ext', { name: 'x' }, 0);
  for (const key of [SCENE_TRIGGER.ARRIVED_HOME, SCENE_TRIGGER.LEFT_HOME]) {
    const trigger = manifest.scene_triggers.find((t) => t.key === key);
    // Gladys builds the filters from the declared fields and the variables
    // from the declared variables: a key missing from the data is always null.
    for (const entry of [...trigger.fields, ...trigger.variables]) {
      assert.ok(entry.key in data, `${key}: "${entry.key}" is never sent`);
    }
    const device = trigger.fields.find((f) => f.key === 'device');
    assert.equal(device.source, 'devices', 'the filter compares external_ids');
    assert.equal(device.required, undefined, 'empty means any device');
  }
});

test('the position action declares every output it returns', () => {
  const action = manifest.scene_actions.find((a) => a.key === SCENE_ACTION.GET_POSITION);
  // Gladys drops an undeclared output: the scene would read an empty value.
  assert.deepEqual(keysOf(action.outputs), Object.keys(positionOutputs({})).sort());
});

test('the refresh action declares the outputs index.js returns', () => {
  const action = manifest.scene_actions.find((a) => a.key === SCENE_ACTION.REFRESH_POSITIONS);
  for (const output of action.outputs) {
    assert.ok(indexSource.includes(`${output.key}:`), `output "${output.key}" is never returned`);
  }
});

test('every widget of the manifest has its handlers, and only those', () => {
  assert.deepEqual(keysOf(manifest.widgets), Object.values(WIDGET).sort());
  for (const key of Object.values(WIDGET)) {
    assert.ok(
      indexSource.includes(`gladys.onWidgetGet('${key}'`),
      `widget "${key}" has no content`,
    );
    assert.ok(
      indexSource.includes(`gladys.onWidgetAction('${key}'`),
      `the ${WIDGET_ACTION.REFRESH} button of widget "${key}" has no handler`,
    );
  }
});

test('the widgets read the settings they declare', () => {
  const presence = manifest.widgets.find((w) => w.key === WIDGET.PRESENCE);
  assert.deepEqual(keysOf(presence.settings), ['devices']);
  assert.ok(indexSource.includes('settings?.devices'));
  const device = manifest.widgets.find((w) => w.key === WIDGET.DEVICE);
  assert.deepEqual(keysOf(device.settings), ['device']);
  assert.ok(indexSource.includes('settings?.device)'));
});

test('the scene and widget declarations respect the bounds of Gladys', () => {
  // Same limits as the core validator (externalIntegration.validateManifest):
  // one broken rule and the whole manifest is refused.
  assert.ok(manifest.widgets.length <= 5);
  for (const widget of manifest.widgets) {
    assert.match(widget.key, /^[a-z0-9_]{2,32}$/);
    assert.match(widget.icon, /^[a-z0-9-]{1,40}$/);
    for (const lang of Object.keys(widget.label)) {
      const { length } = widget.label[lang];
      assert.ok(length >= 3 && length <= 30, `widget label "${widget.label[lang]}"`);
      assert.ok(widget.description[lang].length <= 100, `widget description ${widget.key}`);
    }
    for (const field of widget.settings) {
      assert.ok(['string', 'number', 'boolean', 'select', 'multi_select'].includes(field.type));
    }
  }
  for (const [list, types] of [
    [manifest.scene_triggers, ['string', 'number', 'select', 'multi_select']],
    [manifest.scene_actions, ['string', 'number', 'boolean', 'select', 'multi_select']],
  ]) {
    assert.ok(list.length <= 20);
    for (const entry of list) {
      assert.match(entry.key, /^[a-z0-9_]{1,40}$/);
      assert.ok((entry.fields ?? []).length <= 10);
      for (const field of entry.fields ?? []) {
        assert.ok(types.includes(field.type), `${entry.key}.${field.key}: ${field.type}`);
      }
      for (const variable of [...(entry.variables ?? []), ...(entry.outputs ?? [])]) {
        assert.ok(['string', 'number', 'boolean'].includes(variable.type));
        assert.ok(variable.label.en);
      }
      if (entry.timeout_seconds !== undefined) {
        assert.ok(entry.timeout_seconds >= 5 && entry.timeout_seconds <= 120);
      }
    }
  }
});

test('the manifest asks for the "location" permission', () => {
  // Without it, GET /house answers 403 and the coordinates stay empty: this one
  // line IS the pre-fill feature.
  assert.equal(manifest.location, true);
});

test('the two-factor flow offers a way to ask for a new code', () => {
  // Apple only sends the code when it is asked to: the user must be able to
  // trigger it again without restarting the whole integration.
  const keys = (manifest.actions ?? []).map((a) => a.key);
  assert.ok(keys.includes('resend_2fa_code'));
  assert.ok(keys.includes('refresh_home_location'));
});

test('the cover image respects the store rules, or the catalog shows a placeholder', () => {
  // The indexer accepts a JPEG or PNG of exactly 800x534 and under 150 KB. An
  // invalid cover does not reject the integration: it is indexed with a default
  // image instead — which is exactly how a too-heavy cover goes unnoticed.
  const file = new URL(`../${manifest.cover_image.split('/').pop()}`, import.meta.url);
  const image = readFileSync(file);

  assert.ok(image.length < 150 * 1024, `cover image too heavy: ${image.length} bytes`);
  // PNG signature, then the IHDR chunk: width and height are two big-endian
  // 32-bit integers at offsets 16 and 20.
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  assert.equal(image.readUInt32BE(16), 800);
  assert.equal(image.readUInt32BE(20), 534);
});

test('the cover image is served over https, straight from the repository', () => {
  assert.match(manifest.cover_image, /^https:\/\/raw\.githubusercontent\.com\//);
});

test('the ring action of the manifest also exists as a feature on each device', () => {
  // The Configuration screen keeps its "Make a device ring" button, but the
  // same operation is a writable feature of every device: that is what makes it
  // usable from the dashboard and from a scene.
  const keys = (manifest.actions ?? []).map((a) => a.key);
  assert.ok(keys.includes('identify'));
  assert.ok(indexSource.includes('gladys.onSetValue('), 'no handler for device commands');
  assert.ok(deviceSource.includes('FEATURE.RING'), 'no ring feature on the devices');
});

test('index.js pre-fills the home coordinates from the Gladys house', () => {
  // The manifest promises it in the description of the "home" section: without
  // this call the fields would just stay empty.
  assert.ok(indexSource.includes('fetchGladysHomeCoordinates'));
  const home = manifest.config_schema.find((f) => f.key === 'home');
  assert.match(home.description.en, /pre-filled/i);
});
