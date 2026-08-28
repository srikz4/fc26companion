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
  { key: 'rail', label: 'Alert rail', note: 'The "Needs attention" strip of rule-driven actions.', on: true },
  { key: 'actionChips', label: 'Action chips on rosters', note: 'LOAN OUT / SIGN TO SENIOR chips on squad and youth rows.', on: true },
  { key: 'trendArrows', label: 'Trend arrows', note: 'Season-form arrows next to each rating change: ▲ surge, ↗ rise, — flat, ↘ dip, ▼ fall.', on: true },
  { key: 'developFocus', label: 'Development focus', note: 'On the player card: the attributes where growth buys the most, from the fit weights and this world\u2019s percentiles. Point the game\u2019s development plans at them.', on: true },
  { key: 'absurd', label: 'The absurd bit', note: 'The cheeky lines on the Story card.', on: true },
  { key: 'rpg', label: 'RPG mode', note: 'Career-as-campaign: live challenges computed from your save, with progress. Deterministic — every number is real.', on: false },
  { key: 'ai', label: 'AI mode', note: 'AI narration and insights on top of the recorded facts. Needs a local model or an API key; until one is configured this shows its setup status.', on: false },
];
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
  rail: localStorage.getItem('rail') !== 'hidden',
  wageSel: null,
  wageFilter: 'all',
  oppSel: null,
  open: new Set(),
  attrs: new Set(),
  lastSync: null,
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
const money = (n) => (n === null || n === undefined ? null : n.toLocaleString('en-GB'));
const moneyShort = (n) =>
  n === null || n === undefined
    ? '—'
    : n === 0
      ? '0M'
      : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
      : n >= 1_000
        ? `${Math.round(n / 1_000)}K`
        : String(n);

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
    if (!node.querySelector('.dwell-fill')) node.appendChild(el('span', 'dwell-fill'));
    return node;
  }

  let timer = null;
  const stop = () => {
    node.classList.remove('dwelling');
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const pad = opts.pad ? el('span', 'dwellpad') : null;
  if (pad) node.prepend(pad);
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

  if (!node.querySelector('.dwell-fill')) node.appendChild(el('span', 'dwell-fill'));
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
function playerCard(p, onClose) {
  const card = el('div', `card ${p.advice.severity}`);
  if (state.open.has(p.playerId)) card.classList.add('open');

  // --- what to do about him
  const notable = [p.advice, ...p.otherAdvice].filter((a) => a.severity !== 'steady');
  if (notable.length) {
    const acts = el('div', 'acts');
    for (const a of notable) acts.appendChild(el('span', `act ${a.severity}`, a.tag));
    card.appendChild(acts);
  }

  // --- who he is
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
    mark.title = 'Derived name — measured 98.7% accurate, never drives advice';
    name.appendChild(mark);
  }
  head.appendChild(name);
  if (p.positionShort) head.appendChild(el('span', 'badge-pos', p.positionShort));

  const rates = el('div', 'rates');
  const ovr = el('span', 'rate');
  ovr.appendChild(el('span', `n ${tier(p.overall)}`, p.overall ?? '—'));
  if (p.potential !== null && p.potential !== p.overall) {
    ovr.appendChild(el('span', 'arrow', '→'));
    ovr.appendChild(el('span', `n ceil ${tier(p.potential)}`, p.potential));
  }
  ovr.title =
    p.potential === null || p.overall === null
      ? 'overall'
      : `Rated ${p.overall} today; the game says ${p.potential} is reachable` +
        (p.potential > p.overall ? ` — ${p.potential - p.overall} still to grow.` : '. Already there.');
  rates.appendChild(ovr);

  if (p.fits[0] && p.bestSlot) {
    const fit = el('span', 'rate');
    fit.appendChild(el('span', 'lbl', p.fits[0].slot));
    fit.appendChild(el('span', `n ${tier(p.fits[0].value)}`, p.fits[0].value));
    fit.title = `The rating playing ${slotLabel(p.bestSlot).toLowerCase()} — our figure, not the game's.`;
    rates.appendChild(fit);
  }
  head.appendChild(rates);
  card.appendChild(head);

  // --- one quiet line of facts
  const facts = el('div', 'facts');
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
  card.appendChild(facts);

  // --- only the flags that change a decision
  const flags = el('div', 'flags');
  if (p.potentialTag) flags.appendChild(el('span', 'flag gold', p.potentialTag));
  const g = delta(p.overallSeasonDelta);
  if (g && g.text !== '0') flags.appendChild(el('span', `flag ${g.cls}`, `${g.text} this season`));
  const cd = delta(p.potentialSeasonDelta);
  if (cd && cd.text !== '0') {
    const f2 = el('span', `flag ceilflag ${cd.cls}`, `ceiling ${cd.text}`);
    f2.title = 'Potential change observed across this career\u2019s snapshots since the season began.';
    flags.appendChild(f2);
  }
  if (p.injured) flags.appendChild(el('span', 'flag down', 'Injured'));
  if (p.retiring) flags.appendChild(el('span', 'flag down', 'Retiring'));
  if (p.onLoan) flags.appendChild(el('span', 'flag', 'On loan'));
  if (p.transferBlocked) flags.appendChild(el('span', 'flag', 'Transfer blocked'));
  if (p.youth && p.youth.monthsInSquad === 0) flags.appendChild(el('span', 'flag up', 'New intake'));
  if (p.generation && p.generation.potential !== null && p.generation.potential >= 97 && (p.age ?? 99) <= 21) {
    const gen = el('span', 'flag gold', `Top ${Math.max(1, 100 - p.generation.potential)}% of their generation`);
    gen.title = `A ceiling in the ${p.generation.potential}th percentile of the ${p.generation.peers.toLocaleString('en-GB')} players this age in this world.`;
    flags.appendChild(gen);
  } else if (p.generation && p.generation.overall >= 97 && (p.age ?? 99) <= 21) {
    const gen = el('span', 'flag gold', `Top ${Math.max(1, 100 - p.generation.overall)}% for their age`);
    gen.title = `An overall in the ${p.generation.overall}th percentile of the ${p.generation.peers.toLocaleString('en-GB')} players this age in this world.`;
    flags.appendChild(gen);
  }
  if (flags.childElementCount) card.appendChild(flags);

  if (settings.developFocus && p.developFocus?.length) {
    const dev = el('div', 'devfocus');
    dev.appendChild(el('span', 'lbl', 'DEVELOP'));
    for (const d of p.developFocus) {
      const chip = el('span', 'chipish', `${prettyAttr(d.attr)} ${d.value}`);
      chip.dataset.tip = `${d.percentile}th percentile among ${p.positionShort ?? 'position'}s in this world, and heavily weighted in the ${p.positionShort ?? ''} fit model — growth here buys the most. Point an in-game development plan at it.`;
      dev.appendChild(chip);
    }
    card.appendChild(dev);
  }

  // The player's signature: attributes in the top of the position's world
  // population. "78-rated winger" hides that his pace is elite; this does not.
  if (p.standout.length) {
    const line = el('div', 'standout');
    line.appendChild(el('span', 'lbl', 'Standout'));
    for (const st of p.standout) {
      const chip = el('span', 'so', `${prettyAttr(st.attr)} ${st.value}`);
      chip.title = `${st.percentile}th percentile among ${p.positionShort ?? 'position peers'}s in this world`;
      line.appendChild(chip);
    }
    card.appendChild(line);
  }

  // --- what he is made of
  const groups = el('div', 'groups');
  for (const group of p.groups) {
    const tile = el('div', 'gtile');
    tile.appendChild(el('div', 'gname', group.name));
    const row = el('div', 'grow');
    row.appendChild(el('span', `gval ${tier(group.mean)}`, group.mean ?? '—'));
    const d = delta(group.seasonDelta);
    if (d && d.text !== '0') row.appendChild(el('span', `gdelta ${d.cls}`, d.text));
    tile.appendChild(row);

    // A one-attribute group (every goalkeeper group) would just print its own
    // number again underneath itself.
    const attrs = el('div', 'attrs');
    if (group.attributes.length > 1) for (const a of group.attributes) {
      const line = el('div', 'attr');
      line.appendChild(el('span', 'an', prettyAttr(a.name)));
      line.appendChild(el('span', `av ${tier(a.value)}`, a.value ?? '—'));
      const ad = delta(a.seasonDelta);
      const shown = ad && ad.text !== '0';
      line.appendChild(el('span', `ad ${shown ? ad.cls : ''}`, shown ? ad.text : ''));
      attrs.appendChild(line);
    }
    tile.appendChild(attrs);
    groups.appendChild(tile);
  }
  card.appendChild(groups);

  if (p.playStyles.length) {
    const styles = el('div', 'styles');
    for (const st of p.playStyles) {
      const node = el('span', st.plus ? 'style plus' : 'style', st.name + (st.plus ? '+' : ''));
      node.title = `${st.category} PlayStyle`;
      styles.appendChild(node);
    }
    card.appendChild(styles);
  }

  // --- the season in numbers: labelled blocks, not a run-on sentence
  const strip = el('div', 'strip');
  const add = (label, value, title) => {
    if (value === null || value === undefined || value === '') return;
    const cell = el('span', 'stat');
    if (title) cell.dataset.tip = title;
    cell.appendChild(el('i', null, label));
    cell.appendChild(el('b', null, String(value)));
    strip.appendChild(cell);
  };
  add('Minutes', p.minutesThisSeason);
  add('Apps', p.appearances);
  add('Goals', p.goals || null);
  add(
    'Rating',
    p.averageRating === null
      ? null
      : p.ratingSpread === null
        ? p.averageRating
        : `${p.averageRating} ±${p.ratingSpread}`,
    p.ratingSpread === null
      ? undefined
      : `Average match rating ± its spread over ${p.appearances} games — a low spread means they show up every week.`,
  );
  add('Wage', money(p.wage), p.wageNote ?? undefined);
  add('Deal', p.contractMonths === null ? null : fmtTerm(p.contractMonths));
  add('Role', p.squadRole === 'None' ? null : p.squadRole);
  if (p.youth) add('In academy', p.youth.monthsInSquad === null ? null : fmtTerm(p.youth.monthsInSquad));
  if (p.synergy.length) {
    add(
      'Synergy links',
      p.synergy.length,
      `Patterns connecting this player with squad mates, strongest first:\n` +
        p.synergy.slice(0, 5).map((l) => l.evidence).join('\n'),
    );
  }
  if (strip.childElementCount) card.appendChild(strip);

  const spark = sparkline(p.overallSeries);
  if (spark) {
    const box = el('div', 'sparkbox');
    box.appendChild(el('span', 'lbl', 'OVERALL, THIS CAREER'));
    box.appendChild(spark);
    card.appendChild(box);
  }

  const actions = el('div', 'rowacts');
  const toggle = el('button', 'ghost', state.open.has(p.playerId) ? 'Hide attributes' : 'Attributes');
  activatable(toggle, () => {
    if (state.open.has(p.playerId)) state.open.delete(p.playerId);
    else state.open.add(p.playerId);
    card.classList.toggle('open');
    toggle.firstChild.textContent = card.classList.contains('open') ? 'Hide attributes' : 'Attributes';
  });
  actions.appendChild(toggle);

  if (notable.length) {
    const why = el('button', 'ghost', 'Why');
    activatable(
      why,
      () => {
        card.classList.toggle('notes-open');
        why.firstChild.textContent = card.classList.contains('notes-open') ? 'Hide why' : 'Why';
      },
      { skipWhen: () => card.classList.contains('notes-open') },
    );
    actions.appendChild(why);
  }
  card.appendChild(actions);

  if (notable.length) {
    const panel = el('div', 'notes');
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
function table(headers, rows, opts = {}) {
  const wrap = el('div', 'table-wrap');
  const t = el('table');
  if (opts.tight) t.classList.add('tight');
  const thead = el('thead');
  const hr = el('tr');
  headers.forEach((h, col) => {
    const isObj = typeof h === 'object';
    const th = el('th', `sortable${isObj && h.num ? ' num' : ''}`, isObj ? h.label : h);
    // Through activatable, not a bare click: sorting must dwell like every
    // other control in the app.
    activatable(th, () => {
      // A position column starts ascending (GK first, football order);
      // everything else starts with the biggest number on top.
      const asc = th.classList.contains('on') ? !th.classList.contains('asc') : !!(isObj && h.pos);
      for (const other of hr.children) other.classList.remove('on', 'asc');
      th.classList.add('on');
      if (asc) th.classList.add('asc');
      const body = t.querySelector('tbody');
      const sorted = [...body.children].sort((ra, rb) => {
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
      for (const r of sorted) body.appendChild(r);
    });
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  t.appendChild(thead);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    row.forEach((cell, ci) => {
      const hmeta = typeof headers[ci] === 'object' ? headers[ci] : {};
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
      if (isObj && cell.star) {
        const b = el('button', `starbtn${cell.star.on ? ' on' : ''}`, cell.star.on ? '★' : '☆');
        b.dataset.tip = cell.star.on ? 'On your shortlist — tap to drop' : 'Shortlist this player';
        activatable(b, cell.star.onToggle);
        td.appendChild(b);
      } else if (isObj && cell.cls === 'posbadge') td.appendChild(el('span', 'pos-pill', text));
      else td.textContent = text;
      // A position column sorts by football order, never the alphabet —
      // "CB before CAM because C < B" is nobody's idea of a squad list.
      td.dataset.sort = hmeta.pos
        ? String(posRank(String(text)))
        : String(text === '—' ? '' : text).replace(/[^0-9.\-]/g, '') || String(text);
      if (isObj && cell.title) td.dataset.tip = cell.title;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  wrap.appendChild(t);
  return wrap;
}

/**
 * Squad and Youth render as a roster: one row per player, the whole squad on a
 * single screen. This is a companion — the answer has to be visible before the
 * loading screen ends. A row opens into the full card only when asked.
 */
const ROSTER_COLUMNS = [
  { key: null, label: '' },
  { key: 'ingame', label: 'Pos' },
  { key: null, label: '' },
  { key: 'name', label: 'Player' },
  { key: 'overall', label: 'Rating' },
  { key: 'age', label: 'Age' },
  { key: 'growth', label: 'Δ' },
  { key: null, label: '' },
  { key: 'urgency', label: 'Action' },
  { key: 'minutes', label: 'Mins' },
];

function renderPlayers(list) {
  const wrap = el('div', 'roster');

  const head = el('div', 'rhead');
  for (const col of ROSTER_COLUMNS) {
    const cell = el('span', null, col.label);
    if (col.key) {
      if (state.sort === col.key) {
        cell.classList.add('on');
        if (state.sortAsc) cell.classList.add('asc');
      }
      activatable(cell, () => {
        state.sortAsc = state.sort === col.key ? !state.sortAsc : false;
        state.sort = col.key;
        localStorage.setItem('sort', col.key);
        render();
      });
    }
    head.appendChild(cell);
  }
  wrap.appendChild(head);

  const cmp = (SORTS[state.sort] ?? SORTS.ingame).fn;
  const filtered = applyFilters(list).sort((a, b) => (state.sortAsc ? -cmp(a, b) : cmp(a, b)));
  if (!filtered.length) {
    wrap.appendChild(el('p', 'empty', 'Nothing matches these filters.'));
    return wrap;
  }

  for (const p of filtered) {
    const row = el('div', `rrow ${p.advice.severity}`);

    row.appendChild(el('span', 'rpos', p.positionShort ?? '—'));
    row.appendChild(faceOf(p, 26));
    const name = el('span', 'rname');
    name.append(p.name);
    if (p.nameProvisional) name.appendChild(el('span', 'prov', '~'));
    row.appendChild(name);

    const rate = el('span', 'rate');
    rate.appendChild(el('span', `n ${tier(p.overall)}`, p.overall ?? '—'));
    if (p.potential !== null && p.potential !== p.overall) {
      rate.appendChild(el('span', 'arrow', '→'));
      rate.appendChild(el('span', `n ceil ${tier(p.potential)}`, p.potential));
    }
    row.appendChild(rate);

    row.appendChild(el('span', 'rage', p.age !== null ? `${p.age}y` : ''));

    const g = delta(p.overallSeasonDelta);
    const dcell = el('span', `rdelta ${g && g.text !== '0' ? g.cls : 'flat'}`);
    const arrow = trendArrow(p);
    if (arrow) dcell.appendChild(arrow);
    if (g && g.text !== '0') dcell.append(g.text);
    row.appendChild(dcell);

    const marks = el('span', 'rmarks');
    if (p.injured) marks.appendChild(el('i', 'mk down', '✚'));
    if (p.nationalTeam) marks.appendChild(el('i', 'mk info', '⚑'));
    if (p.potentialTag === 'Special' || p.potentialTag === 'Exciting') marks.appendChild(el('i', 'mk gold', '◆'));
    row.appendChild(marks);

    const act = settings.actionChips ? [p.advice, ...p.otherAdvice].find((a) => a.severity !== 'steady') : null;
    row.appendChild(act ? el('span', `act ${act.severity}`, act.tag) : el('span', 'rquiet', ''));

    row.appendChild(el('span', 'rmins', p.minutesThisSeason !== null ? `${p.minutesThisSeason}'` : ''));

    row.title = [
      p.form ? `Form ${p.form}` : null,
      p.morale,
      p.contractMonths !== null ? `${fmtTerm(p.contractMonths)} left on the deal` : null,
      act ? act.line : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const shell = el('div', 'rshell');
    shell.appendChild(row);

    const openNow = state.open.has(p.playerId);
    if (openNow) {
      shell.classList.add('is-open');
      // Dwell never re-fires on the row that is already open (skipWhen), so
      // closing needs its own control, inside the card head where it cannot
      // sit on top of the row's minutes column.
      shell.appendChild(
        playerCard(p, () => {
          state.open.delete(p.playerId);
          render();
        }),
      );
    }
    activatable(
      row,
      () => {
        if (state.open.has(p.playerId)) state.open.delete(p.playerId);
        else state.open.add(p.playerId);
        render();
      },
      { pad: true, skipWhen: () => state.open.has(p.playerId) },
    );

    wrap.appendChild(shell);
  }
  wrap.appendChild(
    el(
      'p',
      'muted tiny rkey',
      '⚑ national-team call-up · ◆ Special / Exciting ceiling · Δ rating change this season · Mins = minutes played · action colours: red act now, amber this window, blue keep an eye',
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
function renderMatchday(doc) {
  const m = doc.matchday;
  const frag = document.createDocumentFragment();
  const byId = new Map([...doc.senior, ...doc.academy].map((p) => [p.playerId, p]));
  const nameOf = (id) => byId.get(id)?.name ?? `#${id}`;

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
    const chips = el('div', 'chiprow');
    for (const o of doc.opponents) {
      if (o.teamId === doc.club?.id) continue;
      const chip = el('button', `chip${state.oppSel === o.teamId ? ' on' : ''}`, o.name);
      activatable(chip, () => { state.oppSel = o.teamId; render(); }, { skipWhen: () => state.oppSel === o.teamId });
      chips.appendChild(chip);
    }
    panel.appendChild(chips);
    const opp = doc.opponents.find((o) => o.teamId === state.oppSel);
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
    legend.appendChild(el('span', null, 'The number is the rating in that slot'));
    legend.appendChild(el('span', null, 'Amber card = we would pick someone else there'));
    legend.appendChild(el('span', null, 'Positions come from the save’s own formation'));
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
              a.playerId === null ? '—' : nameOf(a.playerId),
              { text: a.fit ?? '—', num: true, tier: a.fit },
              { text: p?.overall ?? '—', num: true, tier: p?.overall },
              { text: a.headroom === null ? '—' : `+${a.headroom}`, num: true },
              p?.form ?? '—',
            ];
          }),
        { tight: true },
      ),
    );
    side.appendChild(
      el(
        'p',
        'muted tiny',
        `Bench and reserves: ${m.recommended.benched.length} available players not in this eleven.`,
      ),
    );
    top.appendChild(wrap);
    wrap.appendChild(side);
  }
  frag.appendChild(top);

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

function renderSynergy(doc) {
  const frag = document.createDocumentFragment();
  const byId = new Map([...doc.senior, ...doc.academy].map((p) => [p.playerId, p]));
  const nameOf = (id) => byId.get(id)?.name ?? `#${id}`;
  const syn = doc.synergy;

  const decompose = (l) =>
    `${nameOf(l.supplier)} supplies ${l.supplierScore}, ${nameOf(l.receiver)} receives ${l.receiverScore} — ` +
    `strength √(${l.supplierScore}×${l.receiverScore})` +
    (l.amplifiedBy.length ? ` +${l.amplifiedBy.join(', ')}` : '') +
    `. ${l.why}.`;

  // --- the XI, as a network
  if (syn.xi) {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, `Your XI connects at ${syn.xi.teamScore ?? '—'}`));
    panel.appendChild(
      el(
        'p',
        'muted',
        'Pairs the formation stands next to each other, scored on the strongest pattern between them. ' +
          'Strength is √(supplier × receiver) over declared attributes, nudged by a directly relevant PlayStyle — ' +
          'a ranking of your own options, never a prediction.',
      ),
    );
    panel.appendChild(
      table(
        ['Pattern', 'From', 'To', { label: 'Supply', num: true }, { label: 'Receive', num: true }, { label: 'Strength', num: true }, 'Amplified by'],
        syn.xi.links.map((l) => [
          l.channel,
          nameOf(l.supplier),
          nameOf(l.receiver),
          { text: l.supplierScore, num: true, tier: l.supplierScore },
          { text: l.receiverScore, num: true, tier: l.receiverScore },
          { text: l.strength, num: true, tier: l.strength },
          l.amplifiedBy.join(', ') || '—',
        ]),
      ),
    );
    if (syn.xi.coldPairs.length) {
      panel.appendChild(
        el(
          'p',
          'muted tiny',
          `Not connecting: ${syn.xi.coldPairs
            .slice(0, 6)
            .map((c) => `${nameOf(c.a)} ↔ ${nameOf(c.b)}`)
            .join(' · ')}${syn.xi.coldPairs.length > 6 ? ` +${syn.xi.coldPairs.length - 6} more` : ''} — ` +
            'adjacent in the shape, but no pattern between them clears 55.',
        ),
      );
    }
    frag.appendChild(panel);
  }

  // --- best partnerships across the whole squad
  const best = el('div', 'panel');
  best.appendChild(el('h2', null, `Strongest partnerships in the squad`));
  best.appendChild(
    el('p', 'muted', 'Every pair in the squad, every pattern, strongest first — including pairs your current XI keeps apart.'),
  );
  best.appendChild(
    table(
      ['Pattern', 'Pair', { label: 'Strength', num: true }, 'Read'],
      syn.partnerships.slice(0, 14).map((l) => [
        l.channel,
        `${nameOf(l.supplier)} → ${nameOf(l.receiver)}`,
        { text: l.strength, num: true, tier: l.strength },
        { text: l.why, title: decompose(l), cls: 'wrap' },
      ]),
    ),
  );
  frag.appendChild(best);

  // --- what to actually do about it
  {
    const act = el('div', 'panel');
    act.appendChild(el('h2', null, '🔧 How to raise it'));
    const moves = [];
    const xiPair = new Set(
      (syn.xi?.links ?? []).map((l) => `${Math.min(l.supplier, l.receiver)}-${Math.max(l.supplier, l.receiver)}`),
    );
    for (const l of syn.partnerships
      .filter((l2) => !xiPair.has(`${Math.min(l2.supplier, l2.receiver)}-${Math.max(l2.supplier, l2.receiver)}`))
      .slice(0, 3)) {
      moves.push(
        `Field ${nameOf(l.supplier)} and ${nameOf(l.receiver)} next to each other — their ${l.channel.toLowerCase()} link scores ${l.strength}, but the current shape keeps them apart.`,
      );
    }
    for (const t of [...(doc.transfers?.targets ?? [])]
      .filter((t2) => t2.synergy?.[0])
      .sort((a, b) => (b.synergy[0]?.strength ?? 0) - (a.synergy[0]?.strength ?? 0))
      .slice(0, 2)) {
      moves.push(
        `Sign ${t.name} (${t.posShort ?? t.slot}) — the ${t.synergy[0].channel.toLowerCase()} link with this squad scores ${t.synergy[0].strength}, the best on the shopping list.`,
      );
    }
    if (syn.xi?.coldPairs?.length) {
      const c = syn.xi.coldPairs[0];
      moves.push(
        `${nameOf(c.a)} and ${nameOf(c.b)} stand next to each other with no pattern between them — swap one of them with a teammate from the partnerships table above, or route play around that side.`,
      );
    }
    if (moves.length) {
      for (const line of moves) act.appendChild(el('p', 'tipline', line));
      act.appendChild(el('p', 'muted tiny', 'Same math as the tables — these are the three biggest levers it found, not a plan it invented.'));
      frag.appendChild(act);
    }
  }

  // --- units: coverage and gain
  if (syn.units.length) {
    const units = el('div', 'panel');
    units.appendChild(el('h2', null, 'Pairings that share one job'));
    units.appendChild(
      el(
        'p',
        'muted',
        'Coverage is how well the pair handles every duty of the unit between them; gain is what the pairing adds over ' +
          'its better half alone. High gain means they complete each other. Zero gain means you picked the same player twice.',
      ),
    );
    units.appendChild(
      table(
        ['Unit', 'Pair', { label: 'Coverage', num: true }, { label: 'Gain', num: true }, 'Who carries what'],
        syn.units.slice(0, 10).map((u) => [
          u.unit,
          `${nameOf(u.a)} + ${nameOf(u.b)}`,
          { text: u.coverage, num: true, tier: u.coverage },
          { text: u.gain > 0 ? `+${u.gain}` : u.gain, num: true },
          {
            text: u.perDuty.map((d) => `${d.duty}: ${nameOf(d.carrier).split(' ').pop()}`).join(' · '),
            title: u.perDuty.map((d) => `${d.duty}: ${nameOf(d.carrier)} ${d.covered}`).join('\n'),
            cls: 'wrap',
          },
        ]),
      ),
    );
    frag.appendChild(units);
  }

  // --- redundancy
  if (syn.redundancies.length) {
    const red = el('div', 'panel');
    red.appendChild(el('h2', null, 'Similar profiles'));
    red.appendChild(
      el(
        'p',
        'muted',
        'Same position, near-identical attribute shape against the world population for that position. ' +
          'Not a criticism of either player — but the second one adds depth, not variety.',
      ),
    );
    red.appendChild(
      table(
        ['Position', 'Pair', { label: 'Similarity', num: true }],
        syn.redundancies.map((r) => [r.slot, `${nameOf(r.a)} + ${nameOf(r.b)}`, { text: r.similarity, num: true }]),
      ),
    );
    frag.appendChild(red);
  }

  const cat = el('div', 'panel');
  cat.appendChild(el('h2', null, 'The patterns'));
  cat.appendChild(
    el('p', 'muted tiny', `Computed against the ${syn.worldPlayers.toLocaleString('en-GB')} players in this career's world.`),
  );
  cat.appendChild(table(['Pattern', 'What it is'], syn.catalogue.map((c) => [c.name, c.why])));
  frag.appendChild(cat);

  return frag;
}

function renderTransfers(doc) {
  const frag = document.createDocumentFragment();
  const t = doc.transfers;

  const short = t.gaps.filter((g) => g.severity !== 'none');
  if (short.length) {
    const gaps = el('div', 'panel');
    gaps.appendChild(el('h2', null, 'Where the squad is short'));
    gaps.appendChild(
      table(
        ['Position', { label: 'Natural cover', num: true }, { label: 'Best you have', num: true }, 'Verdict'],
        short.map((g) => [slotLabel(g.slot), { text: g.cover, num: true }, { text: g.bestFit ?? '—', num: true }, g.note]),
      ),
    );
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

  const targets = el('div', 'panel');
  targets.appendChild(el('h2', null, `${list.length} targets from ${t.scanned.toLocaleString('en-GB')} scanned`));
  targets.appendChild(modeBar);
  if (doc.deals.modelled) {
    targets.appendChild(
      el(
        'p',
        'muted tiny',
        `Fair fee is fitted on the ${doc.deals.sample} transfers this world has actually completed — a reference band, not an oracle. ` +
          'Open a negotiation near the top of the band and walk at the bottom.',
      ),
    );
  }
  targets.appendChild(
    table(
      ['', 'Player', 'Club', { label: 'Pos', pos: true }, { label: 'OVR', num: true }, { label: 'POT', num: true }, { label: 'Fit', num: true }, { label: 'Synergy', num: true }, { label: 'Age', num: true }, 'Fair fee', 'Why'],
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
          text: x.feeGuide ? `${moneyShort(x.feeGuide.low)}–${moneyShort(x.feeGuide.high)}` : '—',
          title: x.feeGuide
            ? `Model midpoint ${moneyShort(x.feeGuide.mid)}, fitted on ${x.feeGuide.sample} observed deals`
            : 'Bigger than any deal this world has done — no honest estimate exists yet',
        },
        { text: x.reasons.join('; ') },
      ]),
    ),
  );
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

function renderWages(doc) {
  const frag = document.createDocumentFragment();
  const w = doc.wages;
  const byId = new Map([...doc.senior, ...doc.academy].map((p) => [p.playerId, p]));
  const nameOf = (id) => byId.get(id)?.name ?? `#${id}`;

  // Master-detail over the WHOLE squad: every row carries its wage, so the
  // number sits next to the name — no trek to a detail pane, which on a phone
  // was a full screen of scrolling away. "Worth doing" is a filter, not the
  // universe.
  {
    const renewalOf = new Map(w.renewals.map((r) => [r.playerId, r]));
    // The whole senior squad, plus any academy prospect the rules want renewed
    // — an academy deal running down is exactly the renewal you cannot miss.
    const everyone = [...doc.senior, ...doc.academy.filter((p) => renewalOf.has(p.playerId))].sort(
      (a, b) => posRank(a.positionShort ?? '') - posRank(b.positionShort ?? '') || (b.overall ?? 0) - (a.overall ?? 0),
    );
    const listed = state.wageFilter === 'worth' ? everyone.filter((p) => renewalOf.has(p.playerId)) : everyone;

    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, `Wages & renewals — ${listed.length} of ${everyone.length}`));
    panel.appendChild(
      el(
        'p',
        'muted',
        'Two shapes per player: flat, and a lower base with appearance money. Anchored to the role band and current wage — ' +
          'the save records no wage demand, so none is invented.',
      ),
    );

    const modes = el('div', 'chiprow');
    for (const [label, mode] of [[`Whole squad ${everyone.length}`, 'all'], [`Renewals worth doing ${w.renewals.length}`, 'worth']]) {
      const chip = el('button', `chip${(state.wageFilter ?? 'all') === mode ? ' on' : ''}`, label);
      activatable(
        chip,
        () => {
          state.wageFilter = mode;
          render();
        },
        { skipWhen: () => (state.wageFilter ?? 'all') === mode },
      );
      modes.appendChild(chip);
    }
    panel.appendChild(modes);

    const split = el('div', 'split');
    const left = el('div', 'split-list');
    const right = el('div', 'split-detail');

    if (!state.wageSel || !listed.some((p) => p.playerId === state.wageSel)) {
      state.wageSel = listed[0]?.playerId ?? null;
    }

    const urgencyLabel = { now: 'Now', soon: 'Soon', later: 'No rush' };
    const urgencyCls = { now: 'urgent', soon: 'action', later: 'watch' };

    for (const p of listed) {
      const r = renewalOf.get(p.playerId);
      const row = el('div', `srow${p.playerId === state.wageSel ? ' sel' : ''}`);
      row.appendChild(el('span', 'rpos', p.positionShort ?? '—'));
      row.appendChild(el('span', 'sname', p.name));
      row.appendChild(r ? el('span', `act ${urgencyCls[r.urgency]}`, urgencyLabel[r.urgency]) : el('span', 'act none', ''));
      row.appendChild(el('span', 'smeta', p.contractMonths === null ? '' : fmtTerm(p.contractMonths)));
      row.appendChild(el('span', 'swage', money(p.wage)));
      activatable(
        row,
        () => {
          state.wageSel = p.playerId;
          render();
        },
        { pad: true, skipWhen: () => state.wageSel === p.playerId },
      );
      left.appendChild(row);
    }

    const selPlayer = byId.get(state.wageSel);
    const sel = renewalOf.get(state.wageSel);
    if (selPlayer && !sel) {
      // No proposal for this player — say why the rules stayed quiet instead
      // of showing an empty pane.
      const p = selPlayer;
      const head = el('div', 'head');
      head.appendChild(el('span', 'name', p.name));
      if (p.positionShort) head.appendChild(el('span', 'badge-pos', p.positionShort));
      right.appendChild(head);
      right.appendChild(
        el('p', 'muted', `On ${money(p.wage)} a week${p.contractMonths === null ? '' : `, ${fmtTerm(p.contractMonths)} left`}${p.squadRole ? ` · ${p.squadRole}` : ''}.`),
      );
      const assess = w.assessmentList.find((a) => a.playerId === p.playerId);
      if (assess?.note) right.appendChild(el('p', 'tipline', assess.note));
      right.appendChild(
        el(
          'p',
          'muted tiny',
          'No renewal proposed: the contract is long enough and the wage close enough to the band that renegotiating now buys nothing. When either changes, a proposal appears here.',
        ),
      );
    }
    if (selPlayer && sel) {
      const p = selPlayer;
      const head = el('div', 'head');
      head.appendChild(el('span', 'name', p.name));
      if (p.positionShort) head.appendChild(el('span', 'badge-pos', p.positionShort));
      right.appendChild(head);
      right.appendChild(
        el('p', 'muted', `On ${money(sel.currentWage)} a week${sel.monthsLeft === null ? '' : `, ${fmtTerm(sel.monthsLeft)} left`}.`),
      );

      for (const o of sel.options) {
        const box = el('div', 'pkg');
        const t = el('div', 'pkg-head');
        t.appendChild(el('b', null, o.label));
        t.appendChild(el('span', 'pkg-wage', `${money(o.weeklyWage)}/wk`));
        box.appendChild(t);
        const rows = [
          ['Term', `${o.years} years`],
          ['Signing bonus', money(o.signOnBonus)],
          o.bonusPerEvent ? ['Appearance bonus', `${money(o.bonusPerEvent)} after ${o.bonusEvents} a season`] : null,
          ['Guaranteed', money(o.guaranteedCost)],
          o.maximumCost !== o.guaranteedCost ? ['If every bonus triggers', money(o.maximumCost)] : null,
        ].filter(Boolean);
        const dl = el('div', 'pkg-rows');
        for (const [k, v] of rows) {
          const line = el('div', 'pkg-row');
          line.appendChild(el('span', null, k));
          line.appendChild(el('b', null, v ?? '—'));
          dl.appendChild(line);
        }
        box.appendChild(dl);
        box.appendChild(el('p', 'pkg-why', o.why));
        box.appendChild(el('p', 'pkg-trade', o.tradeoff));
        right.appendChild(box);
      }

      const clause = el('div', `clause ${sel.releaseClause.recommend ? 'yes' : 'no'}`);
      clause.appendChild(
        el('b', null, sel.releaseClause.recommend ? `Release clause: ${money(sel.releaseClause.amount)}` : 'No release clause'),
      );
      clause.appendChild(el('span', null, sel.releaseClause.why));
      right.appendChild(clause);
    }

    split.appendChild(left);
    split.appendChild(right);
    panel.appendChild(split);
    frag.appendChild(panel);
  }

  const bands = el('div', 'panel');
  bands.appendChild(el('h2', null, `Wage bill ${money(w.totalBill)} across ${w.squadSize}`));
  bands.appendChild(
    table(
      ['Role band', { label: 'Players', num: true }, { label: 'Median', num: true }, { label: 'Low', num: true }, { label: 'High', num: true }],
      w.bands.map((b) => [
        b.role,
        { text: b.count, num: true },
        { text: money(b.median), num: true },
        { text: money(b.low), num: true },
        { text: money(b.high), num: true },
      ]),
    ),
  );
  frag.appendChild(bands);

  for (const [verdict, title] of [
    ['under', 'Paid below their peers'],
    ['over', 'Paid above their peers'],
  ]) {
    const rows = w.assessmentList.filter((a) => a.verdict === verdict);
    if (!rows.length) continue;
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, `${title} — ${rows.length}`));
    panel.appendChild(
      table(
        ['Player', { label: 'Wage', num: true }, { label: 'Band median', num: true }, 'Note'],
        rows.map((a) => [
          nameOf(a.playerId),
          { text: money(a.wage), num: true },
          { text: money(a.peerMedian), num: true },
          a.note,
        ]),
      ),
    );
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
    panel.appendChild(el('h2', null, `Should go out — ${L.candidates.length}`));
    panel.appendChild(
      el(
        'p',
        'muted',
        'Players the rules say need football elsewhere, each with clubs where their level makes them a starter — ' +
          'rated at or just below them, in a signable domestic league. A loan to a better team’s bench defeats the purpose.',
      ),
    );
    for (const c of L.candidates) {
      const box = el('div', 'pkg');
      const head = el('div', 'pkg-head');
      head.appendChild(el('b', null, nameOf(c.playerId)));
      head.appendChild(el('span', 'muted tiny', c.reason));
      box.appendChild(head);
      for (const g of c.dealGuide ?? []) {
        box.appendChild(el('p', 'muted tiny', `→ ${g}`));
      }
      if (c.destinations.length) {
        box.appendChild(
          table(
            ['Club', 'League', { label: 'Their OVR', num: true }, 'Read'],
            c.destinations.map((d) => [
              d.teamName,
              d.leagueName ?? '—',
              { text: d.clubOverall, num: true },
              { text: d.read, cls: 'wrap' },
            ]),
          ),
        );
      } else {
        box.appendChild(el('p', 'muted tiny', 'No club in range — the answer may simply be minutes here.'));
      }
      panel.appendChild(box);
    }
    frag.appendChild(panel);
  }

  if (!L.out.length && !L.inbound.length && !L.candidates.length) {
    frag.appendChild(el('p', 'empty', 'No loans in or out, and nobody the rules say should go.'));
  }
  return frag;
}

