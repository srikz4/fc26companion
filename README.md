# Companion

A read-only second screen for **EA SPORTS FC 26 Manager Career** on PC. It watches your career
save, parses it the moment the game writes it, and turns it into the screens the game doesn't
give you — on your PC or on your phone over your own Wi-Fi.

Everything on screen is read from **your** save file. Nothing is invented: a fact the save
doesn't hold renders as unknown, never as a guess.

## What it gives you

The navigation mirrors the game's own menu — Central, Squad, Transfers, Academy, Office, Story,
Customise — and adds what the game keeps to itself:

- **Position fit** for every player in every slot, fitted on your save's own world and anchored so
  a player's rating in his own position matches the game exactly.
- **Ceiling tracking** across snapshots — potential moves during a career, and Companion shows when
  it moves, up or down.
- **A live league table**, treatment room with recovery times and computed stand-ins, transfer
  windows, and the world's transfer feed.
- **Valuations**: an EA-style fair value with a walk-away floor and a negotiation ceiling, plus what
  your world's own completed deals have actually paid.
- **Wage and contract guidance** for every player with a recorded wage, with two package shapes and
  the longest term the game will accept at that age.
- **Synergy** — who supplies whom and how strongly, from attributes and PlayStyles.
- **Scouting**: your scouts, their missions, and a sign / watch / pass verdict on every prospect a
  report delivers.
- **A story ledger.** Trophies, finishes, record scorelines, transfers, promotions and rating
  milestones are recorded the first time they are seen and never rewritten, so the **Chronicle**
  reads as history rather than a recomputed present.
- **RPG mode** — the career as a campaign, with missions appearing in the view where the work is.
- **A shareable career card**, built from your save.

## Quick start

Double-click **`Companion.vbs`**. It starts the server (minimised in the taskbar) and opens the
page; phone addresses are printed in the server window. Save in game and the page updates itself.

> Companion can only see what the game has written. **If a screen looks out of date, save in game**
> — or advance a day — and it catches up within a few seconds.

- **New here? Start with the [feature guide](docs/feature-guide.md)** — what Companion actually
  does, with pictures.
- New machine? See **[docs/install.md](docs/install.md)**.
- What each screen means and how to play with it: **[docs/usage.md](docs/usage.md)**.

## Principles

- **Read-only.** Companion never writes to a save, never touches game memory, never injects.
- **Local-only.** No accounts, no cloud, no telemetry. The server binds to your machine;
  phone access on your own network is an explicit flag (`--lan`, the launcher's default —
  `Companion.vbs --local` turns it off).
- **Real data only.** Every number traces to a field in your save or to arithmetic over them.
  Models (position fit, fees) are fitted on your save's own world and refuse to extrapolate.
  Derived figures wear a `~` and never drive a recommendation.
- **No pretending.** A feature with nothing behind it says so rather than shipping a plausible
  placeholder — AI mode is switched off and marked unavailable for exactly that reason.

## Disclaimers

- Companion is a fan-made tool. It is **not affiliated with, endorsed by, or connected to
  Electronic Arts**. EA SPORTS FC™ is a trademark of Electronic Arts Inc. All player data,
  club names, and competition names read from your save remain the property of their owners.
- Companion reads your save files as-is and never modifies them; still, keep backups of
  anything you care about. Use at your own risk — see [LICENSE](LICENSE).
- Player face images are **not distributed** with this project. The optional one-time importer
  (`npm run import:faces`) downloads them to your machine at your request; whether that use is
  appropriate in your jurisdiction is your call, and the app works fully without them.
- The bundled name/nation CSVs derive from community datasets
  ([EAFC26-DataHub](https://github.com/ismailoksuz/EAFC26-DataHub)); credit to their authors.

## Credits and acknowledgements

Companion stands on work by the FC/FIFA community and open-source authors:

- **Save schema** — `data/fifa_ng_db-meta.xml` describes EA's career-database layout and comes
  from the FC save-editing community; it is the same schema format used by projects such as
  [fifa-career-save-parser](https://github.com/sammygriffiths/fifa-career-save-parser) (ISC,
  Sammy Griffiths) and the FIFA/FC editor-tool ecosystem. Companion verified it against FC 26
  saves and profiles the fields it cannot name rather than guessing.
- **FC Career Mode Web Parser** by Giorgio Acquati — studied as prior art for FC 25 save
  parsing while Companion's parser was being written from scratch.
- **[EAFC26-DataHub](https://github.com/ismailoksuz/EAFC26-DataHub)** (ismailoksuz) — the
  community player dataset from which `data/playernames_fc26.csv` and `data/nations_fc26.csv`
  are derived.
- **[futwiz](https://www.futwiz.com)** — the source the optional one-time face importer
  downloads player headshots from. The images are never bundled or redistributed.
- **[FIFACM](https://www.fifacm.com/calculator/value)** — the EA-style player-valuation curves
  in `src/engine/eaValue.ts` were calibrated against their public FC 26 value calculator
  (a one-time sampling; nothing is fetched at runtime). Values shown are approximations and
  are marked as derived.
- **[Lucide](https://lucide.dev)** (ISC) — the icon set. The handful of paths the app uses are
  copied into `web/icons.js` rather than fetched, because the runtime never talks to the network.
- **Dependencies** — [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (MIT),
  [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) (MIT),
  [tsx](https://github.com/privatenumber/tsx) (MIT), and
  [TypeScript](https://github.com/microsoft/TypeScript) (Apache-2.0). Each ships its own
  license with the package.

## License

MIT — see [LICENSE](LICENSE).
