/**
 * The icon set.
 *
 * Emoji were doing the work of icons, and emoji are exactly what generated
 * content looks like — a 🏆 in front of every heading reads as a chat reply,
 * not as a product. These are line icons in the app's own stroke weight,
 * drawn from the Lucide set (ISC, https://lucide.dev), copied in rather than
 * pulled from a CDN because the runtime never talks to the network.
 *
 * Only the paths actually used are here; adding one means copying its path
 * data, not adding a dependency.
 */

const PATHS = {
  // structure
  home: 'M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  shuffle: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  graduation: 'M22 10 12 5 2 10l10 5zM6 12v5c3 3 9 3 12 0v-5',
  briefcase: 'M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  // meaning
  trophy: 'M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0z',
  table: 'M3 5h18v14H3zM3 10h18M9 5v14',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  cross: 'M12 5v14M5 12h14',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  chart: 'M3 3v18h18M18 17V9M13 17V5M8 17v-3',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.35-4.35',
  news: 'M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2m0 0a2 2 0 0 1-2-2v-9h4M18 14h-8M15 18h-5M10 6h8v4h-8z',
  coins: 'M8 15a7 7 0 1 0 0-14 7 7 0 0 0 0 14M15.7 5.3A7 7 0 1 1 9.3 17.7',
  wallet: 'M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5M17 12h.01',
  handshake: 'm11 17 2 2a1 1 0 1 0 3-3M14 14l2.5 2.5a1 1 0 1 0 3-3l-3.9-3.9a2 2 0 0 1 0-2.8l.4-.4a2.8 2.8 0 0 1 4 0L22 8M21 3 15 9M3 8l4-4 3 3M2 12l4.6 4.6a1 1 0 1 0 3-3',
  sprout: 'M7 20h10M10 20c5.5-2.5.8-6.4 3-10M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2',
  network: 'M12 16v-4M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4M18 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2',
  layers: 'm12 2 9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5',
  clipboard: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1',
  compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M16.2 7.8l-2.9 6.9-6.9 2.9 2.9-6.9z',
  dice: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2M8 8h.01M16 8h.01M8 16h.01M16 16h.01M12 12h.01',
  mountain: 'm8 3 4 8 5-5 5 15H2z',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
  wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
  gem: 'M6 3h12l4 6-10 13L2 9zM11 3 8 9l4 13 4-13-3-6M2 9h20',
  star: 'm12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
  pen: 'M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z',
  hospital: 'M12 6v4M14 14h-4M14 18h-4M4 22V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v18z',
  stethoscope: 'M11 2v2M5 2v2M5 10a5 5 0 0 0 6 0M8 4v6M20 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4M8 10v4a6 6 0 0 0 12 0v-2',
  ladder: 'M6 2v20M18 2v20M6 7h12M6 12h12M6 17h12',
  swords: 'm14.5 17.5 3-3M3 21l3-3M14 3l7 7-4 4-7-7zM3 3l7 7 4-4-7-7z',
  bus: 'M4 6h16v10H4zM4 16v2a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-2M17 16v2a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-2M6 10h12M8 19h8',
  scroll: 'M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4M19 17V5a2 2 0 0 0-2-2H4',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  mailbox: 'M22 17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6a5 5 0 0 1 5-5h10a5 5 0 0 1 5 5zM6 11h4M8 6V4M16 19v3',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10',
  sparkles: 'm12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9zM5 3l.6 1.4L7 5l-1.4.6L5 7l-.6-1.4L3 5l1.4-.6z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 6v6l4 2',
  check: 'm20 6-11 11-5-5',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 16v-4M12 8h.01',

  // form streaks: hot, cold, and going nowhere
  flame:
    'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5',
  snowflake:
    'm10 20-1.25-2.5L6 18M10 4 8.75 6.5 6 6M14 20l1.25-2.5L18 18M14 4l1.25 2.5L18 6M17 21l-3-6h-4l-3 6M17 3l-3 6h-4L7 3M2 12h20M20 9l-2 3 2 3M4 9l2 3-2 3',
  equal: 'M5 9h14M5 15h14',

  // full screen, both ways
  expand: 'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3',
  minimise: 'M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M16 21v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3',
};

/** An icon as an inline SVG element, inheriting the current text colour. */
export function icon(name, size = 15) {
  const d = PATHS[name];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ico');
  if (d) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

export const hasIcon = (name) => Object.prototype.hasOwnProperty.call(PATHS, name);

/**
 * Which icon a panel heading gets, by the words in it. Applied centrally so a
 * view never has to remember — and so the set stays small and consistent.
 */
export const HEADING_ICONS = [
  [/season|record|career so far|chronicle/i, 'calendar'],
  [/league|table|standing/i, 'table'],
  [/competition|trophy|cabinet/i, 'trophy'],
  [/decision|attention/i, 'bell'],
  [/treatment|injur/i, 'stethoscope'],
  [/mover|growth|development board/i, 'sprout'],
  [/pulse/i, 'activity'],
  [/opponent|fixture|scout report/i, 'search'],
  [/around the world|news/i, 'news'],
  [/campaign|road to glory|treble|invincible|century|wall|youth revolution|academy project|moneyball|custom/i, 'dice'],
  [/arc/i, 'mountain'],
  [/right now/i, 'zap'],
  [/this season/i, 'calendar'],
  [/depth/i, 'ladder'],
  [/squad|bench|reserve|eleven|xi/i, 'users'],
  [/wage|bill|contract|money|finance/i, 'wallet'],
  [/value|sell|worth/i, 'coins'],
  [/target|shopping/i, 'target'],
  [/shortlist|watchlist/i, 'eye'],
  [/loan/i, 'bus'],
  [/synerg|connection|partnership|pattern/i, 'network'],
  [/academy|prospect|youth/i, 'graduation'],
  [/report/i, 'mailbox'],
  [/board|expectation/i, 'shield'],
  [/manager|market|coach/i, 'briefcase'],
  [/stat|glance|position strength|age profile/i, 'chart'],
  [/challenge/i, 'target'],
  [/customise|setting|display|preference|mode/i, 'sliders'],
  [/contract$/i, 'clipboard'],
  [/story|brag|caption/i, 'book'],
  [/how to|lever|raise/i, 'wrench'],
  [/short|gap/i, 'compass'],
  [/ai mode/i, 'sparkles'],
];

/** Icons for ledger events, by kind. */
export const EVENT_ICONS = {
  trophy: 'trophy',
  season: 'calendar',
  signing: 'pen',
  sale: 'coins',
  'record-win': 'zap',
  'record-loss': 'shield',
  promotion: 'graduation',
  milestone: 'chart',
};