function renderYouth(doc) {
  const frag = document.createDocumentFragment();

  if (doc.scouts.length) {
    const panel = el('div', 'panel');
    panel.appendChild(el('h2', null, '🔭 Scouts'));
    panel.appendChild(
      table(
        ['Scout', 'From', 'Judgement', 'Experience', 'Current mission', 'Returns', { label: 'Cost', num: true }, 'Next job'],
        doc.scouts.map((sc) => [
          sc.name,
          `${flagFor(sc.nationality)}${sc.nationality ?? '—'}`,
          { text: '★'.repeat(sc.knowledge ?? 0) || '—', cls: `stars m${Math.min(5, Math.max(1, sc.knowledge ?? 1))}` },
          { text: '★'.repeat(sc.experience ?? 0) || '—', cls: `stars m${Math.min(5, Math.max(1, sc.experience ?? 1))}` },
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
  }

  frag.appendChild(renderPlayers(doc.academy));
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

  // Season story first: the manager's actual record, straight from the save.
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
        season.leagueTrophies ? `🏆×${season.leagueTrophies}` : null,
        season.cupTrophies ? `🏅×${season.cupTrophies}` : null,
        season.bigBuy ? `in: ${season.bigBuy.name} ${moneyShort(season.bigBuy.amount)}` : null,
        season.bigSell ? `out: ${season.bigSell.name} ${moneyShort(season.bigSell.amount)}` : null,
      ].filter(Boolean);
      facts.textContent = bits.join(' · ');
      row.appendChild(facts);
      panel.appendChild(row);
    }
    frag.appendChild(panel);
  }

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
        '📈 Season growth',
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

  const board = el('div', 'panel');
  board.appendChild(el('h2', null, '🏛 Board'));
  board.appendChild(
    table(
      ['Measure', { label: 'Value', num: true }],
      [
        ['Your wage', { text: money(doc.board.wage), num: true }],
        ['Career earnings', { text: money(doc.board.totalEarnings), num: true }],
        ['Reputation', { text: doc.board.reputation ?? '—', num: true }],
        ['Season objectives set', { text: doc.board.objectivesSet, num: true }],
      ],
    ),
  );
  if (doc.board.competitions.length) {
    const outcomeOf = (c) =>
      c.won
        ? '🏆 Won'
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
  grid.appendChild(board);

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
  const H = 1350;
  const ACCENT = '#c9f24b';
  const INK = '#e8eef2';
  const DIM = '#8b98a5';
  const FONT = `-apple-system, 'Segoe UI', Roboto, sans-serif`;
  const parts = [];
  const t = (x, y, text, size, fill, weight = 400, anchor = 'start', spacing = '') =>
    parts.push(`<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}>${escXml(text)}</text>`);

  parts.push(`<rect width="${W}" height="${H}" fill="#0b0f14"/>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="6" fill="${ACCENT}"/>`);

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
      t(64, y, `🏆 ${tr.name} — season ${tr.season}`, 28, INK, 600);
      y += 40;
    }
    y += 8;
  } else {
    t(64, y, 'TROPHY CABINET — empty so far. The story is still being written.', 22, DIM, 600);
    y += 46;
  }

  // Season records
  t(64, y, 'THE RECORD', 22, DIM, 700, 'start', '0.15em');
  y += 44;
  for (const sn of f.seasons.slice(-5)) {
    const pos = ordinal(sn.position);
    const line = [
      `S${sn.season}`,
      pos ? `${pos} place` : 'in progress',
      `${sn.wins}W ${sn.draws}D ${sn.losses}L`,
      `${sn.points} pts`,
      `${sn.goalsFor}:${sn.goalsAgainst}`,
    ].join('   ·   ');
    t(64, y, line, 30, INK, 600);
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
  if (f.riser && f.riser.delta > 0) lines.push(`📈 ${f.riser.name} grew +${f.riser.delta} overall this season — the sharpest riser in the squad.`);
  if (f.jewel && f.jewel.potential !== null) lines.push(`💎 Academy jewel: ${f.jewel.name}, ${f.jewel.age}y, ceiling ${f.jewel.potential}.`);
  if (f.sale) lines.push(`💰 Biggest sale: ${f.sale.name} for ${moneyShort(f.sale.amount)}.`);
  if (f.buy) lines.push(`🖊 Biggest signing: ${f.buy.name} at ${moneyShort(f.buy.amount)}.`);
  if (f.captain) lines.push(`Ⓒ ${f.captain.name} wears the armband.`);
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

  // Footer
  parts.push(`<line x1="64" y1="${H - 84}" x2="${W - 64}" y2="${H - 84}" stroke="#1e2732" stroke-width="2"/>`);
  t(64, H - 44, 'FC26 COMPANION · every number read from the save, nothing invented', 20, DIM, 600);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('')}</svg>`;
}

/** Social caption: plain text for pasting next to the image. */
function storyCaption(doc) {
  const f = bragFacts(doc);
  const out = [`${doc.club?.name ?? 'Career'} — season ${doc.season} ⚽`];
  if (f.cur) out.push(`📊 ${f.cur.wins}W ${f.cur.draws}D ${f.cur.losses}L · ${f.cur.goalsFor}:${f.cur.goalsAgainst}`);
  for (const tr of f.trophies.slice(0, 3)) out.push(`🏆 ${tr.name}`);
  if (f.scorer) out.push(`⚽ ${f.scorer.name} — ${f.scorer.goals} goals`);
  if (f.rated) out.push(`⭐ ${f.rated.name} — ${f.rated.rating.toFixed(1)} avg rating`);
  if (f.sale) out.push(`💰 sold ${f.sale.name} for ${moneyShort(f.sale.amount)}`);
  if (doc.board?.bigWin && doc.board.bigWin.userScore - doc.board.bigWin.oppScore >= 5) {
    out.push(`💥 biggest win ${doc.board.bigWin.userScore}–${doc.board.bigWin.oppScore} v ${doc.board.bigWin.opponent}`);
  }
  if (f.absurd.length) out.push(f.absurd[0]);
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

  if (settings.rpg) {
    const rpg = el('div', 'panel');
    rpg.appendChild(el('h2', null, '🎲 Campaign challenges'));
    for (const c of rpgChallenges(doc)) {
      const row = el('div', 'quest');
      const head2 = el('div', 'qhead');
      head2.appendChild(el('b', null, `${c.done ? '✓ ' : ''}${c.name}`));
      head2.appendChild(el('span', 'muted tiny', c.line));
      row.appendChild(head2);
      const track = el('div', 'btrack');
      const fill = el('div', `bfill${c.done ? ' done' : ''}`);
      fill.style.width = `${c.pct}%`;
      track.appendChild(fill);
      row.appendChild(track);
      rpg.appendChild(row);
    }
    rpg.appendChild(el('p', 'muted tiny', 'Live conditions computed from this save — a challenge reads done while the condition holds. Persistent completion history arrives with the story ledger.'));
    side.appendChild(rpg);
  }

  if (settings.ai) {
    const ai = el('div', 'panel');
    ai.appendChild(el('h2', null, '✨ AI mode'));
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

function renderOverview(doc) {
  const frag = document.createDocumentFragment();
  const grid = el('div', 'grid');
  const panel = (title, node, cls) => {
    const p2 = el('div', `panel${cls ? ` ${cls}` : ''}`);
    p2.appendChild(el('h2', null, title));
    p2.appendChild(node);
    grid.appendChild(p2);
    return p2;
  };
  const go = (view) => {
    const b = el('button', 'ghost tiny-btn', 'Open ›');
    activatable(b, () => {
      state.view = view;
      localStorage.setItem('view', view);
      render();
    });
    return b;
  };

  // --- the season, one line
  const cur = doc.seasons[doc.seasons.length - 1];
  {
    const box = el('div');
    if (settings.rpg) {
      const line = campaignLine(doc);
      if (line) box.appendChild(el('p', 'tipline', line));
    }
    if (cur) {
      const wdl = el('div', 'hero-line');
      const pace = cur.points !== null && cur.played > 0 && cur.played < 38 ? Math.round((cur.points / cur.played) * 38) : null;
      for (const [v2, l2] of [
        [`${cur.wins}W ${cur.draws}D ${cur.losses}L`, 'record'],
        [cur.points ?? '—', 'points'],
        [pace ?? '—', 'pace / 38'],
        [`${cur.goalsFor}:${cur.goalsAgainst}`, 'goals'],
        [doc.stats.meanOverall ?? '—', 'squad rating'],
        [doc.stats.meanAge ?? '—', 'mean age'],
      ]) {
        const cell = el('span', 'stat big');
        cell.appendChild(el('b', null, String(v2)));
        cell.appendChild(el('i', null, l2));
        wdl.appendChild(cell);
      }
      box.appendChild(wdl);
    }
    panel(`📈 Season ${doc.season}`, box, 'span2');
  }

  // --- what needs a decision
  {
    const box = el('div');
    const alerts = doc.alerts.slice(0, 5);
    for (const a of alerts) {
      const row = el('div', 'todo');
      row.appendChild(el('b', null, a.tag));
      row.appendChild(el('span', 'who', a.playerName));
      row.appendChild(el('span', 'why', a.line));
      box.appendChild(row);
    }
    if (doc.alerts.length > 5) box.appendChild(el('p', 'muted tiny', `+${doc.alerts.length - 5} more in the rail.`));
    if (!alerts.length) box.appendChild(el('p', 'muted tiny', 'Nothing needs you. Enjoy it.'));
    panel(`🔔 Decisions — ${doc.alerts.length}`, box);
  }

  // --- movers
  {
    const box = el('div');
    const everyone = [...doc.senior, ...doc.academy];
    const movers = everyone
      .filter((p2) => p2.trend === 'surge' || p2.trend === 'rise')
      .sort((a, b) => (b.overallSeasonDelta ?? 0) - (a.overallSeasonDelta ?? 0))
      .slice(0, 4);
    const fallers = everyone.filter((p2) => p2.trend === 'dip' || p2.trend === 'fall').slice(0, 2);
    for (const p2 of [...movers, ...fallers]) {
      const row = el('div', 'todo');
      const t2 = TREND[p2.trend];
      row.appendChild(el('b', null, `${t2.glyph} ${p2.overallSeasonDelta > 0 ? '+' : ''}${p2.overallSeasonDelta}`));
      row.appendChild(el('span', 'who', p2.name));
      row.appendChild(el('span', 'why', `${p2.positionShort ?? ''} · ${p2.overall}${p2.potential && p2.potential !== p2.overall ? ` → ${p2.potential}` : ''}`));
      box.appendChild(row);
    }
    if (!box.childElementCount) box.appendChild(el('p', 'muted tiny', 'No movement yet this season.'));
    panel('📊 Movers', box);
  }

  // --- ceiling watch, contracts, loans: the pulse
  {
    const box = el('div');
    const add2 = (label, who, why) => {
      const row = el('div', 'todo');
      row.appendChild(el('b', null, label));
      row.appendChild(el('span', 'who', who));
      row.appendChild(el('span', 'why', why));
      box.appendChild(row);
    };
    for (const r of doc.stats.ceilingWatch.slice(0, 2)) {
      add2('Ceiling', r.name, `${r.delta > 0 ? '+' : ''}${r.delta} this season`);
    }
    const dueNow = doc.wages.renewals.filter((r) => r.urgency === 'now');
    if (dueNow.length) add2('Renewals', `${dueNow.length} due now`, 'Wages tab');
    for (const r of (doc.loans.out ?? []).slice(0, 2)) {
      add2('On loan', r.name, `Δ OVR ${r.overallDelta === null || r.overallDelta === undefined ? '—' : (r.overallDelta > 0 ? '+' : '') + r.overallDelta} at ${r.atTeamName ?? '?'}`);
    }
    if (!box.childElementCount) box.appendChild(el('p', 'muted tiny', 'Quiet on every front.'));
    panel('🩺 Pulse', box);
  }

  // --- next opponent snapshot
  {
    const box = el('div');
    const mine = doc.opponents?.find((o) => o.teamId === doc.club?.id);
    const opp = doc.opponents?.find((o) => o.teamId === state.oppSel);
    if (opp && mine) {
      const row = el('div', 'hero-line');
      for (const [l2, a, b] of [['XI', mine.overall, opp.overall], ['DEF', mine.def, opp.def], ['MID', mine.mid, opp.mid], ['ATT', mine.att, opp.att]]) {
        const cell = el('span', 'stat big');
        cell.appendChild(el('b', null, a !== null && b !== null ? `${a > b ? '+' : ''}${Math.round((a - b) * 10) / 10}` : '—'));
        cell.appendChild(el('i', null, l2));
        row.appendChild(cell);
      }
      box.appendChild(el('p', 'muted tiny', `Your edge, line by line, v ${opp.name}.`));
      box.appendChild(row);
    } else {
      box.appendChild(el('p', 'muted tiny', 'Pick your next opponent on Matchday and the line-by-line edge lands here.'));
    }
    box.appendChild(go('matchday'));
    panel(settings.rpg ? '⚔ Next fixture' : '🔎 Opponent', box);
  }

  // --- campaign challenges
  if (settings.rpg) {
    const box = el('div');
    for (const c of rpgChallenges(doc).slice(0, 4)) {
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
    box.appendChild(go('story'));
    panel('🎲 Campaign', box);
  }

  frag.appendChild(grid);
  return frag;
}

function renderShortlist(doc) {
  const frag = document.createDocumentFragment();
  const panel = el('div', 'panel');
  panel.appendChild(el('h2', null, `⭐ Shortlist — ${shortlist.length}`));
  if (!shortlist.length) {
    panel.appendChild(
      el('p', 'muted', 'Empty. Star players on the Transfers tab and they land here with their numbers frozen at that moment — the columns then show how far they have moved since.'),
    );
    frag.appendChild(panel);
    return frag;
  }
  panel.appendChild(
    el('p', 'muted tiny', 'Then = the day you shortlisted. Now = this save. Drift is the story: a rising OVR means the price is rising with it.'),
  );
  const liveById = new Map((doc.transfers?.targets ?? []).map((t2) => [t2.playerId, t2]));
  panel.appendChild(
    table(
      ['', 'Player', 'Club', { label: 'Pos', pos: true }, { label: 'OVR then', num: true }, { label: 'OVR now', num: true }, { label: 'Δ', num: true }, { label: 'POT', num: true }, 'Fee then', 'Fee now', 'Added'],
      shortlist.map((e) => {
        const live = liveById.get(e.playerId);
        const nowOvr = live?.overall ?? null;
        const d = nowOvr !== null && e.overall !== null ? nowOvr - e.overall : null;
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

function renderSettings() {
  const frag = document.createDocumentFragment();
  const panel = el('div', 'panel');
  panel.appendChild(el('h2', null, '⚙ Settings'));
  panel.appendChild(el('p', 'muted', 'Switches persist in this browser. Nothing here touches the save or the store.'));
  for (const def of SETTING_DEFS) {
    const row = el('div', 'setrow');
    const sw = el('button', `switch${settings[def.key] ? ' on' : ''}`);
    sw.appendChild(el('i', 'knob'));
    activatable(sw, () => {
      settings[def.key] = !settings[def.key];
      saveSettings();
      render();
    });
    row.appendChild(sw);
    const txt = el('div', 'settext');
    txt.appendChild(el('b', null, def.label));
    txt.appendChild(el('span', 'muted tiny', def.note));
    row.appendChild(txt);
    panel.appendChild(row);
  }
  frag.appendChild(panel);
  return frag;
}

const VIEWS = {
  overview: { label: 'Overview', render: renderOverview, count: () => null },
  matchday: { label: 'Matchday', render: renderMatchday, count: (d) => d.matchday.diff.filter((x) => x.savedPlayerId !== x.recommendedPlayerId).length },
  squad: { label: 'Squad', render: (d) => renderPlayers(d.senior), count: (d) => d.senior.length, players: true },
  youth: { label: 'Youth', render: renderYouth, count: (d) => d.academy.length, players: true },
  synergy: { label: 'Synergy', render: renderSynergy, count: (d) => d.synergy.partnerships.length },
  transfers: { label: 'Transfers', render: renderTransfers, count: (d) => d.transfers.targets.length },
  wages: { label: 'Wages', render: renderWages, count: (d) => d.wages.renewals.length },
  loans: { label: 'Loans', render: renderLoans, count: (d) => d.loans.out.length + d.loans.candidates.length },
  stats: { label: 'Stats', render: renderStats, count: () => null },
  shortlist: { label: 'Shortlist', render: renderShortlist, count: () => (shortlist.length || null) },
  story: { label: 'Story', render: renderStory, count: () => null },
  settings: { label: '⚙', render: renderSettings, count: () => null },
};

/* ---------------- shell ---------------- */

function renderShell(doc) {
  const views = $('#views');
  views.textContent = '';
  for (const [id, view] of Object.entries(VIEWS)) {
    const tab = el('button', `tab${id === state.view ? ' is-active' : ''}`);
    tab.append(view.label);
    const n = view.count(doc);
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

  const filters = $('#filters');
  filters.textContent = '';
  const active = VIEWS[state.view];
  if (active.players) {
    const list = state.view === 'youth' ? doc.academy : doc.senior;

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
  // Off Squad/Youth the strip only explained its own absence — give the row back.
  filters.style.display = VIEWS[state.view]?.players ? '' : 'none';

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

function render() {
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
  requestAnimationFrame(() => window.scrollTo(0, scrollY));


  main.appendChild(VIEWS[state.view].render(doc));

  $('#counts').textContent =
    `${doc.senior.length} senior · ${doc.academy.length} academy · season ${doc.season ?? '?'} · ` +
    `${doc.snapshots} snapshot${doc.snapshots === 1 ? '' : 's'} · names ${doc.names.squad[0]}/${doc.names.squad[1]}`;
}

async function load(flash = false) {
  const response = await fetch('/api/view', { cache: 'no-store' });
  state.doc = await response.json();
  state.lastSync = Date.now();
  render();
  if (flash) {
    document.body.classList.add('flash');
    setTimeout(() => document.body.classList.remove('flash'), 1000);
  }
}

function wire() {
  state.view = storedPref('view', Object.keys(VIEWS), 'squad');
  state.sort = storedPref('sort', Object.keys(SORTS), 'ingame');
  state.filters = new Set(
    [...state.filters].filter((id) => FILTERS.some((f) => f.id === id)),
  );

  // Three looks: dark, light, and FC26 — near-black with the volt green of the
  // game's own menus, so the second screen reads as an extension of them.
  const THEMES = ['dark', 'light', 'fc26'];
  // Three segments, one pill: pick a theme instead of cycling blind.
  const THEME_LABEL = { light: 'Light', dark: 'Dark', fc26: 'FC26' };
  const seg = $('#themeseg');
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    localStorage.setItem('theme', t);
    for (const b of seg.children) b.classList.toggle('on', b.dataset.theme === t);
  };
  for (const t of ['light', 'dark', 'fc26']) {
    const b = el('button', 'segbtn', THEME_LABEL[t]);
    b.dataset.theme = t;
    activatable(b, () => applyTheme(t), { skipWhen: () => (document.documentElement.dataset.theme || 'dark') === t });
    seg.appendChild(b);
  }
  applyTheme(storedPref('theme', THEMES, 'dark'));


  const events = new EventSource('/api/events');
  events.addEventListener('refresh', () => load(true));

  setInterval(() => {
    if (!state.lastSync) return;
    const s = Math.round((Date.now() - state.lastSync) / 1000);
    $('#synced').textContent = s < 60 ? `synced ${s}s ago` : `synced ${Math.round(s / 60)}m ago`;
  }, 1000);
}

wire();
load();
