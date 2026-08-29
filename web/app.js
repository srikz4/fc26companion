/**
 * The client.
 *
 * Fetches the View document, renders whichever view is selected, and refetches
 * when the server says a save landed.
 *
 * Interaction is dwell **and** click (spec.md §7): resting the pointer on a
 * control for 900ms activates it, and clicking activates the same handler
 * immediately. Every dwell target is also a real button, so nothing is reachable
 * one way but not the other.
 */

import { icon, HEADING_ICONS, EVENT_ICONS } from './icons.js';

const DWELL_MS = 900;

/**
 * Stored preferences are validated on read. A value left behind by an older
 * build ("senior" when the views were renamed) would otherwise index into
 * nothing and blank the whole page.
 */
const storedPref = (key, allowed, fallback) => {
  const value = localStorage.getItem(key);
  return value !== null && allowed.includes(value) ? value : fallback;
};

/**
 * Feature switches, Settings tab. Everything defaults to how the app shipped;
 * RPG and AI modes default off — they add, never take away.
 */
const SETTING_DEFS = [
  { key: 'rail', group: 'Display', label: 'Alert rail', note: 'The "Needs attention" strip of rule-driven actions.', on: true },
  { key: 'actionChips', group: 'Display', label: 'Action chips on rosters', note: 'LOAN OUT / SIGN TO SENIOR chips on squad and academy rows.', on: true },
  { key: 'trendArrows', group: 'Display', label: 'Trend arrows', note: 'Season-form arrows next to each rating change: ▲ surge, ↗ rise, — flat, ↘ dip, ▼ fall.', on: true },
  { key: 'faces', group: 'Display', label: 'Player faces', note: 'Locally imported headshots on rows and cards; off shows initials discs everywhere.', on: true },
  { key: 'treatment', group: 'Central', label: 'Treatment room', note: 'Injured and suspended players with recovery time and a computed stand-in each.', on: true },
  { key: 'leagueTable', group: 'Central', label: 'League table', note: 'Your division added up from the save\u2019s own results \u2014 the table, your full fixture list, and the latest round elsewhere in Europe.', on: true },
  { key: 'newsFeed', group: 'Central', label: 'Around the world', note: 'The save\u2019s own event feed — transfers and news across this world.', on: true },
  { key: 'scoutReports', group: 'Guidance', label: 'Scout report verdicts', note: 'Reads the prospects a scout has delivered and calls each one sign, watch or pass. Switch it off to judge the reports yourself in game — the tab disappears entirely and nothing about them is shown.', on: true },
  { key: 'developFocus', group: 'Guidance', label: 'Development focus', note: 'On the player card: the attributes where growth buys the most, from the fit weights and this world\u2019s percentiles. Point the game\u2019s development plans at them.', on: true },
  { key: 'absurd', group: 'Guidance', label: 'The absurd bit', note: 'The cheeky lines on the Story card.', on: true },
  { key: 'compact', group: 'Preferences', label: 'Compact density', note: 'Tighter paddings and smaller type everywhere — more career per screen.', on: false },
  { key: 'fullMoney', group: 'Preferences', label: 'Full money figures', note: 'Show 12,500,000 instead of 12.5M wherever money appears shortened.', on: false },
  { key: 'rpg', group: 'Modes', label: 'RPG mode', note: 'Career-as-campaign: milestones, season missions and one-save-away marks, all computed from your save — deterministic, nothing rolled. Its home is Story › Campaign, and with it on, each mission also appears at the top of the view where that work happens.', on: false },
  { key: 'ai', group: 'Modes', label: 'AI mode', note: 'Narration and insight on top of the recorded facts. Nothing is wired yet — no provider, no key, no prompt — so the switch stays off rather than pretending. It turns on when there is something behind it.', on: false, disabled: true },
];
/** Landing tab: where a fresh open of Companion starts. */
const LANDING_CHOICES = ['central', 'squad', 'transfers', 'academy', 'office', 'story'];
const settings = (() => {
  try {
    return { ...Object.fromEntries(SETTING_DEFS.map((d) => [d.key, d.on])), ...JSON.parse(localStorage.getItem('settings') || '{}') };
  } catch {
    return Object.fromEntries(SETTING_DEFS.map((d) => [d.key, d.on]));
  }
})();
const saveSettings = () => localStorage.setItem('settings', JSON.stringify(settings));

/**
 * The transfer shortlist. The save has no shortlist table (verified — the
 * game's own shortlist lives outside the database chunk), so this one is
 * Companion's, kept in the browser. Each entry freezes the player's numbers
 * at the moment of shortlisting, so the view can show drift since.
 */
const shortlist = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem('shortlist') || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
})();
const saveShortlist = () => localStorage.setItem('shortlist', JSON.stringify(shortlist));
const shortlisted = (id) => shortlist.some((x) => x.playerId === id);
function toggleShortlist(x, gameDate) {
  const i = shortlist.findIndex((e) => e.playerId === x.playerId);
  if (i >= 0) shortlist.splice(i, 1);
  else
    shortlist.push({
      playerId: x.playerId,
      name: x.name,
      club: x.teamName ?? null,
      pos: x.posShort ?? x.slot ?? null,
      overall: x.overall ?? null,
      potential: x.potential ?? null,
      fee: x.feeGuide?.mid ?? null,
      added: gameDate ?? null,
    });
  saveShortlist();
  render();
}

const state = {
  doc: null,
  view: 'overview',
  sort: 'ingame',
  sortAsc: false,
  dwell: true,
  filters: new Set(JSON.parse(localStorage.getItem('filters') || '[]')),
  /** Column sorts, per table, so a rebuild does not undo one. */
  sorts: (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('sorts') || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  })(),
  /** Set when a card has just been opened, so the next render can reveal it. */
  reveal: false,
  rail: localStorage.getItem('rail') !== 'hidden',
  wageSel: null,
  wageFilter: 'all',
  oppSel: null,
  oppLeague: null,
  oppNation: null,
  devFilter: 'grow',
  subs: (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('subs') || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  })(),
  hubMode: 'basic',
  rosterSel: null,
  open: new Set(),
  attrs: new Set(),
  lastSync: null,
  /** 'live' | 'loading' | 'offline' — what the sync light is saying. */
  connection: 'live',
};

const $ = (s) => document.querySelector(s);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const fmtDate = (n) =>
  n === null || n === undefined ? 'unknown' : String(n).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
/** The career's own currency, read from the save; pounds until a doc says otherwise. */
const cur = () => window.__doc?.currency ?? '£';
const money = (n) => (n === null || n === undefined ? null : `${cur()}${n.toLocaleString('en-GB')}`);
const moneyShort = (n) =>
  n === null || n === undefined
    ? '—'
    : settings.fullMoney && n !== 0
      ? `${cur()}${n.toLocaleString('en-GB')}`
    : n === 0
      ? `${cur()}0`
      : n >= 1_000_000
      ? `${cur()}${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
      : n >= 1_000
        ? `${cur()}${Math.round(n / 1_000)}K`
        : `${cur()}${n}`;

/**
 * Rating tiers, shared by overall, potential and attributes so one glance means
 * the same thing everywhere: under 80 ordinary, 80-84 blue, 85-89 green, 90+
 * violet. The number is always shown as well — colour is never the only signal.
 */
function tier(value) {
  if (value === null || value === undefined) return 't1';
  if (value >= 90) return 't4';
  if (value >= 85) return 't3';
  if (value >= 80) return 't2';
  return 't1';
}

/**
 * Skill moves and weak foot, as metals: 5 gold, 4 silver, 3 bronze, 2 copper,
 * 1 iron. `skillmoves` is stored 0-based in the save (0 means one star);
 * `weakfootabilitytypecode` is already the star count.
 */
/**
 * A player's face, from the locally imported sprites, with an initials disc for
 * anyone the importer could not find — every newgen, by definition.
 */
function faceOf(p, size = 28) {
  const wrap = el('span', 'face');
  wrap.style.width = wrap.style.height = `${size}px`;
  if (!settings.faces) {
    const initials = (p.name || '?').split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('');
    wrap.appendChild(el('span', 'initials', initials.toUpperCase()));
    return wrap;
  }
  const img = document.createElement('img');
  img.src = `/faces/${p.playerId}.png`;
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', () => {
    img.remove();
    const initials = (p.name || '?')
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('');
    wrap.appendChild(el('span', 'initials', initials.toUpperCase()));
  });
  wrap.appendChild(img);
  return wrap;
}

/** Emoji flag for a nation name, empty string when we have no glyph for it. */
const NATION_FLAG = {
  England: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
  Scotland: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
  Wales: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}',
};
const ISO2 = {
  'Northern Ireland': 'GB', 'Republic of Ireland': 'IE', Ireland: 'IE', Spain: 'ES', Germany: 'DE',
  France: 'FR', Italy: 'IT', Portugal: 'PT', Netherlands: 'NL', Belgium: 'BE', Argentina: 'AR',
  Brazil: 'BR', Uruguay: 'UY', Chile: 'CL', Colombia: 'CO', Peru: 'PE', Ecuador: 'EC',
  Paraguay: 'PY', Bolivia: 'BO', Venezuela: 'VE', Mexico: 'MX', 'United States': 'US', Canada: 'CA',
  Japan: 'JP', 'Korea Republic': 'KR', 'South Korea': 'KR', China: 'CN', 'China PR': 'CN',
  Australia: 'AU', 'New Zealand': 'NZ', Poland: 'PL', Sweden: 'SE', Norway: 'NO', Denmark: 'DK',
  Finland: 'FI', Iceland: 'IS', Austria: 'AT', Switzerland: 'CH', Croatia: 'HR', Serbia: 'RS',
  Slovenia: 'SI', Slovakia: 'SK', Czechia: 'CZ', 'Czech Republic': 'CZ', Hungary: 'HU',
  Romania: 'RO', Bulgaria: 'BG', Greece: 'GR', 'Türkiye': 'TR', Turkey: 'TR', Ukraine: 'UA',
  Russia: 'RU', Georgia: 'GE', Armenia: 'AM', Azerbaijan: 'AZ', Kazakhstan: 'KZ', Uzbekistan: 'UZ',
  Morocco: 'MA', Algeria: 'DZ', Tunisia: 'TN', Egypt: 'EG', Senegal: 'SN', 'Côte d\u2019Ivoire': 'CI',
  "Cote d'Ivoire": 'CI', 'Ivory Coast': 'CI', Ghana: 'GH', Nigeria: 'NG', Cameroon: 'CM',
  Mali: 'ML', 'Burkina Faso': 'BF', Guinea: 'GN', 'DR Congo': 'CD', 'Congo DR': 'CD', Angola: 'AO',
  Mozambique: 'MZ', 'South Africa': 'ZA', Kenya: 'KE', 'Cape Verde': 'CV', 'Cabo Verde': 'CV',
  Gambia: 'GM', Togo: 'TG', Benin: 'BJ', Gabon: 'GA', Zambia: 'ZM', Zimbabwe: 'ZW',
  'Saudi Arabia': 'SA', Qatar: 'QA', 'United Arab Emirates': 'AE', Iran: 'IR', Iraq: 'IQ',
  Israel: 'IL', Jordan: 'JO', Lebanon: 'LB', India: 'IN', Indonesia: 'ID', Thailand: 'TH',
  Vietnam: 'VN', Malaysia: 'MY', Philippines: 'PH', Singapore: 'SG', 'North Macedonia': 'MK',
  Albania: 'AL', Kosovo: 'XK', Montenegro: 'ME', 'Bosnia and Herzegovina': 'BA',
  'Bosnia-Herzegovina': 'BA', Moldova: 'MD', Belarus: 'BY', Lithuania: 'LT', Latvia: 'LV',
  Estonia: 'EE', Luxembourg: 'LU', Malta: 'MT', Cyprus: 'CY', Jamaica: 'JM',
  'Trinidad and Tobago': 'TT', 'Costa Rica': 'CR', Honduras: 'HN', Panama: 'PA', Guatemala: 'GT',
  'El Salvador': 'SV', Cuba: 'CU', Haiti: 'HT', 'Dominican Republic': 'DO', Suriname: 'SR',
  Curacao: 'CW', 'Curaçao': 'CW', Guyana: 'GY',
};
function flagFor(name) {
  if (!name) return '';
  if (NATION_FLAG[name]) return NATION_FLAG[name] + ' ';
  const iso = ISO2[name];
  if (!iso || iso === 'XK') return '';
  return [...iso].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join('') + ' ';
}

/**
 * Stars, with a real half — a literal "½" reads as a typo next to ★★★★.
 * The half is a ★ clipped to its left half by an inline-block wrapper.
 */
function starsOf(value, max = 5) {
  const box = el('span', 'starline');
  if (value === null || value === undefined) {
    box.append('—');
    return box;
  }
  const full = Math.floor(value);
  const half = value - full >= 0.25 && value - full < 0.75;
  const capped = Math.min(max, full);
  if (capped > 0) box.append('★'.repeat(capped));
  if (half && capped < max) {
    const h = el('span', 'halfstar');
    h.appendChild(el('span', null, '★'));
    box.appendChild(h);
  }
  return box;
}

function starBadge(label, stars) {
  if (stars === null || stars === undefined) return null;
  const n = Math.max(1, Math.min(5, stars));
  const badge = el('span', 'stars');
  badge.appendChild(el('span', 'lbl', label));
  badge.appendChild(el('span', `mv m${n}`, `${n}★`));
  badge.title = `${label} ${n} of 5`;
  return badge;
}

/**
 * A rating chip: the number in a tier-tinted solid block, and where a ceiling
 * exists, an arrow to a second block. Reads better on a dark ground than the
 * dotted outline it replaces, and keeps overall and potential legible as two
 * separate readings rather than one box with two textures.
 */
function rateChip(label, value, ceiling) {
  const chip = el('span', 'ratechip');
  if (label) chip.appendChild(el('span', 'lbl', label));
  chip.appendChild(el('span', `n ${tier(value)}`, value ?? '—'));
  if (ceiling !== undefined && ceiling !== null && ceiling !== value) {
    chip.appendChild(el('span', 'arrow', '→'));
    chip.appendChild(el('span', `n ceil ${tier(ceiling)}`, ceiling));
  }
  return chip;
}

const TREND = {
  surge: { glyph: '▲', cls: 'tr-surge', word: 'surging' },
  rise: { glyph: '↗', cls: 'tr-rise', word: 'rising' },
  flat: { glyph: '—', cls: 'tr-flat', word: 'steady' },
  dip: { glyph: '↘', cls: 'tr-dip', word: 'dipping' },
  fall: { glyph: '▼', cls: 'tr-fall', word: 'falling' },
};
/**
 * Sheet role codes, cracked against the game's own Tactics screen: every code
 * is roleId*64 + focus. Confirmed on eleven assignments — Versatile read 10 on
 * two different roles, Defend read 1 twice, both fullbacks shared one code.
 * Unlisted ids render as "role N · focus M" until they are read off the screen.
 */
const ROLE_NAMES = {
  65: 'Goalkeeper', 131: 'Fullback', 200: 'Stopper',
  332: 'Deep-Lying Playmaker', 334: 'Playmaker', 531: 'Inside Forward', 599: 'Poacher',
};
const FOCUS_NAMES = { 1: 'Defend', 2: 'Balanced', 6: 'Aggressive', 8: 'Roaming', 10: 'Versatile' };
function roleLabel(roleId, focus) {
  if (roleId === null) return null;
  const r = ROLE_NAMES[roleId];
  const f = FOCUS_NAMES[focus];
  if (r && f) return `${r} · ${f}`;
  return `role ${roleId} · focus ${focus}~`;
}

function trendArrow(p) {
  if (!settings.trendArrows || !p.trend) return null;
  const t = TREND[p.trend];
  const node = el('i', `trend ${t.cls}`, t.glyph);
  node.dataset.tip = `${t.word} — ${p.overallSeasonDelta > 0 ? '+' : ''}${p.overallSeasonDelta} since July, from this career's own snapshots`;
  return node;
}

/** Contract time the way the game says it: 42 months is "3y 6m", not "42mo". */
const fmtTerm = (m) =>
  m === null || m === undefined
    ? '—'
    : m < 12
      ? `${m}m`
      : `${Math.floor(m / 12)}y${m % 12 ? ` ${m % 12}m` : ''}`;

function delta(d) {
  if (d === null || d === undefined) return null;
  const r = Math.round(d * 10) / 10;
  if (r === 0) return { text: '0', cls: 'flat' };
  // `'+' + -3` gives "+-3"; the sign is part of the number, not a prefix.
  return { text: `${r > 0 ? '+' : ''}${r}`, cls: r > 0 ? 'up' : 'down' };
}

/* ---------------- dwell ---------------- */

/**
 * Attach dwell to a control. The click handler is always wired; dwell only adds
 * a second route to the same action, and leaving the element resets it to zero.
 */
/**
 * Dwell, third pass, from real use:
 *
 *  - `skipWhen` — a control that is already in the state dwell would put it in
 *    does nothing. Resting on the active tab, an applied filter, or an open row
 *    used to keep firing; now dwell only ever moves you forward, and undoing is
 *    a click.
 *  - `pad` — large targets (rows) arm dwell only in their leading zone, marked
 *    with a dot. The rest of the row is safe space to rest the pointer while
 *    reading. Small targets (chips, tabs) stay whole-element.
 *  - the pointer-movement guard from the second pass stays: a re-render must
 *    not re-arm under a stationary pointer.
 */
let lastPointerMove = 0;
document.addEventListener('pointermove', () => {
  lastPointerMove = performance.now();
});

// A phone has no resting pointer: where nothing can hover, dwell never arms
// and every control is a plain tap (the click listener below). Keyed on
// hover capability, NOT pointer size — a desktop with a touchscreen reports
// a coarse pointer while the mouse still hovers, and keying on that killed
// dwell for it.
const NO_HOVER = window.matchMedia?.('(hover: none)').matches ?? false;

function activatable(node, onActivate, opts = {}) {
  node.addEventListener('click', onActivate);
  if (NO_HOVER) {
    const host0 = opts.host ?? node;
    if (!host0.querySelector('.dwell-fill')) host0.appendChild(el('span', 'dwell-fill'));
    return node;
  }

  let timer = null;
  const stop = () => {
    node.classList.remove('dwelling');
    if (timer) clearTimeout(timer);
    timer = null;
  };

  // `host` is where the dwell furniture lives. It defaults to the node, but a
  // table row must put it inside a real <td>: a bare <span> child of <tr> gets
  // wrapped in an anonymous cell, which shifts every column off its header.
  const host = opts.host ?? node;
  const pad = opts.pad ? el('span', 'dwellpad') : null;
  if (pad) host.prepend(pad);
  const armTarget = pad ?? node;

  armTarget.addEventListener('pointerenter', () => {
    if (performance.now() - lastPointerMove > 150) return;
    if (opts.skipWhen && opts.skipWhen()) return;
    node.classList.add('dwelling');
    timer = setTimeout(() => {
      stop();
      onActivate();
    }, DWELL_MS);
  });
  armTarget.addEventListener('pointerleave', stop);
  node.addEventListener('pointerdown', stop);

  if (!host.querySelector('.dwell-fill')) host.appendChild(el('span', 'dwell-fill'));
  return node;
}

/* ---------------- tooltip ---------------- */

// One floating tooltip for every [data-tip] element, clamped to the viewport.
// The browser-native title box ignored the theme and clipped at the pitch
// edges; this one cannot leave the screen.
const tipNode = el('div', 'tipfloat');
document.body.appendChild(tipNode);
let tipFor = null;
document.addEventListener('pointerover', (e) => {
  const target = e.target.closest?.('[data-tip]') ?? null;
  if (target === tipFor) return;
  tipFor = target;
  if (!target) {
    tipNode.classList.remove('show');
    return;
  }
  tipNode.textContent = target.dataset.tip;
  tipNode.classList.add('show');
  const r = target.getBoundingClientRect();
  const w = tipNode.offsetWidth;
  const h = tipNode.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  let y = r.top - h - 8;
  if (y < 8) y = Math.min(r.bottom + 8, window.innerHeight - h - 8);
  tipNode.style.left = `${x}px`;
  tipNode.style.top = `${y}px`;
});
const hideTip = () => {
  tipFor = null;
  tipNode.classList.remove('show');
};
document.addEventListener('scroll', hideTip, true);
// On touch there is no hover: the tap itself is the "show me" gesture, so a
// pointerdown on the tipped element must not immediately hide what the
// accompanying pointerover just showed. Tapping anywhere else dismisses.
document.addEventListener(
  'pointerdown',
  (e) => {
    if (tipFor && e.target.closest?.('[data-tip]') === tipFor) return;
    hideTip();
  },
  true,
);

/* ---------------- sparkline ---------------- */

function sparkline(series, width = 150, height = 26) {
  const points = series.filter((p) => p.value !== null);
  if (points.length < 2) return null;

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${points.length} readings, ${min} to ${max}`);

  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * (width - 2) + 1;
      const y = height - 2 - ((p.value - min) / span) * (height - 4);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  svg.appendChild(path);
  return svg;
}

/* ---------------- filters ---------------- */

/**
 * The chips across the top. Each is a predicate over a player, so the same set
 * works on the Squad, Youth and Regens views.
 */
const FILTERS = [
  { id: 'urgent', label: 'Needs action', test: (p) => p.advice.severity === 'urgent' || p.advice.severity === 'action' },
  { id: 'newintake', label: 'New intake', test: (p) => p.youth && p.youth.monthsInSquad === 0 },
  { id: 'ovrup', label: 'OVR up', test: (p) => (p.overallSeasonDelta ?? 0) > 0 },
  { id: 'ovrdown', label: 'OVR down', test: (p) => (p.overallSeasonDelta ?? 0) < 0 },
  { id: 'headroom', label: 'Growth 8+', test: (p) => (p.headroom ?? 0) >= 8 },
  { id: 'special', label: 'Special / Exciting', test: (p) => p.potentialTag === 'Special' || p.potentialTag === 'Exciting' },
  { id: 'u21', label: 'Under 21', test: (p) => p.age !== null && p.age < 21 },
  { id: 'injured', label: 'Injured', test: (p) => p.injured },
  { id: 'expiring', label: 'Contract < 1y', test: (p) => p.contractMonths !== null && p.contractMonths <= 12 },
  { id: 'starved', label: 'Barely playing', test: (p) => (p.minutesThisSeason ?? 0) === 0 },
  { id: 'newgen', label: 'Academy product', test: (p) => p.isNewgen },
];

/**
 * Position filters are generated from the list in front of you rather than
 * hard-coded, so a squad with no wing-backs does not offer a wing-back chip.
 * They combine as OR within positions and AND with everything else — picking
 * "Centre-back" and "Striker" means either, not both at once.
 */
const POSITION_FILTER_PREFIX = 'pos:';

/** Back to front, right to left — the order a team sheet is written in. */
const POSITION_ORDER = [
  'GK', 'LWB', 'LB', 'CB', 'RB', 'RWB',
  'LM', 'CDM', 'CM', 'CAM', 'RM',
  'LW', 'RW', 'ST',
  'SW', 'CF', 'LF', 'RF',
];

const posRank = (short) => {
  const i = POSITION_ORDER.indexOf(short);
  return i < 0 ? 99 : i;
};

function positionFilters(list) {
  const counts = new Map();
  for (const p of list) {
    if (!p.positionShort) continue;
    counts.set(p.positionShort, (counts.get(p.positionShort) ?? 0) + 1);
  }
  return POSITION_ORDER.filter((pos) => counts.has(pos)).map((pos) => ({
    id: POSITION_FILTER_PREFIX + pos,
    label: pos,
    n: counts.get(pos),
  }));
}

function applyFilters(list) {
  if (state.filters.size === 0) return list;

  const positions = [...state.filters].filter((id) => id.startsWith(POSITION_FILTER_PREFIX));
  const others = FILTERS.filter((f) => state.filters.has(f.id));

  return list.filter((p) => {
    if (positions.length && !positions.some((id) => p.positionShort === id.slice(POSITION_FILTER_PREFIX.length))) {
      return false;
    }
    return others.every((f) => f.test(p));
  });
}

/* ---------------- sorting ---------------- */

/**
 * `ingame` is the default because the game lists a squad by position down the
 * spine — keeper, defence, midfield, attack — and a different default order on a
 * second screen is just confusing.
 */
/**
 * The game's own position codes already run in football order — keeper, then
 * defence, midfield, attack — so ordering by code is the order the game shows,
 * which is the point. Sorting by our internal slot names put wingers between
 * midfielders and strikers alphabetically, which is nobody's idea of a squad list.
 */
const slotRank = (p) => {
  const i = POSITION_ORDER.indexOf(p.positionShort);
  return i === -1 ? 99 : i;
};

/** Our slot codes are internal. These are what a person calls them. */
const SLOT_LABEL = {
  GK: 'Goalkeeper',
  CB: 'Centre-back',
  FB: 'Full-back',
  WB: 'Wing-back',
  CDM: 'Defensive mid',
  CM: 'Central mid',
  CAM: 'Attacking mid',
  W: 'Winger',
  ST: 'Striker',
};
const slotLabel = (slot) => SLOT_LABEL[slot] ?? slot ?? '—';

const SORTS = {
  name: { label: 'Name', fn: (a, b) => a.name.localeCompare(b.name) },
  ingame: { label: 'Position', fn: (a, b) => slotRank(a) - slotRank(b) || (b.overall ?? 0) - (a.overall ?? 0) },
  overall: { label: 'Overall', fn: (a, b) => (b.overall ?? 0) - (a.overall ?? 0) },
  potential: { label: 'Potential', fn: (a, b) => (b.potential ?? 0) - (a.potential ?? 0) },
  headroom: { label: 'Growth left', fn: (a, b) => (b.headroom ?? 0) - (a.headroom ?? 0) },
  potential: { label: 'Ceiling', fn: (a, b) => (b.potential ?? 0) - (a.potential ?? 0) },
  age: { label: 'Age', fn: (a, b) => (a.age ?? 99) - (b.age ?? 99) },
  growth: { label: 'Season change', fn: (a, b) => (b.overallSeasonDelta ?? -99) - (a.overallSeasonDelta ?? -99) },
  minutes: { label: 'Minutes', fn: (a, b) => (b.minutesThisSeason ?? 0) - (a.minutesThisSeason ?? 0) },
  wage: { label: 'Wage', fn: (a, b) => (b.wage ?? 0) - (a.wage ?? 0) },
  urgency: { label: 'Urgency', fn: (a, b) => b.advice.priority - a.advice.priority },
};

/* ---------------- player card ---------------- */

/**
 * One player.
 *
 * Reading order is the order you want it: what to do about him, who he is, what
 * he rates, what he is made of, then the small print. "Headroom" is gone as a
 * word — the arrow from overall to ceiling says it, and the tooltip spells it
 * out in English.
 */
/* ---------------- player card ---------------- */

/** Identity block, shared by every face of the card. */
function cardHead(p, onClose) {
  const head = el('div', 'head');
  if (onClose) {
    const closer = el('button', 'chip closer', 'Close ✕');
    activatable(closer, onClose);
    head.appendChild(closer);
  }
  head.appendChild(faceOf(p, 40));
  if (p.jersey !== null) head.appendChild(el('span', 'jersey', `#${p.jersey}`));

  const name = el('span', 'name');
  name.append(p.name);
  if (p.nameProvisional) {
    const mark = el('span', 'prov', ' ~');
    mark.dataset.tip = 'Derived name — measured 98.7% accurate, never drives advice';
    name.appendChild(mark);
  }
  head.appendChild(name);
  if (p.positionShort) head.appendChild(el('span', 'badge-pos', p.positionShort));

  const rates = el('div', 'rates');
  const ovr = el('span', 'rate');
  ovr.appendChild(el('span', 'lbl', 'OVR'));
  ovr.appendChild(el('span', `n ${tier(p.overall)}`, p.overall ?? '—'));
  rates.appendChild(ovr);
  const pot = el('span', 'rate');
  pot.appendChild(el('span', 'lbl', 'POT'));
  pot.appendChild(el('span', `n ceil ${tier(p.potential)}`, p.potential ?? '—'));
  if (p.potential !== null && p.overall !== null && p.potential > p.overall) {
    pot.dataset.tip = `${p.potential - p.overall} still to grow`;
  }
  rates.appendChild(pot);
  if (p.fits[0] && p.bestSlot) {
    const fit = el('span', 'rate');
    fit.appendChild(el('span', 'lbl', p.fits[0].slot));
    fit.appendChild(el('span', `n ${tier(p.fits[0].value)}`, p.fits[0].value));
    fit.dataset.tip = `The rating playing ${slotLabel(p.bestSlot).toLowerCase()} — our figure, not the game's.`;
    rates.appendChild(fit);
  }
  head.appendChild(rates);
  return head;
}

/** The one-line biography under the head. */
function cardFacts(p) {
  const facts = el('div', 'facts');
  if (p.nation) facts.appendChild(el('span', null, `${flagFor(p.nation)}${p.nation}`));
  for (const bit of [
    p.age !== null ? `${p.age}y` : null,
    p.preferredPositions.length > 1 ? p.preferredPositions.join(' / ') : null,
    p.foot ? `${p.foot} foot` : null,
    p.height !== null ? `${p.height}cm` : null,
    p.form ? `Form ${p.form}` : null,
    p.morale,
  ].filter(Boolean)) {
    facts.appendChild(el('span', null, bit));
  }
  const sm = starBadge('SM', p.skillMoves === null ? null : p.skillMoves + 1);
  const wf = starBadge('WF', p.weakFoot);
  if (sm) facts.appendChild(sm);
  if (wf) facts.appendChild(wf);
  return facts;
}

/** Labelled stat tiles — the card's unit of measurement. */
function tileRow(items) {
  const strip = el('div', 'tiles');
  for (const [label, value, tip, cls] of items) {
    if (value === null || value === undefined || value === '') continue;
    const cell = el('span', `tile${cls ? ` ${cls}` : ''}`);
    if (tip) cell.dataset.tip = tip;
    cell.appendChild(el('i', null, label));
    cell.appendChild(el('b', null, String(value)));
    strip.appendChild(cell);
  }
  return strip;
}

/** A labelled section inside the card. */
function cardSection(label, node, cls) {
  const box = el('div', `csec${cls ? ` ${cls}` : ''}`);
  if (label) box.appendChild(el('span', 'lbl', label));
  if (node) box.appendChild(node);
  return box;
}

/**
 * One player, dressed for the view that opened him.
 *
 *   basic       who he is, what to do about him, the shape of his game
 *   stats       the season, match by match
 *   attributes  the full sheet, every attribute with its bar
 *   financial   wage, contract, value and the renewal on the table
 *
 * Each face carries what its view is for and nothing else — the same block
 * repeated four times was the complaint, and it was fair.
 */
function playerCard(p, onClose, mode = 'basic') {
  const card = el('div', `card ${p.advice.severity} mode-${mode}`);
  const notable = [p.advice, ...p.otherAdvice].filter((a) => a.severity !== 'steady');

  if (notable.length && mode === 'basic') {
    const acts = el('div', 'acts');
    for (const a of notable) acts.appendChild(el('span', `act ${a.severity}`, a.tag));
    card.appendChild(acts);
  }
  card.appendChild(cardHead(p, onClose));
  card.appendChild(cardFacts(p));

  if (mode === 'basic') basicFace(card, p);
  else if (mode === 'stats') statsFace(card, p);
  else if (mode === 'attributes') attributesFace(card, p);
  else if (mode === 'financial') financialFace(card, p);

  // The reasoning belongs with the calls, so it rides on the face that shows
  // them — not on the money page or the attribute sheet.
  if (notable.length && mode === 'basic') {
    const panel = el('div', 'notes');
    panel.appendChild(el('span', 'lbl', 'WHY THESE CALLS'));
    for (const a of notable) {
      const row = el('div', `note ${a.severity}`);
      row.appendChild(el('b', null, a.tag));
      row.appendChild(el('span', null, a.line));
      row.appendChild(el('span', 'ev', a.evidence));
      panel.appendChild(row);
    }
    card.appendChild(panel);
  }
  return card;
}

/** basic: who he is and what to do about him. */
function basicFace(card, p) {
  const flags = el('div', 'flags');
  if (p.potentialTag) flags.appendChild(el('span', 'flag gold', p.potentialTag));
  const g = delta(p.overallSeasonDelta);
  if (g && g.text !== '0') flags.appendChild(el('span', `flag ${g.cls}`, `${g.text} this season`));
  const cd = delta(p.potentialSeasonDelta);
  if (cd && cd.text !== '0') {
    const f2 = el('span', `flag ceilflag ${cd.cls}`, `ceiling ${cd.text}`);
    f2.dataset.tip = 'Potential change observed across this career\u2019s snapshots since the season began.';
    flags.appendChild(f2);
  }
  if (p.injured) flags.appendChild(el('span', 'flag down', 'Injured'));
  if (p.retiring) flags.appendChild(el('span', 'flag down', 'Retiring'));
  if (p.onLoan) flags.appendChild(el('span', 'flag', 'On loan'));
  if (p.transferBlocked) flags.appendChild(el('span', 'flag', 'Transfer blocked'));
  if (p.youth && p.youth.monthsInSquad === 0) flags.appendChild(el('span', 'flag up', 'New intake'));
  if (p.generation && p.generation.potential !== null && p.generation.potential >= 97 && (p.age ?? 99) <= 21) {
    const gen = el('span', 'flag gold', `Top ${Math.max(1, 100 - p.generation.potential)}% of their generation`);
    gen.dataset.tip = `A ceiling in the ${p.generation.potential}th percentile of the ${p.generation.peers.toLocaleString('en-GB')} players this age in this world.`;
    flags.appendChild(gen);
  }
  if (flags.childElementCount) card.appendChild(flags);

  // The shape of his game: group means as bars, so strengths read instantly.
  if (p.groups.length) {
    const bars = el('div', 'gbars');
    const best = Math.max(...p.groups.map((x) => x.mean ?? 0), 1);
    for (const group of p.groups) {
      const row = el('div', 'gbar');
      row.appendChild(el('span', 'gbname', group.name));
      const track = el('div', 'btrack');
      const fill = el('div', `bfill ${tier(group.mean)}`);
      fill.style.width = `${Math.max(4, Math.round(((group.mean ?? 0) / Math.max(best, 99)) * 100))}%`;
      track.appendChild(fill);
      row.appendChild(track);
      const v = el('span', 'gbval');
      v.appendChild(el('b', null, group.mean ?? '—'));
      const d = delta(group.seasonDelta);
      if (d && d.text !== '0') v.appendChild(el('span', `gdelta ${d.cls}`, d.text));
      row.appendChild(v);
      bars.appendChild(row);
    }
    card.appendChild(cardSection('THE SHAPE OF HIS GAME', bars));
  }

  if (p.standout.length) {
    const line = el('div', 'chipwrap');
    for (const st of p.standout) {
      const chip = el('span', 'so', `${prettyAttr(st.attr)} ${st.value}`);
      chip.dataset.tip = `${st.percentile}th percentile among ${p.positionShort ?? 'position peers'} in this world`;
      line.appendChild(chip);
    }
    card.appendChild(cardSection('STANDOUT', line));
  }

  if (settings.developFocus && p.developFocus?.length) {
    const dev = el('div', 'chipwrap');
    for (const d of p.developFocus) {
      const chip = el('span', 'chipish', `${prettyAttr(d.attr)} ${d.value}`);
      chip.dataset.tip = `${d.percentile}th percentile for his position and heavily weighted in the fit model — growth here buys the most. Point an in-game development plan at it.`;
      dev.appendChild(chip);
    }
    card.appendChild(cardSection('WHERE GROWTH PAYS', dev));
  }

  if (p.playStyles.length) {
    const styles = el('div', 'chipwrap');
    for (const st of p.playStyles) {
      const node = el('span', st.plus ? 'style plus' : 'style', st.name + (st.plus ? '+' : ''));
      node.dataset.tip = `${st.category} PlayStyle`;
      styles.appendChild(node);
    }
    card.appendChild(cardSection('PLAYSTYLES', styles));
  }

  card.appendChild(
    tileRow([
      ['Minutes', p.minutesThisSeason],
      ['Apps', p.appearances],
      ['Goals', p.goals || null],
      ['Rating', p.averageRating],
      ['Deal', p.contractMonths === null ? null : fmtTerm(p.contractMonths)],
      ['Role', p.squadRole === 'None' ? null : p.squadRole],
    ]),
  );

  const spark = sparkline(p.overallSeries);
  if (spark) card.appendChild(cardSection('OVERALL, THIS CAREER', spark, 'sparkbox'));
}

