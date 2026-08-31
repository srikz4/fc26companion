# Installing Companion

How to get Companion running on any Windows PC that plays FC 26 Manager Career. Ten minutes,
once per machine.

## What you need

| Requirement | Why |
|---|---|
| Windows 10/11 with EA SPORTS FC 26 installed | Companion reads the save files the game writes |
| A Manager Career with at least one save | there is nothing to show before the first save exists |
| [Node.js LTS](https://nodejs.org) (20 or newer) | runs the local server; `npm` comes with it |

## Steps

1. **Get the folder.** Copy the whole `companion` folder to the new PC (or `git clone` it if
   it lives in a repository). Any location works — Desktop, `C:\Tools`, anywhere.

2. **Install dependencies.** Open a terminal in that folder and run:

   ```bash
   npm install
   ```

3. **First run.** Double-click **`Companion.vbs`**. It starts the server minimised and opens
   the page. If a save already exists, the squad appears within a few seconds of the first
   parse. If Windows asks about the firewall, allow Node on **private networks** — that is
   what lets your phone in.

4. **Phone (optional).** The server window (minimised in the taskbar) prints
   `on your phone http://<ip>:4126`. Open that address on any phone on the same Wi-Fi.
   Don't want phone access? Create the shortcut with `Create Desktop Shortcut.vbs --local`.

5. **Player faces (optional, one-time).** The app shows initials by default. To fetch player
   headshots to your machine:

   ```bash
   npm run import:faces
   ```

   This is the only feature that touches the internet, it runs only when you invoke it, and
   the app is complete without it.

## A desktop shortcut

Double-click **`Create Desktop Shortcut.vbs`**. It puts *Companion* on your desktop with the app's
own icon and points it at the right folder. Run it again any time — it replaces the shortcut rather
than adding a second one. Want phone access off? Run it as `Create Desktop Shortcut.vbs --local`.

From then on it is one double-click: if the server is already running it just opens the page.

> The icon has to live on the **shortcut**, not on `Companion.vbs`. Windows draws every `.vbs` with
> the Windows Script Host icon and offers no way to change that, which is why this is a script
> rather than a property on the file. If the desktop still shows the old icon after running it,
> press <kbd>F5</kbd> on the desktop — Windows caches icons aggressively.

## Where things live

- **Save files** are read from `%LOCALAPPDATA%\EA SPORTS FC 26\settings\` — found automatically.
  You can point Companion at any other file instead, under **Customise → Save file**; the watcher
  follows whichever folder that file is in.
- **History** lives in `store\history.sqlite` inside the app folder: a snapshot of every save it
  has seen, the **story ledger** of what happened and when it was first seen, and the fixture-slot
  names learned so far. Delete it and Companion rebuilds from the next save, losing season-trend
  history, every dated event, and the club names on the league table until they are learned again.
- **Snapshots** (byte-for-byte copies of each save it parsed) live in `snapshots\`. These are what
  `npm run backfill:fixtures` reads, so keeping them is what lets the league table fill in.
- **Which save you chose** is remembered in `store\save-choice.json`. It is per-machine and is not
  part of the repository.
- Companion **never writes** to the game's folders.

## History, and why it starts today

Companion can only witness what it is running for. The first time it reads a save it records the
career's own record — past seasons, trophies, the record scorelines — but those carry no date,
because the save does not hold one. Everything from that point on is dated the day it was first
seen and never rewritten. Leave it running as you play and the Chronicle fills in properly.

## Commands you may want

Everything runs from the app folder.

| Command | What it does |
| --- | --- |
| `npm run serve` | The app. `-- --lan` for phone access, `-- --port 5000` to move it. |
| `npm run backfill:fixtures` | Reads club names for the league table out of every archived save. `-- --reset` re-derives from scratch. |
| `npm run import:faces` | Fetches player headshots once, on your instruction. |
| `npm run import:names` | Rebuilds the name table. |
| `npm run make:icon` | Redraws `Companion.ico` and `web/favicon.ico` from the mark in `web/favicon.svg`. Only needed if you change the mark. |
| `npm test` | The test suite. |

There are two more for decoding work — `experiment:baseline` and `experiment:stats` — documented in
the scripts themselves. They are for investigating what the save holds, not for daily use.

## Moving to a new PC and keeping history

Copy the whole folder including `store\` and `snapshots\`. The career is recognised by its own
identity, not the machine.

## Uninstalling

Delete the folder. Nothing is installed anywhere else — no registry entries, no services.

## Troubleshooting

- **Page says "Waiting for the first save"** — save your career in game once; the page updates
  itself.
- **The screen looks behind the game** — Companion only sees what the game has written. Save in
  game (or advance a day) and it catches up within a few seconds. The "synced" clock in the header
  shows how long it has been since the last save it read.
- **"Port 4126 is already in use"** — Companion is already running; the launcher will simply
  open the page next time.
- **Phone can't connect** — same Wi-Fi? Launcher run without `--local`? Check the firewall
  allowed Node on private networks.
- **Faces are initials** — run `npm run import:faces` once, then refresh.
- **The desktop icon looks jagged or is the plain script icon** — run
  `Create Desktop Shortcut.vbs`, then press <kbd>F5</kbd> on the desktop. The icon belongs to the
  shortcut; a `.vbs` file cannot carry one.
- **You want Companion to read a different save** — Customise → Save file. It lists what it finds
  and takes a full path for anything else, including a save copied from another machine. Choosing
  one moves the watcher onto its folder.
- **The shortlist shows players you removed in game** — the save is behind the game, not Companion.
  The game rewrites its shortlist section only now and then; the panel shows the date the save
  actually holds so you can see how far back it goes.
- **League table rows say "not yet named"** — the save files fixtures by slot rather than by club,
  and a slot is named only when a save proves whose it is. Run `npm run backfill:fixtures` to read
  those proofs out of every save already archived; one season's worth usually names a whole
  division. Add `--reset` to work the names out again from scratch. It touches nothing else — the
  names are derived, so they can always be re-derived.
