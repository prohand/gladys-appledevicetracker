// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1+).
//
// The manifest declares two widgets (`widgets`), and Gladys asks for their
// content when a dashboard shows them. The content is not HTML: it is a short
// list of components (tiles, a status list, a chart, buttons) that Gladys
// draws itself, with its theme, its dark mode and its layout.
//
//   - `presence`: who is at home — one line per device, at home or how far;
//   - `device`: one device in detail — battery, distance, the distance chart
//     of the last 24 hours, the ring button and a link to the map.
//
// Tiles and charts bound to a feature (`device_feature`) are live: Gladys
// updates them from the published states, with no help from here. The rest
// (texts, status lines) is re-read at the end of `ttl_seconds`, or sooner when
// the tracker nudges the widget after a refresh (requestWidgetRefresh).
//
// Every function here is pure: the tracker gathers the data, these only turn
// it into content, so the tests can check the content against the rules of
// Gladys (validateWidgetContent) without a tracker.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { FEATURE } from './devices/index.js';

export const WIDGET = {
  PRESENCE: 'presence',
  DEVICE: 'device',
};

/** The one button action of both widgets. */
export const WIDGET_ACTION = {
  REFRESH: 'refresh',
};

// Gladys shows at most 10 lines in a status list.
const MAX_STATUS_ITEMS = 10;

const KM_PER_MILE = 1.609344;

const TEXTS = {
  en: {
    atHome: 'At home',
    away: 'Away',
    unknown: 'Unknown',
    noPosition: 'No position',
    presence: 'Presence',
    charging: 'Charging',
    yes: 'Yes',
    no: 'No',
    accuracy: 'Accuracy',
    lastPosition: 'Last position',
    battery: 'Battery',
    distance: 'Distance',
    distanceChart: 'Distance from home (24 h)',
    ring: 'Ring',
    map: 'Map',
    refresh: 'Refresh',
    justNow: 'just now',
    minutesAgo: (n) => `${n} min ago`,
    hoursAgo: (n) => `${n} h ago`,
    daysAgo: (n) => `${n} d ago`,
    updated: (age) => `Find My read ${age}`,
    notSignedIn: 'Not signed in to iCloud: open the Configuration tab of the integration.',
    twoFactor:
      'iCloud is asking for a new two-factor code: enter it from the Configuration tab of the integration.',
    noDevice: 'No device yet: add your Apple devices from the Discovery tab of the integration.',
    deviceGone: 'This device is not in the Find My list any more.',
    others: 'Others',
  },
  fr: {
    atHome: 'A la maison',
    away: 'Absent',
    unknown: 'Inconnue',
    noPosition: 'Pas de position',
    presence: 'Presence',
    charging: 'En charge',
    yes: 'Oui',
    no: 'Non',
    accuracy: 'Precision',
    lastPosition: 'Derniere position',
    battery: 'Batterie',
    distance: 'Distance',
    distanceChart: 'Distance du domicile (24 h)',
    ring: 'Sonner',
    map: 'Carte',
    refresh: 'Rafraichir',
    justNow: "a l'instant",
    minutesAgo: (n) => `il y a ${n} min`,
    hoursAgo: (n) => `il y a ${n} h`,
    daysAgo: (n) => `il y a ${n} j`,
    updated: (age) => `Localiser lu ${age}`,
    notSignedIn: "Pas connecte a iCloud : ouvrez l'onglet Configuration de l'integration.",
    twoFactor:
      "iCloud demande un nouveau code de double authentification : saisissez-le depuis l'onglet Configuration de l'integration.",
    noDevice:
      "Aucun appareil pour l'instant : ajoutez vos appareils Apple depuis l'onglet Decouverte de l'integration.",
    deviceGone: "Cet appareil n'est plus dans la liste de Localiser.",
    others: 'Autres',
  },
};

/** The texts in the language of the user reading the dashboard (English otherwise). */
export function textsFor(language) {
  return TEXTS[language] ?? TEXTS.en;
}

/**
 * How long Gladys may keep a content before asking again: the refresh
 * interval of Find My, since nothing changes in between — within the bounds
 * Gladys accepts (10 s to 1 h).
 *
 * @param {object} config normalized integration config
 */