/** stats: the season, and every match in it. */
function statsFace(card, p) {
  const apps = p.appearances ?? 0;
  const mins = p.minutesThisSeason ?? 0;
  const per90 = (v) => (mins >= 90 && v !== null && v !== undefined ? Math.round((v / mins) * 90 * 100) / 100 : null);
  card.appendChild(
    tileRow([
      ['Apps', apps],
      ['Minutes', mins || null],
      ['Goals', p.goals ?? 0],
      ['Goals / 90', per90(p.goals)],
      ['Avg rating', p.averageRating, apps ? `Across ${apps} rated appearances` : undefined],
      ['Consistency', p.ratingSpread === null ? null : `±${p.ratingSpread}`, 'Spread of his match ratings — a low number means he shows up every week.'],
      ['Mins / app', apps ? Math.round(mins / apps) : null],
      ['Form', p.form],
      ['Morale', p.morale],
    ]),
  );

  if (p.recentRatings?.length) {
    const best = Math.max(...p.recentRatings.map((m) => m.rating));
    const bars = el('div', 'gbars');
    for (const m of p.recentRatings.slice(-10).reverse()) {
      const row = el('div', 'gbar');
      row.appendChild(el('span', 'gbname', fmtDate(m.date)));
      const track = el('div', 'btrack');
      const fill = el('div', `bfill ${m.rating >= 8 ? 't4' : m.rating >= 7 ? 't3' : m.rating >= 6 ? 't2' : 't1'}`);
      fill.style.width = `${Math.max(6, Math.round((m.rating / Math.max(best, 10)) * 100))}%`;
      track.appendChild(fill);
      row.appendChild(track);
      const v = el('span', 'gbval');
      v.appendChild(el('b', null, m.rating.toFixed(1)));
      v.appendChild(el('span', 'gdelta', `${m.minutes}'`));
      row.appendChild(v);
      row.dataset.tip = `${m.position} · ${m.minutes} minutes · rated ${m.rating}`;
      bars.appendChild(row);
    }
    card.appendChild(cardSection('MATCH BY MATCH', bars));
  } else {
    card.appendChild(cardSection('MATCH BY MATCH', el('p', 'muted tiny', 'No rated appearances recorded this season.')));
  }

  const spark = sparkline(p.overallSeries);
  if (spark) card.appendChild(cardSection('OVERALL, THIS CAREER', spark, 'sparkbox'));
}

/** attributes: the full sheet, nothing else. */
function attributesFace(card, p) {
  const wrap = el('div', 'attrsheet');
  for (const group of p.groups) {
    const col = el('div', 'asheet-group');
    const head = el('div', 'asheet-head');
    head.appendChild(el('span', 'gname', group.name));
    const mean = el('span', 'gval-wrap');
    mean.appendChild(el('b', `gval ${tier(group.mean)}`, group.mean ?? '—'));
    const gd = delta(group.seasonDelta);
    if (gd && gd.text !== '0') mean.appendChild(el('span', `gdelta ${gd.cls}`, gd.text));
    head.appendChild(mean);
    col.appendChild(head);
    for (const a of group.attributes) {
      const row = el('div', 'asheet-row');
      row.appendChild(el('span', 'an', prettyAttr(a.name)));
      const track = el('div', 'btrack');
      const fill = el('div', `bfill ${tier(a.value)}`);
      fill.style.width = `${Math.max(3, Math.round(((a.value ?? 0) / 99) * 100))}%`;
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', `av ${tier(a.value)}`, a.value ?? '—'));
      const ad = delta(a.seasonDelta);
      row.appendChild(el('span', `ad ${ad && ad.text !== '0' ? ad.cls : ''}`, ad && ad.text !== '0' ? ad.text : ''));
      col.appendChild(row);
    }
    wrap.appendChild(col);
  }
  card.appendChild(wrap);

  if (p.standout.length || p.developFocus?.length) {
    const line = el('div', 'chipwrap');
    for (const st of p.standout) {
      const chip = el('span', 'so', `${prettyAttr(st.attr)} ${st.value}`);
      chip.dataset.tip = `${st.percentile}th percentile among ${p.positionShort ?? 'peers'} in this world`;
      line.appendChild(chip);
    }
    for (const d of p.developFocus ?? []) {
      const chip = el('span', 'chipish', `↑ ${prettyAttr(d.attr)} ${d.value}`);
      chip.dataset.tip = `${d.percentile}th percentile and heavily weighted for his position — growth here buys the most.`;
      line.appendChild(chip);
    }
    card.appendChild(cardSection('ELITE, AND WHERE GROWTH PAYS', line));
  }
}

/** financial: wage, contract, value, and the deal on the table. */
function financialFace(card, p) {
  const doc = state.doc;
  const sv = doc?.sellValues?.rows?.find((r) => r.playerId === p.playerId);
  const ren = doc?.wages?.renewals?.find((r) => r.playerId === p.playerId);
  const assess = doc?.wages?.assessmentList?.find((a) => a.playerId === p.playerId);

  card.appendChild(
    tileRow([
      ['Wage', money(p.wage), p.wageNote ?? undefined],
      ['Contract', p.contractMonths === null ? null : fmtTerm(p.contractMonths)],
      ['Role', p.squadRole === 'None' ? null : p.squadRole],
      ['Share of bill', assess?.shareOfBill ? `${(assess.shareOfBill * 100).toFixed(1)}%` : null, 'This wage as a share of the whole squad bill.'],
      ['Band median', money(assess?.peerMedian), 'Median wage of squad members in the same role band.'],
      ['Verdict', p.wageVerdict, assess?.note],
    ]),
  );

  if (sv?.ea) {
    const band = el('div', 'valband');
    const line = el('div', 'valbar');
    line.appendChild(el('i', 'vfloor'));
    line.appendChild(el('i', 'vmid'));
    line.appendChild(el('i', 'vceil'));
    band.appendChild(line);
    const marks = el('div', 'valmarks');
    for (const [lbl, v, cls] of [['Walk away', sv.ea.floor, 'lo'], ['Fair value', sv.ea.value, 'mid'], ['Push to', sv.ea.ceiling, 'hi']]) {
      const m = el('span', `vmark ${cls}`);
      m.appendChild(el('i', null, lbl));
      m.appendChild(el('b', null, moneyShort(v)));
      marks.appendChild(m);
    }
    band.appendChild(marks);
    band.dataset.tip = 'EA-style valuation, rebuilt from community-derived curves. Derived (~), never a rule input.';
    card.appendChild(cardSection('WHAT HE IS WORTH ~', band));
    if (sv.mid !== null && sv.mid !== undefined) {
      card.appendChild(
        el('p', 'muted tiny', `This world has actually paid ${moneyShort(sv.low)}–${moneyShort(sv.high)} for players of this profile.`),
      );
    }
  }

  if (ren) {
    const wrap = el('div', 'pkgrow');
    for (const o of ren.options) {
      const box = el('div', 'pkg');
      const t = el('div', 'pkg-head');
      t.appendChild(el('b', null, o.kind === 'flat' ? 'Flat deal' : 'Base plus bonus'));
      t.appendChild(el('span', 'pkg-wage', `${money(o.weeklyWage)}/wk`));
      box.appendChild(t);
      const rows = [
        ['Term', `${o.years} years`],
        ['Signing bonus', money(o.signOnBonus)],
        o.bonusPerEvent ? ['Appearance bonus', `${money(o.bonusPerEvent)} after ${o.bonusEvents}/season`] : null,
        ['Guaranteed', money(o.guaranteedCost)],
        o.maximumCost !== o.guaranteedCost ? ['If all bonuses hit', money(o.maximumCost)] : null,
      ].filter(Boolean);
      const dl = el('div', 'pkg-rows');
      for (const [k, v] of rows) {
        const line = el('div', 'pkg-row');
        line.appendChild(el('span', null, k));
        line.appendChild(el('b', null, v ?? '—'));
        dl.appendChild(line);
      }
      box.appendChild(dl);
      box.appendChild(el('p', 'pkg-trade', o.tradeoff));
      wrap.appendChild(box);
    }
    card.appendChild(cardSection(`RENEWAL — THE GAME TAKES AT MOST ${ren.maxYears}Y AT THIS AGE`, wrap));
    const clause = el('div', `clause ${ren.releaseClause.recommend ? 'yes' : 'no'}`);
    clause.appendChild(el('b', null, ren.releaseClause.recommend ? `Release clause: ${money(ren.releaseClause.amount)}` : 'No release clause'));
    clause.appendChild(el('span', null, ren.releaseClause.why));
    card.appendChild(clause);
  }
}

/** `defensiveawareness` is not a word. */
function prettyAttr(key) {
  const named = {
    gkdiving: 'Diving', gkhandling: 'Handling', gkkicking: 'Kicking',
    gkpositioning: 'Positioning', gkreflexes: 'Reflexes',
    defensiveawareness: 'Def. awareness', standingtackle: 'Standing tackle',
    slidingtackle: 'Sliding tackle', headingaccuracy: 'Heading',
    shortpassing: 'Short passing', longpassing: 'Long passing',
    freekickaccuracy: 'Free kicks', sprintspeed: 'Sprint speed',
    ballcontrol: 'Ball control', shotpower: 'Shot power', longshots: 'Long shots',
  };
  return named[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/* ---------------- views ---------------- */

/**
 * Every table sorts by its own columns: click a header, click again to flip.
 * Each cell carries its raw value in data-sort, so sorting rearranges the DOM
 * rows without re-rendering — the top-level sort bar is gone; the columns you
 * can see are the sorts you get.
 */
/**
 * opts.onRow + opts.keys make rows activatable: keys[i] identifies row i and
 * survives re-sorting, because it rides on the row element itself.
 */
function table(headers, rows, opts = {}) {
  const wrap = el('div', 'table-wrap');
  const t = el('table');
  if (opts.tight) t.classList.add('tight');

  // A column every row leaves blank is noise wearing a header — the academy's
  // "Mins" column, for instance, where the save records no academy minutes at
  // all. Drop it rather than print a wall of dashes. Interactive cells (stars)
  // never count as blank.
  const blankCell = (c) =>
    c === null || c === undefined || c === '' || c === '—' ||
    (typeof c === 'object' && !c.star && !c.node && (c.text === null || c.text === undefined || c.text === '' || c.text === '—'));
  const keep = headers.map((h, i) =>
    (typeof h === 'object' && h.always) || rows.length === 0 || !rows.every((r) => blankCell(r[i])),
  );
  headers = headers.filter((_, i) => keep[i]);
  rows = rows.map((r) => r.filter((_, i) => keep[i]));

  const rowsAreOpenable = !!(opts.keys && opts.onRow);
  if (rowsAreOpenable) headers = [{ label: '', always: true, zone: true }, ...headers];

  /**
   * Which table this is, so its sort can be remembered.
   *
   * Keyed on the column labels rather than a hand-written id: two tables with
   * the same columns are the same table as far as sorting goes, and no call site
   * has to remember to pass anything.
   */
  const sortKey = opts.sortKey ?? headers.map((h) => (typeof h === 'object' ? h.label : h)).join('|');

  const sortBy = (col, asc) => {
    for (const other of hr.children) other.classList.remove('on', 'asc');
    const th = hr.children[col];
    if (th) {
      th.classList.add('on');
      if (asc) th.classList.add('asc');
    }
    const body = t.querySelector('tbody');
    if (!body) return;
    // Detail rows travel with their parent, so sort only the real rows and
    // re-attach each detail underneath the row it belongs to.
    const dataRows = [...body.children].filter((r) => !r.classList.contains('detailrow'));
    const sorted = dataRows.sort((ra, rb) => {
      const va = ra.children[col]?.dataset.sort ?? '';
      const vb = rb.children[col]?.dataset.sort ?? '';
      const na = Number(va);
      const nb = Number(vb);
      const cmp =
        !Number.isNaN(na) && !Number.isNaN(nb) && va !== '' && vb !== ''
          ? na - nb
          : String(va).localeCompare(String(vb));
      return asc ? cmp : -cmp;
    });
    for (const r of sorted) {
      const detail = r.nextElementSibling?.classList.contains('detailrow') ? r.nextElementSibling : null;
      body.appendChild(r);
      if (detail) body.appendChild(detail);
    }
  };

  const thead = el('thead');
  const hr = el('tr');
  headers.forEach((h, col) => {
    const isObj = typeof h === 'object';
    if (isObj && h.zone) {
      hr.appendChild(el('th', 'dwellzone'));
      return;
    }
    const th = el('th', `sortable${isObj && h.num ? ' num' : ''}`, isObj ? h.label : h);
    // Through activatable, not a bare click: sorting must dwell like every
    // other control in the app.
    activatable(th, () => {
      // A position column starts ascending (GK first, football order);
      // everything else starts with the biggest number on top.
      const asc = th.classList.contains('on') ? !th.classList.contains('asc') : !!(isObj && h.pos);
      sortBy(col, asc);
      // Remembered, because the page rebuilds itself every time the game saves
      // and every time a card opens. A sort that survives neither is a sort you
      // have to keep redoing for no reason you can see.
      state.sorts[sortKey] = { col, asc };
      try {
        localStorage.setItem('sorts', JSON.stringify(state.sorts));
      } catch {
        /* a browser refusing storage is not a reason to fail the sort */
      }
    });
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  t.appendChild(thead);
  const tbody = el('tbody');
  rows.forEach((row, ri) => {
    const tr = el('tr');
    const rowable = rowsAreOpenable;
    let zoneCell = null;
    if (rowable) {
      tr.dataset.key = String(opts.keys[ri]);
      tr.classList.add('rowable');
      if (String(opts.keys[ri]) === String(opts.openKey ?? '')) tr.classList.add('is-open');
      zoneCell = el('td', 'dwellzone');
      tr.appendChild(zoneCell);
    }
    row.forEach((cell, ci) => {
      const h2 = headers[ci + (rowable ? 1 : 0)];
      const hmeta = typeof h2 === 'object' ? h2 : {};
      const isObj = typeof cell === 'object' && cell !== null;
      const classes = [
        isObj && cell.num ? 'num' : '',
        isObj && cell.tier !== undefined ? `tier-cell ${tier(cell.tier)}` : '',
        isObj && cell.cls ? cell.cls : '',
      ]
        .filter(Boolean)
        .join(' ');
      const td = el('td', classes);
      const text = isObj ? cell.text : (cell ?? '—');
      if (isObj && cell.node) td.appendChild(cell.node);
      else if (isObj && cell.star) {
        const b = el('button', `starbtn${cell.star.on ? ' on' : ''}`, cell.star.on ? '★' : '☆');
        b.dataset.tip = cell.star.on ? 'On your watchlist — tap to drop' : 'Watch this player: freezes today’s numbers so the drift shows';
        activatable(b, cell.star.onToggle);
        td.appendChild(b);
      } else if (isObj && cell.cls === 'posbadge') td.appendChild(el('span', 'pos-pill', text));
      else td.textContent = text;
      // A position column sorts by football order, never the alphabet —
      // "CB before CAM because C < B" is nobody's idea of a squad list.
      td.dataset.sort = hmeta.pos
        ? String(posRank(String(isObj && cell.sortText !== undefined ? cell.sortText : text)))
        : isObj && cell.sort !== undefined
          ? String(cell.sort)
          : String(text === '—' ? '' : text).replace(/[^0-9.\-]/g, '') || String(text);
      if (isObj && cell.title) td.dataset.tip = cell.title;
      tr.appendChild(td);
    });
    // Dwell arms only in the leading zone — the rest of the row stays safe to
    // rest a pointer on while reading, which is what made the roster pleasant.
    if (rowable) {
      activatable(tr, () => opts.onRow(tr.dataset.key), { host: zoneCell, pad: true });
    }
    tbody.appendChild(tr);

    // The detail opens under the row it came from, not at the top of the page.
    if (rowable && opts.detail && String(opts.keys[ri]) === String(opts.openKey ?? '')) {
      const dr = el('tr', 'detailrow');
      const dtd = el('td');
      dtd.colSpan = headers.length;
      const node = opts.detail(String(opts.keys[ri]));
      if (node) dtd.appendChild(node);
      dr.appendChild(dtd);
      tbody.appendChild(dr);
    }
  });
  t.appendChild(tbody);
  const remembered = state.sorts[sortKey];
  if (remembered && remembered.col < headers.length) sortBy(remembered.col, remembered.asc);
  wrap.appendChild(t);
  return wrap;
}

/**
 * Squad and Youth render as a roster: one row per player, the whole squad on a
 * single screen. This is a companion — the answer has to be visible before the
 * loading screen ends. A row opens into the full card only when asked.
 */
// Overall and ceiling are two facts, so they are two columns — an "89 → 91"
// blob could not be sorted on either half.
const ROSTER_COLUMNS = [
  { key: null, label: '' },
  { key: 'ingame', label: 'Pos' },
  { key: null, label: '' },
  { key: 'name', label: 'Player' },
  { key: 'overall', label: 'OVR' },
  { key: 'potential', label: 'POT' },
  { key: 'age', label: 'Age' },
  { key: 'growth', label: 'Δ' },
  { key: null, label: '' },
  { key: 'urgency', label: 'Action' },
  { key: 'minutes', label: 'Mins' },
];

/**
 * The roster, in the same table as every other squad view. Basic used to be a
 * bespoke CSS grid while Stats, Attributes and Financial were real tables —
 * so the four views of one squad looked like four different products. They are
 * one engine now: same alignment, same sorting, same row behaviour, different
 * columns.
 */
/** Face, name and the marks that change a decision — one cell, every table. */
function playerNameCell(p) {
  const box = el('span', 'pcell');
  box.appendChild(faceOf(p, 22));
  const nm = el('span', 'pcname');
  nm.append(p.name);
  if (p.nameProvisional) nm.appendChild(el('span', 'prov', '~'));
  box.appendChild(nm);
  const marks = el('span', 'rmarks');
  const mark = (cls, name, tip) => {
    const holder = el('i', `mk ${cls}`);
    holder.appendChild(icon(name, 13));
    holder.dataset.tip = tip;
    marks.appendChild(holder);
  };
  /**
   * How they are playing, in the same visual language as the league table: a
   * run that is going well burns, a run that is going badly freezes, and three
   * is a spark where five is the thing itself. The icon follows the role, so a
   * centre-back on a run does not wear a striker's badge.
   */
  const PERF_ICON = {
    hattrick: 'flame',
    brace: 'flame',
    scoring: 'flame',
    struggling: 'snowflake',
    keeper: 'shield',
    defender: 'shield',
    midfielder: 'compass',
    wide: 'zap',
    forward: 'target',
  };
  const perf = p.matchForm?.mark;
  if (perf) {
    const glyph = PERF_ICON[perf.kind] ?? PERF_ICON[perf.role] ?? 'activity';
    mark(`streak ${perf.tone} ${perf.depth >= 5 ? 'blaze' : 'spark'}`, glyph, perf.line);
  }
  if (p.injured) mark('down', 'cross', 'Injured');
  if (p.nationalTeam) mark('info', 'flag', 'Away with his country');
  if (p.potentialTag === 'Special' || p.potentialTag === 'Exciting') {
    mark('gold', 'gem', `${p.potentialTag} ceiling`);
  }
  if (marks.childElementCount) box.appendChild(marks);
  return box;
}

function renderPlayers(list, opts = {}) {
  const frag = document.createDocumentFragment();
  const filtered = applyFilters(list).sort(
    (a, b) => posRank(a.positionShort ?? '') - posRank(b.positionShort ?? '') || (b.overall ?? 0) - (a.overall ?? 0),
  );

  if (state.rosterSel && !filtered.some((p) => p.playerId === state.rosterSel)) state.rosterSel = null;

  const panel = el('div', 'panel');
  panel.appendChild(el('h2', null, opts.title ?? '👥 Squad'));
  if (!filtered.length) {
    panel.appendChild(el('p', 'empty', 'Nothing matches these filters.'));
    frag.appendChild(panel);
    return frag;
  }

  const nameCell = playerNameCell;
  const deltaCell = (p) => {
    const g = delta(p.overallSeasonDelta);
    const box = el('span', `rdelta ${g && g.text !== '0' ? g.cls : 'flat'}`);
    const arrow = trendArrow(p);
    if (arrow) box.appendChild(arrow);
    if (g && g.text !== '0') box.append(g.text);
    return box;
  };

  panel.appendChild(
    table(
      [
        { label: 'Pos', pos: true },
        'Player',
        { label: 'OVR', num: true },
        { label: 'POT', num: true },
        { label: 'Age', num: true },
        { label: 'Δ', num: true },
        'Action',
        { label: 'Mins', num: true },
      ],
      filtered.map((p) => {
        const act = settings.actionChips ? [p.advice, ...p.otherAdvice].find((a) => a.severity !== 'steady') : null;
        return [
          { text: p.positionShort ?? '—', cls: 'posbadge' },
          { node: nameCell(p), text: p.name, sort: p.name },
          { text: p.overall ?? '—', num: true, tier: p.overall },
          {
            text: p.potential ?? '—',
            num: true,
            tier: p.potential,
            title: (p.headroom ?? 0) > 0 ? `${p.headroom} still to grow` : undefined,
          },
          { text: p.age ?? '—', num: true },
          { node: deltaCell(p), text: p.overallSeasonDelta ?? '', num: true, sort: p.overallSeasonDelta ?? -99 },
          act ? { node: el('span', `act ${act.severity}`, act.tag), text: act.tag, title: act.line } : '',
          { text: p.minutesThisSeason !== null ? `${p.minutesThisSeason}'` : '—', num: true },
        ];
      }),
      {
        keys: filtered.map((p) => p.playerId),
        openKey: state.rosterSel,
        detail: (key) => {
          const sel = filtered.find((p) => p.playerId === Number(key));
          return sel ? playerCard(sel, () => { state.rosterSel = null; render(); }, 'basic') : null;
        },
        onRow: (key) => {
          const id = Number(key);
          state.rosterSel = state.rosterSel === id ? null : id;
          state.reveal = state.rosterSel !== null;
          render();
        },
      },
    ),
  );
  panel.appendChild(
    el(
      'p',
      'muted tiny rkey',
      'Tap a row for the card. ⚑ national-team call-up · ◆ Special / Exciting ceiling · Δ rating change this season · action colours: red act now, amber this window, blue keep an eye.',
    ),
  );
  panel.appendChild(squadMarkKey());
  frag.appendChild(panel);
  return frag;
}

/**
 * What the marks beside a player's name mean.
 *
 * The same discipline as the league table's key: every mark listed whether or
 * not today's squad happens to show one, because the moment you first meet a
 * symbol is exactly when its explanation needs to be on screen. The roles are
 * spelled out too — the badge changes with the position, and a shield on a
 * centre-back is not the same claim as a flame on a striker.
 */
function squadMarkKey() {
  const wrap = el('div', 'legend');
  const item = (build, label) => {
    const row = el('span', 'legitem');
    const mark = el('span', 'legmark');
    build(mark);
    row.appendChild(mark);
    row.appendChild(el('span', 'legtext', label));
    wrap.appendChild(row);
  };
  const streak = (tone, heat, glyph, label) => {
    item((m) => {
      const holder = el('span', `streak ${tone} ${heat}`);
      holder.appendChild(icon(glyph, 13));
      m.appendChild(holder);
    }, label);
  };
  streak('hot', 'blaze', 'flame', 'hat-trick last time out');
  streak('hot', 'spark', 'flame', 'a brace, or a scoring run');
  streak('good', 'spark', 'shield', 'a defender holding firm');
  streak('good', 'spark', 'compass', 'a midfielder running the game');
  streak('good', 'spark', 'zap', 'a winger unplayable out wide');
  streak('good', 'spark', 'target', 'a forward leading the line');
  streak('hot', 'blaze', 'shield', 'five or more at 8 and above');
  streak('cold', 'blaze', 'snowflake', 'three or more at 5 and below');
  item((m) => {
    const holder = el('i', 'mk down');
    holder.appendChild(icon('cross', 13));
    m.appendChild(holder);
  }, 'injured');
  item((m) => {
    const holder = el('i', 'mk info');
    holder.appendChild(icon('flag', 13));
    m.appendChild(holder);
  }, 'away with his country');
  item((m) => {
    const holder = el('i', 'mk gold');
    holder.appendChild(icon('gem', 13));
    m.appendChild(holder);
  }, 'Special or Exciting ceiling');
  wrap.appendChild(
    el(
      'span',
      'legitem legnote',
      'Form comes from the match ratings the game itself gave, over the window the save keeps. Unused substitutes are not counted.',
    ),
  );
  return wrap;
}

/**
 * The pitch. Coordinates come from the save's own formation offsets, so a 4-3-3
 * here stands where the game stands it — this is not a layout we invented.
 *
 * Each disc carries the fit for that slot, tiered like every other rating.
 * A dashed gold ring means our recommendation differs from the XI you saved.
 */
const CODE_SHORT = [
  'GK', 'SW', 'RWB', 'RB', 'CB', 'CB', 'CB', 'LB', 'LWB',
  'CDM', 'CDM', 'CDM', 'RM', 'CM', 'CM', 'CM', 'LM',
  'CAM', 'CAM', 'CAM', 'RF', 'CF', 'LF', 'RW', 'ST', 'ST', 'ST', 'LW',
];
const codeShort = (code) => (code !== null && code !== undefined ? CODE_SHORT[code] : undefined);

function renderPitch(xi, diff, byId, nameOf) {
  const wrap = el('div', 'pitch');
  wrap.appendChild(el('div', 'halfway'));
  wrap.appendChild(el('div', 'circle'));
  wrap.appendChild(el('div', 'box top'));
  wrap.appendChild(el('div', 'box bottom'));

  const savedAt = new Map(diff.map((d) => [d.index, d.savedPlayerId]));

  // The game's coordinates cluster midfielders and defenders tightly enough
  // that 100px cards overlap. A few relaxation passes push near-neighbours
  // apart while keeping the shape recognisable; positions stay the save's, only
  // the labels give each other room.
  const spots = xi.assignments.map((a) => {
    const raw = xi.shape.spots[a.index] ?? { x: 0.5, y: 0.5 };
    return { x: raw.x, y: raw.y };
  });
  const MIN_X = 0.26;
  const MIN_Y = 0.11;
  for (let pass = 0; pass < 24; pass++) {
    let moved = false;
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const a = spots[i];
        const b = spots[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.abs(dx) < MIN_X && Math.abs(dy) < MIN_Y) {
          // Separate along whichever axis is closer to done.
          if (MIN_Y - Math.abs(dy) <= MIN_X - Math.abs(dx)) {
            const push = (MIN_Y - Math.abs(dy)) / 2 + 0.002;
            const dir = dy >= 0 ? 1 : -1;
            a.y -= push * dir;
            b.y += push * dir;
          } else {
            const push = (MIN_X - Math.abs(dx)) / 2 + 0.002;
            const dir = dx >= 0 ? 1 : -1;
            a.x -= push * dir;
            b.x += push * dir;
          }
          moved = true;
        }
      }
    }
    for (const sp of spots) {
      sp.x = Math.min(0.88, Math.max(0.12, sp.x));
      sp.y = Math.min(0.95, Math.max(0.04, sp.y));
    }
    if (!moved) break;
  }

  for (const a of xi.assignments) {
    const spot = spots[a.index] ?? { x: 0.5, y: 0.5 };
    const node = el('div', 'slot');
    // y runs from our own goal line upward; flip it so we attack up the screen.
    // x needs no flip: in this save the RB spot (position code 3) sits at
    // x=0.9 and the LB spot (code 7) at x=0.1 — left-to-right as viewed.
    node.style.left = `${spot.x * 100}%`;
    node.style.top = `${(1 - spot.y) * 100}%`;

    const savedId = savedAt.get(a.index) ?? null;
    const changed = savedId !== null && a.playerId !== null && savedId !== a.playerId;
    if (changed) node.classList.add('changed');

    const p = byId.get(a.playerId);
    const pc = el('div', 'pc');

    const row = el('div', 'prow');
    row.appendChild(el('span', `pn ${tier(a.fit)}`, a.fit ?? '—'));
    row.appendChild(el('span', 'pp', codeShort(a.positionCode) ?? p?.positionShort ?? '—'));
    pc.appendChild(row);

    const who = a.playerId === null ? '—' : nameOf(a.playerId);
    pc.appendChild(el('div', 'pnm', who));

    const sheetRole = (window.__doc?.matchday?.sheetRoles ?? []).find((r2) => r2.playerId === a.playerId);
    if (sheetRole && sheetRole.roleId !== null) {
      const rl = roleLabel(sheetRole.roleId, sheetRole.focus);
      if (rl) pc.appendChild(el('div', 'prole', rl));
    }

    // Age and form, which change week to week. The old "% of ceiling" bar read
    // 98-100% for every senior and told you nothing.
    if (p) {
      pc.appendChild(
        el('div', 'pmeta', [p.age !== null ? `${p.age}y` : null, p.form].filter(Boolean).join(' · ')),
      );
      // data-tip renders through our own styled tooltip; the browser default
      // looked pasted on top of the pitch.
      node.dataset.tip = [
        who,
        p.overall !== null ? `${p.overall} overall` : null,
        p.minutesThisSeason !== null ? `${p.minutesThisSeason} minutes` : null,
        a.familiar ? 'plays here naturally' : 'out of position',
        p.injured ? 'injured' : null,
      ]
        .filter(Boolean)
        .join(' · ');
    }

    if (changed && savedId !== null) {
      pc.appendChild(el('div', 'swap', `for ${nameOf(savedId)}`));
      node.dataset.tip = `${node.dataset.tip ?? ''} — you picked ${nameOf(savedId)}; ${who} fits this slot better.`;
    }

    node.appendChild(pc);
    wrap.appendChild(node);
  }

  return wrap;
}

/** Matchday: your XI versus the recommended one, plus every shape you own. */
/**
 * Who we actually play next, when the fixture ledger names them.
 *
 * Before the calendar was decoded the opponent had to be picked by hand. Now
 * the save knows, so the picker starts on the right club and the manual choice
 * is only needed while that slot is still unnamed.
 */
function ledgerNextOpponent(doc) {
  const m = (doc.leagueTable?.ourSeason ?? []).find((x) => !x.result && x.opponentTeamId !== null);
  return m ? m.opponentTeamId : null;
}

function renderMatchday(doc) {
  const m = doc.matchday;
  const frag = document.createDocumentFragment();
  const quests0 = questStrip(doc, 'squad/tactics');
  if (quests0) frag.appendChild(quests0);
  const byId = new Map([...doc.senior, ...doc.academy].map((p) => [p.playerId, p]));
  const nameOf = (id) => byId.get(id)?.name ?? `#${id}`;

  // Depth first: team management starts with knowing where the squad is one
  // injury from a hole.
  frag.appendChild(renderDepth(doc));

  const top = el('div', 'panel');
  top.appendChild(el('h2', null, m.saved?.tacticName ?? 'Your XI'));
  top.appendChild(el('p', 'muted', m.note));

  // The shape to play, and the shape that grows the squad when they differ.
  if (m.shapeAdvice.now) {
    const advice = el('div', 'shape-advice');
    const now = el('div', 'sa');
    now.appendChild(el('b', null, `Play ${m.shapeAdvice.now.name}`));
    now.appendChild(el('span', null, `today ${m.shapeAdvice.now.today ?? '—'} · growth ${m.shapeAdvice.now.growth ?? '—'}`));
    advice.appendChild(now);
    if (m.shapeAdvice.development) {
      const dev = el('div', 'sa dev');
      dev.appendChild(el('b', null, `Develop in ${m.shapeAdvice.development.name}`));
      dev.appendChild(
        el(
          'span',
          null,
          `costs ${m.shapeAdvice.development.todayCost} today, +${((m.shapeAdvice.development.growth ?? 0) - (m.shapeAdvice.now.growth ?? 0)).toFixed(1)} growth`,
        ),
      );
      advice.appendChild(dev);
    }
    top.appendChild(advice);
  }

  // Set pieces and the armband, as icons: saved holder vs the formula's pick.
  if (m.roles.length) {
    const ICONS = { captain: 'C', penalty: '⚽', freekick: '⌖', cross: '↷', corner: '⚑' };
    const roles = el('div', 'roles');
    for (const r of m.roles) {
      const chip = el('span', 'rolechip');
      chip.appendChild(el('i', `ric ${r.icon}`, ICONS[r.icon] ?? '·'));
      const best = r.recommended[0];
      const agrees = r.currentId !== null && best && r.currentId === best.playerId;
      const holder = r.currentId !== null ? nameOf(r.currentId) : null;
      if (agrees) {
        chip.appendChild(el('span', null, holder));
        chip.classList.add('ok');
      } else if (holder && best) {
        chip.appendChild(el('span', 'was', holder));
        chip.appendChild(el('span', 'arrow', '→'));
        chip.appendChild(el('span', null, `${nameOf(best.playerId)} ${best.score}`));
        chip.classList.add('swap');
      } else if (best) {
        chip.appendChild(el('span', null, `${nameOf(best.playerId)} ${best.score}`));
        // No taker assigned in game: dashed border instead of the missing one.
        chip.classList.add('unset');
      }
      chip.dataset.tip =
        `${r.role} — ${r.formula}`+ '\n' +
        r.recommended.map((c, i) => `${i + 1}. ${nameOf(c.playerId)} ${c.score}`).join('\n') +
        (r.currentId !== null && r.currentScore !== null ? `\nYours: ${holder} ${r.currentScore}` : '');
      roles.appendChild(chip);
    }
    top.appendChild(roles);
  }
  // Opponent scout: the save holds no fixture list, but it holds every
  // opponent's squad — pick who you play next and read the lines.
  if (doc.opponents?.length > 1) {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, settings.rpg ? '⚔ Boss scouting' : '🔎 Opponent scout'));
    panel.appendChild(
      el('p', 'muted tiny', 'The save has no fixture list, so pick the club you play next. Lines are the mean rating of their best XI: keeper, back four, middle four, front three.'),
    );
    const mine = doc.opponents.find((o) => o.teamId === doc.club?.id);
    // Nation (flags) -> league -> team, the way you would actually look one up.
    const teamStars = (o) => (o.overall === null ? '' : o.overall >= 83 ? '★★★★★' : o.overall >= 80 ? '★★★★' : o.overall >= 76 ? '★★★' : o.overall >= 72 ? '★★' : '★');
    const nations = [...new Set(doc.opponents.map((o) => o.nation))];
    nations.sort((a, b) => (a === mine?.nation ? -1 : b === mine?.nation ? 1 : a.localeCompare(b)));
    if (!state.oppNation || !nations.includes(state.oppNation)) state.oppNation = mine?.nation ?? nations[0];
    const nchips = el('div', 'chiprow');
    for (const n2 of nations) {
      const chip = el('button', `chip${state.oppNation === n2 ? ' on' : ''}`, `${flagFor(n2)}${n2}`);
      activatable(chip, () => { state.oppNation = n2; state.oppLeague = null; render(); }, { skipWhen: () => state.oppNation === n2 });
      nchips.appendChild(chip);
    }
    panel.appendChild(nchips);

    const leagues = [...new Set(doc.opponents.filter((o) => o.nation === state.oppNation).map((o) => o.league))];
    leagues.sort((a, b) => (a === mine?.league ? -1 : b === mine?.league ? 1 : a.localeCompare(b)));
    if (!state.oppLeague || !leagues.includes(state.oppLeague)) state.oppLeague = leagues[0];
    if (leagues.length > 1) {
      const lchips = el('div', 'chiprow');
      for (const lg of leagues) {
        const chip = el('button', `chip${state.oppLeague === lg ? ' on' : ''}`, lg);
        activatable(chip, () => { state.oppLeague = lg; render(); }, { skipWhen: () => state.oppLeague === lg });
        lchips.appendChild(chip);
      }
      panel.appendChild(lchips);
    }

    const chosen = state.oppSel ?? ledgerNextOpponent(doc);
    const chips = el('div', 'chiprow');
    for (const o of doc.opponents.filter((o2) => o2.league === state.oppLeague)) {
      if (o.teamId === doc.club?.id) continue;
      const chip = el('button', `chip teamchip${chosen === o.teamId ? ' on' : ''}`);
      chip.appendChild(el('span', null, o.name));
      chip.appendChild(el('i', 'stars5', teamStars(o)));
      chip.dataset.tip = `A ${o.att ?? '—'} · M ${o.mid ?? '—'} · D ${o.def ?? '—'} · GK ${o.gk ?? '—'}`;
      activatable(chip, () => { state.oppSel = o.teamId; render(); }, { skipWhen: () => state.oppSel === o.teamId });
      chips.appendChild(chip);
    }
    panel.appendChild(chips);
    const opp = doc.opponents.find((o) => o.teamId === chosen);
    if (opp && mine) {
      const line = (label, ours, theirs) => {
        const d = ours !== null && theirs !== null ? Math.round((ours - theirs) * 10) / 10 : null;
        return [label, { text: ours ?? '—', num: true, tier: ours }, { text: theirs ?? '—', num: true, tier: theirs },
          { text: d === null ? '—' : `${d > 0 ? '+' : ''}${d}`, num: true }];
      };
      panel.appendChild(
        table(
          ['Line', { label: 'You', num: true }, { label: opp.name, num: true }, { label: 'Edge', num: true }],
          [line('Best XI', mine.overall, opp.overall), line('Goalkeeper', mine.gk, opp.gk),
           line('Defence', mine.def, opp.def), line('Midfield', mine.mid, opp.mid), line('Attack', mine.att, opp.att)],
        ),
      );
      const bits = [];
      if (opp.threats.length) bits.push(`Threats: ${opp.threats.map((t2) => `${t2.name} (${t2.pos ?? '?'} ${t2.overall})`).join(' · ')}.`);
      if (opp.pace) bits.push(`Fastest: ${opp.pace.name}, ${opp.pace.sprint} sprint speed — mind the ball over the top.`);
      const lines2 = [];
      const edges = [['goalkeeper', mine.gk, opp.gk], ['defence', mine.def, opp.def], ['midfield', mine.mid, opp.mid], ['attack', mine.att, opp.att]]
        .filter(([, a, b]) => a !== null && b !== null)
        .map(([n2, a, b]) => [n2, Math.round((a - b) * 10) / 10]);
      const best = [...edges].sort((a, b) => b[1] - a[1])[0];
      const worst = [...edges].sort((a, b) => a[1] - b[1])[0];
      if (best && best[1] > 0) lines2.push(`Your biggest edge is ${best[0]} (+${best[1]}) — play through it.`);
      if (worst && worst[1] < 0) lines2.push(`They outrate your ${worst[0]} by ${Math.abs(worst[1])} — that is where the game can be lost.`);
      for (const b of bits) panel.appendChild(el('p', 'tipline', b));
      for (const l2 of lines2) panel.appendChild(el('p', 'tipline', l2));
    } else {
      panel.appendChild(el('p', 'muted tiny', 'Rest on a club to compare.'));
    }
    frag.appendChild(panel);
  }

  // Every saved team sheet, scored the same way: the game lets a manager keep
  // several, and reading only the first silently ignored the rest.
  if (m.sheets?.length > 1) {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, `Team sheets — ${m.sheets.length}`));
    panel.appendChild(
      table(
        ['Sheet', 'Shape', { label: 'Players', num: true }, { label: 'Today', num: true }],
        m.sheets.map((sh) => [
          sh.name,
          sh.shapeName ?? '—',
          { text: sh.players, num: true },
          { text: sh.today ?? '—', num: true, tier: sh.today },
        ]),
      ),
    );
    panel.appendChild(
      el('p', 'muted tiny', 'Today = the mean rating of that sheet\u2019s eleven in its own positions. The pitch below always shows the first sheet, which the game treats as the default.'),
    );
    frag.appendChild(panel);
  }

  if (m.recommended) {
    const meta = el('div', 'subhead');
    meta.appendChild(el('span', null, `Shape ${m.recommended.shape.name}`));
    meta.appendChild(el('span', null, `Today ${m.recommended.today ?? '—'}`));
    meta.appendChild(el('span', null, `Growth ${m.recommended.growth ?? '—'}`));
    if (m.saved?.defensiveDepth !== null && m.saved?.defensiveDepth !== undefined) {
      meta.appendChild(el('span', null, `Depth ${m.saved.defensiveDepth}`));
    }
    top.appendChild(meta);

    const wrap = el('div', 'pitch-wrap');
    wrap.appendChild(renderPitch(m.recommended, m.diff, byId, nameOf));

    const side = el('div', 'pitch-side');
    const legend = el('div', 'pitch-legend');
    legend.appendChild(el('span', null, 'Rating in that slot'));
    legend.appendChild(el('span', 'lg-amber', 'Amber = we would pick someone else'));
    side.appendChild(legend);

    // The eleven as a list, for reading rather than scanning. Football order,
    // back to front, like the game's own team sheet.
    side.appendChild(
      table(
        [{ label: 'Pos', pos: true }, 'Player', { label: 'Fit', num: true }, { label: 'OVR', num: true }, { label: 'Growth', num: true }, 'Form'],
        [...m.recommended.assignments]
          .sort((a, b) => posRank(codeShort(a.positionCode) ?? '') - posRank(codeShort(b.positionCode) ?? ''))
          .map((a) => {
            const p = byId.get(a.playerId);
            return [
              { text: codeShort(a.positionCode) ?? a.slot ?? '—', cls: 'posbadge' },
              p ? { node: playerNameCell(p), text: p.name, sort: p.name } : (a.playerId === null ? '—' : nameOf(a.playerId)),
              { text: a.fit ?? '—', num: true, tier: a.fit },
              { text: p?.overall ?? '—', num: true, tier: p?.overall },
              { text: a.headroom === null ? '—' : `+${a.headroom}`, num: true },
              p?.form ?? '—',
            ];
          }),
        { tight: true },
      ),
    );
    top.appendChild(wrap);
    wrap.appendChild(side);
  }
  frag.appendChild(top);

  // Who is left: the bench you would name, then everyone else. The old line
  // said "12 available players not in this eleven" and left you to guess who.
  {
    const inXI = new Set((m.recommended?.assignments ?? []).map((a) => a.playerId));
    const rest = doc.senior
      .filter((p2) => !inXI.has(p2.playerId))
      .sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));
    const unavailable = new Set((m.unavailable ?? []).map((u) => u.playerId));
    const available = rest.filter((p2) => !unavailable.has(p2.playerId));

    // A bench covers the shape: a keeper, then the best available in each line.
    const lineOf = (p2) => {
      const sh = p2.positionShort ?? '';
      if (sh === 'GK') return 'GK';
      if (['CB', 'RB', 'LB', 'RWB', 'LWB'].includes(sh)) return 'DEF';
      if (['CDM', 'CM', 'CAM', 'RM', 'LM'].includes(sh)) return 'MID';
      return 'ATT';
    };
    const bench = [];
    for (const line of ['GK', 'DEF', 'DEF', 'MID', 'MID', 'ATT', 'ATT']) {
      const pick = available.find((p2) => !bench.includes(p2) && lineOf(p2) === line);
      if (pick) bench.push(pick);
    }
    for (const p2 of available) {
      if (bench.length >= 7) break;
      if (!bench.includes(p2)) bench.push(p2);
    }
    const reserves = rest.filter((p2) => !bench.includes(p2));

    const squadTable = (list2, note) =>
      table(
        [{ label: 'Pos', pos: true }, 'Player', { label: 'OVR', num: true }, { label: 'POT', num: true }, { label: 'Age', num: true }, { label: 'Mins', num: true }, 'Status'],
        list2.map((p2) => [
          { text: p2.positionShort ?? '—', cls: 'posbadge' },
          { node: playerNameCell(p2), text: p2.name, sort: p2.name },
          { text: p2.overall ?? '—', num: true, tier: p2.overall },
          { text: p2.potential ?? '—', num: true, tier: p2.potential },
          { text: p2.age ?? '—', num: true },
          { text: p2.minutesThisSeason !== null ? `${p2.minutesThisSeason}'` : '—', num: true },
          unavailable.has(p2.playerId)
            ? { node: el('span', 'act urgent', (m.unavailable.find((u) => u.playerId === p2.playerId)?.reason ?? 'out').toUpperCase()), text: 'out' }
            : note,
        ]),
        { tight: true },
      );

    if (bench.length) {
      const panel = el('div', 'panel');
      panel.appendChild(el('h2', null, `Bench — ${bench.length}`));
      panel.appendChild(el('p', 'muted tiny', 'The seven that cover the shape: a keeper, then the best available in each line.'));
      panel.appendChild(squadTable(bench, 'available'));
      frag.appendChild(panel);
    }
    if (reserves.length) {
      const panel = el('div', 'panel');
      panel.appendChild(el('h2', null, `Reserves — ${reserves.length}`));
      panel.appendChild(squadTable(reserves, ''));
      frag.appendChild(panel);
    }
  }

  const changes = m.diff.filter((d) => d.savedPlayerId !== d.recommendedPlayerId && d.recommendedPlayerId !== null);
  const changePanel = el('div', 'panel');
  changePanel.appendChild(el('h2', null, `Selection — ${changes.length} change${changes.length === 1 ? '' : 's'} suggested`));
  if (!changes.length) {
    changePanel.appendChild(el('p', 'muted', 'Your saved XI matches the recommendation at every slot.'));
  } else {
    changePanel.appendChild(
      table(
        ['Slot', 'You picked', { label: 'Fit', num: true }, 'Recommended', { label: 'Fit', num: true }, { label: 'Gain', num: true }],
        changes.map((d) => [
          d.slot ?? '—',
          d.savedPlayerId ? nameOf(d.savedPlayerId) : '—',
          { text: d.savedFit ?? '—', num: true },
          d.recommendedPlayerId ? nameOf(d.recommendedPlayerId) : '—',
          { text: d.recommendedFit ?? '—', num: true },
          { text: d.fitCost === null ? '—' : `+${d.fitCost}`, num: true },
        ]),
      ),
    );
  }
  frag.appendChild(changePanel);

  if (m.unavailable.length) {
    const out = el('div', 'panel');
    out.appendChild(el('h2', null, 'Unavailable'));
    out.appendChild(table(['Player', 'Reason'], m.unavailable.map((u) => [u.name, u.reason])));
    frag.appendChild(out);
  }

  const shapes = el('div', 'panel');
  shapes.appendChild(el('h2', null, 'Shapes you own'));
  shapes.appendChild(
    el('p', 'muted', 'Today and growth are always shown together: a shape one point worse now may be several points better for development.'),
  );
  shapes.appendChild(
    table(
      ['Shape', { label: 'Today', num: true }, { label: 'Growth', num: true }, { label: 'Cost vs best', num: true }],
      m.shapes.map((s) => [
        s.xi.shape.name,
        { text: s.xi.today ?? '—', num: true },
        { text: s.xi.growth ?? '—', num: true },
        { text: s.todayCost === null || s.todayCost === 0 ? '—' : `-${s.todayCost}`, num: true },
      ]),
    ),
  );
  frag.appendChild(shapes);

  const cal = el('div', 'panel');
  cal.appendChild(el('h2', null, 'Fit calibration'));
  cal.appendChild(
    el(
      'p',
      'muted',
      `Our fit sits ${m.calibration.meanAbsoluteError ?? '?'} from the game's own rating on average across ${m.calibration.count} players, ` +
        `${m.calibration.within1} of them within 1. Until that average is inside 1, treat fit-driven advice as provisional.`,
    ),
  );
  frag.appendChild(cal);
  return frag;
}

