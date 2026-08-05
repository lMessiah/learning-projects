# SaveGameTransfer

Move game saves / states from one device to another.

A single-file site — open `index.html`, no build step, no dependencies.

## What it does

- **Accounts.** Sign up with a username and password, no email. Passwords are
  stored as PBKDF2-SHA256 hashes with a per-user salt.
- **Folders, one per platform.** Creating a folder means picking a console from
  22 options — NES, SNES, PS1, PS2, GBA, N64, Dreamcast, DS, PSP and so on.
- **The folder knows its extensions.** Each platform carries the ROM and save
  extensions its emulators actually use, so a dropped file sorts itself.
  Numbered save slots (`.state3`, `.sav2`, `.ss1`) are recognised too.
- **Drag a pile of files in**, or press **+ Add game** to name one by hand.
  Saves get matched to games by filename, ignoring region tags like `(USA)`
  and `[!]`. Anything it can't place, it asks about.
- **Press a game** and the file picker opens straight onto its save slot.
- **Download** any file, or every save in a folder at once.

## Where the files live

In this browser, in IndexedDB — that's what holds a multi-gigabyte ISO where
localStorage would not. Storage is per-device and per-browser.

**There is no server yet.** So "device to another device" currently means:
download the save here, move the file across however you like, upload it there.
The account/folder/game structure is what a sync backend would plug into.

Two things follow from having no server:

- Clearing site data wipes the account and everything in it.
- The password hashing keeps passwords out of plain sight in the local
  database. It is not authentication — anyone with access to the browser
  profile can read the files directly.

## Platforms

8-bit: NES · Game Boy/Color · Master System/Game Gear · Atari 2600
16-bit: SNES · Mega Drive/Genesis · PC Engine/TurboGrafx · Neo Geo/Arcade
32/64-bit: PlayStation 1 · Nintendo 64 · Saturn · Dreamcast
Handhelds: GBA · Nintendo DS · PSP · Neo Geo Pocket/WonderSwan
Disc era: PlayStation 2 · GameCube · Wii · Original Xbox
Other: DOS/PC · Amiga/C64 · anything else

Adding one is a single entry in the `PLATFORMS` array in `index.html`.
