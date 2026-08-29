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
   Don't want phone access? Make your shortcut run `Companion.vbs --local`.

5. **Player faces (optional, one-time).** The app shows initials by default. To fetch player
   headshots to your machine:

   ```bash
   npm run import:faces
   ```

   This is the only feature that touches the internet, it runs only when you invoke it, and
   the app is complete without it.

## A desktop shortcut

Right-click `Companion.vbs` → **Send to → Desktop (create shortcut)**, rename it *Companion*.
From then on it is one double-click: if the server is already running it just opens the page.

## Where things live

- **Save files** are read from `%LOCALAPPDATA%\EA SPORTS FC 26\settings\` — found automatically.
- **History** lives in `store\history.sqlite` inside the app folder: a snapshot of every save it
  has seen, plus the **story ledger** of what happened and when it was first seen. Delete it and
  Companion rebuilds from the next save, losing season-trend history and every dated event.
- **Snapshots** (byte-for-byte copies of each save it parsed) live in `snapshots\`.
- Companion **never writes** to the game's folders.

## History, and why it starts today

Companion can only witness what it is running for. The first time it reads a save it records the
career's own record — past seasons, trophies, the record scorelines — but those carry no date,
because the save does not hold one. Everything from that point on is dated the day it was first
seen and never rewritten. Leave it running as you play and the Chronicle fills in properly.

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