/**
 * A player you do not own. Same anatomy as the squad card, minus the parts
 * that only mean something for your own players (advice, minutes, growth
 * history) and plus the parts that decide a signing: what he costs, what he is
 * elite at, and the full attribute sheet.
 */
function scoutCard(profile, onClose, extra) {
  const p = profile;
  const card = el('div', 'card scoutcard');

  const head = el('div', 'head');
  if (onClose) {
    const closer = el('button', 'chip closer', 'Close ✕');
    activatable(closer, onClose);
    head.appendChild(closer);
  }
  head.appendChild(faceOf(p, 40));
  head.appendChild(el('span', 'name', p.name));
  if (p.positionShort) head.appendChild(el('span', 'badge-pos', p.positionShort));
  const rates = el('div', 'rates');
  for (const [lbl, v, ceil] of [['OVR', p.overall, false], ['POT', p.potential, true]]) {
    const r = el('span', 'rate');
    r.appendChild(el('span', 'lbl', lbl));
    r.appendChild(el('span', `n ${ceil ? 'ceil ' : ''}${tier(v)}`, v ?? '—'));
    rates.appendChild(r);
  }
  head.appendChild(rates);
  card.appendChild(head);

  const facts = el('div', 'facts');
  if (p.nation) facts.appendChild(el('span', null, `${flagFor(p.nation)}${p.nation}`));
  for (const bit of [
    p.teamName,
    p.league,
    p.age !== null ? `${p.age}y` : null,
    p.preferredPositions.length > 1 ? p.preferredPositions.join(' / ') : null,
    p.foot ? `${p.foot} foot` : null,
    p.height !== null ? `${p.height}cm` : null,
    p.contractMonths !== null ? `${fmtTerm(p.contractMonths)} left` : null,
  ].filter(Boolean)) {
    facts.appendChild(el('span', null, bit));
  }
  const sm = starBadge('SM', p.skillMoves === null ? null : p.skillMoves + 1);
  const wf = starBadge('WF', p.weakFoot);
  if (sm) facts.appendChild(sm);
  if (wf) facts.appendChild(wf);
  card.appendChild(facts);

  card.appendChild(
    tileRow([
      ['Fair value ~', p.ea ? moneyShort(p.ea.value) : null, p.ea ? `Walk away below ${moneyShort(p.ea.floor)}; a motivated buyer can be pushed to ${moneyShort(p.ea.ceiling)}.` : undefined],
      ['Walk away', p.ea ? moneyShort(p.ea.floor) : null],
      ['Push to', p.ea ? moneyShort(p.ea.ceiling) : null],
      ['Wage', money(p.wage)],
      ...(extra ?? []),
    ]),
  );

  if (p.standout.length) {
    const line = el('div', 'chipwrap');
    for (const st of p.standout) {
      const chip = el('span', 'so', `${prettyAttr(st.attr)} ${st.value}`);
      chip.dataset.tip = `${st.percentile}th percentile among ${p.positionShort ?? 'peers'} in this world`;
      line.appendChild(chip);
    }
    card.appendChild(cardSection('ELITE FOR HIS POSITION', line));
  }

  if (p.playStyles.length) {
    const styles = el('div', 'chipwrap');
    for (const st of p.playStyles) {
      const node = el('span', st.plus ? 'style plus' : 'style', st.name + (st.plus ? '+' : ''));
      node.dataset.tip = `${st.category} PlayStyle`;
      styles.appendChild(node);
    }
    card.appendChild(cardSection('PLAYSTYLES', styles));
  }

  const wrap = el('div', 'attrsheet');
  for (const group of p.groups) {
    const col = el('div', 'asheet-group');
    const gh = el('div', 'asheet-head');
    gh.appendChild(el('span', 'gname', group.name));
    const mean = el('span', 'gval-wrap');
    mean.appendChild(el('b', `gval ${tier(group.mean)}`, group.mean ?? '—'));
    gh.appendChild(mean);
    col.appendChild(gh);
    for (const a of group.attributes) {
      const row = el('div', 'asheet-row');
      row.appendChild(el('span', 'an', prettyAttr(a.name)));
      const track = el('div', 'btrack');
      const fill = el('div', `bfill ${tier(a.value)}`);
      fill.style.width = `${Math.max(3, Math.round(((a.value ?? 0) / 99) * 100))}%`;
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', `av ${tier(a.value)}`, a.value ?? '—'));
      col.appendChild(row);
    }
    wrap.appendChild(col);
  }
  card.appendChild(cardSection('THE SHEET', wrap));
  return card;
}

/** Money with its unit under it, so a column of figures reads at a glance. */
function moneyCell(n, unit) {
  const box = el('span', 'mcell');
  if (n === null || n === undefined) {
    box.append('—');
    return box;
  }
  box.appendChild(el('b', null, moneyShort(n)));
  if (unit) box.appendChild(el('i', null, `/${unit}`));
  return box;
}

/** A contract as a term plus a runway, so "running down" is visible. */
function contractCell(months) {
  const box = el('span', 'ccell');
  if (months === null || months === undefined) {
    box.append('—');
    return box;
  }
  box.appendChild(el('b', null, fmtTerm(months)));
  const track = el('div', 'btrack');
  const fill = el('div', `bfill ${months <= 6 ? 't1' : months <= 18 ? 't2' : 't3'}`);
  fill.style.width = `${Math.max(4, Math.min(100, Math.round((months / 60) * 100)))}%`;
  track.appendChild(fill);
  box.appendChild(track);
  box.dataset.tip = months <= 6 ? 'Inside six months — he can talk to anyone soon.' : 'Bar is scaled against a five-year deal.';
  return box;
}

/** Floor, fair value and ceiling as one figure with its range beneath. */
function valuationCell(ea) {
  const box = el('span', 'vcell');
  if (!ea) {
    box.append('—');
    return box;
  }
  box.appendChild(el('b', 'vval', moneyShort(ea.value)));
  const range = el('span', 'vrange');
  range.appendChild(el('i', 'vlo', moneyShort(ea.floor)));
  range.appendChild(el('span', 'vsep', '–'));
  range.appendChild(el('i', 'vhi', moneyShort(ea.ceiling)));
  box.appendChild(range);
  box.dataset.tip = `Walk away below ${moneyShort(ea.floor)}; open near ${moneyShort(ea.value)}; a motivated buyer can be pushed to ${moneyShort(ea.ceiling)}.`;
  return box;
}

/** The case for a signing, as badges rather than a semicolon-jammed sentence. */
function reasonTags(x) {
  const box = el('span', 'reasons');
  for (const t of x.reasonTags ?? []) {
    const chip = el('span', `rtag rt-${t.kind}`, t.text);
    chip.dataset.tip = t.detail;
    box.appendChild(chip);
  }
  if (!box.childElementCount && x.reasons?.length) box.append(x.reasons.join(' · '));
  return box;
}

/** Look up a scouted profile by id, or null when the scan has not seen him. */
const profileOf = (doc, id) => (doc.scoutProfiles ?? []).find((x) => x.playerId === id) ?? null;

/** Shared: open a scout card above a table, or say why it cannot. */
function scoutDetail(doc, id, onClose, extra) {
  const prof = profileOf(doc, id);
  if (prof) return scoutCard(prof, onClose, extra);
  const box = el('div', 'panel');
  box.appendChild(
    el('p', 'muted tiny', 'No profile this snapshot — he is outside the current scan, so his sheet is not in the document. The frozen numbers below still hold.'),
  );
  return box;
}

/**
 * Synergy, as connections rather than a spreadsheet.
 *
 * A "pattern" is a way two players help each other — a runner and a passer, a
 * crosser and a header of the ball. Each link is scored √(supplier × receiver)
 * over the attributes that pattern actually needs. What matters on screen is
 * WHO connects to WHOM, HOW STRONGLY, and WHAT TO DO — so that is what the
 * page shows, in that order.
 */
/**
 * The depth chart: every position, first choice down to nothing, with the age
 * behind each name. It answers the two questions a squad list buries — where
 * would one injury hurt, and where is the succession already in the building.
 */
function renderDepth(doc) {
  const panel = el('div', 'panel');
  panel.appendChild(el('h2', null, '🪜 Depth chart'));
  panel.appendChild(
    el('p', 'muted tiny', 'Sorted by our fit in that position, not by the game\u2019s overall — a converted fullback ranks where he would actually play. One name deep is one injury from a problem.'),
  );

  const ORDER = ['GK', 'RB', 'CB', 'LB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST'];
  const bySlot = new Map();
  for (const p of doc.senior) {
    const slot = p.positionShort ?? p.bestSlot;
    if (!slot) continue;
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), p]);
  }
  const grid = el('div', 'depthgrid');
  const slots = [...new Set([...ORDER.filter((x) => bySlot.has(x)), ...bySlot.keys()])];
  for (const slot of slots) {
    const men = (bySlot.get(slot) ?? []).sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));
    const col = el('div', `depthcol${men.length <= 1 ? ' thin' : ''}`);
    const head = el('div', 'depthhead');
    head.appendChild(el('span', 'pos-pill', slot));
    head.appendChild(el('span', 'depthn', `${men.length} deep`));
    col.appendChild(head);
    men.slice(0, 4).forEach((p, i) => {
      const row = el('div', `depthman${i === 0 ? ' first' : ''}`);
      row.appendChild(el('i', 'depthrank', String(i + 1)));
      const nm = el('span', 'depthname', p.name.split(' ').pop());
      row.appendChild(nm);
      row.appendChild(el('span', `depthovr ${tier(p.overall)}`, String(p.overall ?? '—')));
      row.appendChild(el('span', 'depthage', p.age !== null ? `${p.age}` : ''));
      row.dataset.tip = `${p.name} · ${p.overall}${p.potential && p.potential !== p.overall ? ` → ${p.potential}` : ''} · ${p.age}y${p.injured ? ' · injured' : ''}`;
      col.appendChild(row);
    });
    if (!men.length) col.appendChild(el('p', 'muted tiny', 'nobody'));
    if (men.length === 1) col.appendChild(el('p', 'depthwarn', 'one injury from a hole'));
    grid.appendChild(col);
  }
  panel.appendChild(grid);
  return panel;
}

function renderSynergy(doc) {
  const frag = document.createDocumentFragment();
  const byId = new Map([...doc.senior, ...doc.academy].map((p) => [p.playerId, p]));
  const nameOf = (id) => byId.get(id)?.name ?? `#${id}`;
  const shortName = (id) => (byId.get(id)?.name ?? `#${id}`).split(' ').pop();
  const posOf = (id) => byId.get(id)?.positionShort ?? '';
  const syn = doc.synergy;

  // --- what it is, and how connected the XI actually is
  {
    const hero = el('div', 'panel');
    hero.appendChild(el('h2', null, '🕸 Synergy'));
    hero.appendChild(
      el('p', 'muted', 'Two players “connect” when one supplies what the other uses — a fullback who overlaps into a winger who drifts inside, a passer into a runner. Every pair in your squad is scored on every pattern; the strongest links are the ones worth building the XI around.'),
    );
    hero.appendChild(
      tileRow([
        ['XI connection', syn.xi?.teamScore ?? '—', 'Mean strength of the links inside your current shape.', (syn.xi?.teamScore ?? 0) >= 70 ? 'good' : ''],
        ['Live links', syn.xi?.links?.length ?? 0, 'Adjacent pairs in the shape that clear the threshold.'],
        ['Cold pairs', syn.xi?.coldPairs?.length ?? 0, 'Adjacent in the shape with nothing between them.', (syn.xi?.coldPairs?.length ?? 0) > 2 ? 'warn' : ''],
        ['Squad patterns', syn.partnerships.length, 'Every scored pair in the squad, XI or not.'],
      ]),
    );
    frag.appendChild(hero);
  }

  // --- the connections themselves, as cards
  const linkCard = (l, tagline) => {
    const box = el('div', 'linkcard');
    const head = el('div', 'lchead');
    head.appendChild(el('span', 'lchannel', l.channel));
    const strength = el('span', `lcstrength ${tier(l.strength)}`, String(l.strength));
    head.appendChild(strength);
    box.appendChild(head);

    const pair = el('div', 'lcpair');
    const a = el('div', 'lcplayer');
    a.appendChild(el('b', null, shortName(l.supplier)));
    a.appendChild(el('span', 'lcpos', posOf(l.supplier)));
    a.appendChild(el('span', 'lcscore', `supplies ${l.supplierScore}`));
    const arrow = el('div', 'lcarrow', '→');
    const b = el('div', 'lcplayer');
    b.appendChild(el('b', null, shortName(l.receiver)));
    b.appendChild(el('span', 'lcpos', posOf(l.receiver)));
    b.appendChild(el('span', 'lcscore', `receives ${l.receiverScore}`));
    pair.appendChild(a);
    pair.appendChild(arrow);
    pair.appendChild(b);
    box.appendChild(pair);

    const track = el('div', 'btrack');
    const fill = el('div', `bfill ${tier(l.strength)}`);
    fill.style.width = `${Math.max(4, Math.min(100, l.strength))}%`;
    track.appendChild(fill);
    box.appendChild(track);

    box.appendChild(el('p', 'lcwhy', l.why));
    if (l.amplifiedBy?.length) {
      const amp = el('div', 'chipwrap');
      for (const x of l.amplifiedBy) amp.appendChild(el('span', 'style plus', x));
      box.appendChild(amp);
    }
    if (tagline) box.appendChild(el('p', 'muted tiny', tagline));
    box.dataset.tip = `${nameOf(l.supplier)} supplies ${l.supplierScore}, ${nameOf(l.receiver)} receives ${l.receiverScore} — strength is √(supplier × receiver)${l.amplifiedBy?.length ? `, lifted by ${l.amplifiedBy.join(', ')}` : ''}.`;
    return box;
  };

  {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, '⚡ Your strongest connections'));
    const grid = el('div', 'linkgrid');
    const xiPair = new Set(
      (syn.xi?.links ?? []).map((l) => `${Math.min(l.supplier, l.receiver)}-${Math.max(l.supplier, l.receiver)}`),
    );
    for (const l of syn.partnerships.slice(0, 6)) {
      const inXI = xiPair.has(`${Math.min(l.supplier, l.receiver)}-${Math.max(l.supplier, l.receiver)}`);
      grid.appendChild(linkCard(l, inXI ? 'Already side by side in your shape.' : 'Not adjacent in the current shape — moving them together is free strength.'));
    }
    panel.appendChild(grid);
    frag.appendChild(panel);
  }

  // --- the three biggest levers
  {
    const act = el('div', 'panel');
    act.appendChild(el('h2', null, '🔧 What to do about it'));
    const moves = [];
    const xiPair = new Set(
      (syn.xi?.links ?? []).map((l) => `${Math.min(l.supplier, l.receiver)}-${Math.max(l.supplier, l.receiver)}`),
    );
    for (const l of syn.partnerships
      .filter((l2) => !xiPair.has(`${Math.min(l2.supplier, l2.receiver)}-${Math.max(l2.supplier, l2.receiver)}`))
      .slice(0, 3)) {
      moves.push([
        'Field them together',
        `${nameOf(l.supplier)} + ${nameOf(l.receiver)}`,
        `Their ${l.channel.toLowerCase()} link scores ${l.strength}, and the current shape keeps them apart.`,
      ]);
    }
    for (const t of [...(doc.transfers?.targets ?? [])]
      .filter((t2) => t2.synergy?.[0])
      .sort((a, b) => (b.synergy[0]?.strength ?? 0) - (a.synergy[0]?.strength ?? 0))
      .slice(0, 2)) {
      moves.push([
        'Sign him',
        `${t.name} (${t.posShort ?? t.slot})`,
        `His ${t.synergy[0].channel.toLowerCase()} link with this squad scores ${t.synergy[0].strength} — the best on the shopping list.`,
      ]);
    }
    if (syn.xi?.coldPairs?.length) {
      const c = syn.xi.coldPairs[0];
      moves.push([
        'Cold spot',
        `${nameOf(c.a)} ↔ ${nameOf(c.b)}`,
        'Side by side in the shape with no pattern between them — swap one, or route play down the other side.',
      ]);
    }
    if (moves.length) {
      for (const [label, who, why] of moves) {
        const row = el('div', 'todo');
        row.appendChild(el('b', null, label));
        row.appendChild(el('span', 'who', who));
        row.appendChild(el('span', 'why', why));
        act.appendChild(row);
      }
      act.appendChild(el('p', 'muted tiny', 'The same arithmetic as the cards above — these are the biggest levers it found, not a plan it invented.'));
    } else {
      act.appendChild(el('p', 'muted tiny', 'Your shape already fields the strongest links it can.'));
    }
    frag.appendChild(act);
  }

  // --- the rest, folded away
  {
    const more = el('div', 'panel');
    more.appendChild(el('h2', null, '📚 Every pattern in the squad'));
    more.appendChild(
      el('p', 'muted tiny', `${syn.partnerships.length} scored pairs, strongest first. Percentiles come from the ${syn.worldPlayers.toLocaleString('en-GB')} players in this world.`),
    );
    more.appendChild(
      table(
        ['Pattern', 'Supplies', 'Receives', { label: 'Strength', num: true }, 'What it means'],
        syn.partnerships.slice(0, 20).map((l) => [
          l.channel,
          `${shortName(l.supplier)} ${l.supplierScore}`,
          `${shortName(l.receiver)} ${l.receiverScore}`,
          { text: l.strength, num: true, tier: l.strength },
          { text: l.why, cls: 'wrap' },
        ]),
        { tight: true },
      ),
    );
    if (syn.catalogue?.length) {
      const cat = el('div', 'chipwrap');
      for (const c of syn.catalogue) {
        const chip = el('span', 'chipish', c.name);
        chip.dataset.tip = c.why;
        cat.appendChild(chip);
      }
      more.appendChild(cardSection('THE PATTERNS COMPANION LOOKS FOR', cat));
    }
    frag.appendChild(more);
  }
  return frag;
}

function renderTransfers(doc) {
  const frag = document.createDocumentFragment();
  const quests0 = questStrip(doc, 'transfers/targets');
  if (quests0) frag.appendChild(quests0);
  const t = doc.transfers;

  const short = t.gaps.filter((g) => g.severity !== 'none');
  if (short.length) {
    const gaps = el('div', 'panel');
    gaps.appendChild(el('h2', null, '🕳 Where the squad is short'));
    const grid = el('div', 'gapgrid');
    for (const g of short) {
      const box = el('div', `gapcard ${g.severity}`);
      box.appendChild(el('span', 'pos-pill', g.slot));
      box.appendChild(el('b', 'gapname', slotLabel(g.slot)));
      const nums = el('div', 'gapnums');
      const add = (lbl, v) => {
        const c = el('span', 'gapnum');
        c.appendChild(el('i', null, lbl));
        c.appendChild(el('b', null, String(v)));
        nums.appendChild(c);
      };
      add('Cover', g.cover);
      add('Best', g.bestFit ?? '—');
      box.appendChild(nums);
      box.appendChild(el('p', 'gapnote', g.note));
      grid.appendChild(box);
    }
    gaps.appendChild(grid);
    frag.appendChild(gaps);
  }

  // Shopping lists: pick the kind of signing that suits how you play.
  const MODES = [
    { id: 'all', label: 'All' },
    { id: 'superstar', label: 'Superstars' },
    { id: 'rising', label: 'In the making' },
    { id: 'wonderkid', label: 'Wonderkids' },
    { id: 'underdog', label: 'Underdogs' },
  ];
  const modeBar = el('div', 'filters inpanel');
  for (const m of MODES) {
    const n = m.id === 'all' ? t.targets.length : t.targets.filter((x) => x.archetypes.includes(m.id)).length;
    const chip = el('button', `chip${(state.transferMode ?? 'all') === m.id ? ' on' : ''}`);
    chip.append(m.label);
    chip.appendChild(el('span', 'n', n));
    activatable(
      chip,
      () => {
        state.transferMode = m.id;
        render();
      },
      { skipWhen: () => (state.transferMode ?? 'all') === m.id },
    );
    modeBar.appendChild(chip);
  }

  let list = [...t.targets];
  if (state.transferMode && state.transferMode !== 'all') {
    list = list.filter((x) => x.archetypes.includes(state.transferMode));
  }

  // Default order is upgrade; every column header sorts the table itself.
  list.sort((a, b) => b.upgrade - a.upgrade);

  // A selected target opens his real card — attributes, PlayStyles, price.
  if (state.targetSel && !list.some((x) => x.playerId === state.targetSel)) state.targetSel = null;
  if (state.targetSel) {
    const sel = list.find((x) => x.playerId === state.targetSel);
    frag.appendChild(
      scoutDetail(doc, state.targetSel, () => { state.targetSel = null; render(); }, [
        ['Fit here', sel?.fit ?? null, 'Our rating for him in the slot he would fill.'],
        ['Upgrade', sel && sel.upgrade > 0 ? `+${Math.round(sel.upgrade * 10) / 10}` : null, 'How much better his fit is than your best in that slot.'],
        ['Synergy', sel?.synergy?.[0]?.strength ?? null, sel?.synergy?.[0]?.channel],
      ]),
    );
  }

  const targets = el('div', 'panel');
  targets.appendChild(el('h2', null, `🎯 ${list.length} targets from ${t.scanned.toLocaleString('en-GB')} scanned`));
  targets.appendChild(modeBar);
  targets.appendChild(
    el(
      'p',
      'muted tiny',
      'EA value ~ is the game\u2019s own idea of a fair fee, rebuilt from community-derived curves (ovr × age × ceiling × position). ' +
        (doc.deals.modelled
          ? `Hover it for what this world has actually paid (${doc.deals.sample} observed deals).`
          : 'What this world actually pays appears alongside once the window produces priced deals.'),
    ),
  );
  targets.appendChild(
    table(
      ['', 'Player', 'Club', { label: 'Pos', pos: true }, { label: 'OVR', num: true }, { label: 'POT', num: true }, { label: 'Fit', num: true }, { label: 'Synergy', num: true }, { label: 'Age', num: true }, { label: 'EA value ~', num: true }, 'Why'],
      list.slice(0, 40).map((x) => [
        { text: '', star: { on: shortlisted(x.playerId), onToggle: () => toggleShortlist(x, doc.gameDate) } },
        { text: x.name, title: x.teamName ? `currently at ${x.teamName}` : undefined },
        x.teamName ?? '—',
        { text: x.posShort ?? x.slot, cls: 'posbadge' },
        { text: x.overall, num: true, tier: x.overall },
        { text: x.potential ?? '—', num: true, tier: x.potential },
        { text: x.fit, num: true, tier: x.fit },
        {
          text: x.synergy[0] ? x.synergy[0].strength : '—',
          num: true,
          tier: x.synergy[0]?.strength,
          title: x.synergy[0]
            ? `${x.synergy[0].channel}${x.synergyGain !== null && x.synergyGain > 0 ? ` — ${x.synergyGain} stronger than your best of that pattern` : ''}`
            : undefined,
        },
        { text: x.age ?? '—', num: true },
        {
          text: x.ea ? moneyShort(x.ea.value) : '—',
          num: true,
          title: [
            x.ea ? `EA-style: floor ${moneyShort(x.ea.floor)} · ceiling ${moneyShort(x.ea.ceiling)}` : null,
            x.feeGuide ? `This world has paid ${moneyShort(x.feeGuide.low)}–${moneyShort(x.feeGuide.high)} for this profile (${x.feeGuide.sample} deals)` : null,
          ].filter(Boolean).join('\n') || undefined,
        },
        { node: reasonTags(x), text: x.reasons.join('; '), sort: x.reasons.length },
      ]),
      {
        keys: list.slice(0, 40).map((x) => x.playerId),
        onRow: (key) => {
          state.targetSel = Number(key);
          render();
        },
      },
    ),
  );
  targets.appendChild(el('p', 'muted tiny', 'Tap a row for his full sheet: attributes, PlayStyles, and what he is elite at for the position.'));
  frag.appendChild(targets);

  if (doc.deals.observed.length) {
    const deals = el('div', 'panel');
    deals.appendChild(el('h2', null, `Deals this world has done — ${doc.deals.observed.length}`));
    deals.appendChild(
      table(
        ['Player', 'To', { label: 'Fee', num: true }, { label: 'OVR', num: true }, { label: 'Age', num: true }, 'Completes'],
        doc.deals.observed.slice(0, 12).map((d) => [
          d.name,
          d.toTeamName ?? '—',
          { text: moneyShort(d.fee), num: true },
          { text: d.overall ?? '—', num: true, tier: d.overall },
          { text: d.age ?? '—', num: true },
          d.completes ?? '—',
        ]),
      ),
    );
    frag.appendChild(deals);
  }

  return frag;
}

/**
 * Wages, as a board rather than a spreadsheet.
 *
 * The bill and its shape first, then one card per player: what he earns, how
 * long is left, whether that is fair against his role band, and the deal to
 * put on the table. Tapping a card opens his money page — both packages, the
 * valuation, the clause call.
 */