export function widgetTtl(config) {
  return Math.min(3600, Math.max(60, Number(config?.poll_frequency) || 300));
}

/**
 * A distance for a human: meters under a kilometer, one decimal above, miles
 * for a user who asked for them.
 *
 * @param {number} km distance in kilometers
 * @param {string} language ISO 639-1 code
 * @param {'metric'|'us'} units unit preference of the user
 */
export function formatDistance(km, language, units) {
  const format = (value, digits) =>
    new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value);
  if (units === 'us') {
    const miles = km / KM_PER_MILE;
    return `${format(miles, miles < 10 ? 1 : 0)} mi`;
  }
  if (km < 1) {
    return `${format(Math.round(km * 1000), 0)} m`;
  }
  return `${format(km, km < 10 ? 1 : 0)} km`;
}

/**
 * "12 min ago", "3 h ago": how old a position (or a refresh) is.
 *
 * @param {number|null} minutes age, in minutes
 * @param {object} t the texts of the user's language
 */
export function formatAge(minutes, t) {
  if (!Number.isFinite(minutes)) {
    return t.unknown;
  }
  if (minutes < 1) {
    return t.justNow;
  }
  if (minutes < 60) {
    return t.minutesAgo(minutes);
  }
  if (minutes < 48 * 60) {
    return t.hoursAgo(Math.round(minutes / 60));
  }
  return t.daysAgo(Math.round(minutes / 1440));
}

/**
 * The one line saying where a device is: at home, away (and how far), or
 * nobody knows.
 */
function presenceLine(summary, t, language, units) {
  if (summary.present === true) {
    return { value: t.atHome, color: WIDGET_COLORS.SUCCESS, icon: 'home' };
  }
  if (summary.present === false) {
    const distance =
      summary.distanceKm !== null
        ? ` · ${formatDistance(summary.distanceKm, language, units)}`
        : '';
    return { value: `${t.away}${distance}`, color: WIDGET_COLORS.NEUTRAL, icon: 'navigation' };
  }
  return {
    value: summary.located ? t.unknown : t.noPosition,
    color: WIDGET_COLORS.WARNING,
    icon: 'help-circle',
  };
}

/** The refresh button both widgets end with. */
function refreshButton(t) {
  return {
    type: 'button',
    label: t.refresh,
    icon: 'refresh-cw',
    style: 'secondary',
    action: { key: WIDGET_ACTION.REFRESH },
  };
}

/**
 * The content shown instead of the data when there is none to show: not
 * signed in yet, or iCloud waiting for a code. Said plainly rather than an
 * empty card, which would look like "everybody is away".
 *
 * @param {'connected'|'disconnected'|'2fa_required'} status the tracker status
 * @param {object} t the texts of the user's language
 * @returns {object|null} the content, or null when signed in
 */
function signInContent(status, t, ttl) {
  if (status === 'connected') {
    return null;
  }
  return {
    ttl_seconds: ttl,
    components: [
      {
        type: 'text',
        variant: 'body',
        text: status === '2fa_required' ? t.twoFactor : t.notSignedIn,
      },
    ],
  };
}

/**
 * Content of the `presence` widget: who is at home.
 *
 * @param {object} params
 * @param {string} params.status the tracker status (TRACKER_STATUS)
 * @param {object[]} params.summaries the devices to show (summarizeDevice)
 * @param {number|null} params.refreshedMinutesAgo age of the last Find My read
 * @param {string} params.language ISO 639-1 code of the user
 * @param {'metric'|'us'} params.units unit preference of the user
 * @param {number} params.ttl seconds before Gladys asks again (widgetTtl)
 */
