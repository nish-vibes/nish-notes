# NiSH Notes

A note-taking app for Windows that looks like a real notebook: lined paper with a red margin
on the left, and a folder menu on the right where you sort your pages.

No installer and no admin rights: download `NiSHNotes.exe` and double-click it.

## Download

Get `NiSHNotes.exe` from the [latest release](https://github.com/nish-vibes/nish-notes/releases/latest)
and put it anywhere (Desktop, Documents, a USB stick). Windows may show "Windows protected your PC"
the first time because the app isn't signed: click **More info → Run anyway**.

## What it does

- **Lined pages** in a handwriting font (switch to plain text in the **⋯** menu).
  Everything is **saved automatically** while you type. If a save ever fails (a USB stick was
  pulled out, say) a popup tells you, and the app keeps trying.
- **Formatting like Notes on a Mac.** Click **Aa** for Title, Heading, Subheading, Body and
  Monostyled, **bold**, *italic*, underline, strikethrough, bulleted, dashed and numbered lists
  and indenting. The checklist button makes a to-do list; click a circle to tick it off.
- **Margin notes.** The narrow column left of the red line is its own little text area, for dates,
  keywords or reminders next to your page.
- **Scribble.** Draw on the page with a pen or a see-through marker in six colours and three sizes.
  The eraser removes whole strokes, and Undo/Redo work as you'd expect.
- **Folders on the right.** Click a folder to open or close it. Each folder has a coloured tab.
- **Sort by dragging.** Hover over a folder or page and drag its handle (or the row itself) to move it.
  Drop a page on a folder to move it there. Alt+↑/↓ moves the selected folder or page with the keyboard.
- **Right-click** (or the **⋯** that appears on hover) to rename, recolour, move or delete.
  Double-click a name to rename it, or just type a new title at the top of the page.
- **Search** finds pages by title, text and margin notes.
- **Drop .txt, .md or .html files** from Explorer onto the window to add them as pages.
- Deleted pages and folders go to a `_Trash` folder inside your notes folder, so nothing is lost by mistake.
- **Keep running when closed** (in the **⋯** menu): the window's X then only hides the window and
  NiSH Notes waits in the notification area (the tray, by the clock). Click its icon to open it again,
  right-click it to quit. Starting `NiSHNotes.exe` again also brings the window back, and only one
  copy of the app ever runs. If you don't see the icon, it may be under the ˄ arrow by the clock.

Shortcuts: **Ctrl+N** new page · **Ctrl+Shift+N** new folder · **Ctrl+F** search · **F2** rename ·
**Ctrl+B / I / U** bold, italic, underline · **Ctrl+Shift+X** strikethrough ·
**Ctrl+Shift+T / H / J / B / M** title, heading, subheading, body, monostyled ·
**Ctrl+Shift+L** checklist · **Ctrl+Shift+7 / 8 / 9** bulleted, dashed, numbered list ·
**Tab / Shift+Tab** indent in lists · **Ctrl+Shift+V** paste without formatting ·
in Scribble: **P / M / E** pen, marker, eraser, **Ctrl+Z / Ctrl+Y** undo, redo, **Esc** done.

## Where your notes are

Every folder in the menu is a real folder, and every page is a small `.html` file you can open
in any web browser (text, margin notes and drawing included), copy or back up without the app.
Pages from NiSH Notes 1.0 were plain `.txt` files; they open as before and become `.html` the
first time you change them.

- By default they are in **Documents\NiSH Notes**.
- **Portable mode:** make a folder called `Notes` next to `NiSHNotes.exe` and the app uses that
  instead, handy on a USB stick.
- Or pick any folder with **⋯ → Change notes folder…** (a OneDrive folder works too).

The small file `_nishnotes.json` in the notes folder remembers the order of pages and folders
and the folder colours. Files you add with another program are picked up the next time the app starts
(or with **⋯ → Reload from disk**).

## Requirements

Windows 10 or 11. The window uses Microsoft Edge WebView2, which is already part of Windows.
If it has been removed, the app tells you how to get it back (it installs for your user, no admin needed).

## Building it yourself

GitHub Actions builds the exe on every push to `main` (see `.github/workflows/build.yml`) and runs
the notebook tests plus a GUI smoke test that opens the window and clicks through everything.
A new release is published when `VERSION` changes.

Locally on Windows:

```
pip install -r requirements.txt pyinstaller
python app.py                      # run it
python tests/test_store.py         # tests
pyinstaller NiSHNotes.spec         # build dist\NiSHNotes.exe (put the Kalam font in web\fonts first)
```

The handwriting font is [Kalam](https://fonts.google.com/specimen/Kalam) by the Indian Type Foundry,
under the SIL Open Font License.