function renderWages(doc) {
  const frag = document.createDocumentFragment();
  const quests0 = questStrip(doc, 'squad/wages');
  if (quests0) frag.appendChild(quests0);
  const w = doc.wages;
  const renewalOf = new Map(w.renewals.map((r) => [r.playerId, r]));
  const assessOf = new Map(w.assessmentList.map((a) => [a.playerId, a]));
  const everyone = [...doc.senior, ...doc.academy.filter((p) => renewalOf.has(p.playerId))].sort(
    (a, b) => posRank(a.positionShort ?? '') - posRank(b.positionShort ?? '') || (b.overall ?? 0) - (a.overall ?? 0),
  );
  const dueNow = everyone.filter((p) => (renewalOf.get(p.playerId)?.urgency ?? 'later') === 'now');
  const dueSoon = everyone.filter((p) => (renewalOf.get(p.playerId)?.urgency ?? 'later') === 'soon');
  const overpaid = everyone.filter((p) => assessOf.get(p.playerId)?.verdict === 'over');
  const underpaid = everyone.filter((p) => assessOf.get(p.playerId)?.verdict === 'under');
  const top = [...everyone].sort((a, b) => (b.wage ?? 0) - (a.wage ?? 0))[0];

  // --- the bill, and its shape
  {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, '💷 The wage bill'));
    panel.appendChild(
      tileRow([
        ['Weekly bill', money(w.totalBill)],
        ['Squad', w.squadSize],
        ['Median wage', money(w.median)],
        ['Top earner', top ? `${top.name.split(' ').pop()} ${moneyShort(top.wage)}` : null],
        ['Due now', dueNow.length || null, 'Contracts inside six months.', dueNow.length ? 'warn' : ''],
        ['Overpaid', overpaid.length || null, 'Paid well above their role band.', overpaid.length ? 'warn' : ''],
        ['Underpaid', underpaid.length || null, 'Paid well below their role band — cheap to lock down now.'],
      ]),
    );
    if (w.bands.length) {
      const bars = el('div', 'gbars');
      const max = Math.max(...w.bands.map((b) => b.high));
      for (const b of w.bands) {
        const row = el('div', 'gbar');
        row.appendChild(el('span', 'gbname', `${b.role} ×${b.count}`));
        // Low → median → high as a real range, not one number pretending.
        const track = el('div', 'btrack rangebar');
        const span2 = el('div', 'rspan');
        span2.style.left = `${(b.low / max) * 100}%`;
        span2.style.width = `${Math.max(2, ((b.high - b.low) / max) * 100)}%`;
        const mid = el('i', 'rmid');
        mid.style.left = `${(b.median / max) * 100}%`;
        track.appendChild(span2);
        track.appendChild(mid);
        row.appendChild(track);
        const v = el('span', 'gbval');
        v.appendChild(el('b', null, moneyShort(b.median)));
        row.appendChild(v);
        row.dataset.tip = `${b.role}: ${money(b.low)} – ${money(b.high)}, median ${money(b.median)} across ${b.count} players.`;
        bars.appendChild(row);
      }
      panel.appendChild(cardSection('WHAT EACH ROLE BAND PAYS — LOW · MEDIAN · HIGH', bars));
    }
    frag.appendChild(panel);
  }

  // --- the selected player's money page
  if (state.wageSel && !everyone.some((p) => p.playerId === state.wageSel)) state.wageSel = null;
  if (state.wageSel) {
    const p2 = everyone.find((x) => x.playerId === state.wageSel);
    if (p2) frag.appendChild(playerCard(p2, () => { state.wageSel = null; render(); }, 'financial'));
  }

  // --- the board
  {
    const panel = el('div', 'panel');
    const modes = el('div', 'chiprow');
    const FILTERS2 = [
      [`Whole squad ${everyone.length}`, 'all'],
      [`Due now ${dueNow.length}`, 'now'],
      [`Due soon ${dueSoon.length}`, 'soon'],
      [`Overpaid ${overpaid.length}`, 'over'],
      [`Underpaid ${underpaid.length}`, 'under'],
    ];
    for (const [label, mode] of FILTERS2) {
      const chip = el('button', `chip${(state.wageFilter ?? 'all') === mode ? ' on' : ''}`, label);
      activatable(chip, () => { state.wageFilter = mode; render(); }, { skipWhen: () => (state.wageFilter ?? 'all') === mode });
      modes.appendChild(chip);
    }
    const mode = state.wageFilter ?? 'all';
    const listed =
      mode === 'now' ? dueNow : mode === 'soon' ? dueSoon : mode === 'over' ? overpaid : mode === 'under' ? underpaid : everyone;
    panel.appendChild(el('h2', null, `📋 Contracts — ${listed.length} of ${everyone.length}`));
    panel.appendChild(modes);
    panel.appendChild(
      el('p', 'muted tiny', 'Every player with a recorded wage has an offer. Renew when you like — the term shown is the longest the game will take at that age, and the wage is anchored to his own role band. Tap a card for both packages and the clause call.'),
    );

    const grid = el('div', 'wagegrid');
    const URG = { now: ['Now', 'urgent'], soon: ['Soon', 'action'], later: ['No rush', 'watch'] };
    for (const p2 of listed) {
      const r = renewalOf.get(p2.playerId);
      const a = assessOf.get(p2.playerId);
      const cardEl = el('div', `wagecard${state.wageSel === p2.playerId ? ' sel' : ''}`);

      const top2 = el('div', 'wtop');
      top2.appendChild(el('span', 'pos-pill', p2.positionShort ?? '—'));
      top2.appendChild(el('b', 'wname', p2.name));
      if (r) {
        const [lbl, cls] = URG[r.urgency];
        top2.appendChild(el('span', `act ${cls}`, lbl));
      }
      cardEl.appendChild(top2);

      const nums = el('div', 'wnums');
      const num2 = (lbl, v, cls) => {
        const c = el('span', `wnum${cls ? ` ${cls}` : ''}`);
        c.appendChild(el('i', null, lbl));
        c.appendChild(el('b', null, v));
        nums.appendChild(c);
      };
      num2('Now', money(p2.wage) ?? '—');
      if (r) num2('Offer', `${money(r.options[0].weeklyWage)}`, 'accent');
      num2('Term', p2.contractMonths === null ? '—' : fmtTerm(p2.contractMonths));
      if (r) num2('Up to', `${r.maxYears}y`);
      cardEl.appendChild(nums);

      // Contract runway: how much of a five-year horizon is left.
      const months = p2.contractMonths ?? 0;
      const track = el('div', 'btrack');
      const fill = el('div', `bfill ${months <= 6 ? 't1' : months <= 18 ? 't2' : 't3'}`);
      fill.style.width = `${Math.max(3, Math.min(100, Math.round((months / 60) * 100)))}%`;
      track.appendChild(fill);
      cardEl.appendChild(track);

      if (a) {
        const v = el('span', `wverdict v-${a.verdict}`);
        v.textContent = a.verdict === 'in-line' ? 'in line with his band' : a.verdict === 'unknown' ? 'band too thin to compare' : `paid ${a.verdict} the band`;
        v.dataset.tip = a.note;
        cardEl.appendChild(v);
      }

      activatable(cardEl, () => {
        state.wageSel = state.wageSel === p2.playerId ? null : p2.playerId;
        render();
      });
      grid.appendChild(cardEl);
    }
    panel.appendChild(grid);
    frag.appendChild(panel);
  }
  return frag;
}

function renderLoans(doc) {
  const frag = document.createDocumentFragment();
  const byId = new Map([...doc.senior, ...doc.academy].map((p) => [p.playerId, p]));
  const nameOf = (id) => byId.get(id)?.name ?? `#${id}`;
  const L = doc.loans;

  if (L.out.length) {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, `Out on loan — ${L.out.length}`));
    const fmtDelta = (d) => (d === null || d === undefined ? '—' : d > 0 ? `+${d}` : String(d));
    panel.appendChild(
      table(
        ['Player', 'At', { label: 'OVR', num: true }, { label: 'Δ OVR', num: true }, { label: 'POT', num: true }, { label: 'Δ ceiling', num: true }, { label: 'Age', num: true }, 'Ends', 'Buy option'],
        L.out.map((r) => [
          r.name,
          r.atTeamName ?? '—',
          { text: r.overall ?? '—', num: true, tier: r.overall },
          { text: fmtDelta(r.overallDelta), num: true },
          { text: r.potential ?? '—', num: true, tier: r.potential },
          { text: fmtDelta(r.ceilingDelta), num: true },
          { text: r.age ?? '—', num: true },
          r.ends ?? '—',
          r.buyOption ? 'Yes' : '—',
        ]),
      ),
    );
    panel.appendChild(
      el(
        'p',
        'muted tiny',
        'The save keeps no record of matches at the loan club — no minutes, no goals, verified. The Δ columns are rating and ceiling movement since July, from our own snapshots: a flat Δ OVR deep into a development loan is the wasted-loan signal.',
      ),
    );
    frag.appendChild(panel);
  }

  if (L.inbound.length) {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, `On loan with us — ${L.inbound.length}`));
    panel.appendChild(
      table(
        ['Player', 'Parent club', { label: 'OVR', num: true }, 'Ends', 'Buy option'],
        L.inbound.map((r) => [
          r.name,
          r.atTeamName ?? '—',
          { text: r.overall ?? '—', num: true, tier: r.overall },
          r.ends ?? '—',
          r.buyOption ? 'Yes' : '—',
        ]),
      ),
    );
    frag.appendChild(panel);
  }

  if (L.candidates.length) {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, `🚏 Should go out — ${L.candidates.length}`));
    panel.appendChild(
      el('p', 'muted tiny', 'Players the rules say need football elsewhere, each with the clubs where their level makes them a starter. When a real approach arrives, score it below rather than guessing from this list.'),
    );
    const grid = el('div', 'loangrid');
    for (const c of L.candidates) {
      const p2 = byId.get(c.playerId);
      const box = el('div', 'loancard');
      const top = el('div', 'loantop');
      if (p2) top.appendChild(el('span', 'pos-pill', p2.positionShort ?? '—'));
      top.appendChild(el('b', 'loanname', nameOf(c.playerId)));
      if (p2) top.appendChild(el('span', 'loanage', p2.age !== null ? `${p2.age}y` : ''));
      box.appendChild(top);

      if (p2) {
        const nums = el('div', 'loannums');
        const add = (lbl, v, cls) => {
          const cell = el('span', `loannum${cls ? ` ${cls}` : ''}`);
          cell.appendChild(el('i', null, lbl));
          cell.appendChild(el('b', null, String(v)));
          nums.appendChild(cell);
        };
        add('Now', p2.overall ?? '—');
        add('Ceiling', p2.potential ?? '—', 'accent');
        add('Minutes', `${p2.minutesThisSeason ?? 0}'`, (p2.minutesThisSeason ?? 0) < 300 ? 'warn' : '');
        box.appendChild(nums);
      }

      box.appendChild(el('p', 'loanwhy', c.reason));
      if (c.destinations.length) {
        const chips = el('div', 'chipwrap');
        for (const d of c.destinations.slice(0, 4)) {
          const chip = el('span', 'destchip');
          chip.appendChild(el('b', null, d.teamName));
          chip.appendChild(el('i', null, String(d.clubOverall)));
          chip.dataset.tip = `${d.leagueName ?? 'Unknown league'} · club rated ${d.clubOverall} — ${d.read}`;
          chips.appendChild(chip);
        }
        box.appendChild(cardSection('WHERE HE WOULD START', chips));
      } else {
        box.appendChild(el('p', 'muted tiny', 'No club in range — the answer may simply be minutes here.'));
      }
      for (const g of c.dealGuide ?? []) box.appendChild(el('p', 'muted tiny', `· ${g}`));
      grid.appendChild(box);
    }
    panel.appendChild(grid);
    frag.appendChild(panel);
  }

  // --- score a real approach: the club that just called, judged on the spot
  {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, '📞 Score a loan approach'));
    panel.appendChild(
      el(
        'p',
        'muted',
        'A club is asking for your player: pick the player and the club, and the offer is scored from the save — would he start there, does the level stretch him, is the league worth his minutes. No what-ifs, just the measurements.',
      ),
    );

    const pool = [...doc.senior, ...doc.academy]
      .filter((p2) => (p2.age ?? 99) <= 23 && (p2.headroom ?? 0) >= 2 && !p2.onLoan)
      .sort((a, b) => (b.headroom ?? 0) - (a.headroom ?? 0))
      .slice(0, 14);
    if (!pool.length) {
      panel.appendChild(el('p', 'muted tiny', 'Nobody in the squad fits the loan-out profile right now.'));
      frag.appendChild(panel);
      return frag;
    }
    if (!state.loanPlayer || !pool.some((p2) => p2.playerId === state.loanPlayer)) state.loanPlayer = pool[0].playerId;
    const pchips = el('div', 'chiprow');
    for (const p2 of pool) {
      const chip = el('button', `chip${state.loanPlayer === p2.playerId ? ' on' : ''}`, `${p2.name} ${p2.overall}`);
      activatable(chip, () => { state.loanPlayer = p2.playerId; render(); }, { skipWhen: () => state.loanPlayer === p2.playerId });
      pchips.appendChild(chip);
    }
    panel.appendChild(pchips);

    // Nation → league → club, same ladder as the opponent scout.
    const opps = doc.opponents ?? [];
    const nations = [...new Set(opps.map((o) => o.nation))].sort();
    if (!state.loanNation || !nations.includes(state.loanNation)) state.loanNation = nations[0] ?? null;
    const nchips = el('div', 'chiprow');
    for (const n2 of nations) {
      const chip = el('button', `chip${state.loanNation === n2 ? ' on' : ''}`, `${flagFor(n2)}${n2}`);
      activatable(chip, () => { state.loanNation = n2; state.loanLeague = null; state.loanClub = null; render(); }, { skipWhen: () => state.loanNation === n2 });
      nchips.appendChild(chip);
    }
    panel.appendChild(nchips);
    const leagues = [...new Set(opps.filter((o) => o.nation === state.loanNation).map((o) => o.league))].sort();
    if (!state.loanLeague || !leagues.includes(state.loanLeague)) state.loanLeague = leagues[0] ?? null;
    if (leagues.length > 1) {
      const lchips = el('div', 'chiprow');
      for (const lg of leagues) {
        const chip = el('button', `chip${state.loanLeague === lg ? ' on' : ''}`, lg);
        activatable(chip, () => { state.loanLeague = lg; state.loanClub = null; render(); }, { skipWhen: () => state.loanLeague === lg });
        lchips.appendChild(chip);
      }
      panel.appendChild(lchips);
    }
    const clubs = opps.filter((o) => o.league === state.loanLeague && o.teamId !== doc.club?.id);
    if (!state.loanClub || !clubs.some((c) => c.teamId === state.loanClub)) state.loanClub = null;
    const cchips = el('div', 'chiprow');
    for (const o of clubs) {
      const chip = el('button', `chip teamchip${state.loanClub === o.teamId ? ' on' : ''}`);
      chip.appendChild(el('span', null, o.name));
      activatable(chip, () => { state.loanClub = o.teamId; render(); }, { skipWhen: () => state.loanClub === o.teamId });
      cchips.appendChild(chip);
    }
    panel.appendChild(cchips);

    const player = pool.find((p2) => p2.playerId === state.loanPlayer);
    const club = clubs.find((c) => c.teamId === state.loanClub);
    if (player && club) {
      const groupOf2 = (short) =>
        short === 'GK' ? 'gk' : ['CB', 'RB', 'LB', 'RWB', 'LWB'].includes(short) ? 'def' : ['CDM', 'CM', 'CAM', 'RM', 'LM'].includes(short) ? 'mid' : 'att';
      const line = club[groupOf2(player.positionShort ?? 'CM')] ?? club.overall;
      const reasons = [];
      let score = 0;
      const lineDiff = line !== null && player.overall !== null ? Math.round((player.overall - line) * 10) / 10 : null;
      if (lineDiff !== null) {
        if (lineDiff >= 2) { score += 4; reasons.push(`Walks into their ${groupOf2(player.positionShort ?? 'CM').toUpperCase()} line (${player.overall} v their ${line}) — minutes near-guaranteed.`); }
        else if (lineDiff >= 0) { score += 3; reasons.push(`At the level of their ${groupOf2(player.positionShort ?? 'CM').toUpperCase()} line (${player.overall} v ${line}) — should start most weeks.`); }
        else if (lineDiff >= -2) { score += 2; reasons.push(`Slightly under their line (${player.overall} v ${line}) — a fight for the shirt, which can be the point.`); }
        else { reasons.push(`Well under their ${groupOf2(player.positionShort ?? 'CM').toUpperCase()} line (${player.overall} v ${line}) — bench risk, which defeats a loan.`); }
      }
      const clubDiff = club.overall !== null && player.overall !== null ? Math.round((club.overall - player.overall) * 10) / 10 : null;
      if (clubDiff !== null) {
        if (clubDiff >= -4 && clubDiff <= 2) { score += 3; reasons.push(`The club (${club.overall}) sits right in the stretch zone for a ${player.overall}-rated player.`); }
        else if (clubDiff < -4) { score += 1; reasons.push(`The club (${club.overall}) is well below his level — easy minutes, little stretch.`); }
        else { score += 1; reasons.push(`The club (${club.overall}) is above his level — good football if he plays, but will he?`); }
      }
      const leagueClubs = opps.filter((o) => o.league === club.league);
      const leagueMean = leagueClubs.length
        ? Math.round((leagueClubs.reduce((a, o) => a + (o.overall ?? 0), 0) / leagueClubs.length) * 10) / 10
        : null;
      if (leagueMean !== null && player.overall !== null) {
        if (leagueMean >= player.overall - 5) { score += 2; reasons.push(`${club.league} averages ${leagueMean} — strong enough that the minutes count double.`); }
        else { score += 1; reasons.push(`${club.league} averages ${leagueMean} — a soft league for him; expect volume, not schooling.`); }
      }
      if ((player.age ?? 99) <= 21 && (player.headroom ?? 0) >= 4) { score += 1; reasons.push(`${player.age}y with ${player.headroom} of ceiling left — exactly who development loans exist for.`); }

      const verdict = score >= 8 ? 'Take it' : score >= 6 ? 'Take it, with terms' : score >= 4 ? 'Negotiate or decline' : 'Decline';
      const box = el('div', 'pkg');
      const head2 = el('div', 'pkg-head');
      head2.appendChild(el('b', null, `${player.name} → ${club.name}`));
      head2.appendChild(el('span', 'pkg-wage', `${score}/10 · ${verdict}`));
      box.appendChild(head2);
      for (const r2 of reasons) box.appendChild(el('p', 'muted tiny', `· ${r2}`));
      box.appendChild(el('p', 'pkg-trade', 'Terms worth demanding: no buy option on anyone with ceiling left; a recall clause if minutes dry up. The save records neither, so hold them in the negotiation itself.'));
      panel.appendChild(box);
    } else {
      panel.appendChild(el('p', 'muted tiny', 'Pick a club to score the approach.'));
    }
    frag.appendChild(panel);
  }

  if (!L.out.length && !L.inbound.length && !L.candidates.length) {
    frag.appendChild(el('p', 'empty', 'No loans in or out, and nobody the rules say should go.'));
  }
  return frag;
}

function renderScouting(doc) {
  const frag = document.createDocumentFragment();
  const quests0 = questStrip(doc, 'academy/players');
  if (quests0) frag.appendChild(quests0);

  if (doc.scouts.length) {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, '🔭 Scouts'));
    panel.appendChild(
      table(
        ['Scout', 'From', 'Judgement', 'Experience', 'Current mission', 'Returns', { label: 'Cost', num: true }, 'Next job'],
        doc.scouts.map((sc) => [
          sc.name,
          `${flagFor(sc.nationality)}${sc.nationality ?? '—'}`,
          { node: starsOf(sc.knowledge), text: sc.knowledge ?? '', sort: sc.knowledge ?? 0, cls: `stars m${Math.min(5, Math.max(1, sc.knowledge ?? 1))}` },
          { node: starsOf(sc.experience), text: sc.experience ?? '', sort: sc.experience ?? 0, cls: `stars m${Math.min(5, Math.max(1, sc.experience ?? 1))}` },
          sc.mission ? `${sc.mission.positions.join(' / ') || '?'} in ${flagFor(sc.mission.nation)}${sc.mission.nation ?? '?'}` : 'idle',
          sc.mission?.returns ?? '—',
          { text: sc.mission?.cost ?? '—', num: true },
          { text: sc.nextJob ?? 'Well placed.', title: sc.nextJob ?? undefined, cls: 'wrap' },
        ]),
      ),
    );
    panel.appendChild(
      (() => {
        const box = el('div', 'legendbox');
        const add = (b, rest) => {
          const line = el('span');
          line.appendChild(el('b', null, b + ' — '));
          line.append(rest);
          box.appendChild(line);
        };
        add('Judgement', 'how tight and how accurate the potential ranges come back.');
        add('Experience', 'how quickly reports arrive and how many players each trip covers.');
        add('Next job', 'a thin position in your squad, paired with the nation holding the deepest under-21 pool for it in this world. "Well placed" means no thin position is uncovered.');
        add('Cost', 'per-mission cost in the save’s own units.');
        return box;
      })(),
    );
    frag.appendChild(panel);
  } else {
    const p2 = el('div', 'panel');
    p2.appendChild(el('h2', null, '🔭 Scouts'));
    p2.appendChild(el('p', 'muted tiny', 'No scouts hired yet — hire them in game and their missions land here.'));
    frag.appendChild(p2);
  }

  {
    const notes = el('div', 'panel');
    const reports = doc.academyReports ?? [];
    notes.appendChild(el('h2', null, `Report prospects — ${reports.length}`));
    if (reports.length) {
      const byVerdict = (v) => reports.filter((r) => r.report.verdict === v);
      notes.appendChild(
        tileRow([
          ['Delivered', reports.length],
          ['Sign', byVerdict('sign').length || null, 'Ceiling worth a place in your academy.', byVerdict('sign').length ? 'good' : ''],
          ['Watch', byVerdict('watch').length || null],
          ['Pass', byVerdict('pass').length || null],
          ['Best ceiling', Math.max(0, ...reports.map((r) => r.potential ?? 0)) || null],
        ]),
      );
      notes.appendChild(
        el('p', 'muted', 'A scout has delivered these into your academy; signing them in game is what gives them a contract. Until then they sit here, and Companion tells them apart from your own prospects by exactly that.'),
      );
      notes.appendChild(
        table(
          [{ label: 'Pos', pos: true }, 'Prospect', 'From', { label: 'Age', num: true }, { label: 'OVR', num: true }, { label: 'POT', num: true }, 'Verdict', 'Why'],
          reports.map((r) => [
            { text: r.positionShort ?? '—', cls: 'posbadge' },
            { node: playerNameCell(r), text: r.name, sort: r.name },
            `${flagFor(r.nation)}${r.nation ?? '—'}`,
            { text: r.age ?? '—', num: true },
            { text: r.overall ?? '—', num: true, tier: r.overall },
            { text: r.potential ?? '—', num: true, tier: r.potential },
            {
              node: el('span', `verdictpill v-${r.report.verdict}`, r.report.verdict.toUpperCase()),
              text: r.report.verdict,
              sort: r.report.verdict === 'sign' ? 2 : r.report.verdict === 'watch' ? 1 : 0,
            },
            { text: r.report.why, cls: 'wrap' },
          ]),
          {
            keys: reports.map((r) => r.playerId),
            openKey: state.reportSel,
            detail: (key) => {
              const sel = reports.find((r) => r.playerId === Number(key));
              return sel ? playerCard(sel, () => { state.reportSel = null; render(); }, 'attributes') : null;
            },
            onRow: (key) => {
              const id = Number(key);
              state.reportSel = state.reportSel === id ? null : id;
              state.reveal = state.reportSel !== null;
              render();
            },
          },
        ),
      );
      notes.appendChild(el('p', 'muted tiny', 'Open a row for the full attribute sheet. Sign or release in game and this list follows on the next save.'));
    } else {
      const away = (doc.scouts ?? []).filter((sc) => sc.away);
      const when = away
        .map((sc) => sc.mission?.returns)
        .filter(Boolean)
        .sort()[0];
      notes.appendChild(
        el(
          'p',
          'muted',
          away.length
            ? `Nothing to sign: ${away.length === (doc.scouts ?? []).length ? 'every scout is' : `${away.length} of your ${(doc.scouts ?? []).length} scouts are`} still out on a trip${when ? `, the first back ${when}` : ''}. When a report lands, the prospect appears in your academy unsigned — and here, with a verdict.`
            : 'No unsigned reports right now. When a scout delivers, the prospect appears in your academy unsigned — and here, with a sign-or-pass verdict weighed against the academy you already have.',
        ),
      );
    }
    frag.appendChild(notes);
  }
  return frag;
}

/** A horizontal bar row: label, tinted bar scaled to the panel max, value. */
function barRow(label, value, max, tierValue, suffix = '') {
  const row = el('div', 'brow');
  row.appendChild(el('span', 'blabel', label));
  const track = el('div', 'btrack');
  const fill = el('div', `bfill ${tier(tierValue ?? value)}`);
  fill.style.width = `${max > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0}%`;
  track.appendChild(fill);
  row.appendChild(track);
  row.appendChild(el('span', 'bval', `${value}${suffix}`));
  return row;
}

function renderStats(doc) {
  const s2 = doc.stats;
  const frag = document.createDocumentFragment();

  const grid = el('div', 'grid');
  const panel = (title, node) => {
    const p2 = el('div', 'panel');
    p2.appendChild(el('h2', null, title));
    p2.appendChild(node);
    return p2;
  };
  const bars = (rows) => {
    const box = el('div', 'bars');
    for (const r of rows) box.appendChild(r);
    return box;
  };

  const maxCount = Math.max(1, ...s2.byPosition.map((r) => r.count));
  grid.appendChild(
    panel(
      '🧩 Position strength',
      bars(
        s2.byPosition.map((r) =>
          barRow(`${r.slot} ×${r.count}`, r.meanOverall ?? 0, 99, r.meanOverall, ''),
        ),
      ),
    ),
  );
  void maxCount;

  const maxBand = Math.max(1, ...s2.ageProfile.map((r) => r.count));
  grid.appendChild(
    panel('🎂 Age profile', bars(s2.ageProfile.map((r) => barRow(r.band, r.count, maxBand, 70)))),
  );

  const maxGoals = Math.max(1, ...s2.topScorers.map((r) => r.goals));
  grid.appendChild(
    panel('⚽ Top scorers', bars(s2.topScorers.map((r) => barRow(r.name, r.goals, maxGoals, 86)))),
  );

  grid.appendChild(
    panel(
      '⭐ Best rated',
      bars(s2.bestRated.map((r) => barRow(`${r.name} (${r.apps})`, r.rating, 10, r.rating * 10))),
    ),
  );

  const maxMin = Math.max(1, ...s2.mostMinutes.map((r) => r.minutes));
  grid.appendChild(
    panel('⏱ Most minutes', bars(s2.mostMinutes.map((r) => barRow(r.name, r.minutes, maxMin, 70)))),
  );

  if (s2.biggestRisers.length) {
    const maxD = Math.max(1, ...s2.biggestRisers.map((r) => Math.abs(r.delta)));
    grid.appendChild(
      panel(
        'Season growth',
        bars(s2.biggestRisers.map((r) => barRow(r.name, r.delta, maxD, r.delta > 0 ? 90 : 60, ''))),
      ),
    );
  }

  // Ceiling watch: dynamic potential, observed. Falls come first because a
  // falling ceiling is usually the bill for benching a grower to win now.
  {
    const cw = el('div', 'panel');
    cw.appendChild(el('h2', null, '📉 Ceiling watch'));
    if (s2.ceilingWatch.length) {
      cw.appendChild(
        table(
          ['Player', 'Squad', { label: 'Ceiling Δ', num: true }, { label: 'Minutes', num: true }, { label: 'Age', num: true }],
          s2.ceilingWatch.map((r) => [
            r.name,
            r.squad === 'senior' ? 'Senior' : 'Academy',
            { text: `${r.delta > 0 ? '+' : ''}${r.delta}`, num: true },
            { text: r.minutes ?? '—', num: true },
            { text: r.age ?? '—', num: true },
          ]),
        ),
      );
      cw.appendChild(
        el('p', 'muted tiny', 'Potential moving inside this career, read from your own snapshots. A fall on low minutes is the price of playing to win — the alert rail flags falls of 2+ on players 21 and under.'),
      );
    } else {
      cw.appendChild(
        el('p', 'muted tiny', `No ceiling movement observed yet across ${doc.snapshots} snapshots this season. Potential is dynamic in FC 26 — when someone's moves, it lands here, rises and falls both.`),
      );
    }
    grid.appendChild(cw);
  }


  // The to-do list: label, names, numbers. No sermons.
  {
    const items = [];
    const starving = [...doc.senior, ...doc.academy]
      .filter((p) => (p.age ?? 99) <= 21 && (p.headroom ?? 0) >= 5 && (p.minutesThisSeason ?? 0) < 300)
      .sort((a, b) => (b.headroom ?? 0) - (a.headroom ?? 0))
      .slice(0, 3);
    if (starving.length) items.push(['Needs minutes', starving.map((p) => p.name).join(' · '), `5+ growth, under 300'`]);
    const falling = s2.ceilingWatch.filter((r) => r.delta < 0);
    if (falling.length) items.push(['Ceiling slipping', falling.map((r) => `${r.name} ${r.delta}`).join(' · '), 'give them games']);
    const promotable = doc.academy
      .filter((p) => (p.potential ?? 0) >= 85 && (p.age ?? 0) >= 17)
      .sort((a, b) => (b.potential ?? 0) - (a.potential ?? 0))
      .slice(0, 2);
    if (promotable.length) items.push(['Promote', promotable.map((p) => `${p.name} (${p.potential})`).join(' · '), 'academy → senior']);
    const dueNow = (doc.wages?.renewals ?? []).filter((r) => r.urgency === 'now').length;
    if (dueNow) items.push(['Renewals due', `${dueNow} now`, 'Wages tab']);
    if (items.length) {
      const tp = el('div', 'panel');
      tp.appendChild(el('h2', null, '🎯 To do'));
      for (const [label, who, why] of items) {
        const line = el('div', 'todo');
        line.appendChild(el('b', null, label));
        line.appendChild(el('span', 'who', who));
        line.appendChild(el('span', 'why', why));
        tp.appendChild(line);
      }
      grid.appendChild(tp);
    }
  }
  const summary = el('div', 'panel');
  summary.appendChild(el('h2', null, '🧮 At a glance'));
  summary.appendChild(
    table(
      ['Measure', { label: 'Value', num: true }],
      [
        ['Senior players', { text: s2.squadSize, num: true }],
        ['Academy prospects', { text: s2.academySize, num: true }],
        ['Mean overall', { text: s2.meanOverall ?? '—', num: true, tier: s2.meanOverall }],
        ['Mean ceiling', { text: s2.meanPotential ?? '—', num: true, tier: s2.meanPotential }],
        ['Mean age', { text: s2.meanAge ?? '—', num: true }],
        ['Minutes played', { text: s2.totalMinutes.toLocaleString('en-GB'), num: true }],
        ['Wage bill', { text: money(s2.wageBill), num: true }],
      ],
    ),
  );

  frag.appendChild(grid);
  frag.appendChild(summary);
  return frag;
}

/**
 * Squad Hub, with the game's own four ways of reading a squad: Basic (the
 * roster), Stats, Attributes, Financial. Same players, different columns.
 */
function renderSquadHub(doc) {
  return renderSquadViews(doc, doc.senior, '👥 Squad');
}

/** The academy deserves the same four ways of reading a squad. */
function renderAcademyHub(doc) {
  return renderSquadViews(doc, doc.academy, '🎓 My academy');
}

function renderSquadViews(doc, source, title) {
  const frag = document.createDocumentFragment();
  const chips = el('div', 'chiprow hubmodes');
  for (const [id, label] of [['basic', 'Basic'], ['stats', 'Stats'], ['attributes', 'Attributes'], ['financial', 'Financial']]) {
    const chip = el('button', `chip${(state.hubMode ?? 'basic') === id ? ' on' : ''}`, label);
    activatable(chip, () => { state.hubMode = id; render(); }, { skipWhen: () => (state.hubMode ?? 'basic') === id });
    chips.appendChild(chip);
  }
  frag.appendChild(chips);

  const mode = state.hubMode ?? 'basic';
  if (mode === 'basic') {
    frag.appendChild(renderPlayers(source, { title }));
    return frag;
  }

  const list = applyFilters(source);
  // A selected row opens the card above the table, dressed for this view:
  // Stats shows the match log, Attributes the full sheet, Financial the money.
  if (state.hubSel && !list.some((p2) => p2.playerId === state.hubSel)) state.hubSel = null;
  const rowOpts = {
    keys: list.map((p2) => p2.playerId),
    openKey: state.hubSel,
    detail: (key) => {
      const sel = list.find((p2) => p2.playerId === Number(key));
      return sel ? playerCard(sel, () => { state.hubSel = null; render(); }, mode) : null;
    },
    onRow: (key) => {
      const id = Number(key);
      state.hubSel = state.hubSel === id ? null : id;
      // A card opens below its row, which on a long table can be off the bottom
      // of the screen; ask the next render to bring it into view.
      state.reveal = state.hubSel !== null;
      render();
    },
  };
  const panel = el('div', 'panel');
  if (mode === 'stats') {
    panel.appendChild(el('h2', null, '📊 Season numbers'));
    panel.appendChild(
      table(
        [{ label: 'Pos', pos: true }, 'Player', { label: 'OVR', num: true }, { label: 'Apps', num: true }, { label: 'Goals', num: true }, { label: 'Rating', num: true }, { label: 'Mins', num: true }, 'Form'],
        list.map((p) => [
          { text: p.positionShort ?? '—', cls: 'posbadge' },
          { node: playerNameCell(p), text: p.name, sort: p.name },
          { text: p.overall ?? '—', num: true, tier: p.overall },
          { text: p.appearances ?? '—', num: true },
          { text: p.goals ?? '—', num: true },
          { text: p.averageRating ?? '—', num: true },
          { text: p.minutesThisSeason ?? '—', num: true },
          p.form ?? '—',
        ]),
        rowOpts,
      ),
    );
    panel.appendChild(el('p', 'muted tiny', 'Rest on the dot at the row start, or tap anywhere, for his match log.'));
  } else if (mode === 'attributes') {
    // Columns are the groups every listed player has — keepers now carry the
    // outfield groups too, so the intersection is the six shared ones and a
    // keeper's row stops being a line of dashes.
    const groups = list.length
      ? list
          .map((p) => p.groups.map((g) => g.name))
          .reduce((acc, names) => acc.filter((n) => names.includes(n)))
      : [];
    panel.appendChild(el('h2', null, '🧬 Attribute groups'));
    panel.appendChild(
      table(
        [{ label: 'Pos', pos: true }, 'Player', { label: 'OVR', num: true }, ...groups.map((g) => ({ label: g, num: true }))],
        list.map((p) => [
          { text: p.positionShort ?? '—', cls: 'posbadge' },
          { node: playerNameCell(p), text: p.name, sort: p.name },
          { text: p.overall ?? '—', num: true, tier: p.overall },
          ...groups.map((g) => {
            const grp = p.groups.find((x) => x.name === g);
            return { text: grp?.mean ?? '—', num: true, tier: grp?.mean };
          }),
        ]),
        rowOpts,
      ),
    );
    panel.appendChild(el('p', 'muted tiny', 'Group means; open a row for the full attribute sheet. A keeper\u2019s groups differ from an outfielder\u2019s, so his columns read — here.'));
  } else {
    const valueOf = new Map((doc.sellValues?.rows ?? []).map((r) => [r.playerId, r]));
    panel.appendChild(el('h2', null, '💷 Money'));
    panel.appendChild(
      table(
        [{ label: 'Pos', pos: true }, 'Player', { label: 'Age', num: true }, { label: 'OVR', num: true }, { label: 'Wage', num: true }, 'Contract', 'Wage check', { label: 'EA value ~', num: true }, { label: 'World pays', num: true }],
        list.map((p) => {
          const v = valueOf.get(p.playerId);
          return [
            { text: p.positionShort ?? '—', cls: 'posbadge' },
            { node: playerNameCell(p), text: p.name, sort: p.name },
            { text: p.age ?? '—', num: true },
            { text: p.overall ?? '—', num: true, tier: p.overall },
            { text: money(p.wage) ?? '—', num: true },
            p.contractMonths !== null ? fmtTerm(p.contractMonths) : '—',
            p.wageVerdict ?? '—',
            {
              text: v?.ea ? moneyShort(v.ea.value) : '—',
              num: true,
              title: v?.ea ? `EA-style: floor ${moneyShort(v.ea.floor)}, ceiling ${moneyShort(v.ea.ceiling)}` : undefined,
            },
            {
              text: v?.mid != null ? moneyShort(v.mid) : '—',
              num: true,
              title: v?.mid != null ? `This world's own deals: ${moneyShort(v.low)}–${moneyShort(v.high)}` : 'No priced deals in this world to model from yet',
            },
          ];
        }),
        rowOpts,
      ),
    );
    panel.appendChild(el('p', 'muted tiny', 'Open a row for the full money read: the band, the spread and the deal on the table.'));
  }
  frag.appendChild(panel);
  return frag;
}