export function buildPresenceWidget({
  status,
  summaries,
  refreshedMinutesAgo,
  language,
  units,
  ttl,
}) {
  const t = textsFor(language);
  const signIn = signInContent(status, t, ttl);
  if (signIn) {
    return signIn;
  }
  if (summaries.length === 0) {
    return { ttl_seconds: ttl, components: [{ type: 'text', variant: 'body', text: t.noDevice }] };
  }

  const atHome = summaries.filter((summary) => summary.present === true).length;
  // Past the limit, the last line counts the devices left out rather than
  // hiding them.
  const shown =
    summaries.length > MAX_STATUS_ITEMS ? summaries.slice(0, MAX_STATUS_ITEMS - 1) : summaries;
  const items = shown.map((summary) => ({
    label: summary.name,
    ...presenceLine(summary, t, language, units),
  }));
  if (shown.length < summaries.length) {
    items.push({
      label: t.others,
      value: `+${summaries.length - shown.length}`,
      icon: 'more-horizontal',
    });
  }

  const components = [
    {
      type: 'value',
      label: t.atHome,
      value: `${atHome} / ${summaries.length}`,
      icon: 'home',
      color: atHome > 0 ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
    },
    { type: 'status', items },
  ];
  if (Number.isFinite(refreshedMinutesAgo)) {
    components.push({
      type: 'text',
      variant: 'caption',
      text: t.updated(formatAge(refreshedMinutesAgo, t)),
    });
  }
  components.push(refreshButton(t));
  return { ttl_seconds: ttl, components };
}

/**
 * Content of the `device` widget: one device in detail.
 *
 * @param {object} params
 * @param {string} params.status the tracker status (TRACKER_STATUS)
 * @param {object|null} params.summary the device (summarizeDevice), null when
 *   it is no longer in Find My
 * @param {(feature: string) => string|null} params.featureId the external_id
 *   of one of its features, null when Gladys does not hold that feature (a
 *   tile bound to a missing feature is dropped by Gladys with a warning)
 * @param {string} params.language ISO 639-1 code of the user
 * @param {'metric'|'us'} params.units unit preference of the user
 * @param {number} params.ttl seconds before Gladys asks again (widgetTtl)
 */
export function buildDeviceWidget({ status, summary, featureId, language, units, ttl }) {
  const t = textsFor(language);
  const signIn = signInContent(status, t, ttl);
  if (signIn) {
    return signIn;
  }
  if (!summary) {
    return {
      ttl_seconds: ttl,
      components: [{ type: 'text', variant: 'body', text: t.deviceGone }],
    };
  }

  const components = [{ type: 'text', variant: 'heading', text: summary.name }];

  // The two live tiles: Gladys keeps them up to date from the states.
  const battery = summary.batteryLevel !== null ? featureId(FEATURE.BATTERY) : null;
  if (battery) {
    components.push({ type: 'value', label: t.battery, icon: 'battery', device_feature: battery });
  }
  const distance = featureId(FEATURE.DISTANCE);
  if (distance) {
    components.push({
      type: 'value',
      label: t.distance,
      icon: 'navigation',
      device_feature: distance,
    });
    components.push({
      type: 'chart',
      device_features: [distance],
      interval: 'last-day',
      chart_type: 'line',
      title: t.distanceChart,
    });
  }

  const presence = presenceLine(summary, t, language, units);
  const items = [{ label: t.presence, ...presence }];
  if (summary.charging !== null) {
    items.push({
      label: t.charging,
      value: summary.charging ? t.yes : t.no,
      icon: 'battery-charging',
      color: summary.charging ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
    });
  }
  if (summary.accuracy !== null) {
    items.push({
      label: t.accuracy,
      value: `± ${formatDistance(summary.accuracy / 1000, language, units)}`,
      icon: 'crosshair',
    });
  }
  items.push({ label: t.lastPosition, value: formatAge(summary.ageMinutes, t), icon: 'clock' });
  components.push({ type: 'status', items });

  // The ring button presses the Ring feature itself: same path as the button
  // of the device on the dashboard (onSetValue), nothing to add here.
  const ring = featureId(FEATURE.RING);
  if (ring) {
    components.push({
      type: 'button',
      label: t.ring,
      icon: 'bell',
      style: 'primary',
      device_feature: ring,
      value: 1,
    });
  }
  if (summary.mapUrl) {
    components.push({
      type: 'button',
      label: t.map,
      icon: 'map',
      style: 'secondary',
      link: { url: summary.mapUrl },
    });
  }
  components.push(refreshButton(t));
  return { ttl_seconds: ttl, components };
}