/**
 * The shortlist as the game saved it: read from the save's own blob section,
 * cracked by shortlisting known players and diffing the bytes.
 */
function renderIngameShortlist(doc) {
  const frag = document.createDocumentFragment();
  const sl = doc.shortlistIngame;
  const panel = el('div', 'panel');
  panel.appendChild(el('h2', null, '⭐ Shortlist — from the game'));
  if (!sl?.readable) {
    panel.appendChild(
      el('p', 'muted', 'The shortlist section of this save could not be read. It lives outside the database block, and when its layout shifts Companion says so rather than guessing.'),
    );
  } else if (!sl.players.length) {
    panel.appendChild(
      el('p', 'muted', 'Your in-game shortlist is empty. Shortlist players in game, save, and they appear here with the club, the numbers and what this world would pay.'),
    );
  } else {
    panel.appendChild(
      table(
        ['Player', 'Club', 'League', 'From', { label: 'Age', num: true }, { label: 'OVR', num: true }, { label: 'POT', num: true }, { label: 'EA value ~', num: true }],
        sl.players.map((p) => [
          p.name,
          p.club ?? '—',
          p.league ?? '—',
          `${flagFor(p.nation)}${p.nation ?? '—'}`,
          { text: p.age ?? '—', num: true },
          { text: p.overall ?? '—', num: true, tier: p.overall },
          { text: p.potential ?? '—', num: true, tier: p.potential },
          {
            text: p.ea ? moneyShort(p.ea.value) : '—',
            num: true,
            title: [
              p.ea ? `EA-style: floor ${moneyShort(p.ea.floor)} · ceiling ${moneyShort(p.ea.ceiling)}` : null,
              p.fee ? `This world has paid ${moneyShort(p.fee.low)}–${moneyShort(p.fee.high)} for this profile` : null,
            ].filter(Boolean).join('\n') || 'No estimate available',
          },
        ]),
      ),
    );
    panel.appendChild(
      el('p', 'muted tiny', `Read straight from the save's own shortlist section${sl.date ? `, last touched ${fmtDate(sl.date)}` : ''}. Shortlist or drop players in game and save — this list follows. The Watchlist tab is Companion's own layer with drift tracking on top.`),
    );
  }
  frag.appendChild(panel);
  return frag;
}

/**
 * Sell values. No custom sliders: the band is fitted on the transfers this
 * world has actually agreed — the game's own market, read back at your squad.
 */
function renderSellValues(doc) {
  const frag = document.createDocumentFragment();
  const sv = doc.sellValues;
  const panel = el('div', 'panel');
  panel.appendChild(el('h2', null, 'Sell values'));
  panel.appendChild(
    el(
      'p',
      'muted',
      'EA-style valuation for every senior player — the game\u2019s own idea of fair, rebuilt from community-derived curves. ' +
        'Floor: walk away below it. Ceiling: where a motivated buyer can be pushed. Marked ~ because it is derived, not read; ' +
        'when an in-game screen disagrees, tell Companion and the curves get recalibrated.',
    ),
  );
  if (state.sellSel && !sv.rows.some((r) => r.playerId === state.sellSel)) state.sellSel = null;
  if (state.sellSel) {
    const p2 = doc.senior.find((x) => x.playerId === state.sellSel);
    if (p2) frag.appendChild(playerCard(p2, () => { state.sellSel = null; render(); }, 'financial'));
  }
  panel.appendChild(
    table(
      [{ label: 'Pos', pos: true }, 'Player', { label: 'Age', num: true }, { label: 'OVR', num: true }, { label: 'POT', num: true }, { label: 'Wage', num: true }, 'Contract', { label: 'Valuation ~', num: true }, { label: 'World pays', num: true }],
      sv.rows.map((r) => {
        const p2 = window.__doc?.senior?.find((x) => x.playerId === r.playerId);
        return [
          { text: p2?.positionShort ?? '—', cls: 'posbadge' },
          { node: p2 ? playerNameCell(p2) : undefined, text: r.name, sort: r.name },
          { text: r.age ?? '—', num: true },
          { text: r.overall ?? '—', num: true, tier: r.overall },
          { text: r.potential ?? '—', num: true, tier: r.potential },
          { node: moneyCell(r.wage, 'wk'), text: r.wage ?? '', num: true, sort: r.wage ?? 0 },
          { node: contractCell(r.contractMonths), text: r.contractMonths ?? '', sort: r.contractMonths ?? 0 },
          { node: valuationCell(r.ea), text: r.ea?.value ?? '', num: true, sort: r.ea?.value ?? 0 },
          {
            text: r.mid !== null ? `${moneyShort(r.low)}–${moneyShort(r.high)}` : r.offMarket ? 'beyond it' : '—',
            num: true,
            title: r.mid !== null
              ? `Fitted on the ${sv.sample} deals this world has actually agreed`
              : sv.modelled
                ? 'Bigger than any deal this world has done'
                : `No priced deals in this world yet (${sv.sample}) — the column fills in as the window does business`,
          },
        ];
      }),
      {
        keys: sv.rows.map((r) => r.playerId),
        onRow: (key) => {
          state.sellSel = Number(key);
          render();
        },
      },
    ),
  );
  panel.appendChild(el('p', 'muted tiny', 'Tap a row for his money card: wage against the band, the valuation spread, and the renewal on the table.'));
  frag.appendChild(panel);
  return frag;
}

/** The target coach: the game's own star ratings, filtered to poachable. */
function renderCoach(doc) {
  const frag = document.createDocumentFragment();
  const c = doc.coaching;
  const panel = el('div', 'panel');
  panel.appendChild(el('h2', null, '🎓 Target coach'));
  if (c?.targets?.length) {
    panel.appendChild(
      table(
        ['Manager', 'Club', { label: 'Stars', num: true }, { label: 'Age', num: true }],
        c.targets.map((m) => [
          m.name,
          m.club ?? '—',
          { node: starsOf(m.stars), text: m.stars ?? '', sort: m.stars ?? 0, cls: `stars m${Math.min(5, Math.max(1, Math.round(m.stars ?? 1)))}`, title: `${m.stars} stars — the game's own rating` },
          { text: m.age ?? '—', num: true },
        ]),
      ),
    );
    panel.appendChild(
      el('p', 'muted tiny', 'The game star-rates every real manager; these are the best-rated ones employed at clubs in your leagues right now, youngest first among equals. The save has no coach-hiring mechanic to write back to — use them as Live Editor targets or succession notes. The full list, national coaches included, is under Office › Manager Market.'),
    );
  } else {
    panel.appendChild(el('p', 'muted tiny', 'No rated club managers found in this world.'));
  }
  frag.appendChild(panel);
  return frag;
}

/* ---------------- the Office ---------------- */

/** Board expectations: confidence, objectives, competition outcomes. */
function renderBoard(doc) {
  const frag = document.createDocumentFragment();
  const seasons = doc.seasons ?? [];
  const cur = seasons[seasons.length - 1] ?? null;
  const comps = (doc.board?.competitions ?? []).filter((c) => c.season === doc.season);
  const wonAll = (doc.board?.competitions ?? []).filter((c) => c.won).length;

  {
    const hero = el('div', 'panel');
    hero.appendChild(el('h2', null, '🏛 Where you stand'));
    hero.appendChild(
      tileRow([
        ['Season', doc.season],
        ['League position', cur?.position && cur.position > 0 ? ordinal(cur.position) : 'in progress'],
        ['Points', cur?.points ?? null],
        ['Trophies won', wonAll || null],
        ['Live competitions', comps.filter((c) => !c.notStarted && !c.won).length || null],
        ['Your wage', money(doc.board.wage)],
        ['Career earnings', money(doc.board.totalEarnings)],
      ]),
    );
    hero.appendChild(
      el('p', 'muted tiny', 'The board\u2019s own confidence number reads zero in every observed save, so it is not shown — these are the facts the save does keep.'),
    );
    frag.appendChild(hero);
  }

  if (comps.length) {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, 'This season\u2019s competitions'));
    const grid = el('div', 'compgrid');
    for (const c of comps) {
      const state2 = c.won ? 'won' : c.notStarted ? 'idle' : c.result === 1 ? 'met' : 'live';
      const box = el('div', `compcard ${state2}`);
      box.appendChild(el('b', 'compname', c.name));
      const pill = el('span', `comppill ${state2}`);
      pill.textContent = c.won ? 'Won' : c.notStarted ? 'Not started' : c.result === 1 ? 'Objective met' : 'In progress';
      box.appendChild(pill);
      grid.appendChild(box);
    }
    panel.appendChild(grid);
    panel.appendChild(
      el('p', 'muted tiny', 'Cup brackets and group tables are not written to the save (verified) — progress and outcome are.'),
    );
    frag.appendChild(panel);
  }

  const board = el('div', 'panel');
  board.appendChild(el('h2', null, '🏛 Board'));
  board.appendChild(
    table(
      ['Measure', { label: 'Value', num: true }],
      [
        ['Reputation', { text: doc.board.reputation ?? '—', num: true }],
        ['Season objectives set', { text: doc.board.objectivesSet, num: true }],
      ],
    ),
  );
  if (doc.board.competitions.length) {
    const outcomeOf = (c) =>
      c.won
        ? 'Won'
        : c.result === 1
          ? 'Objective met'
          : c.result === -1
            ? c.season === doc.season
              ? c.notStarted
                ? 'Not started yet'
                : 'In progress'
              : 'Not recorded'
            : `code ${c.result}`;
    // You are living one season; the rest is history behind a toggle.
    const modes = el('div', 'chiprow');
    for (const [label, hist] of [['This season', false], ['History', true]]) {
      const mode = el('button', `chip${!!state.boardHist === hist ? ' on' : ''}`, label);
      activatable(
        mode,
        () => {
          state.boardHist = hist;
          render();
        },
        { skipWhen: () => !!state.boardHist === hist },
      );
      modes.appendChild(mode);
    }
    board.appendChild(modes);
    const compRows = doc.board.competitions.filter((c) =>
      state.boardHist ? c.season !== doc.season : c.season === doc.season,
    );
    board.appendChild(
      state.boardHist
        ? table(
            ['Competition', { label: 'Season', num: true }, 'Outcome'],
            compRows.map((c) => [c.name, { text: c.season, num: true }, outcomeOf(c)]),
          )
        : table(
            ['Competition', 'Status'],
            compRows.map((c) => [c.name, outcomeOf(c)]),
          ),
    );
  }
  if (doc.board.bigWin || doc.board.bigLoss) {
    const rec = [];
    if (doc.board.bigWin) rec.push(`Biggest win ${doc.board.bigWin.userScore}–${doc.board.bigWin.oppScore} v ${doc.board.bigWin.opponent}`);
    if (doc.board.bigLoss) rec.push(`worst loss ${doc.board.bigLoss.userScore}–${doc.board.bigLoss.oppScore} v ${doc.board.bigLoss.opponent}`);
    board.appendChild(el('p', 'tipline', rec.join(' · ') + '.'));
  }
  frag.appendChild(board);
  return frag;
}

/** The manager's own office: career record, pay, the record book. */
function renderManagerOffice(doc) {
  const frag = document.createDocumentFragment();
  const seasons = doc.seasons ?? [];

  // The career as a timeline: one column per season, height by points, with
  // the finish and the silverware attached. A record you can see the shape of.
  if (seasons.length) {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, '🗓 The career so far'));
    const maxPts = Math.max(1, ...seasons.map((x) => x.points ?? 0));
    const chart = el('div', 'timeline');
    for (const sn of seasons) {
      const col = el('div', 'tlcol');
      const bar = el('div', 'tlbar');
      const fill = el('div', `tlfill${sn.position === 1 ? ' champ' : ''}`);
      fill.style.height = `${Math.max(6, Math.round(((sn.points ?? 0) / maxPts) * 100))}%`;
      bar.appendChild(fill);
      const trophies = sn.leagueTrophies + sn.cupTrophies;
      const mark = el('span', 'tltrophy');
      for (let i = 0; i < Math.min(3, trophies); i++) mark.appendChild(el('i', 'tpip'));
      col.appendChild(mark);
      col.appendChild(bar);
      col.appendChild(el('b', 'tlpts', String(sn.points ?? '—')));
      col.appendChild(el('span', 'tlpos', sn.position && sn.position > 0 ? ordinal(sn.position) : 'live'));
      col.appendChild(el('i', 'tlseason', `S${sn.season}`));
      col.dataset.tip =
        `Season ${sn.season}: ${sn.wins}W ${sn.draws}D ${sn.losses}L · ${sn.points ?? '—'} points · ` +
        `${sn.goalsFor}:${sn.goalsAgainst}${sn.position && sn.position > 0 ? ` · finished ${ordinal(sn.position)}` : ''}` +
        `${trophies ? ` · ${trophies} trophy${trophies > 1 ? 'ies' : ''}` : ''}`;
      chart.appendChild(col);
    }
    panel.appendChild(chart);
    const totals = seasons.reduce(
      (a, x) => ({ w: a.w + x.wins, d: a.d + x.draws, l: a.l + x.losses, gf: a.gf + (x.goalsFor ?? 0), ga: a.ga + (x.goalsAgainst ?? 0) }),
      { w: 0, d: 0, l: 0, gf: 0, ga: 0 },
    );
    const played = totals.w + totals.d + totals.l;
    panel.appendChild(
      tileRow([
        ['Seasons', seasons.length],
        ['Played', played || null],
        ['Win rate', played ? `${Math.round((totals.w / played) * 100)}%` : null],
        ['Record', played ? `${totals.w}-${totals.d}-${totals.l}` : null],
        ['Goals', played ? `${totals.gf}:${totals.ga}` : null],
        ['Trophies', seasons.reduce((a, x) => a + x.leagueTrophies + x.cupTrophies, 0) || null],
      ]),
    );
    frag.appendChild(panel);
  }

  // Season story: the manager's actual record, straight from the save.
  if (doc.seasons.length) {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, '📜 Season record'));
    for (const season of doc.seasons) {
      const row = el('div', 'season');
      row.appendChild(el('b', null, `Season ${season.season}`));

      const wdl = el('div', 'wdl');
      const total = Math.max(1, season.played);
      for (const [n, cls] of [[season.wins, 'w'], [season.draws, 'd'], [season.losses, 'l']]) {
        const seg = el('i', `seg ${cls}`);
        seg.style.width = `${(n / total) * 100}%`;
        seg.title = `${season.wins}W ${season.draws}D ${season.losses}L`;
        wdl.appendChild(seg);
      }
      row.appendChild(wdl);

      const facts = el('span', 'sfacts');
      const current = season.season === doc.season && season.played > 0 && season.played < 38;
      const bits = [
        `${season.wins}W ${season.draws}D ${season.losses}L`,
        season.points !== null ? `${season.points} pts` : null,
        current && season.points !== null
          ? `pace ${Math.round((season.points / season.played) * 38)} over 38`
          : null,
        season.position !== null ? `P${season.position}` : null,
        season.goalsFor !== null ? `${season.goalsFor}:${season.goalsAgainst}` : null,
        season.leagueTrophies ? `${season.leagueTrophies} league title${season.leagueTrophies > 1 ? 's' : ''}` : null,
        season.cupTrophies ? `${season.cupTrophies} cup${season.cupTrophies > 1 ? 's' : ''}` : null,
        season.bigBuy ? `in: ${season.bigBuy.name} ${moneyShort(season.bigBuy.amount)}` : null,
        season.bigSell ? `out: ${season.bigSell.name} ${moneyShort(season.bigSell.amount)}` : null,
      ].filter(Boolean);
      facts.textContent = bits.join(' · ');
      row.appendChild(facts);
      panel.appendChild(row);
    }
    frag.appendChild(panel);
  }

  const me = el('div', 'panel');
  me.appendChild(el('h2', null, '🧑‍💼 The manager'));
  const trophies = doc.seasons.reduce((a, x) => a + x.leagueTrophies + x.cupTrophies, 0);
  me.appendChild(
    table(
      ['Measure', { label: 'Value', num: true }],
      [
        ['Seasons managed', { text: doc.seasons.length, num: true }],
        ['Trophies', { text: trophies, num: true }],
        ['Your wage', { text: money(doc.board.wage), num: true }],
        ['Career earnings', { text: money(doc.board.totalEarnings), num: true }],
      ],
    ),
  );
  if (doc.board.bigWin || doc.board.bigLoss) {
    const rec = [];
    if (doc.board.bigWin) rec.push(`Biggest win ${doc.board.bigWin.userScore}–${doc.board.bigWin.oppScore} v ${doc.board.bigWin.opponent} (${fmtDate(doc.board.bigWin.date)})`);
    if (doc.board.bigLoss) rec.push(`worst loss ${doc.board.bigLoss.userScore}–${doc.board.bigLoss.oppScore} v ${doc.board.bigLoss.opponent} (${fmtDate(doc.board.bigLoss.date)})`);
    me.appendChild(el('p', 'tipline', rec.join(' · ') + '.'));
  }
  frag.appendChild(me);
  return frag;
}

/** Every real manager in this world, by the game's own star rating. */
function renderManagerMarket(doc) {
  const frag = document.createDocumentFragment();
  const c = doc.coaching;
  const all = c?.market ?? [];
  const panel = el('div', 'panel');
  panel.appendChild(el('h2', null, '🌍 Manager market'));

  const game = state.marketGame ?? 'men';
  const counts = { men: all.filter((m) => m.game === 'men').length, women: all.filter((m) => m.game === 'women').length, other: all.filter((m) => m.game === 'other').length };
  const chips = el('div', 'chiprow');
  for (const [id, label] of [['men', `Men's game ${counts.men}`], ['women', `Women's game ${counts.women}`], ['other', `Unattached / other ${counts.other}`]]) {
    const chip = el('button', `chip${game === id ? ' on' : ''}`, label);
    activatable(chip, () => { state.marketGame = id; render(); }, { skipWhen: () => game === id });
    chips.appendChild(chip);
  }
  panel.appendChild(chips);

  const rows = all.filter((m) => m.game === game).slice(0, 80);
  const starCell = (v) => ({
    node: starsOf(v),
    text: v ?? '',
    sort: v ?? 0,
    cls: `stars m${Math.min(5, Math.max(1, Math.round(v ?? 1)))}`,
    title: v === null ? undefined : `${v} stars — the game's own rating, decoded from the save`,
  });
  if (rows.length) {
    panel.appendChild(
      table(
        ['Manager', 'Club', 'League', 'From', { label: 'Age', num: true }, { label: 'Stars', num: true }],
        rows.map((m) => [
          m.name,
          m.club ?? '—',
          m.league ?? '—',
          `${flagFor(m.nation)}${m.nation ?? '—'}`,
          { text: m.age ?? '—', num: true },
          starCell(m.stars),
        ]),
      ),
    );
    panel.appendChild(
      el('p', 'muted tiny', `Top ${rows.length} of ${counts[game]} in this lane, by the game's own star rating. Squad › Coach filters the men's/women's split down to poachable club managers in your leagues.`),
    );
  } else {
    panel.appendChild(el('p', 'muted tiny', 'Nobody in this lane.'));
  }
  frag.appendChild(panel);
  return frag;
}

/** Finances: what the save actually persists, labelled where it does not. */
/**
 * Finances.
 *
 * The club's balance sheet as the save actually keeps it: what the squad is
 * worth against what it costs, where the money sits, and the standing that
 * decides who will talk to you. Budgets are the one thing FC 26 does not write
 * to disk, and that is said once rather than printed as four zeroes.
 */
function renderFinances(doc) {
  const frag = document.createDocumentFragment();
  const f = doc.finances ?? {};
  const sv = doc.sellValues?.rows ?? [];
  const squadValue = sv.reduce((a, r) => a + (r.ea?.value ?? 0), 0);
  const annualWages = (f.wageBill ?? 0) * 52;

  // --- the headline
  {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, 'The balance'));
    panel.appendChild(
      tileRow([
        ['Squad value ~', squadValue ? moneyShort(squadValue) : null, 'Every senior player at his EA-style fair value, added up.'],
        ['Club worth', f.clubWorth ? moneyShort(f.clubWorth) : null, 'The value the save records for the club itself.'],
        ['Wage bill', moneyShort(f.wageBill ?? 0), 'Per week, across everyone with a recorded wage.'],
        ['A year of wages', annualWages ? moneyShort(annualWages) : null],
        ['Your wage', f.managerWage ? moneyShort(f.managerWage) : null],
        ['Career earnings', f.totalEarnings ? moneyShort(f.totalEarnings) : null],
      ]),
    );
    panel.appendChild(
      el('p', 'muted tiny', 'Squad value is derived (~) from the valuation curves; club worth and the wage bill are read straight from the save.'),
    );
    frag.appendChild(panel);
  }

  const cols = el('div', 'grid');

  // --- where the money is: the wage bill by role band, and the biggest assets
  {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, 'Where the wages go'));
    const bands = doc.wages?.bands ?? [];
    const total = bands.reduce((a, b) => a + b.median * b.count, 0) || 1;
    if (bands.length) {
      const bar = el('div', 'stackbar');
      const TONE = ['t4', 't3', 't2', 't1', 'flat'];
      bands.forEach((b, i) => {
        const seg = el('i', `stackseg ${TONE[i % TONE.length]}`);
        seg.style.width = `${Math.max(1, ((b.median * b.count) / total) * 100)}%`;
        seg.dataset.tip = `${b.role}: ${b.count} player${b.count === 1 ? '' : 's'}, median ${money(b.median)} — about ${moneyShort(b.median * b.count)} of the weekly bill.`;
        bar.appendChild(seg);
      });
      panel.appendChild(bar);
      const key = el('div', 'chipwrap');
      bands.forEach((b, i) => {
        const chip = el('span', `bandkey ${TONE[i % TONE.length]}`);
        chip.appendChild(el('i', 'bandswatch'));
        chip.append(`${b.role} ×${b.count}`);
        chip.dataset.tip = `Median ${money(b.median)}, from ${money(b.low)} to ${money(b.high)}.`;
        key.appendChild(chip);
      });
      panel.appendChild(key);
    }
    const top = [...(doc.senior ?? [])].sort((a, b) => (b.wage ?? 0) - (a.wage ?? 0)).slice(0, 5);
    if (top.length) {
      const bars = el('div', 'gbars');
      const max = Math.max(...top.map((p2) => p2.wage ?? 0), 1);
      for (const p2 of top) {
        const row = el('div', 'gbar');
        row.appendChild(el('span', 'gbname', p2.name.split(' ').pop()));
        const track = el('div', 'btrack');
        const fill = el('div', 'bfill t3');
        fill.style.width = `${Math.max(4, Math.round(((p2.wage ?? 0) / max) * 100))}%`;
        track.appendChild(fill);
        row.appendChild(track);
        const v = el('span', 'gbval');
        v.appendChild(el('b', null, moneyShort(p2.wage)));
        row.appendChild(v);
        row.dataset.tip = `${p2.name} — ${((p2.wage ?? 0) / Math.max(1, f.wageBill ?? 1) * 100).toFixed(1)}% of the weekly bill.`;
        bars.appendChild(row);
      }
      panel.appendChild(cardSection('THE FIVE BIGGEST EARNERS', bars));
    }
    cols.appendChild(panel);
  }

  // --- the standing that decides who talks to you
  {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, 'Standing'));
    const bars = el('div', 'gbars');
    const scale = (label, v, tip) => {
      if (v === null || v === undefined) return;
      const row = el('div', 'gbar');
      row.appendChild(el('span', 'gbname', label));
      const track = el('div', 'btrack');
      const fill = el('div', `bfill ${v >= 8 ? 't4' : v >= 6 ? 't3' : v >= 4 ? 't2' : 't1'}`);
      fill.style.width = `${v * 10}%`;
      track.appendChild(fill);
      row.appendChild(track);
      const val = el('span', 'gbval');
      val.appendChild(el('b', null, `${v}/10`));
      row.appendChild(val);
      row.dataset.tip = tip;
      bars.appendChild(row);
    };
    scale('Domestic prestige', f.domesticPrestige, 'How the country sees the club. It shapes who will consider a move here.');
    scale('International prestige', f.internationalPrestige, 'How the world sees the club — the number that matters for foreign signings.');
    scale('Profitability', f.profitability, 'The board\u2019s own read on how the club is trading.');
    scale('Youth development', f.youthDevelopment, 'The facility rating that shapes what your academy produces. Raising it is a long game with the largest payoff in this app.');
    panel.appendChild(bars);
    if (f.financialStrictness !== null && f.financialStrictness !== undefined) {
      panel.appendChild(
        el('p', 'muted tiny', `Board financial strictness: ${f.financialStrictness}. Higher means less patience with a wage bill that outruns the results.`),
      );
    }
    cols.appendChild(panel);
  }

  // --- the biggest things you own
  {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, 'Your biggest assets'));
    const top = sv.filter((r) => r.ea).slice(0, 6);
    if (top.length) {
      panel.appendChild(
        table(
          ['Player', { label: 'Age', num: true }, { label: 'Wage', num: true }, { label: 'Worth ~', num: true }, { label: 'Years of his wage', num: true }],
          top.map((r) => {
            const years = r.wage && r.ea ? r.ea.value / (r.wage * 52) : null;
            return [
              r.name,
              { text: r.age ?? '—', num: true },
              { node: moneyCell(r.wage, 'wk'), text: r.wage ?? '', num: true, sort: r.wage ?? 0 },
              { node: valuationCell(r.ea), text: r.ea?.value ?? '', num: true, sort: r.ea?.value ?? 0 },
              {
                text: years === null ? '—' : `${years.toFixed(1)}y`,
                num: true,
                title: years === null ? undefined : `Selling him would cover about ${years.toFixed(1)} years of what he is paid.`,
              },
            ];
          }),
          { tight: true },
        ),
      );
    } else {
      panel.appendChild(el('p', 'muted tiny', 'No valuations yet.'));
    }
    cols.appendChild(panel);
  }

  // --- budgets, said once
  {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, 'Budgets'));
    const known = [f.transferBudget, f.wageBudget, f.startTransferBudget, f.startWageBudget].some(
      (v) => v !== null && v !== undefined,
    );
    if (known) {
      panel.appendChild(
        table(
          ['Measure', { label: 'Value', num: true }],
          [
            ['Transfer budget', { text: money(f.transferBudget) ?? '—', num: true }],
            ['Wage budget', { text: money(f.wageBudget) ?? '—', num: true }],
            ['Start-of-season transfer budget', { text: money(f.startTransferBudget) ?? '—', num: true }],
            ['Start-of-season wage budget', { text: money(f.startWageBudget) ?? '—', num: true }],
          ],
        ),
      );
    } else {
      panel.appendChild(
        el('p', 'muted', 'FC 26 keeps the live budgets in memory and writes zeroes to the save — verified across every save Companion has read. Rather than print four zeroes as though you were broke, Companion says nothing and leaves the budget where it is knowable: on the game\u2019s own transfer screen.'),
      );
      panel.appendChild(
        el('p', 'muted tiny', 'If a save ever does carry them, this panel fills itself in.'),
      );
    }
    cols.appendChild(panel);
  }

  frag.appendChild(cols);
  return frag;
}

/** Live scenarios: verified absent from the save, said plainly. */
function renderChallenges(doc) {
  const frag = document.createDocumentFragment();
  const panel = el('div', 'panel');
  panel.appendChild(el('h2', null, '🎯 Challenges'));
  panel.appendChild(
    el('p', 'muted', 'The game\u2019s live scenarios and challenge details are not written into the career save — a full sweep of every table and every blob section finds nothing to read. When they reach the disk, this tab lights up.'),
  );
  panel.appendChild(
    el('p', 'muted tiny', settings.rpg
      ? 'Meanwhile RPG mode is on: Companion runs its own campaign layer — career milestones, phase missions and micro missions, all computed from your real save. They live on the Story tab.'
      : 'Meanwhile: switch on RPG mode under Customise and Companion runs its own campaign layer — career milestones, phase missions and micro missions, all computed from your real save.'),
  );
  frag.appendChild(panel);
  void doc;
  return frag;
}

/* ---------------- career story: the brag report ---------------- */

/**
 * Everything on the card is computed from the save: season records, the
 * board's trophy ledger, the store's snapshot history. Nothing is invented —
 * a fact that is not in the data simply does not appear.
 */
function bragFacts(doc) {
  const st = doc.stats ?? {};
  const seasons = doc.seasons ?? [];
  const cur = seasons[seasons.length - 1] ?? null;
  const totals = seasons.reduce(
    (a, x) => ({
      played: a.played + (x.played ?? 0),
      wins: a.wins + (x.wins ?? 0),
      draws: a.draws + (x.draws ?? 0),
      losses: a.losses + (x.losses ?? 0),
      gf: a.gf + (x.goalsFor ?? 0),
      ga: a.ga + (x.goalsAgainst ?? 0),
    }),
    { played: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0 },
  );
  const trophies = (doc.board?.competitions ?? []).filter((c) => c.won);
  const scorer = (st.topScorers ?? [])[0] ?? null;
  const scorer2 = (st.topScorers ?? [])[1] ?? null;
  const rated = (st.bestRated ?? [])[0] ?? null;
  const iron = (st.mostMinutes ?? [])[0] ?? null;
  const riser = (st.biggestRisers ?? [])[0] ?? null;
  const jewel = [...(doc.academy ?? [])].sort((a, b) => (b.potential ?? 0) - (a.potential ?? 0))[0] ?? null;
  const sale = [...seasons].map((x) => x.bigSell).filter((x) => x && x.amount > 0)
    .sort((a, b) => b.amount - a.amount)[0] ?? null;
  const buy = [...seasons].map((x) => x.bigBuy).filter((x) => x && x.amount > 0)
    .sort((a, b) => b.amount - a.amount)[0] ?? null;
  const captainRole = (doc.matchday?.roles ?? []).find((r) => r.role === 'Captain');
  const captain = captainRole?.currentId != null
    ? (doc.senior ?? []).find((x) => x.playerId === captainRole.currentId) ?? null
    : null;
  const topWage = [...(doc.senior ?? [])].sort((a, b) => (b.wage ?? 0) - (a.wage ?? 0))[0] ?? null;

  // Absurdities: every number real, every line anchored to something the
  // player will actually remember — a date, a name, a projection they can
  // check. Guards keep a line out rather than letting it show a blank.
  const absurd = [];
  if (cur && cur.played >= 5) {
    const gpg = cur.goalsFor / cur.played;
    if (gpg >= 2.2) absurd.push(`${cur.goalsFor} goals in ${cur.played} games. At this rate that's ${Math.round(gpg * 38)} by the end of May.`);
    const gapg = cur.goalsAgainst / cur.played;
    const keeper = [...(doc.senior ?? [])]
      .filter((k) => k.positionShort === 'GK')
      .sort((a, b) => (b.minutesThisSeason ?? 0) - (a.minutesThisSeason ?? 0))[0];
    if (gapg <= 0.9) absurd.push(`${cur.goalsAgainst} conceded in ${cur.played}${keeper ? ` — ${keeper.name} could have brought a deckchair` : ''}.`);
  }
  if (rated && rated.rating >= 8.5 && rated.apps >= 10) {
    absurd.push(`${rated.name} is averaging ${rated.rating.toFixed(1)} over ${rated.apps} games. Ballon d'Or voters, look away.`);
  }
  if (scorer && scorer2 && scorer.goals === scorer2.goals && scorer.goals > 0) {
    absurd.push(`${scorer.name.split(' ').pop()} and ${scorer2.name.split(' ').pop()} are tied on ${scorer.goals} — the strikers have a private league of their own.`);
  }
  if (sale && buy && sale.amount > buy.amount * 3) {
    absurd.push(`Sold ${sale.name} for ${moneyShort(sale.amount)}, biggest buy ${moneyShort(buy.amount)}. The board thinks you're a wizard.`);
  } else if (sale && !buy) {
    absurd.push(`${moneyShort(sale.amount)} banked for ${sale.name}, nothing spent. Pure profit football.`);
  }
  if (topWage && st.wageBill && topWage.wage) {
    const share = (topWage.wage / st.wageBill) * 100;
    if (share >= 10) absurd.push(`${topWage.name} takes ${share.toFixed(0)}% of the entire wage bill — and honestly, fair.`);
  }
  if (st.meanAge && st.meanAge <= 24.5) {
    absurd.push(`Average squad age ${st.meanAge} — half this dressing room can't rent a car.`);
  }
  if (jewel && jewel.potential !== null && jewel.potential >= 88) {
    absurd.push(`There's a ${jewel.potential}-potential kid in the academy. Pretend you don't know.`);
  }
  if (doc.board?.bigWin && doc.board.bigWin.userScore - doc.board.bigWin.oppScore >= 7) {
    const w = doc.board.bigWin;
    const month = new Date(Math.floor(w.date / 10000), (Math.floor(w.date / 100) % 100) - 1, 1)
      .toLocaleString('en-GB', { month: 'long' });
    absurd.unshift(
      `You put ${w.userScore} past ${w.opponent} in ${month}.${w.userScore >= 10 ? ' Double digits. In one match.' : ' Their keeper still flinches.'}`,
    );
  }

  return { seasons, cur, totals, trophies, scorer, scorer2, rated, iron, riser, jewel, sale, buy, captain, topWage, absurd, st };
}

const escXml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ordinal = (n) =>
  n === null || n === undefined || n <= 0
    ? null
    : `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** The shareable card, as SVG: one source of truth for screen and export. */
function storySvg(doc) {
  const f = bragFacts(doc);
  const W = 1080;
  const ACCENT = '#c9f24b';
  const INK = '#e8eef2';
  const DIM = '#8b98a5';
  const FONT = `-apple-system, 'Segoe UI', Roboto, sans-serif`;
  const parts = [];
  const t = (x, y, text, size, fill, weight = 400, anchor = 'start', spacing = '') =>
    parts.push(`<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}>${escXml(text)}</text>`);
  // Rich line: segments with their own colour and weight, one <text> of tspans.
  const seg = (x, y, size, segments) =>
    parts.push(
      `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}">` +
        segments.map((sg) => `<tspan fill="${sg.fill}" font-weight="${sg.w ?? 600}"${sg.dx ? ` dx="${sg.dx}"` : ''}>${escXml(sg.t)}</tspan>`).join('') +
        `</text>`,
    );

  // The background and footer are added at the end, once the content has
  // decided how tall the card needs to be — a fixed height overflowed the
  // moment the cabinet, the record and the absurd bit all showed up at once.

  // Header
  t(64, 110, `CAREER REPORT · SEASON ${doc.season ?? '?'}`, 26, ACCENT, 700, 'start', '0.2em');
  t(64, 178, doc.club?.name ?? 'Career', 58, INK, 800);
  t(64, 220, [doc.manager, doc.gameDate ? `~${fmtDate(doc.gameDate)}` : null].filter(Boolean).join('  ·  '), 26, DIM);
  parts.push(`<line x1="64" y1="252" x2="${W - 64}" y2="252" stroke="#1e2732" stroke-width="2"/>`);

  // Trophies
  let y = 306;
  if (f.trophies.length) {
    t(64, y, 'TROPHY CABINET', 22, DIM, 700, 'start', '0.15em');
    y += 42;
    for (const tr of f.trophies.slice(0, 4)) {
      seg(64, y, 28, [
        { t: '— ', fill: ACCENT, w: 800 },
        { t: tr.name, fill: INK, w: 800 },
        { t: `  season ${tr.season}`, fill: DIM, w: 600 },
      ]);
      y += 40;
    }
    y += 8;
  } else {
    seg(64, y, 22, [
      { t: 'TROPHY CABINET  ', fill: DIM, w: 700 },
      { t: 'empty — the hunger is the story.', fill: ACCENT, w: 600 },
    ]);
    y += 46;
  }

  // Season records: won green, drawn grey, lost red, scored green, conceded
  // red — the record reads at a glance instead of as one white sentence.
  const GREEN = '#4ade80';
  const RED = '#f87171';
  t(64, y, 'THE RECORD', 22, DIM, 700, 'start', '0.15em');
  y += 44;
  for (const sn of f.seasons.slice(-5)) {
    const pos = ordinal(sn.position);
    const champion = sn.position === 1;
    // Every family gets its own colour: season volt, position silver/bronze,
    // W green, D grey, L red, points volt, goals green:red.
    const posFill = champion ? ACCENT : sn.position === 2 ? '#cbd5e1' : sn.position === 3 ? '#d9a05b' : DIM;
    seg(64, y, 30, [
      { t: `S${sn.season}`, fill: ACCENT, w: 800 },
      { t: champion ? '  CHAMPIONS' : pos ? `  ${pos}` : '  live', fill: posFill, w: 800, dx: 6 },
      { t: `  ${sn.wins}W`, fill: GREEN, w: 800, dx: 18 },
      { t: ` ${sn.draws}D`, fill: DIM, w: 700 },
      { t: ` ${sn.losses}L`, fill: RED, w: 800 },
      { t: `  ${sn.points}`, fill: ACCENT, w: 800, dx: 18 },
      { t: ' pts', fill: DIM, w: 600 },
      { t: `  ${sn.goalsFor}`, fill: GREEN, w: 800, dx: 18 },
      { t: ':', fill: DIM, w: 600 },
      { t: `${sn.goalsAgainst}`, fill: RED, w: 800 },
    ]);
    y += 46;
  }
  y += 18;

  // Hero tiles, 2 x 3
  const tiles = [];
  if (f.totals.played > 0) tiles.push(['WIN RATE', `${Math.round((f.totals.wins / f.totals.played) * 100)}%`, `${f.totals.wins} of ${f.totals.played} matches`]);
  if (f.cur && f.cur.played > 0) tiles.push(['GOALS / GAME', (f.cur.goalsFor / f.cur.played).toFixed(1), `this season, ${f.cur.goalsFor} scored`]);
  if (f.scorer) tiles.push(['TOP SCORER', f.scorer.name, `${f.scorer.goals} goals${f.scorer2 && f.scorer2.goals === f.scorer.goals ? ` (tied with ${f.scorer2.name.split(' ').pop()})` : ''}`]);
  if (f.rated) tiles.push(['BEST RATED', f.rated.name, `${f.rated.rating.toFixed(1)} avg over ${f.rated.apps} games`]);
  if (f.st.meanOverall) tiles.push(['SQUAD', `${f.st.meanOverall}`, `average rating · ${f.st.meanAge}y average age`]);
  if (f.iron) tiles.push(['IRON MAN', f.iron.name, `${f.iron.minutes} minutes this season`]);
  const tw = (W - 64 * 2 - 24) / 2;
  tiles.slice(0, 6).forEach((tile, i) => {
    const tx = 64 + (i % 2) * (tw + 24);
    const ty = y + Math.floor(i / 2) * 132;
    parts.push(`<rect x="${tx}" y="${ty}" width="${tw}" height="112" rx="14" fill="#121821" stroke="#1e2732"/>`);
    t(tx + 24, ty + 36, tile[0], 18, DIM, 700, 'start', '0.12em');
    t(tx + 24, ty + 72, tile[1], 30, ACCENT, 800);
    t(tx + 24, ty + 98, tile[2], 18, DIM);
  });
  y += Math.ceil(Math.min(tiles.length, 6) / 2) * 132 + 30;

  // Wonderkids + market
  const lines = [];
  // No emoji on the card: it is an exported image, and a row of pictographs is
  // exactly what makes something look machine-made.
  if (f.riser && f.riser.delta > 0) lines.push(`Sharpest riser — ${f.riser.name}, +${f.riser.delta} overall this season.`);
  if (f.jewel && f.jewel.potential !== null) lines.push(`Academy jewel — ${f.jewel.name}, ${f.jewel.age}, ceiling ${f.jewel.potential}.`);
  if (f.sale) lines.push(`Biggest sale — ${f.sale.name} for ${moneyShort(f.sale.amount)}.`);
  if (f.buy) lines.push(`Biggest signing — ${f.buy.name} at ${moneyShort(f.buy.amount)}.`);
  if (f.captain) lines.push(`${f.captain.name} wears the armband.`);
  for (const line of lines.slice(0, 4)) {
    t(64, y, line, 26, INK, 500);
    y += 42;
  }
  y += 12;

  // Absurdities
  if (f.absurd.length && settings.absurd) {
    t(64, y, 'THE ABSURD BIT', 22, DIM, 700, 'start', '0.15em');
    y += 42;
    for (const line of f.absurd.slice(0, 3)) {
      t(64, y, line, 24, ACCENT, 500);
      y += 40;
    }
  }

  // Footer, then size the card to what it actually holds.
  const H = Math.max(1350, y + 120);
  parts.push(`<line x1="64" y1="${H - 84}" x2="${W - 64}" y2="${H - 84}" stroke="#1e2732" stroke-width="2"/>`);
  t(64, H - 44, 'FC26 COMPANION · every number read from the save, nothing invented', 20, DIM, 600);
  const chrome = `<rect width="${W}" height="${H}" fill="#0b0f14"/><rect x="0" y="0" width="${W}" height="6" fill="${ACCENT}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${chrome}${parts.join('')}</svg>`;
}

/** Social caption: plain text for pasting next to the image. */
function storyCaption(doc) {
  const f = bragFacts(doc);
  const out = [`${doc.club?.name ?? 'Career'} — season ${doc.season}`];
  if (f.cur) out.push(`${f.cur.wins}W ${f.cur.draws}D ${f.cur.losses}L · ${f.cur.goalsFor}:${f.cur.goalsAgainst}`);
  for (const tr of f.trophies.slice(0, 3)) out.push(`Won the ${tr.name}`);
  if (f.scorer) out.push(`${f.scorer.name} — ${f.scorer.goals} goals`);
  if (f.rated) out.push(`${f.rated.name} — ${f.rated.rating.toFixed(1)} average rating`);
  if (f.sale) out.push(`Sold ${f.sale.name} for ${moneyShort(f.sale.amount)}`);
  if (doc.board?.bigWin && doc.board.bigWin.userScore - doc.board.bigWin.oppScore >= 5) {
    out.push(`Biggest win ${doc.board.bigWin.userScore}–${doc.board.bigWin.oppScore} v ${doc.board.bigWin.opponent}`);
  }
  if (f.absurd.length) out.push(f.absurd[0]);
  out.push('Tracked on Companion — the second screen that reads the save itself');
  out.push('#FC26 #CareerMode');
  return out.join(String.fromCharCode(10));
}

/**
 * RPG mode: the career as a campaign. Every challenge is computed live from
 * the document — real numbers, deterministic thresholds, no dice behind the
 * curtain. Completion is "the condition holds right now"; history lands when
 * the story ledger ships (docs/ai-features.md phase A).
 */
function rpgChallenges(doc) {
  const cur = doc.seasons[doc.seasons.length - 1];
  const xi = doc.matchday?.recommended?.assignments ?? [];
  const byId = new Map([...doc.senior, ...doc.academy].map((p) => [p.playerId, p]));
  const xiPlayers = xi.map((a) => byId.get(a.playerId)).filter(Boolean);
  const out = [];
  const add = (name, line, value, target, higherIsBetter = true) => {
    if (value === null || value === undefined) return;
    const pct = higherIsBetter ? Math.min(100, Math.round((value / target) * 100)) : Math.min(100, Math.round((target / Math.max(value, 0.01)) * 100));
    out.push({ name, line, value, target, pct, done: higherIsBetter ? value >= target : value <= target });
  };
  if (cur && cur.played > 0) {
    add('Century', `Score 100 league goals in a season — ${cur.goalsFor} so far.`, cur.goalsFor, 100);
    add('The Wall', `Concede 0.8 a game or less — at ${(cur.goalsAgainst / cur.played).toFixed(2)}.`, cur.goalsAgainst / cur.played, 0.8, false);
    add('Invincible run', `Go the season unbeaten — ${cur.losses} ${cur.losses === 1 ? 'loss' : 'losses'} so far.`, cur.losses, 0, false);
  }
  if (xiPlayers.length >= 11) {
    const ages = xiPlayers.map((p) => p.age).filter((a) => a !== null);
    const meanAge = ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : null;
    if (meanAge !== null) add('Youth revolution', `Field an XI averaging under 24 — currently ${meanAge.toFixed(1)}.`, meanAge, 24, false);
    const grads = xiPlayers.filter((p) => p.isNewgen).length;
    add('Academy XI', `Three academy products in the best XI — ${grads} there now.`, grads, 3);
  }
  const sales = doc.seasons.reduce((a, x) => a + (x.bigSell?.amount ?? 0), 0);
  const buys = doc.seasons.reduce((a, x) => a + (x.bigBuy?.amount ?? 0), 0);
  if (sales || buys) add('Moneyball', `Record sales outweigh record buys — ${moneyShort(sales)} out vs ${moneyShort(buys)} in.`, sales, Math.max(buys, 1));
  return out;
}

/** Campaign selection persists across sessions; 'custom' keeps chosen levers. */
const campaign = (() => {
  try {
    return { type: 'rtg', levers: [], ...JSON.parse(localStorage.getItem('campaign') || '{}') };
  } catch {
    return { type: 'rtg', levers: [] };
  }
})();
const saveCampaign = () => localStorage.setItem('campaign', JSON.stringify(campaign));
if (!Array.isArray(campaign.blend)) campaign.blend = [];

/**
 * The campaigns.
 *
 * `creed` is the one line the campaign judges you by; `chapters` names the
 * phases of a season in its own voice, so the same August reads differently
 * under Moneyball than under Invincibles. Everything else about a campaign —
 * its ladder, its missions — is computed from the save.
 */
const CAMPAIGNS = {
  rtg: {
    name: 'Road to Glory',
    blurb: 'Climb until the biggest trophies stop being dreams.',
    creed: 'Every season should end higher than the last.',
    chapters: { summer: 'The rebuild', autumn: 'The climb', winter: 'The correction', runin: 'The run-in', review: 'The reckoning' },
  },
  treble: {
    name: 'The Treble',
    blurb: 'League, cup and Europe — in one impossible season.',
    creed: 'Three trophies or the season was a rehearsal.',
    chapters: { summer: 'Assembling the squad', autumn: 'Three fronts', winter: 'Holding all three', runin: 'The convergence', review: 'What was won' },
  },
  invincible: {
    name: 'Invincibles',
    blurb: 'A season nobody beats you.',
    creed: 'The zero in the loss column is the whole story.',
    chapters: { summer: 'Before the first test', autumn: 'The streak', winter: 'The nerves', runin: 'The last miles', review: 'Where it broke, or did not' },
  },
  century: {
    name: 'Century Club',
    blurb: 'Goals until the nets complain.',
    creed: 'A hundred goals, and style is not optional.',
    chapters: { summer: 'Loading the guns', autumn: 'The barrage', winter: 'Keeping the rate', runin: 'The chase for a hundred', review: 'The count' },
  },
  wall: {
    name: 'The Wall',
    blurb: 'Build the meanest defence this save has ever recorded.',
    creed: 'Concede nothing and the rest takes care of itself.',
    chapters: { summer: 'Laying bricks', autumn: 'The shutout run', winter: 'Cracks and repairs', runin: 'Holding the line', review: 'What got through' },
  },
  youthrev: {
    name: 'Youth Revolution',
    blurb: 'The youngest team in the land, and the best.',
    creed: 'If he is old enough, he is good enough.',
    chapters: { summer: 'The intake', autumn: 'Learning in public', winter: 'Growing pains', runin: 'The kids hold on', review: 'How far they came' },
  },
  academy: {
    name: 'Academy Project',
    blurb: 'A first team grown, not bought.',
    creed: 'Every shirt earned in your own academy.',
    chapters: { summer: 'Promotions', autumn: 'Minutes for the young', winter: 'The temptation to buy', runin: 'Trusting them', review: 'The graduation' },
  },
  moneyball: {
    name: 'Moneyball',
    blurb: 'Win while the books stay green.',
    creed: 'Value is the only currency that compounds.',
    chapters: { summer: 'Buy low', autumn: 'Proving the model', winter: 'Sell high', runin: 'The margin', review: 'The balance sheet' },
  },
  custom: {
    name: 'Custom',
    blurb: 'Blend the campaigns you care about.',
    creed: 'Your rules, held to the same standard.',
    chapters: { summer: 'The window', autumn: 'The grind', winter: 'Midwinter', runin: 'The run-in', review: 'The review' },
  },
};

/** The majors a custom campaign can blend. */
const BLENDABLE = ['rtg', 'treble', 'invincible', 'century', 'wall', 'youthrev', 'academy', 'moneyball'];

/**
 * Which campaigns are actually in play: the chosen one, or — for a custom
 * blend — every major the user picked. The blend is what makes the ladder and
 * the missions coherent rather than a pile of unrelated conditions.
 */
function activeCampaigns() {
  if (campaign.type !== 'custom') return [campaign.type];
  const picked = (campaign.blend ?? []).filter((k) => BLENDABLE.includes(k));
  return picked.length ? picked : [];
}

/**
 * Career-long milestone ladders, computed from the whole recorded history —
 * seasons, trophies, the squad — so the arc runs toward the end of a 15-season
 * career instead of resetting every August.
 */
/**
 * The ladder for whatever is in play. A single campaign gives its own; a blend
 * interleaves its campaigns' ladders so the arc reads as one story with each
 * milestone labelled by the strand it belongs to.
 */
function activeLadder(doc) {
  const types = activeCampaigns();
  if (types.length === 0) return null;
  if (types.length === 1) return campaignLadder(doc, types[0]);

  const strands = types
    .map((t) => ({ t, rungs: campaignLadder(doc, t) ?? [] }))
    .filter((x) => x.rungs.length);
  if (!strands.length) return null;

  // Interleave by depth so the blend advances on every front at once rather
  // than finishing one campaign before starting the next.
  const out = [];
  const depth = Math.max(...strands.map((x) => x.rungs.length));
  for (let i = 0; i < depth; i++) {
    for (const strand of strands) {
      const rung = strand.rungs[i];
      if (rung) out.push({ ...rung, strand: CAMPAIGNS[strand.t].name });
    }
  }
  return out;
}

function campaignLadder(doc, type) {
  const seasons = doc.seasons ?? [];
  const cur2 = seasons[seasons.length - 1] ?? null;
  const finished = seasons.filter((x) => (x.position ?? 0) > 0);
  const bestPos = finished.length ? Math.min(...finished.map((x) => x.position)) : null;
  const titles = finished.filter((x) => x.position === 1).length + (doc.board?.competitions ?? []).filter((c) => c.won && c.name.includes('Premier League')).length;
  const cupsWon = (doc.board?.competitions ?? []).filter((c) => c.won && !c.name.includes('League') && !c.name.includes('Champions')).length;
  const uclWon = (doc.board?.competitions ?? []).some((c) => c.won && c.name.includes('Champions'));
  const gaSeasons = finished.map((x) => ({ s: x.season, ga: x.played ? x.goalsAgainst / x.played : 99 }));
  const underOne = gaSeasons.filter((x) => x.ga < 1).length;
  const newgens = doc.senior.filter((p2) => p2.isNewgen);
  const xi = (doc.matchday?.recommended?.assignments ?? []).map((a) => a.playerId);
  const xiNewgens = doc.senior.filter((p2) => p2.isNewgen && xi.includes(p2.playerId)).length;
  const netBySeason = seasons.map((x) => (x.bigSell?.amount ?? 0) - (x.bigBuy?.amount ?? 0));
  const netPositive = netBySeason.filter((n) => n > 0).length;

  const M = (name, done, detail) => ({ name, done, detail });
  if (type === 'wall')
    return [
      M('A season under 1.0 conceded a game', underOne >= 1, `${underOne} so far`),
      M('A season under 0.8', gaSeasons.some((x) => x.ga < 0.8), gaSeasons.length ? `best ${Math.min(...gaSeasons.map((x) => x.ga)).toFixed(2)}` : 'no full season yet'),
      M('Back-to-back mean seasons', underOne >= 2, `${underOne} of 2`),
      M('Thirty or fewer conceded in a full season', finished.some((x) => x.goalsAgainst <= 30), ''),
      M('Five mean seasons across the career', underOne >= 5, `${underOne} of 5`),
    ];
  if (type === 'academy')
    return [
      M('An academy product in the best XI', xiNewgens >= 1, `${xiNewgens} there now`),
      M('Three in the best XI', xiNewgens >= 3, `${xiNewgens} of 3`),
      M('An academy product reaches 85', newgens.some((p2) => (p2.overall ?? 0) >= 85), newgens.length ? `best ${Math.max(...newgens.map((p2) => p2.overall ?? 0))}` : 'none promoted yet'),
      M('Five academy products in the senior squad', newgens.length >= 5, `${newgens.length} of 5`),
      M('The armband on an academy product', doc.senior.some((p2) => p2.isNewgen && (doc.matchday?.roles ?? []).some((r2) => r2.role === 'Captain' && r2.currentId === p2.playerId)), ''),
    ];
  if (type === 'moneyball')
    return [
      M('A net-positive window', netPositive >= 1, `${netPositive} seasons in the green`),
      M('Back-to-back green seasons', netPositive >= 2, `${netPositive} of 2`),
      M('A record sale triple the record buy', seasons.some((x) => (x.bigSell?.amount ?? 0) > 3 * Math.max(x.bigBuy?.amount ?? 0, 1)), ''),
      M('Career books in the green', netBySeason.reduce((a, b) => a + b, 0) > 0, moneyShort(netBySeason.reduce((a, b) => a + b, 0)) + ' career net'),
      M('A title with green books', netBySeason.reduce((a, b) => a + b, 0) > 0 && titles >= 1, ''),
    ];
  if (type === 'invincible') {
    const minLosses = finished.length ? Math.min(...finished.map((x) => x.losses)) : null;
    const curL = cur2 && cur2.played ? cur2.losses : null;
    return [
      M('A season of five losses or fewer', (minLosses !== null && minLosses <= 5) || (curL !== null && cur2.played >= 30 && curL <= 5), minLosses !== null ? `best: ${minLosses} losses` : ''),
      M('Twenty games into a season unbeaten', cur2 !== null && cur2.played >= 20 && cur2.losses === 0, cur2 ? `${cur2.losses} losses after ${cur2.played}` : ''),
      M('A two-loss season', minLosses !== null && minLosses <= 2, ''),
      M('The unbeaten season', (minLosses !== null && minLosses === 0) || (cur2 !== null && cur2.played >= 38 && cur2.losses === 0), ''),
      M('Do it while champions', false, 'unbeaten and the title, same season'),
    ];
  }
  if (type === 'century') {
    const bestGf = finished.length ? Math.max(...finished.map((x) => x.goalsFor)) : 0;
    const gfNow = cur2?.goalsFor ?? 0;
    const centuries = finished.filter((x) => x.goalsFor >= 100).length + (gfNow >= 100 ? 1 : 0);
    const careerGoals = seasons.reduce((a, x) => a + (x.goalsFor ?? 0), 0);
    return [
      M('Eighty in a season', bestGf >= 80 || gfNow >= 80, `best ${Math.max(bestGf, gfNow)}`),
      M('The century', centuries >= 1, ''),
      M('A hundred and twenty', bestGf >= 120 || gfNow >= 120, ''),
      M('Back-to-back centuries', centuries >= 2, `${centuries} of 2`),
      M('Five hundred career goals', careerGoals >= 500, `${careerGoals} so far`),
    ];
  }
  if (type === 'youthrev') {
    const u21 = doc.senior.filter((p2) => (p2.age ?? 99) <= 21).length;
    const xiAges = (doc.matchday?.recommended?.assignments ?? [])
      .map((a) => doc.senior.find((p2) => p2.playerId === a.playerId)?.age)
      .filter((a) => a !== null && a !== undefined);
    const xiMean = xiAges.length ? xiAges.reduce((a, b) => a + b, 0) / xiAges.length : null;
    const teenXI = xiAges.some((a) => a <= 19);
    return [
      M('Six under-21s in the senior squad', u21 >= 6, `${u21} of 6`),
      M('A best XI averaging under 24', xiMean !== null && xiMean < 24, xiMean !== null ? `now ${xiMean.toFixed(1)}` : ''),
      M('A teenager in the best XI', teenXI, ''),
      M('Under 23 on average', xiMean !== null && xiMean < 23, ''),
      M('Youngest squad, top four', xiMean !== null && xiMean < 24 && bestPos !== null && bestPos <= 4, ''),
    ];
  }
  if (type === 'treble') {
    const leagueWon = titles >= 1;
    const cupWon = cupsWon >= 1;
    const wonBySeason = new Map();
    for (const c of doc.board?.competitions ?? []) {
      if (!c.won) continue;
      wonBySeason.set(c.season, (wonBySeason.get(c.season) ?? 0) + 1);
    }
    const doubleSeason = [...wonBySeason.values()].some((n2) => n2 >= 2);
    const trebleSeason = [...wonBySeason.values()].some((n2) => n2 >= 3);
    return [
      M('Win the league', leagueWon, ''),
      M('Win a domestic cup', cupWon, ''),
      M('Win the Champions League', uclWon, ''),
      M('A double — two trophies, one season', doubleSeason, ''),
      M('THE TREBLE', trebleSeason, 'all three, one season'),
    ];
  }
  if (type === 'custom') return null;
  return [
    M('Finish in the top half', bestPos !== null && bestPos <= 10, bestPos ? `best: ${ordinal(bestPos)}` : 'no finished season yet'),
    M('Top four', bestPos !== null && bestPos <= 4, ''),
    M('Runner-up', bestPos !== null && bestPos <= 2, ''),
    M('Champions', titles >= 1, titles ? `${titles} title${titles > 1 ? 's' : ''}` : ''),
    M('A domestic cup', cupsWon >= 1, ''),
    M('Champions League', uclWon, ''),
    M('Back-to-back titles', titles >= 2, `${titles} of 2`),
  ];
}

/** Where the season stands: windows open and shut, and the missions follow. */
function seasonPhase(doc) {
  const m = doc.gameDate ? Math.floor(doc.gameDate / 100) % 100 : null;
  const base =
    m === null
      ? { id: 'unknown', label: 'Season in progress' }
      : m === 7 || m === 8
        ? { id: 'summer', label: 'Summer window — squad building' }
        : m === 1
          ? { id: 'winter', label: 'Winter window — one correction allowed' }
          : m === 6
            ? { id: 'review', label: 'Season review' }
            : m >= 2 && m <= 5
              ? { id: 'runin', label: 'The run-in — every point is a final' }
              : { id: 'autumn', label: 'Autumn — the grind that decides May' };

  // With a campaign running, the same month is named in its voice: August is
  // "Loading the guns" under Century Club and "Buy low" under Moneyball.
  if (settings.rpg) {
    const lead = activeCampaigns()[0] ?? campaign.type;
    const chapter = CAMPAIGNS[lead]?.chapters?.[base.id];
    if (chapter) return { ...base, label: chapter, plain: base.label };
  }
  return base;
}

/**
 * Mini missions: 2-3 live conditions per campaign, re-cut for the phase of the
 * season. Same rules as everything else — computed, never rolled.
 */
function campaignMissions(doc) {
  const phase = seasonPhase(doc);
  const cur = doc.seasons[doc.seasons.length - 1];
  const out = [];
  // `where` is the tab whose work the mission is about, so the quest can be
  // shown next to the thing you would actually do about it.
  const push = (name, line, pct, done, where = null) =>
    out.push({ name, line, pct: Math.max(0, Math.min(100, Math.round(pct))), done, where });
  const ppg = cur && cur.played ? (cur.points ?? 0) / cur.played : null;
  const gapg = cur && cur.played ? cur.goalsAgainst / cur.played : null;
  const winRate = cur && cur.played ? cur.wins / cur.played : null;
  const net = cur ? (cur.bigSell?.amount ?? 0) - (cur.bigBuy?.amount ?? 0) : 0;
  const gaps = (doc.transfers?.gaps ?? []).filter((g) => g.severity !== 'none');
  const totalMin = doc.stats.totalMinutes || 1;
  const acadMin = doc.senior.filter((p2) => p2.isNewgen).reduce((a, p2) => a + (p2.minutesThisSeason ?? 0), 0);
  const acadShare = acadMin / totalMin;
  const windowOpen = phase.id === 'summer' || phase.id === 'winter';

  for (const type of activeCampaigns()) buildMissionsFor(type);
  function buildMissionsFor(type) {
  if (type === 'wall') {
    if (gapg !== null) push('Keep the door shut', `Concede under 0.9 a game — at ${gapg.toFixed(2)}.`, (0.9 / Math.max(gapg, 0.01)) * 100, gapg <= 0.9, 'squad/tactics');
    if (windowOpen && gaps.some((g) => ['GK', 'CB', 'FB'].includes(g.slot)))
      push('Fix the back line', `The window is open and ${gaps.filter((g) => ['GK', 'CB', 'FB'].includes(g.slot)).map((g) => g.slot).join('/')} is thin.`, 0, false, 'transfers/targets');
    else if (windowOpen) push('Hold the wall together', 'No defensive gap — resist the shiny signing.', 100, true, 'transfers/targets');
  } else if (type === 'academy') {
    push('Academy minutes', `${(acadShare * 100).toFixed(1)}% of all minutes to academy products — target 15%.`, (acadShare / 0.15) * 100, acadShare >= 0.15, 'squad/develop');
    const pending = doc.alerts.filter((a) => a.tag === 'Sign to senior').length;
    if (pending) push('Promotions pending', `${pending} academy deal${pending > 1 ? 's' : ''} to convert before they walk.`, 0, false, 'academy/players');
    else push('Nobody slips away', 'Every promotion case is handled.', 100, true, 'academy/players');
  } else if (type === 'moneyball') {
    if (windowOpen) push('Green window', `Close this window net positive — currently ${net >= 0 ? '+' : ''}${moneyShort(net)}.`, net > 0 ? 100 : 50, net > 0, 'transfers/targets');
    const over = doc.wages.assessmentList.filter((a) => a.verdict === 'over').length;
    push('No fat contracts', `${over} player${over === 1 ? '' : 's'} paid above the band.`, over === 0 ? 100 : Math.max(0, 100 - over * 20), over === 0, 'squad/wages');
  } else if (type === 'invincible') {
    if (cur) push('Zero column', `${cur.losses} ${cur.losses === 1 ? 'loss' : 'losses'} after ${cur.played} — keep the zero.`, cur.losses === 0 ? 100 : 0, cur.losses === 0, 'squad/tactics');
    if (winRate !== null) push('Kill the draws', `Draws are survivable, losses are not — win rate ${(winRate * 100).toFixed(0)}%.`, (winRate / 0.65) * 100, winRate >= 0.65, 'squad/tactics');
  } else if (type === 'century') {
    if (cur) {
      const nextMark = Math.ceil(Math.max(cur.goalsFor + 1, 20) / 20) * 20;
      push(`Reach ${nextMark}`, `${cur.goalsFor} scored — next stop ${nextMark}.`, (cur.goalsFor / nextMark) * 100, false);
      if (cur.played) push('Three a game', `${(cur.goalsFor / cur.played).toFixed(1)} per game — hold 3.0.`, ((cur.goalsFor / cur.played) / 3) * 100, cur.goalsFor / cur.played >= 3, 'squad/tactics');
    }
  } else if (type === 'youthrev') {
    const xiAges = (doc.matchday?.recommended?.assignments ?? [])
      .map((a) => doc.senior.find((p2) => p2.playerId === a.playerId)?.age)
      .filter((a2) => a2 !== null && a2 !== undefined);
    const xiMean = xiAges.length ? xiAges.reduce((a2, b) => a2 + b, 0) / xiAges.length : null;
    if (xiMean !== null) push('Keep it young', `Best XI averages ${xiMean.toFixed(1)} — stay under 24.`, (24 / Math.max(xiMean, 1)) * 100, xiMean < 24, 'squad/tactics');
    if (windowOpen) push('Sign the future', 'Window rule: nobody over 24 comes in.', 50, false, 'transfers/targets');
  } else if (type === 'treble') {
    const alive = (doc.board?.competitions ?? []).filter((c) => c.season === doc.season && !c.won && c.result === -1 && !c.notStarted).length;
    push('Stay alive everywhere', `${alive} competition${alive === 1 ? '' : 's'} still running — lose none of them.`, alive > 0 ? 100 : 0, alive >= 2, 'squad/tactics');
    if (ppg !== null) push('League pace', `${(ppg * 38).toFixed(0)}-point pace — the treble starts with the title.`, ((ppg * 38) / 88) * 100, ppg * 38 >= 88, 'squad/tactics');
  } else {
    if (ppg !== null) push('Title pace', `${(ppg * 38).toFixed(0)} points over 38 at this rate — hold 88+.`, ((ppg * 38) / 88) * 100, ppg * 38 >= 88, 'squad/tactics');
    if (winRate !== null && phase.id === 'runin') push('The run-in', `Win rate ${(winRate * 100).toFixed(0)}% — champions close at 70%+.`, (winRate / 0.7) * 100, winRate >= 0.7, 'squad/tactics');
    if (windowOpen && gaps.length) push('Cover the gaps', `${gaps.map((g) => g.slot).join(' · ')} thin while the window is open.`, 0, false, 'transfers/targets');
    else if (windowOpen) push('Squad complete', 'No line is thin — spend nothing you do not need to.', 100, true, 'transfers/targets');
  }
  }
  // A blend can ask for the same thing twice; say it once.
  const seenMission = new Set();
  for (let i = out.length - 1; i >= 0; i--) {
    if (seenMission.has(out[i].name)) out.splice(i, 1);
    else seenMission.add(out[i].name);
  }

  // Micro: one-save-away nudges from the leaders' own numbers.
  const micro = [];
  const scorer = (doc.stats.topScorers ?? [])[0];
  if (scorer) {
    const nextS = Math.ceil((scorer.goals + 1) / 5) * 5;
    micro.push({ name: `${scorer.name.split(' ').pop()} to ${nextS}`, line: `${scorer.goals} goals — ${nextS - scorer.goals} to the next mark.`, pct: Math.round((scorer.goals / nextS) * 100), done: false, where: 'squad/tactics' });
  }
  const rated = (doc.stats.bestRated ?? [])[0];
  if (rated && rated.apps >= 5) micro.push({ name: 'Keep the standard', line: `${rated.name.split(' ').pop()} averages ${rated.rating.toFixed(1)} — hold 8.0+.`, pct: Math.min(100, Math.round((rated.rating / 8) * 100)), done: rated.rating >= 8, where: 'squad/tactics' });
  const starved = [...doc.senior, ...doc.academy]
    .filter((p2) => (p2.age ?? 99) <= 21 && (p2.headroom ?? 0) >= 5 && (p2.minutesThisSeason ?? 0) < 300)
    .sort((a, b) => (b.headroom ?? 0) - (a.headroom ?? 0))[0];
  if (starved) micro.push({ name: `Minutes for ${starved.name.split(' ').pop()}`, line: `${starved.minutesThisSeason ?? 0}' so far — get to 300 before June.`, pct: Math.round(((starved.minutesThisSeason ?? 0) / 300) * 100), done: (starved.minutesThisSeason ?? 0) >= 300, where: 'squad/develop' });
  return { phase, missions: out, micro };
}

function renderStory(doc) {
  const frag = document.createDocumentFragment();

  const bar = el('div', 'storybar');
  const save = el('button', 'primary', 'Save as image');
  save.addEventListener('click', () => {
    // SVG -> canvas -> PNG, no libraries: the card uses text and rects only,
    // so rasterising it never taints the canvas.
    const svg = storySvg(doc);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1080;
      canvas.height = 1350;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `career-report-${(doc.club?.name ?? 'club').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-s${doc.season ?? 0}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, 'image/png');
    };
    img.src = url;
  });
  bar.appendChild(save);

  const copy = el('button', 'ghost', 'Copy caption');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(storyCaption(doc));
      copy.textContent = 'Copied ✓';
      setTimeout(() => { copy.textContent = 'Copy caption'; }, 1500);
    } catch {
      copy.textContent = 'Clipboard blocked';
    }
  });
  bar.appendChild(copy);
  bar.appendChild(el('span', 'muted tiny', '1080×1350 — sized for a feed post. The caption pastes alongside it.'));
  frag.appendChild(bar);

  const cols = el('div', 'storycols');
  const card = el('div', 'storycard');
  card.innerHTML = storySvg(doc);
  cols.appendChild(card);

  const side = el('div', 'storyside');
  const f = bragFacts(doc);

  const rb = el('div', 'panel');
  rb.appendChild(el('h2', null, '📖 Record book'));
  const recRows = [];
  if (doc.board?.bigWin) {
    const w = doc.board.bigWin;
    recRows.push(['Biggest win', `${w.userScore}–${w.oppScore} v ${w.opponent}`, fmtDate(w.date)]);
  }
  if (doc.board?.bigLoss) {
    const w = doc.board.bigLoss;
    recRows.push(['Worst loss', `${w.userScore}–${w.oppScore} v ${w.opponent}`, fmtDate(w.date)]);
  }
  const bestSeason = [...(doc.seasons ?? [])]
    .filter((x) => (x.position ?? 0) > 0)
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))[0];
  if (bestSeason) recRows.push(['Best season', `S${bestSeason.season} — ${bestSeason.points} pts, ${ordinal(bestSeason.position)}`, '']);
  if (f.sale) recRows.push(['Record sale', `${f.sale.name} — ${moneyShort(f.sale.amount)}`, '']);
  if (f.buy) recRows.push(['Record buy', `${f.buy.name} — ${moneyShort(f.buy.amount)}`, '']);
  if (f.rated) recRows.push(['Season’s best', `${f.rated.name} — ${f.rated.rating.toFixed(1)} avg over ${f.rated.apps}`, '']);
  if (recRows.length) rb.appendChild(table(['Record', 'Detail', 'When'], recRows));
  side.appendChild(rb);

  const cap = el('div', 'panel');
  cap.appendChild(el('h2', null, '📝 Caption'));
  const pre = el('pre', 'caption');
  pre.textContent = storyCaption(doc);
  cap.appendChild(pre);
  cap.appendChild(el('p', 'muted tiny', 'What “Copy caption” puts on your clipboard — paste it next to the image.'));
  side.appendChild(cap);

  if (false && settings.ai) {
    const ai = el('div', 'panel');
    ai.appendChild(el('h2', null, 'AI mode'));
    ai.appendChild(
      el('p', 'muted', 'Switched on, not yet wired: AI narration needs a language-model provider — a local one (Ollama / LM Studio) or an API key. Nothing here fakes it in the meantime; the deterministic app is complete without it.'),
    );
    ai.appendChild(el('p', 'muted tiny', 'The implementation plan lives in docs/ai-features.md — grounding contract, provider setup, and what the narration will and will not be allowed to do.'));
    side.appendChild(ai);
  }

  cols.appendChild(side);
  frag.appendChild(cols);

  return frag;
}

/** Deterministic campaign narration: chapter and arc from the record alone. */
function campaignLine(doc) {
  const cur = doc.seasons[doc.seasons.length - 1];
  if (!cur || !cur.played) return null;
  const ppg = cur.points !== null ? cur.points / cur.played : null;
  const arc =
    cur.losses === 0
      ? 'an unbeaten season is alive — every match now carries it'
      : ppg !== null && ppg >= 2.3
        ? 'a title charge at full tilt'
        : ppg !== null && ppg >= 1.9
          ? 'in the hunt — one bad week from a crossroads'
          : 'a rebuilding chapter, and the academy knows it';
  return `Chapter ${doc.season}: ${cur.wins}W ${cur.draws}D ${cur.losses}L, ${cur.goalsFor}:${cur.goalsAgainst} — ${arc}.`;
}

function renderCentral(doc) {
  const frag = document.createDocumentFragment();
  const wrap = el('div', 'central');
  const colMain = el('div', 'central-main');
  const colSide = el('div', 'central-side');
  wrap.appendChild(colMain);
  wrap.appendChild(colSide);
  frag.appendChild(wrap);

  const panel = (col, title, node) => {
    const p2 = el('div', 'panel');
    p2.appendChild(el('h2', null, title));
    p2.appendChild(node);
    col.appendChild(p2);
    return p2;
  };
  const go = (view, sub) => {
    const b = el('button', 'ghost tiny-btn', 'Open ›');
    activatable(b, () => {
      state.view = view;
      localStorage.setItem('view', view);
      if (sub) {
        state.subs[view] = sub;
        localStorage.setItem('subs', JSON.stringify(state.subs));
      }
      render();
    });
    return b;
  };
  const todoRow = (box, label, who, why) => {
    const row = el('div', 'todo');
    row.appendChild(el('b', null, label));
    row.appendChild(el('span', 'who', who));
    row.appendChild(el('span', 'why', why ?? ''));
    box.appendChild(row);
  };

  const cur = doc.seasons[doc.seasons.length - 1];

  // ---------- main column: the season, the tables, the world ----------
  {
    const box = el('div');
    if (doc.gameDate) {
      const d = new Date(Math.floor(doc.gameDate / 10000), Math.floor((doc.gameDate % 10000) / 100) - 1, doc.gameDate % 100);
      const bar = el('div', 'datebar');
      const day = el('span', 'dateday');
      day.textContent = `${d.toLocaleDateString('en-GB', { weekday: 'long' })}, ${d.toLocaleDateString('en-GB', { month: 'short', day: '2-digit' })}`.toUpperCase();
      day.dataset.tip = 'Estimated from the newest dated record in the save — there is no live date field.';
      bar.appendChild(day);
      bar.appendChild(el('span', 'dateyear', String(Math.floor(doc.gameDate / 10000))));
      for (const w of doc.calendar?.windows ?? []) {
        const pill = el('span', `wchip${w.openNow ? ' open' : ''}`);
        pill.appendChild(el('i', 'dot'));
        pill.append(`${w.label} ${w.opens} → ${w.closes}`);
        if (w.openNow) pill.appendChild(el('b', null, 'OPEN'));
        bar.appendChild(pill);
      }
      box.appendChild(bar);
    }
    if (cur) {
      const wdl = el('div', 'hero-line');
      const pace = cur.points !== null && cur.played > 0 && cur.played < 38 ? Math.round((cur.points / cur.played) * 38) : null;
      const heroStats = [
        [cur.wins, 'won', 'h-up'],
        [cur.draws, 'drawn', 'h-mid'],
        [cur.losses, 'lost', 'h-down'],
        [cur.goalsFor, 'scored', 'h-up'],
        [cur.goalsAgainst, 'conceded', 'h-down'],
        [cur.points ?? '—', 'points', ''],
      ];
      if (pace !== null) heroStats.push([pace, 'pace / 38', '']);
      heroStats.push([doc.stats.meanOverall ?? '—', 'squad', ''], [doc.stats.meanAge ?? '—', 'mean age', '']);
      for (const [v2, l2, cls2] of heroStats) {
        const cell = el('span', `stat big${cls2 ? ` ${cls2}` : ''}`);
        cell.appendChild(el('b', null, String(v2)));
        cell.appendChild(el('i', null, l2));
        wdl.appendChild(cell);
      }
      box.appendChild(wdl);
    }
    panel(colMain, `Season ${doc.season}`, box);
  }

  // A club the save has not yet named. The row is still true — it is the
  // record of a real team, we just cannot put a badge on it yet. Shared by the
  // table, the season list and anywhere else a slot surfaces.
  const UNNAMED_WHY =
    'The save stores this fixture list by slot, not by club. A slot is named when a save proves it — from the matchday round-up, or from who a club you can already name just played — so this row fills in as the season goes on. Run “npm run backfill:fixtures” to read the names out of saves you have already archived.';

  if (settings.leagueTable && doc.leagueTable?.rows?.length) {
    const lt = doc.leagueTable;
    const box = el('div');
    // Two possible sources, and they are not equally good. 'fixtures' means the
    // rows were added up from the save's own record of every match played, which
    // is the real table. 'links' is the fallback for when that cannot be read,
    // and for the user's own division it is usually last season's leftovers.
    const fromLedger = lt.source === 'fixtures';
    // Points a five-match run is worth, which is what makes the bar and the
    // pips agree instead of quietly measuring different things.
    const runPoints = (form5) => (form5 ?? []).reduce((n, x) => n + (x === 'W' ? 3 : x === 'D' ? 1 : 0), 0);
    // Newest on the left: reading a run should start with what just happened.
    const formRun = (r) => {
      if (!r.form5?.length) return { text: '—' };
      const recentFirst = [...r.form5].reverse();
      const box2 = el('span', 'formrun');
      recentFirst.forEach((res, i) => {
        box2.appendChild(el('i', `fpip f-${res.toLowerCase()}${i === 0 ? ' newest' : ''}`, res));
      });
      const pts = runPoints(r.form5);
      return {
        node: box2,
        text: recentFirst.join(''),
        sort: pts,
        title:
          `Last five, most recent first — ${recentFirst.join(' ')}. That is ${pts} of a possible 15.` +
          (fromLedger
            ? ' Read off the results themselves, so this is the league alone: cups and friendlies are not in it.'
            : ' From the club record in the save, which counts all competitions.'),
      };
    };
    const formCell = (r) => {
      // When the rows come from the results, score the form off those same five
      // so the bar cannot contradict the pips beside it. The game's own rating
      // still gets a mention, because it counts cups and this does not.
      const pct = fromLedger && r.form5?.length ? Math.round((runPoints(r.form5) / 15) * 100) : r.form;
      if (pct === null || pct === undefined) return { text: '—' };
      const box2 = el('span', 'formcell');
      const track = el('div', 'btrack');
      const fill = el('div', `bfill ${pct >= 66 ? 't3' : pct >= 40 ? 't2' : 't1'}`);
      fill.style.width = `${Math.max(3, Math.min(100, pct))}%`;
      track.appendChild(fill);
      box2.appendChild(track);
      box2.appendChild(el('b', null, String(pct)));
      return {
        node: box2,
        text: pct,
        num: true,
        sort: pct,
        title: fromLedger
          ? `${runPoints(r.form5)} points from the last five league matches, as a share of fifteen.` +
            (r.form !== null ? ` The game’s own form rating, which counts every competition, reads ${r.form}.` : '')
          : `The game's own recent-form rating, 0–100${r.formLong !== null ? ` · ${r.formLong} over the longer run` : ''}.`,
      };
    };

    /**
     * A run worth noticing, shown against the number it is made of.
     *
     * Three in a row is a spark; five is the thing itself. Wins burn, losses
     * freeze, and a run of draws is a club going nowhere in particular.
     */
    const STREAK_LOOK = { W: ['flame', 'hot'], D: ['equal', 'flat'], L: ['snowflake', 'cold'] };
    const streakCell = (r, kind, value) => {
      const cell = { text: value, num: true, sort: value, cls: r.isUser ? 'you' : undefined };
      const st = r.streak;
      const marked = st && st.kind === kind && st.length >= 3;
      // Every cell in these three columns carries the slot, marked or not, so
      // the digits line up down the column. Hanging the mark off a marked cell
      // alone shifted its number out of step with the nineteen below it.
      const wrap = el('span', 'streaknum');
      const slot = el('span', 'streakslot');
      if (marked) {
        const [ico, tone] = STREAK_LOOK[kind];
        const mark = el('span', `streak ${tone} ${st.length >= 5 ? 'blaze' : 'spark'}`);
        mark.appendChild(icon(ico, 13));
        slot.appendChild(mark);
      }
      wrap.appendChild(slot);
      wrap.appendChild(el('b', null, String(value)));
      if (!marked) return { ...cell, node: wrap };
      const word = kind === 'W' ? 'wins' : kind === 'D' ? 'draws' : 'defeats';
      return {
        ...cell,
        node: wrap,
        title: `${st.length} ${word} in a row${st.length >= 5 ? ', and counting' : ''}.`,
      };
    };
// The movement column is the insight the raw table hides: who is climbing
    // and who is falling relative to where they finished last season.
    // Thirteen columns is a lot of table. Scoping a class to it lets the number
    // columns run tighter here than they would anywhere else, so the form and
    // the last five fit beside the record instead of behind a scrollbar.
    const grid = table(
        lt.started
          ? [
              { label: '#', num: true, always: true },
              { label: '', always: true },
              { label: 'Club', always: true },
              { label: 'P', num: true, always: true },
              { label: 'W', num: true, always: true },
              { label: 'D', num: true, always: true },
              { label: 'L', num: true, always: true },
              { label: 'GF', num: true, always: true },
              { label: 'GA', num: true, always: true },
              { label: 'GD', num: true, always: true },
              { label: 'Pts', num: true, always: true },
              { label: 'Form', num: true },
              { label: 'Last 5' },
            ]
          : [
              { label: '', always: true },
              { label: '', always: true },
              { label: 'Club', always: true },
              { label: 'Last five', always: true },
              { label: 'Form', num: true, always: true },
            ],
        (lt.started ? lt.rows : [...lt.rows].sort((a, b) => (b.form ?? -1) - (a.form ?? -1))).map((r, i) => {
          const you = r.isUser ? 'you' : '';
          const rank = i + 1;
          // Positive means climbed: they were lower-numbered before.
          const move = r.prevPosition !== null && r.prevPosition > 0 ? r.prevPosition - rank : null;
          // Every club gets the same kind of number: places gained or lost
          // since the last matchday. Promotion is not a movement — it is a
          // fact about the club — so it rides beside the name instead of
          // taking over this column and leaving one row reading "up" while
          // nineteen read a figure.
          const moveCell =
            move === null
              ? { text: '·', cls: `mv-flat${you ? ' you' : ''}`, sort: '0', title: 'No previous round to compare with yet.' }
              : {
                  text: move > 0 ? `▲${move}` : move < 0 ? `▼${-move}` : '—',
                  cls: `${move > 0 ? 'mv-up' : move < 0 ? 'mv-down' : 'mv-flat'}${you ? ' you' : ''}`,
                  sort: String(move),
                  title:
                    move === 0
                      ? `Held ${ordinal(rank)} through the last round.`
                      : `${move > 0 ? 'Up' : 'Down'} ${Math.abs(move)} since the last round — ${ordinal(r.prevPosition)} to ${ordinal(rank)}.` +
                        (r.lastSeasonPosition ? ` Finished ${ordinal(r.lastSeasonPosition)} last season.` : ''),
                };
          const nameCell = (() => {
            if (r.name === null) return { text: 'not yet named', cls: 'unnamed', sort: '￿', title: UNNAMED_WHY };
            if (!r.movedDivision) return { text: r.name, cls: you || undefined };
            const wrap = el('span', 'clubcell');
            wrap.appendChild(el('span', null, r.name));
            wrap.appendChild(
              el('i', `divtag ${r.movedDivision === 'up' ? 'promoted' : 'relegated'}`, r.movedDivision === 'up' ? 'P' : 'R'),
            );
            return {
              node: wrap,
              text: r.name,
              sort: r.name,
              cls: you || undefined,
              title: r.movedDivision === 'up' ? `${r.name} came up this summer.` : `${r.name} came down into this division.`,
            };
          })();
          return lt.started
            ? [
                { text: rank, num: true, cls: you || undefined },
                moveCell,
                nameCell,
                { text: r.played, num: true, cls: you || undefined },
                streakCell(r, 'W', r.wins),
                streakCell(r, 'D', r.draws),
                streakCell(r, 'L', r.losses),
                { text: r.gf, num: true, cls: you || undefined },
                { text: r.ga, num: true, cls: you || undefined },
                { text: r.gd, num: true, cls: you || undefined },
                { text: r.points, num: true, cls: you || undefined },
                { ...formCell(r), cls: you || undefined },
                { ...formRun(r), cls: you || undefined },
              ]
            : [
                { text: '', cls: you || undefined },
                { text: '', cls: you || undefined },
                nameCell,
                { ...formRun(r), cls: you || undefined },
                { ...formCell(r), cls: you || undefined },
              ];
        }),
        { tight: true },
    );
    grid.classList.add('ltable');
    box.appendChild(grid);

    /**
     * What every mark in the table means.
     *
     * Listed in full whether or not the table happens to show one today. A
     * legend that appears and disappears with the thing it explains is no use:
     * the moment you meet a symbol for the first time is exactly the moment its
     * explanation has gone missing.
     */
    const legend = el('div', 'legend');
    const legendItem = (build, label) => {
      const item = el('span', 'legitem');
      const mark = el('span', 'legmark');
      build(mark);
      item.appendChild(mark);
      item.appendChild(el('span', 'legtext', label));
      legend.appendChild(item);
    };
    const streakLegend = (kind, heat, label) => {
      const [ico, tone] = STREAK_LOOK[kind];
      legendItem((m) => {
        const mark = el('span', `streak ${tone} ${heat}`);
        mark.appendChild(icon(ico, 13));
        m.appendChild(mark);
      }, label);
    };

    legendItem((m) => m.appendChild(el('b', 'mv-up', '▲3')), 'places gained since the last round');
    legendItem((m) => m.appendChild(el('b', 'mv-down', '▼3')), 'places lost');
    legendItem((m) => m.appendChild(el('b', 'mv-flat', '—')), 'unmoved');
    legendItem((m) => m.appendChild(el('i', 'divtag promoted', 'P')), 'promoted this summer');
    legendItem((m) => m.appendChild(el('i', 'divtag relegated', 'R')), 'relegated into this division');
    streakLegend('W', 'spark', 'three wins running');
    streakLegend('W', 'blaze', 'five or more — on fire');
    streakLegend('L', 'spark', 'three defeats running');
    streakLegend('L', 'blaze', 'five or more — frozen');
    streakLegend('D', 'spark', 'three draws running');
    streakLegend('D', 'blaze', 'five or more — going nowhere');
    legendItem((m) => {
      const run = el('span', 'formrun');
      for (const [res, cls] of [['W', 'f-w newest'], ['D', 'f-d'], ['L', 'f-l']]) {
        run.appendChild(el('i', `fpip ${cls}`, res));
      }
      m.appendChild(run);
    }, 'last five, most recent first');
    legendItem((m) => {
      const cell = el('span', 'formcell');
      const track = el('div', 'btrack');
      const fill = el('div', 'bfill t3');
      fill.style.width = '70%';
      track.appendChild(fill);
      cell.appendChild(track);
      m.appendChild(cell);
    }, 'points from those five, out of fifteen');
    legendItem((m) => m.appendChild(el('span', 'unnamedchip', 'not yet named')), 'no save has proved whose slot this is');
    box.appendChild(legend);
    box.appendChild(
      el('p', 'muted tiny', !lt.started
        ? 'No league match has been played yet this season, so there is nothing to add up.'
        : fromLedger
          ? `Added up from every result the save has recorded${lt.named < lt.total ? `. ${lt.total - lt.named} of ${lt.total} clubs are still unnamed \u2014 the save files fixtures by slot, and a slot is named only once a save proves whose it is` : ''}.`
          : 'Taken from the club records in the save, which for your own division are usually last season\u2019s.'),
    );
    panel(colMain, lt.league ?? 'League table', box);
  }

  // Our own league season: what has been played, and what comes next.
  if (settings.leagueTable && doc.leagueTable?.ourSeason?.length) {
    const season = doc.leagueTable.ourSeason;
    const lastPlayed = season.reduce((n, m, i) => (m.result ? i : n), -1);
    const from = Math.max(0, lastPlayed - 2);
    const around = season.slice(from, lastPlayed + 7);
    const box = el('div');
    box.appendChild(
      table(
        [
          { label: 'Date', always: true },
          { label: '', always: true },
          { label: 'Opponent', always: true },
          { label: 'Score', always: true },
        ],
        around.map((m, i) => {
          const next = !m.result && from + i === lastPlayed + 1;
          const you = next ? 'you' : undefined;
          return [
            { text: fmtDate(m.date), cls: you },
            { text: m.home ? 'H' : 'A', cls: 'venue', title: m.home ? 'At home' : 'Away' },
            m.opponent === null
              ? { text: 'not yet named', cls: 'unnamed', title: UNNAMED_WHY }
              : { text: m.opponent, cls: you },
            m.result
              ? {
                  text: `${m.goalsFor}\u2013${m.goalsAgainst}`,
                  cls: `res r-${m.result.toLowerCase()}`,
                  sort: m.goalsFor - m.goalsAgainst,
                }
              : { text: next ? 'next up' : 'to play', cls: next ? 'you' : 'muted' },
          ];
        }),
        { tight: true },
      ),
    );
    box.appendChild(
      el(
        'p',
        'muted tiny',
        `${season.filter((m) => m.result).length} of ${season.length} league matches played. The whole season is written out months ahead, so a date this far out can still move.`,
      ),
    );
    panel(colMain, 'Your league season', box);
  }

  // The rest of Europe's latest round, exactly as the save recorded it.
  if (settings.leagueTable && doc.leagueTable?.elsewhere?.length) {
    const box = el('div');
    const byLeague = new Map();
    for (const r of doc.leagueTable.elsewhere) {
      const key = r.league ?? 'Elsewhere';
      if (!byLeague.has(key)) byLeague.set(key, []);
      byLeague.get(key).push(r);
    }
    for (const [league, list] of byLeague) {
      box.appendChild(el('h4', 'subhead', league));
      for (const r of list) {
        // A results feed reads best as home, score, away on one line, with the
        // side that won carrying the weight.
        const verdict = r.homeGoals === r.awayGoals ? 'd' : r.homeGoals > r.awayGoals ? 'h' : 'a';
        const line = el('div', 'euro');
        line.appendChild(el('span', `euroteam${verdict === 'h' ? ' won' : ''}`, r.home));
        line.appendChild(el('b', 'euroscore', `${r.homeGoals}\u2013${r.awayGoals}`));
        line.appendChild(el('span', `euroteam${verdict === 'a' ? ' won' : ''}`, r.away));
        box.appendChild(line);
      }
    }
    box.appendChild(
      el(
        'p',
        'muted tiny',
        'The round-up the game writes after a matchday: the headline leagues, latest round only. It names real clubs, which is how the slots in your own table earn their names.',
      ),
    );
    panel(colSide, 'Around Europe', box);
  }

  {
    const comps = (doc.board?.competitions ?? []).filter((c) => c.season === doc.season);
    if (comps.length) {
      const box = el('div');
      for (const c of comps) {
        todoRow(box, c.name, c.won ? 'Won' : c.notStarted ? 'Not started yet' : c.result === 1 ? 'Objective met' : 'In progress', '');
      }
      box.appendChild(el('p', 'muted tiny', 'Cup brackets and group tables are not written to the save (verified) — progress and outcomes are.'));
      panel(colMain, 'Competitions', box);
    }
  }

  if (settings.newsFeed && doc.calendar?.events?.length) {
    /**
     * The save's own news feed.
     *
     * Only one kind of entry is understood: a transfer, which names both clubs.
     * The rest carry a player, a club and a date but no readable label, and
     * "event #2" told you nothing you could act on. They are counted rather
     * than captioned, because an honest gap reads better than a fake headline.
     */
    const named = doc.calendar.events.filter((e) => e.eventId === 5 && e.team1 && e.team2);
    const unlabelled = doc.calendar.events.length - named.length;
    const box = el('div');
    for (const e of named.slice(0, 10)) {
      todoRow(box, fmtDate(e.date), e.player ?? e.team1, `${e.team1} → ${e.team2}`);
    }
    if (!named.length) box.appendChild(el('p', 'muted tiny', 'No transfers in the feed yet.'));
    if (unlabelled) {
      box.appendChild(
        el(
          'p',
          'muted tiny',
          `${unlabelled} other ${unlabelled === 1 ? 'entry' : 'entries'} carry a player, a club and a date but not what happened. The save does not label the kind in a way Companion can read yet, so they are left out rather than captioned with a number.`,
        ),
      );
    }
    panel(colMain, 'Transfers around the world', box);
  }

  // ---------- side column: what needs you ----------
  {
    const box = el('div');
    for (const a of doc.alerts.slice(0, 5)) todoRow(box, a.tag, a.playerName, a.line);
    if (doc.alerts.length > 5) box.appendChild(el('p', 'muted tiny', `+${doc.alerts.length - 5} more in the rail.`));
    if (!doc.alerts.length) box.appendChild(el('p', 'muted tiny', 'Nothing outstanding.'));
    panel(colSide, `🔔 Decisions — ${doc.alerts.length}`, box);
  }

  if (settings.treatment) {
    const t2 = doc.treatment ?? { injured: [], suspended: [] };
    const box = el('div');
    for (const r of t2.injured) {
      todoRow(box, '🩹 Injured', `${r.name}${r.pos ? ` · ${r.pos}` : ''}`, `${r.daysOut !== null ? `out ~${r.daysOut} days` : 'length unrecorded'}${r.replacement ? ` — step in: ${r.replacement.name} (fit ${r.replacement.fit})` : ''}`);
    }
    for (const r of t2.suspended) {
      todoRow(box, '🟥 Suspended', `${r.name}${r.pos ? ` · ${r.pos}` : ''}`, r.replacement ? `step in: ${r.replacement.name} (fit ${r.replacement.fit})` : '');
    }
    if (!box.childElementCount) box.appendChild(el('p', 'muted tiny', 'No injuries, no suspensions.'));
    panel(colSide, '🏥 Treatment room', box);
  }

  {
    const box = el('div');
    const everyone = [...doc.senior, ...doc.academy];
    const movers = everyone
      .filter((p2) => p2.trend === 'surge' || p2.trend === 'rise')
      .sort((a, b) => (b.overallSeasonDelta ?? 0) - (a.overallSeasonDelta ?? 0))
      .slice(0, 4);
    const fallers = everyone.filter((p2) => p2.trend === 'dip' || p2.trend === 'fall').slice(0, 2);
    for (const p2 of [...movers, ...fallers]) {
      const t2 = TREND[p2.trend];
      todoRow(box, `${t2.glyph} ${p2.overallSeasonDelta > 0 ? '+' : ''}${p2.overallSeasonDelta}`, p2.name, `${p2.positionShort ?? ''} · ${p2.overall}${p2.potential && p2.potential !== p2.overall ? ` → ${p2.potential}` : ''}`);
    }
    if (!box.childElementCount) box.appendChild(el('p', 'muted tiny', 'No rating movement yet.'));
    panel(colSide, '📊 Movers', box);
  }

  {
    const box = el('div');
    for (const r of doc.stats.ceilingWatch.slice(0, 2)) {
      todoRow(box, 'Ceiling', r.name, `${r.delta > 0 ? '+' : ''}${r.delta} this season`);
    }
    const dueNow = doc.wages.renewals.filter((r) => r.urgency === 'now');
    if (dueNow.length) todoRow(box, 'Renewals', `${dueNow.length} due now`, 'Squad › Wages');
    for (const r of (doc.loans.out ?? []).slice(0, 2)) {
      todoRow(box, 'On loan', r.name, `Δ OVR ${r.overallDelta === null || r.overallDelta === undefined ? '—' : (r.overallDelta > 0 ? '+' : '') + r.overallDelta} at ${r.atTeamName ?? '?'}`);
    }
    if (!box.childElementCount) box.appendChild(el('p', 'muted tiny', 'Nothing to report.'));
    panel(colSide, '🩺 Pulse', box);
  }

  {
    const box = el('div');
    const mine = doc.opponents?.find((o) => o.teamId === doc.club?.id);
    const chosen = state.oppSel ?? ledgerNextOpponent(doc);
    const opp = doc.opponents?.find((o) => o.teamId === chosen);
    if (opp && mine) {
      const row = el('div', 'hero-line');
      for (const [l2, a, b] of [['XI', mine.overall, opp.overall], ['DEF', mine.def, opp.def], ['MID', mine.mid, opp.mid], ['ATT', mine.att, opp.att]]) {
        const cell = el('span', 'stat big');
        cell.appendChild(el('b', null, a !== null && b !== null ? `${a > b ? '+' : ''}${Math.round((a - b) * 10) / 10}` : '—'));
        cell.appendChild(el('i', null, l2));
        row.appendChild(cell);
      }
      box.appendChild(
        el(
          'p',
          'muted tiny',
          state.oppSel === null
            ? `Your edge, line by line, v ${opp.name} \u2014 your next league match, from the save's own fixture list.`
            : `Your edge, line by line, v ${opp.name}.`,
        ),
      );
      box.appendChild(row);
    } else {
      box.appendChild(
        el(
          'p',
          'muted tiny',
          "Your next opponent's slot in the fixture list has not been named yet. Pick them under Squad \u203a Team Management and the line-by-line edge lands here.",
        ),
      );
    }
    box.appendChild(go('squad', 'tactics'));
    panel(colSide, settings.rpg ? '⚔ Next fixture' : '🔎 Opponent', box);
  }

  if (settings.rpg) {
    const box = el('div');
    const ladder = activeLadder(doc);
    if (ladder) {
      const done = ladder.filter((m) => m.done).length;
      const track = el('div', 'btrack');
      const fill = el('div', `bfill${done === ladder.length ? ' done' : ''}`);
      fill.style.width = `${Math.round((done / ladder.length) * 100)}%`;
      track.appendChild(fill);
      box.appendChild(el('p', 'muted tiny', `${CAMPAIGNS[campaign.type].name} — ${done} of ${ladder.length} milestones, season ${doc.season} of 15.`));
      box.appendChild(track);
      const next = ladder.find((m) => !m.done);
      if (next) box.appendChild(el('p', 'tipline', `Next: ${next.name}${next.detail ? ` (${next.detail})` : ''}.`));
    } else {
      for (const c of rpgChallenges(doc).filter((c2) => campaign.levers.includes(c2.name)).slice(0, 4)) {
        const row = el('div', 'quest');
        const head2 = el('div', 'qhead');
        head2.appendChild(el('b', null, `${c.done ? '✓ ' : ''}${c.name}`));
        head2.appendChild(el('span', 'muted tiny', `${c.pct}%`));
        row.appendChild(head2);
        const track = el('div', 'btrack');
        const fill = el('div', `bfill${c.done ? ' done' : ''}`);
        fill.style.width = `${c.pct}%`;
        track.appendChild(fill);
        row.appendChild(track);
        box.appendChild(row);
      }
    }
    box.appendChild(go('story', 'campaign'));
    panel(colSide, '🎲 Campaign', box);
  }

  return frag;
}

/**
 * The development board. The save holds no development-plan data (verified,
 * §10) — this is the board you SET plans from: who has growth left, where each
 * player's growth buys the most, and whether the minutes are arriving.
 */
/**
 * The development board. The save holds no development-plan data (verified) —
 * this is the board you SET plans from: who has growth left, where each
 * player's growth buys the most, and whether the minutes are arriving.
 */
function renderDevelop(doc) {
  const frag = document.createDocumentFragment();
  const quests0 = questStrip(doc, 'squad/develop');
  if (quests0) frag.appendChild(quests0);
  const everyone = [...doc.senior, ...doc.academy].sort((a, b) => (b.headroom ?? 0) - (a.headroom ?? 0));
  const growers = everyone.filter((p2) => (p2.headroom ?? 0) >= 2);
  const starved = growers.filter((p2) => (p2.minutesThisSeason ?? 0) < 300 && (p2.age ?? 99) <= 23);

  const head = el('div', 'panel');
  head.appendChild(el('h2', null, '🌱 Development board'));
  head.appendChild(
    tileRow([
      ['Still growing', growers.length, 'Players with two or more points of ceiling left.'],
      ['Growth banked', everyone.reduce((a, x) => a + Math.max(0, x.overallSeasonDelta ?? 0), 0), 'Total overall points gained across the squad this season.'],
      ['Starved', starved.length, 'Under 23, growth left, and under 300 minutes — the ones a season is being wasted on.', starved.length ? 'warn' : ''],
      ['Mean ceiling', doc.stats.meanPotential ?? '—'],
    ]),
  );
  head.appendChild(
    el('p', 'muted tiny', 'Focus = the attributes where growth buys the most fit, from the fitted position weights and this world\u2019s percentiles. Point the game\u2019s development plans there; the save does not expose the plans themselves.'),
  );
  const modes2 = el('div', 'chiprow');
  for (const [label, mode] of [[`Growth left ${growers.length}`, 'grow'], [`Everyone ${everyone.length}`, 'all'], [`Needs minutes ${starved.length}`, 'starved']]) {
    const chip = el('button', `chip${(state.devFilter ?? 'grow') === mode ? ' on' : ''}`, label);
    activatable(chip, () => { state.devFilter = mode; render(); }, { skipWhen: () => (state.devFilter ?? 'grow') === mode });
    modes2.appendChild(chip);
  }
  head.appendChild(modes2);
  frag.appendChild(head);

  const pool = state.devFilter === 'all' ? everyone : state.devFilter === 'starved' ? starved : growers;
  if (!pool.length) {
    frag.appendChild(el('p', 'empty', 'Nobody here.'));
    return frag;
  }

  const grid = el('div', 'devgrid');
  for (const p2 of pool) {
    const cardEl = el('div', 'devcard');
    const top = el('div', 'devtop');
    top.appendChild(el('span', 'pos-pill', p2.positionShort ?? '—'));
    top.appendChild(el('b', 'devname', p2.name));
    top.appendChild(el('span', 'devage', p2.age !== null ? `${p2.age}y` : ''));
    const arrow = trendArrow(p2);
    if (arrow) top.appendChild(arrow);
    cardEl.appendChild(top);

    // The growth runway: how far he has come and how far is left.
    const span = el('div', 'runway');
    const from = p2.overall ?? 0;
    const to = p2.potential ?? from;
    const pct = to > 0 ? Math.round((from / to) * 100) : 0;
    const track = el('div', 'btrack');
    const fill = el('div', `bfill ${tier(p2.overall)}`);
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    span.appendChild(el('span', `runnow ${tier(p2.overall)}`, String(from)));
    span.appendChild(track);
    span.appendChild(el('span', `runceil ${tier(p2.potential)}`, String(to)));
    span.dataset.tip = `${p2.headroom ?? 0} points of ceiling still reachable`;
    cardEl.appendChild(span);

    const mins = p2.minutesThisSeason ?? 0;
    const meter = el('div', 'devmins');
    const mtrack = el('div', 'btrack');
    const mfill = el('div', `bfill ${mins >= 900 ? 't3' : mins >= 300 ? 't2' : 't1'}`);
    mfill.style.width = `${Math.max(2, Math.min(100, Math.round((mins / 900) * 100)))}%`;
    mtrack.appendChild(mfill);
    meter.appendChild(el('span', 'devlbl', 'MINUTES'));
    meter.appendChild(mtrack);
    meter.appendChild(el('span', 'devval', `${mins}'`));
    meter.dataset.tip = mins < 300 ? 'Under 300 minutes — growth stalls without games.' : 'Bar is scaled against 900 minutes, a full development season.';
    cardEl.appendChild(meter);

    const focus = el('div', 'chipwrap devfocus');
    if (p2.developFocus?.length) {
      for (const d of p2.developFocus) {
        const chip = el('span', 'chipish', `${prettyAttr(d.attr)} ${d.value}`);
        chip.dataset.tip = `${d.percentile}th percentile for his position, heavily weighted in the fit model — growth here buys the most.`;
        focus.appendChild(chip);
      }
    } else {
      focus.appendChild(el('span', 'muted tiny', 'Balanced profile'));
    }
    cardEl.appendChild(focus);

    activatable(cardEl, () => {
      state.view = 'squad';
      state.subs.squad = 'hub';
      state.hubMode = 'attributes';
      state.hubSel = p2.playerId;
      localStorage.setItem('view', 'squad');
      localStorage.setItem('subs', JSON.stringify(state.subs));
      render();
    });
    grid.appendChild(cardEl);
  }
  frag.appendChild(grid);
  return frag;
}

function renderShortlist(doc) {
  const frag = document.createDocumentFragment();
  const panel = el('div', 'panel');
  panel.appendChild(el('h2', null, `👁 Watchlist — ${shortlist.length}`));
  if (!shortlist.length) {
    panel.appendChild(
      el('p', 'muted', 'Empty. Star players under Targets and they land here with their numbers frozen at that moment — the columns then show how far they have moved since. This list is Companion\u2019s own; the game\u2019s shortlist has its own tab.'),
    );
    frag.appendChild(panel);
    return frag;
  }
  panel.appendChild(
    el('p', 'muted tiny', 'Then = the day you shortlisted. Now = this save. Drift is the story: a rising OVR means the price is rising with it.'),
  );
  const liveById = new Map((doc.transfers?.targets ?? []).map((t2) => [t2.playerId, t2]));
  // Still worth it? A verdict that moves with every save, from the live read.
  const verdictOf = (e, live) => {
    if (!live) return { text: 'no live read', tip: 'Outside the current target scan this snapshot — the frozen numbers hold until a scan sees him again.' };
    const head = (live.potential ?? 0) - (live.overall ?? 0);
    const d = live.overall !== null && e.overall !== null ? live.overall - e.overall : 0;
    if (head <= 1) return { text: 'ceiling reached', tip: `${live.overall}/${live.potential} — the growth you starred him for is spent. Only sign for what he is today.` };
    if (d >= 2) return { text: 'move now', tip: `+${d} since you starred him — every save makes him dearer, and the ceiling is still ${head} away.` };
    if (d < 0) return { text: 'cooling', tip: `${d} since you starred him — watch one more window before paying.` };
    return { text: 'still worth it', tip: `${head} of growth still ahead at the profile you starred.` };
  };
  panel.appendChild(
    table(
      ['', 'Player', 'Club', { label: 'Pos', pos: true }, { label: 'OVR then', num: true }, { label: 'OVR now', num: true }, { label: 'Δ', num: true }, { label: 'POT', num: true }, 'Fee then', 'Fee now', 'Verdict', 'Added'],
      shortlist.map((e) => {
        const live = liveById.get(e.playerId);
        const nowOvr = live?.overall ?? null;
        const d = nowOvr !== null && e.overall !== null ? nowOvr - e.overall : null;
        const verdict = verdictOf(e, live);
        return [
          { text: '', star: { on: true, onToggle: () => toggleShortlist(e, doc.gameDate) } },
          e.name,
          live?.teamName ?? e.club ?? '—',
          { text: e.pos ?? '—', cls: 'posbadge' },
          { text: e.overall ?? '—', num: true, tier: e.overall },
          { text: nowOvr ?? '—', num: true, tier: nowOvr, title: nowOvr === null ? 'Off the current target list — no live read this snapshot' : undefined },
          { text: d === null ? '—' : `${d > 0 ? '+' : ''}${d}`, num: true },
          { text: live?.potential ?? e.potential ?? '—', num: true, tier: live?.potential ?? e.potential },
          e.fee !== null ? moneyShort(e.fee) : '—',
          live?.feeGuide?.mid ? moneyShort(live.feeGuide.mid) : '—',
          { text: verdict.text, title: verdict.tip },
          e.added ? `~${fmtDate(e.added)}` : '—',
        ];
      }),
    ),
  );
  panel.appendChild(
    el('p', 'muted tiny', 'A dash under "now" means the player is outside the current 70-strong target scan this snapshot — the frozen numbers stay until you drop the star. Kept in this browser, never in the save.'),
  );
  frag.appendChild(panel);
  return frag;
}

/**
 * The campaign, on its own page and in three tiers you can tell apart at a
 * glance: THE ARC is the career ladder (where am I in the story), THIS SEASON
 * is the phase's missions, RIGHT NOW is the one-save-away nudges. They used to
 * share one column and one visual language, which is why nobody could read it.
 */
function renderCampaign(doc) {
  const frag = document.createDocumentFragment();
  if (!settings.rpg) {
    const off = el('div', 'panel');
    off.appendChild(el('h2', null, '🎲 Campaign'));
    off.appendChild(
      el('p', 'muted', 'RPG mode is off. Switch it on under Customise › Modes and this page becomes a campaign: a career-long ladder of milestones, missions that re-cut with the phase of the season, and one-save-away nudges — all computed from your real save, never rolled.'),
    );
    const go = el('button', 'ghost', 'Open Customise ›');
    activatable(go, () => {
      state.view = 'customise';
      localStorage.setItem('view', 'customise');
      render();
    });
    off.appendChild(go);
    frag.appendChild(off);
    return frag;
  }

  const def = CAMPAIGNS[campaign.type];
  const blend = activeCampaigns();
  const ladder = activeLadder(doc);
  const { phase, missions, micro } = campaignMissions(doc);
  const seasonsRun = doc.season ?? 1;
  const CAREER = 15;

  // --- the banner: which campaign, and how far into the career
  {
    const hero = el('div', 'panel camphero');
    const top = el('div', 'camptop');
    top.appendChild(el('h2', null, def.name));
    top.appendChild(el('span', 'campblurb', def.blurb));
    hero.appendChild(top);
    if (def.creed) hero.appendChild(el('p', 'campcreed', def.creed));
    if (campaign.type === 'custom' && blend.length) {
      const strands = el('div', 'chipwrap');
      for (const k of blend) {
        const chip = el('span', 'strandchip', CAMPAIGNS[k].name);
        chip.dataset.tip = CAMPAIGNS[k].creed ?? CAMPAIGNS[k].blurb;
        strands.appendChild(chip);
      }
      hero.appendChild(strands);
    }

    const steps = el('div', 'seasonsteps');
    for (let i = 1; i <= CAREER; i++) {
      const dot = el('i', `sstep${i < seasonsRun ? ' past' : i === seasonsRun ? ' now' : ''}`);
      dot.dataset.tip = i === seasonsRun ? `Season ${i} — you are here` : `Season ${i}`;
      steps.appendChild(dot);
    }
    hero.appendChild(steps);
    // The chapter line is the campaign's voice, so it lives with the campaign
    // rather than on the first screen everybody reads for facts.
    const chapter = campaignLine(doc);
    if (chapter) hero.appendChild(el('p', 'chapterline', chapter));
    hero.appendChild(el('p', 'muted tiny', `Season ${seasonsRun} of a ${CAREER}-season career.`));
    frag.appendChild(hero);
  }

  const cols = el('div', 'campcols');

  // --- tier 1: the career arc, as a stepper
  {
    const panel = el('div', 'panel');
    if (ladder) {
      const done = ladder.filter((m) => m.done).length;
      const h = el('h2', null, '🏔 The arc');
      panel.appendChild(h);
      panel.appendChild(el('p', 'muted tiny', `${done} of ${ladder.length} career milestones. These outlast a season — they are the story the save is telling.`));
      const track = el('div', 'btrack big');
      const fill = el('div', `bfill${done === ladder.length ? ' done' : ''}`);
      fill.style.width = `${Math.round((done / ladder.length) * 100)}%`;
      track.appendChild(fill);
      panel.appendChild(track);

      const stepper = el('div', 'stepper');
      let nextNamed = false;
      for (const m of ladder) {
        const isNext = !m.done && !nextNamed;
        if (isNext) nextNamed = true;
        const row = el('div', `step${m.done ? ' done' : isNext ? ' next' : ''}`);
        row.appendChild(el('i', 'stepmark', m.done ? '✓' : isNext ? '▶' : ''));
        const body = el('div', 'stepbody');
        body.appendChild(el('b', null, m.name));
        if (m.strand) body.appendChild(el('span', 'strandtag', m.strand));
        if (m.detail) body.appendChild(el('span', 'stepdetail', m.detail));
        if (isNext) body.appendChild(el('span', 'stepnow', 'you are here'));
        row.appendChild(body);
        stepper.appendChild(row);
      }
      panel.appendChild(stepper);
    } else {
      panel.appendChild(el('h2', null, 'Your blend'));
      panel.appendChild(
        el('p', 'muted', 'A custom campaign is a mixture of the others. Pick the strands you care about under Customise and their ladders interleave here, so the arc advances on every front at once instead of finishing one story before starting the next.'),
      );
      const go = el('button', 'ghost', 'Choose your strands ›');
      activatable(go, () => {
        state.view = 'customise';
        localStorage.setItem('view', 'customise');
        render();
      });
      panel.appendChild(go);
    }
    cols.appendChild(panel);
  }

  // --- tiers 2 and 3: the season, and right now
  {
    const right = el('div', 'campright');

    const season = el('div', 'panel');
    season.appendChild(el('h2', null, '📅 This season'));
    const banner = el('p', 'phasebanner', phase.label);
    if (phase.plain) banner.dataset.tip = phase.plain;
    season.appendChild(banner);
    if (missions.length) {
      for (const c of missions) season.appendChild(questRow(c.name, c.line, c.pct, c.done));
      season.appendChild(el('p', 'muted tiny', 'Missions re-cut with the phase of the season — the windows, the grind, the run-in.'));
    } else {
      season.appendChild(el('p', 'muted tiny', 'No live mission for this phase of this campaign.'));
    }
    right.appendChild(season);

    const now = el('div', 'panel');
    now.appendChild(el('h2', null, '⚡ Right now'));
    if (micro.length) {
      for (const c of micro) now.appendChild(questRow(c.name, c.line, c.pct, c.done, true));
      now.appendChild(el('p', 'muted tiny', 'Small marks, re-read from the leaders\u2019 own numbers with every save.'));
    } else {
      now.appendChild(el('p', 'muted tiny', 'Nothing within reach this save — play a few matches and the marks appear.'));
    }
    right.appendChild(now);

    cols.appendChild(right);
  }

  frag.appendChild(cols);
  return frag;
}

/**
 * The campaign, wherever the work actually happens.
 *
 * RPG mode is a lens, not a tab: when it is on, the missions that concern a
 * view appear at the top of it in the campaign's own violet, so a quest is
 * next to the thing you would do about it. Off, nothing changes anywhere.
 */
function questStrip(doc, where) {
  if (!settings.rpg || !doc?.seasons?.length) return null;
  let all;
  try {
    all = campaignMissions(doc);
  } catch {
    return null;
  }
  const mine = [...all.missions, ...all.micro].filter((q) => q.where === where);
  if (!mine.length) return null;

  const box = el('div', 'panel questpanel');
  const head = el('h2', null, CAMPAIGNS[campaign.type].name);
  head.appendChild(el('span', 'questbadge', all.phase.label));
  box.appendChild(head);
  const chapter = campaignLine(doc);
  if (chapter) box.appendChild(el('p', 'chapterline', chapter));
  const grid = el('div', 'queststrip');
  for (const q of mine) grid.appendChild(questRow(q.name, q.line, q.pct, q.done, true));
  box.appendChild(grid);
  const go = el('button', 'ghost tiny-btn', 'The whole campaign ›');
  activatable(go, () => {
    state.view = 'story';
    state.subs.story = 'campaign';
    localStorage.setItem('view', 'story');
    localStorage.setItem('subs', JSON.stringify(state.subs));
    render();
  });
  box.appendChild(go);
  return box;
}

/** One mission: name, the number behind it, and how far along it is. */
function questRow(name, line, pct, done, small) {
  const row = el('div', `quest${small ? ' micro' : ''}${done ? ' is-done' : ''}`);
  const head = el('div', 'qhead');
  head.appendChild(el('b', null, `${done ? '✓ ' : ''}${name}`));
  head.appendChild(el('span', 'qline', line));
  row.appendChild(head);
  const track = el('div', 'btrack');
  const fill = el('div', `bfill${done ? ' done' : ''}`);
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  track.appendChild(fill);
  row.appendChild(track);
  return row;
}

/**
 * The Chronicle: the career as chapters, written from the record.
 *
 * Every line is a fact the save carries — the finish, the trophies, the record
 * scoreline, the biggest deal, the milestone that fell that year. Nothing is
 * narrated that did not happen.
 */
function renderChronicle(doc) {
  const frag = document.createDocumentFragment();
  const seasons = [...(doc.seasons ?? [])].sort((a, b) => b.season - a.season);
  const compsBySeason = new Map();
  for (const c of doc.board?.competitions ?? []) {
    if (!c.won) continue;
    compsBySeason.set(c.season, [...(compsBySeason.get(c.season) ?? []), c.name]);
  }

  {
    const hero = el('div', 'panel');
    hero.appendChild(el('h2', null, `${doc.club?.name ?? 'The club'} — the chronicle`));
    const trophies = seasons.reduce((a, x) => a + x.leagueTrophies + x.cupTrophies, 0);
    const totals = seasons.reduce(
      (a, x) => ({ w: a.w + x.wins, d: a.d + x.draws, l: a.l + x.losses }),
      { w: 0, d: 0, l: 0 },
    );
    hero.appendChild(
      tileRow([
        ['Chapters', seasons.length],
        ['Trophies', trophies || null],
        ['Record', totals.w + totals.d + totals.l ? `${totals.w}-${totals.d}-${totals.l}` : null],
        ['Recorded', (doc.story ?? []).length || null, 'Events in the ledger — each written the first time it was seen, and never rewritten.'],
        ['Manager', doc.manager],
      ]),
    );
    hero.appendChild(
      el('p', 'muted tiny', 'The ledger records what happened and when Companion first saw it: trophies, finishes, record scorelines, the transfer business, promotions out of the academy, and players crossing 80, 85 and 90. History starts the day the watcher does — earlier seasons are read from the save\u2019s own record and carry no date.'),
    );
    frag.appendChild(hero);
  }

  const book = el('div', 'chronicle');
  for (const sn of seasons) {
    const live = sn.season === doc.season && (sn.position ?? 0) <= 0;
    const chapter = el('div', `chapter${live ? ' live' : ''}${sn.position === 1 ? ' title' : ''}`);

    const head = el('div', 'chhead');
    head.appendChild(el('i', 'chnum', `Season ${sn.season}`));
    const verdict = live
      ? 'in progress'
      : sn.position === 1
        ? 'CHAMPIONS'
        : sn.position && sn.position > 0
          ? `finished ${ordinal(sn.position)}`
          : 'unrecorded';
    head.appendChild(el('b', 'chverdict', verdict));
    chapter.appendChild(head);

    const line = el('div', 'chline');
    const stat = (label, v, cls) => {
      const c = el('span', `chstat${cls ? ` ${cls}` : ''}`);
      c.appendChild(el('i', null, label));
      c.appendChild(el('b', null, String(v)));
      line.appendChild(c);
    };
    stat('W', sn.wins, 'up');
    stat('D', sn.draws);
    stat('L', sn.losses, 'down');
    if (sn.points !== null) stat('Pts', sn.points, 'accent');
    if (sn.goalsFor !== null) stat('Goals', `${sn.goalsFor}:${sn.goalsAgainst}`);
    chapter.appendChild(line);

    // The ledger is the source: dated entries written the first time each thing
    // was seen. What it has not witnessed yet is filled from the season record,
    // undated and marked as such, rather than pretending to a date.
    const iconFor = (kind) => icon(EVENT_ICONS[kind] ?? 'check', 14);
    // A date is shown only when it belongs to the season it is filed under.
    // Everything already in the save when the watcher started was stamped with
    // the day we first read it, and dating season one with today's date would
    // be a lie dressed as history.
    const seasonOfDate = (ymd) => {
      if (!ymd || !doc.gameDate || doc.season === null) return null;
      const yearOf = (d) => (Math.floor((d % 10000) / 100) >= 7 ? Math.floor(d / 10000) : Math.floor(d / 10000) - 1);
      return doc.season - (yearOf(doc.gameDate) - yearOf(ymd));
    };
    const ledger = (doc.story ?? []).filter((e) => e.season === sn.season && e.kind !== 'season');
    const events = ledger.map((e) => [
      e.kind,
      e.title,
      e.detail,
      seasonOfDate(e.gameDate) === e.season ? e.gameDate : null,
    ]);
    if (!ledger.length) {
      for (const name of compsBySeason.get(sn.season) ?? []) events.push(['trophy', `Won the ${name}`, null, null]);
      if (sn.bigBuy) events.push(['signing', `Signed ${sn.bigBuy.name}`, moneyShort(sn.bigBuy.amount), null]);
      if (sn.bigSell) events.push(['sale', `Sold ${sn.bigSell.name}`, moneyShort(sn.bigSell.amount), null]);
    }
    if (live) {
      const pace = sn.played ? Math.round(((sn.points ?? 0) / sn.played) * 38) : null;
      if (pace !== null) events.push(['milestone', `${sn.played} played, on a ${pace}-point pace`, null, null]);
    }
    if (events.length) {
      const list = el('div', 'chevents');
      for (const [kind, text, detail, when] of events) {
        const row = el('div', 'chevent');
        const mark = el('i', `chico k-${kind}`);
        mark.appendChild(iconFor(kind));
        row.appendChild(mark);
        const body = el('span', 'chbody');
        body.appendChild(el('b', null, text));
        if (detail) body.appendChild(el('span', 'chdetail', detail));
        row.appendChild(body);
        if (when) row.appendChild(el('span', 'chwhen', fmtDate(when)));
        list.appendChild(row);
      }
      chapter.appendChild(list);
    }
    book.appendChild(chapter);
  }
  if (!seasons.length) book.appendChild(el('p', 'empty', 'No seasons recorded yet.'));
  frag.appendChild(book);

  if (settings.rpg) {
    const ladder = activeLadder(doc);
    if (ladder) {
      const done = ladder.filter((m) => m.done);
      const panel = el('div', 'panel questpanel');
      panel.appendChild(el('h2', null, `${CAMPAIGNS[campaign.type].name} — milestones reached`));
      if (done.length) {
        const list = el('div', 'chevents');
        for (const m of done) {
          const row = el('div', 'chevent');
          row.appendChild(el('i', null, '✓'));
          row.append(`${m.name}${m.detail ? ` — ${m.detail}` : ''}`);
          list.appendChild(row);
        }
        panel.appendChild(list);
      } else {
        panel.appendChild(el('p', 'muted tiny', 'No milestone reached yet. The first one is always the hardest.'));
      }
      frag.appendChild(panel);
    }
  }
  return frag;
}

function renderSettings() {
  const frag = document.createDocumentFragment();
  const intro = el('div', 'panel');
  intro.appendChild(el('h2', null, '⚙ Customise'));
  intro.appendChild(el('p', 'muted', 'Everything here lives in this browser. Nothing touches the save, the store, or the network.'));

  // Landing tab: chips, not a switch.
  const landRow = el('div', 'setrow');
  const landTxt = el('div', 'settext');
  landTxt.appendChild(el('b', null, 'Landing tab'));
  landTxt.appendChild(el('span', 'muted tiny', 'Where Companion opens. "Last used" follows you around instead.'));
  const landChips = el('div', 'chiprow');
  const landing = typeof settings.landing === 'string' ? settings.landing : null;
  for (const [id, label] of [[null, 'Last used'], ...LANDING_CHOICES.map((v2) => [v2, VIEWS[v2].label])]) {
    const chip = el('button', `chip${landing === id ? ' on' : ''}`, label);
    activatable(chip, () => {
      if (id === null) delete settings.landing;
      else settings.landing = id;
      saveSettings();
      render();
    }, { skipWhen: () => landing === id });
    landChips.appendChild(chip);
  }
  landTxt.appendChild(landChips);
  landRow.appendChild(landTxt);
  intro.appendChild(landRow);
  frag.appendChild(intro);

  /**
   * Which save file Companion reads.
   *
   * Unlike everything else on this screen, this one is NOT a browser setting: it
   * changes what the app is looking at, so it lives on the server and survives a
   * restart. It also moves the watcher, which is the part worth saying out loud
   * — a chosen file is followed just as closely as the game's own.
   */
  const savePanel = el('div', 'panel');
  savePanel.appendChild(el('h2', null, 'Save file'));
  const saveBody = el('div', 'savebody');
  saveBody.appendChild(el('p', 'muted tiny', 'Loading\u2026'));
  savePanel.appendChild(saveBody);
  frag.appendChild(savePanel);

  const bytesLabel = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const paintSaves = (info) => {
    saveBody.replaceChildren();
    if (!info || info.error) {
      saveBody.appendChild(el('p', 'muted tiny', info?.error ?? 'Could not read the save list.'));
      return;
    }
    const following = el('p', 'muted tiny');
    following.append(
      info.following === 'newest'
        ? 'Following the newest Manager Career save the game writes. '
        : 'Following a file you chose. ',
      `The watcher is on ${info.watching}, so a save written there \u2014 by the game or by anything else \u2014 lands on screen by itself.`,
    );
    saveBody.appendChild(following);

    const list = el('div', 'savelist');
    const row = (c) => {
      const item = el('div', `saverow${c.active ? ' on' : ''}`);
      const text = el('div', 'savetext');
      text.appendChild(el('b', null, c.name));
      text.appendChild(
        el('span', 'muted tiny', `${bytesLabel(c.sizeBytes)} \u00b7 saved ${new Date(c.modified).toLocaleString()}`),
      );
      text.appendChild(el('span', 'savepath', c.path));
      item.appendChild(text);
      const pick = el('button', `chip${c.active ? ' on' : ''}`, c.active ? 'In use' : 'Use this');
      if (!c.active) activatable(pick, () => choose(c.path));
      item.appendChild(pick);
      return item;
    };
    for (const c of info.candidates ?? []) list.appendChild(row(c));
    saveBody.appendChild(list);

    const custom = el('div', 'saveadd');
    const field = el('input', 'saveinput');
    field.type = 'text';
    field.placeholder = 'Paste the full path to a save file';
    field.spellcheck = false;
    if (info.chosenPath) field.value = info.chosenPath;
    const go = el('button', 'chip', 'Load this file');
    activatable(go, () => choose(field.value.trim()));
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') choose(field.value.trim());
    });
    custom.appendChild(field);
    custom.appendChild(go);
    saveBody.appendChild(custom);

    if (info.following !== 'newest') {
      const back = el('button', 'chip', 'Go back to the newest save');
      activatable(back, () => choose(null));
      saveBody.appendChild(back);
    }
    saveBody.appendChild(
      el(
        'p',
        'muted tiny',
        'A downloaded save is just a file on this machine \u2014 put it anywhere and point at it here. Companion opens local paths and nothing else.',
      ),
    );
  };

  const choose = (path) => {
    saveBody.replaceChildren(el('p', 'muted tiny', 'Loading that save\u2026'));
    fetch('/api/saves', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path || null }),
    })
      .then((r) => r.json())
      .then((info) => {
        paintSaves(info);
        if (!info.error) load();
      })
      .catch(() => paintSaves({ error: 'Could not reach Companion to change the save.' }));
  };

  fetch('/api/saves')
    .then((r) => r.json())
    .then(paintSaves)
    .catch(() => paintSaves({ error: 'Could not reach Companion to read the save list.' }));

  const grid = el('div', 'setgrid');
  // Modes are not a list of switches: each one changes what the whole app is,
  // so each gets its own box.
  const groups = [...new Set(SETTING_DEFS.map((d) => (d.group === 'Modes' ? d.label : d.group)))];
  for (const g of groups) {
    const card = el('div', `panel${g.includes('RPG') ? ' modecard rpgcard' : g.includes('AI') ? ' modecard aicard' : ''}`);
    const heading = el('h2', null, g);
    if (g.includes('AI')) heading.appendChild(el('span', 'statuspill', 'Not available yet'));
    card.appendChild(heading);
    for (const def of SETTING_DEFS.filter((d) => (d.group === 'Modes' ? d.label : d.group) === g)) {
      const row = el('div', `setrow${def.disabled ? ' is-disabled' : ''}`);
      const sw = el('button', `switch${settings[def.key] && !def.disabled ? ' on' : ''}${def.disabled ? ' off-limits' : ''}`);
      sw.appendChild(el('i', 'knob'));
      if (def.disabled) {
        sw.disabled = true;
        sw.dataset.tip = 'Nothing is wired behind this yet — it turns on when there is.';
      } else {
        activatable(sw, () => {
          settings[def.key] = !settings[def.key];
          saveSettings();
          render();
        });
      }
      row.appendChild(sw);
      const txt = el('div', 'settext');
      txt.appendChild(el('b', null, def.label));
      txt.appendChild(el('span', 'muted tiny', def.note));
      if (def.key === 'rpg' && settings.rpg) {
        const chips = el('div', 'chiprow');
        for (const [key, cdef] of Object.entries(CAMPAIGNS)) {
          const chip = el('button', `chip${campaign.type === key ? ' on' : ''}`, cdef.name);
          chip.dataset.tip = cdef.blurb;
          activatable(chip, () => { campaign.type = key; saveCampaign(); render(); }, { skipWhen: () => campaign.type === key });
          chips.appendChild(chip);
        }
        txt.appendChild(chips);
        if (campaign.type === 'custom') {
          txt.appendChild(
            el('p', 'muted tiny', 'Blend two or three. Their ladders interleave and their missions merge, so the campaign stays one story.'),
          );
          const lchips = el('div', 'chiprow');
          for (const k of BLENDABLE) {
            const on = (campaign.blend ?? []).includes(k);
            const chip = el('button', `chip${on ? ' on' : ''}`, CAMPAIGNS[k].name);
            chip.dataset.tip = CAMPAIGNS[k].creed ?? CAMPAIGNS[k].blurb;
            activatable(chip, () => {
              campaign.blend = on
                ? campaign.blend.filter((x) => x !== k)
                : [...(campaign.blend ?? []), k];
              saveCampaign();
              render();
            });
            lchips.appendChild(chip);
          }
          txt.appendChild(lchips);
        }
      }

      row.appendChild(txt);
      card.appendChild(row);
    }
    grid.appendChild(card);
  }
  frag.appendChild(grid);

  const foot = el('div', 'panel');
  foot.appendChild(el('h2', null, '🧾 The contract'));
  foot.appendChild(
    el('p', 'muted tiny', 'Companion reads the save, never writes it. Real data only — a fact the save does not carry renders as unknown, and anything derived wears a ~. Local only: the server binds to this machine unless you started it with --lan, and even then it only speaks to your own network.'),
  );
  frag.appendChild(foot);
  return frag;
}

/**
 * The game's own menu: Central, Squad, Transfers, Academy, Office, Customise —
 * plus Story, ours. Sections nest the way the game's sub-menus do.
 */
const VIEWS = {
  central: { label: 'Central', render: renderCentral, count: (d) => d.alerts.length || null },
  squad: {
    label: 'Squad',
    subs: [
      { id: 'hub', label: 'Squad Hub', render: renderSquadHub, players: true },
      { id: 'tactics', label: 'Team Management', render: renderMatchday, count: (d) => d.matchday.diff.filter((x) => x.savedPlayerId !== x.recommendedPlayerId).length || null },
      { id: 'develop', label: 'Development', render: renderDevelop },
      { id: 'synergy', label: 'Synergy', render: renderSynergy },
      { id: 'wages', label: 'Wages', render: renderWages, count: (d) => d.wages.renewals.filter((r) => r.urgency === 'now').length || null },
      { id: 'coach', label: 'Coach', render: renderCoach },
    ],
  },
  transfers: {
    label: 'Transfers',
    subs: [
      { id: 'targets', label: 'Targets', render: renderTransfers, count: (d) => d.transfers.targets.length || null },
      { id: 'shortlist', label: 'Shortlist', render: renderIngameShortlist, count: (d) => d.shortlistIngame?.players?.length || null },
      { id: 'watchlist', label: 'Watchlist', render: renderShortlist, count: () => shortlist.length || null },
      { id: 'sell', label: 'Sell Values', render: renderSellValues },
      { id: 'loans', label: 'Loans', render: renderLoans, count: (d) => d.loans.out.length || null },
    ],
  },
  academy: {
    label: 'Academy',
    subs: [
      { id: 'players', label: 'My Academy', render: renderAcademyHub, players: true, count: (d) => d.academy.length || null },
      { id: 'scouting', label: 'Scout Reports', render: renderScouting, count: (d) => (settings.scoutReports ? d.academyReports.length || null : null), hidden: () => !settings.scoutReports },
    ],
  },
  office: {
    label: 'Office',
    subs: [
      { id: 'board', label: 'Board', render: renderBoard },
      { id: 'manager', label: 'Manager', render: renderManagerOffice },
      { id: 'market', label: 'Manager Market', render: renderManagerMarket },
      { id: 'finances', label: 'Finances', render: renderFinances },
      { id: 'stats', label: 'Club Stats', render: renderStats },
      { id: 'challenges', label: 'Challenges', render: renderChallenges },
    ],
  },
  story: {
    label: 'Story',
    subs: [
      { id: 'chronicle', label: 'Chronicle', render: renderChronicle },
      { id: 'card', label: 'Brag card', render: renderStory },
      { id: 'campaign', label: 'Campaign', render: renderCampaign },
    ],
  },
  customise: { label: 'Customise', render: renderSettings, count: () => null },
};

/** The active sub-tab of the active view, remembered per section. */
const activeSub = () => {
  const view = VIEWS[state.view];
  if (!view?.subs) return null;
  const shown = view.subs.filter((s2) => !s2.hidden?.());
  const stored = state.subs[state.view];
  return shown.find((s2) => s2.id === stored) ?? shown[0] ?? null;
};

/* ---------------- shell ---------------- */

function renderShell(doc) {
  const views = $('#views');
  views.textContent = '';
  for (const [id, view] of Object.entries(VIEWS)) {
    const tab = el('button', `tab${id === state.view ? ' is-active' : ''}`);
    tab.append(view.label);
    const n = view.count ? view.count(doc) : null;
    if (n !== null && n !== undefined) tab.appendChild(el('span', 'count', n));
    activatable(
      tab,
      () => {
        state.view = id;
        localStorage.setItem('view', id);
        render();
      },
      { skipWhen: () => state.view === id },
    );
    views.appendChild(tab);
  }

  // Second row: the section's own sub-tabs, the way the game's menus nest.
  const subnav = $('#subviews');
  subnav.textContent = '';
  const activeView = VIEWS[state.view];
  const sub = activeSub();
  if (activeView.subs) {
    for (const s2 of activeView.subs.filter((x) => !x.hidden?.())) {
      const b = el('button', `subtab${sub?.id === s2.id ? ' is-active' : ''}`);
      b.append(s2.label);
      const n2 = s2.count ? s2.count(doc) : null;
      if (n2) b.appendChild(el('span', 'count', n2));
      activatable(
        b,
        () => {
          state.subs[state.view] = s2.id;
          localStorage.setItem('subs', JSON.stringify(state.subs));
          render();
        },
        { skipWhen: () => sub?.id === s2.id },
      );
      subnav.appendChild(b);
    }
  }
  subnav.style.display = activeView.subs ? '' : 'none';

  const filters = $('#filters');
  filters.textContent = '';
  const wantsRoster = !!(activeView.players || sub?.players);
  if (wantsRoster) {
    const list = state.view === 'academy' ? doc.academy : doc.senior;

    const toggle = (id) => () => {
      if (state.filters.has(id)) state.filters.delete(id);
      else state.filters.add(id);
      localStorage.setItem('filters', JSON.stringify([...state.filters]));
      render();
    };

    for (const f of positionFilters(list)) {
      const chip = el('button', `chip pos${state.filters.has(f.id) ? ' on' : ''}`);
      chip.append(f.label);
      chip.appendChild(el('span', 'n', f.n));
      activatable(chip, toggle(f.id), { skipWhen: () => state.filters.has(f.id) });
      filters.appendChild(chip);
    }
    filters.appendChild(el('span', 'sep'));

    for (const f of FILTERS) {
      const n = list.filter(f.test).length;
      if (n === 0 && !state.filters.has(f.id)) continue;
      const chip = el('button', `chip${state.filters.has(f.id) ? ' on' : ''}`);
      chip.append(f.label);
      chip.appendChild(el('span', 'n', n));
      activatable(chip, toggle(f.id), { skipWhen: () => state.filters.has(f.id) });
      filters.appendChild(chip);
    }
    if (state.filters.size) {
      const clear = el('button', 'chip', 'Clear');
      activatable(clear, () => {
        state.filters.clear();
        localStorage.setItem('filters', '[]');
        render();
      });
      filters.appendChild(clear);
    }
  }
  // Off the rosters the strip only explained its own absence — give the row back.
  filters.style.display = wantsRoster ? '' : 'none';

  const rail = $('#rail');
  rail.textContent = '';
  rail.style.display = settings.rail ? '' : 'none';
  const alerts = settings.rail ? doc.alerts.slice(0, 40) : [];

  // The rail announces itself once and can be put away entirely — it is the
  // loudest thing on the page, so it has to be dismissible.
  const head = el('div', 'rail-head');
  head.appendChild(el('b', null, alerts.length ? `Needs attention` : 'Nothing needs attention'));
  if (alerts.length) head.appendChild(el('span', 'n', alerts.length));
  const toggle = el('button', 'ghost', state.rail ? 'Hide' : 'Show');
  activatable(toggle, () => {
    state.rail = !state.rail;
    localStorage.setItem('rail', state.rail ? 'open' : 'hidden');
    render();
  });
  head.appendChild(toggle);
  rail.appendChild(head);

  if (state.rail && alerts.length) {
    const list = el('div', 'rail-list');
    for (const a of alerts.slice(0, state.railAll ? 40 : 8)) {
      const node = el('div', `alert ${a.severity}`);
      node.appendChild(el('span', `dot ${a.severity}`));
      node.appendChild(el('span', `act ${a.severity}`, a.tag));
      node.appendChild(el('b', null, a.playerName));
      node.appendChild(el('span', 'aline', a.line));
      node.title = `${a.line}
${a.evidence}  [${a.rule}]`;
      list.appendChild(node);
    }
    if (alerts.length > 8) {
      const more = el('button', 'chip', state.railAll ? 'Show fewer' : `All ${alerts.length}`);
      activatable(more, () => {
        state.railAll = !state.railAll;
        render();
      });
      list.appendChild(more);
    }
    rail.appendChild(list);
  }
}

/**
 * Panels state their name and show their numbers. Anything explanatory folds
 * into an `i` on the heading — one affordance, one place, no walls of prose.
 * Applied to the built DOM so no view has to remember to do it.
 */
function polishPanels(root) {
  for (const panel of root.querySelectorAll('.panel')) {
    const h = panel.querySelector(':scope > h2');
    if (!h) continue;

    // The heading is a name with a mark, not a decorated sentence: emoji out,
    // one line icon in, chosen centrally so the set stays small and no view
    // has to remember.
    for (const node of h.childNodes) {
      if (node.nodeType !== 3) continue;
      node.textContent = node.textContent.replace(
        /^[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]+\s*/u,
        '',
      );
    }
    if (!h.querySelector('.ico')) {
      const label = h.textContent.trim();
      const hit = HEADING_ICONS.find(([re]) => re.test(label));
      if (hit) h.prepend(icon(hit[1], 15));
    }

    // Every explanatory paragraph inside the panel, however deeply a view
    // happened to nest it — but never one inside a card, a table or a mission,
    // where the words are the content rather than a description of it.
    const prose = [...panel.querySelectorAll('p.muted')].filter(
      (k) => !k.closest('.card, table, .quest, .step, .pkg, .clause, .linkcard, .devcard, .loancard, .settext, .compcard'),
    );
    const substantive = [...panel.querySelectorAll(':scope > *')].filter(
      (k) => k !== h && !prose.includes(k) && !(k.children.length === 0 && prose.includes(k)),
    ).length;
    if (!prose.length || substantive === 0) continue;

    const info = el('button', 'infobtn');
    info.appendChild(icon('info', 13));
    info.setAttribute('aria-label', 'About this panel');
    info.dataset.tip = prose.map((x) => x.textContent.trim()).filter(Boolean).join('\n\n');
    h.appendChild(info);
    for (const x of prose) x.remove();
  }
}

function render() {
  window.__doc = state.doc;
  document.body.classList.toggle('compact', !!settings.compact);
  // The game saves constantly while you play and every save re-renders this
  // page — without restoring scroll, a phone reading a player card snaps back
  // to the top mid-read and the lower groups look like they never render.
  const scrollY = window.scrollY;

  const doc = state.doc;
  const main = $('#main');
  main.textContent = '';

  if (!doc || doc.error) {
    main.appendChild(el('p', 'empty', doc?.error ?? 'Waiting for the first save…'));
    return;
  }

  $('#club').textContent = [doc.club.name, doc.manager].filter(Boolean).join(' · ') || '—';
  // Companion only ever sees what the game has written. If the screen looks
  // behind the game, the save is behind the game.
  const synced = $('#synced');
  if (synced) {
    synced.dataset.tip =
      'Companion reads the save file, so it can only be as current as your last save. ' +
      'If something on screen looks out of date, save in game (or advance a day) and it updates within a few seconds.';
  }
  $('#game-date').textContent = `~${fmtDate(doc.gameDate)}`;
  $('#game-date').title = `Estimated from ${doc.gameDateBasis || 'nothing'} — the save has no live date field`;

  const warn = $('#warnings');
  warn.textContent = '';
  if (doc.warnings.length) {
    for (const w of doc.warnings) warn.appendChild(el('p', null, w));
    warn.hidden = false;
  } else warn.hidden = true;

  renderShell(doc);
  hideTip();
  requestAnimationFrame(() => {
    // Restoring the old position is right for a background refresh, but wrong
    // the moment you opened something: then the thing you opened is what you
    // want to be looking at.
    if (state.reveal) {
      state.reveal = false;
      const card = document.querySelector('tr.detailrow');
      if (card) {
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
    }
    window.scrollTo(0, scrollY);
  });


  main.appendChild((activeSub()?.render ?? VIEWS[state.view].render)(doc));
  polishPanels(main);

  $('#counts').textContent =
    `${doc.senior.length} senior · ${doc.academy.length} academy · season ${doc.season ?? '?'} · ` +
    `${doc.snapshots} snapshot${doc.snapshots === 1 ? '' : 's'} · names ${doc.names.squad[0]}/${doc.names.squad[1]}`;
}

/**
 * The sync light, which answers "is what I am looking at current?".
 *
 *   blue   a new save has landed and is being read
 *   green  fresh — read within the last ten minutes
 *   amber  ten minutes old; the game has probably moved on
 *   red    half an hour old; save in game to catch up
 *   grey   not connected to the server at all
 *
 * The clock is wall-clock time since the last save Companion read, which is
 * the only thing that can tell you the screen is behind the game.
 */
function paintSync() {
  const node = $('#synced');
  if (!node) return;
  const dot = $('#syncdot');

  if (state.connection === 'offline') {
    node.textContent = 'not connected';
    if (dot) dot.className = 'syncdot grey';
    node.dataset.tip = 'The Companion server is not answering. Start it again (Companion.vbs) and this reconnects on its own.';
    return;
  }
  if (state.connection === 'loading') {
    node.textContent = 'reading save…';
    if (dot) dot.className = 'syncdot blue';
    node.dataset.tip = 'A new save landed and is being parsed.';
    return;
  }
  if (!state.lastSync) {
    node.textContent = 'never synced';
    if (dot) dot.className = 'syncdot grey';
    return;
  }

  const secs = Math.round((Date.now() - state.lastSync) / 1000);
  const mins = secs / 60;
  node.textContent = secs < 60 ? `synced ${secs}s ago` : `synced ${Math.round(mins)}m ago`;
  if (dot) dot.className = `syncdot ${mins >= 30 ? 'red' : mins >= 10 ? 'amber' : 'green'}`;
  node.dataset.tip =
    mins >= 30
      ? 'Half an hour since the last save Companion read — the screen is almost certainly behind the game. Save in game to catch up.'
      : mins >= 10
        ? 'Ten minutes since the last save. If something looks out of date, save in game.'
        : 'Companion reads the save file, so it is only ever as current as your last save. Save in game and it updates within a few seconds.';
}

async function load(flash = false) {
  try {
    const response = await fetch('/api/view', { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    state.doc = await response.json();
    state.lastSync = Date.now();
    state.connection = 'live';
  } catch {
    state.connection = 'offline';
    paintSync();
    return;
  }
  render();
  paintSync();
  if (flash) {
    document.body.classList.add('flash');
    setTimeout(() => document.body.classList.remove('flash'), 1000);
  }
}

function wire() {
  // Old single-level view ids map into the new sections so a returning browser
  // lands where it used to work, not on a blank tab.
  const MIGRATE = {
    overview: ['central'], matchday: ['squad', 'tactics'], squad: ['squad', 'hub'],
    youth: ['academy', 'players'], develop: ['squad', 'develop'], synergy: ['squad', 'synergy'],
    wages: ['squad', 'wages'], loans: ['transfers', 'loans'], stats: ['office', 'stats'],
    shortlist: ['transfers', 'watchlist'], settings: ['customise'],
  };
  const storedView = localStorage.getItem('view');
  // Only a browser that has never seen the two-level nav gets migrated —
  // 'squad' is both an old id and a new one, and re-migrating on every load
  // would clobber the remembered sub-tab.
  if (storedView && MIGRATE[storedView] && localStorage.getItem('subs') === null) {
    const [v2, s2] = MIGRATE[storedView];
    localStorage.setItem('view', v2);
    if (s2) {
      state.subs[v2] = s2;
      localStorage.setItem('subs', JSON.stringify(state.subs));
    }
  }
  // The landing preference decides where a fresh open starts; without one,
  // the last-used tab wins as before.
  state.view =
    typeof settings.landing === 'string' && VIEWS[settings.landing]
      ? settings.landing
      : storedPref('view', Object.keys(VIEWS), 'central');
  state.sort = storedPref('sort', Object.keys(SORTS), 'ingame');
  state.filters = new Set(
    [...state.filters].filter((id) => FILTERS.some((f) => f.id === id)),
  );

  // One look: FC26. The second screen reads as an extension of the game's own
  // menus — near-black with volt green — and no longer argues about it.
  document.documentElement.dataset.theme = 'fc26';
  localStorage.removeItem('theme');


  const events = new EventSource('/api/events');
  events.addEventListener('refresh', () => {
    // A save landed: say so while it is being read, then settle to fresh.
    state.connection = 'loading';
    paintSync();
    load(true);
  });
  events.addEventListener('error', () => {
    if (events.readyState === EventSource.CLOSED) {
      state.connection = 'offline';
      paintSync();
    }
  });
  events.addEventListener('open', () => {
    if (state.connection === 'offline') load(true);
  });

  setInterval(paintSync, 1000);
  paintSync();
}

wire();
load();
