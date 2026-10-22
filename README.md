# NiSH Notes

A note-taking app for Windows that looks like a real notebook: lined paper with a red margin
on the left, and a folder menu on the right where you sort your pages.

No installer and no admin rights: download `NiSHNotes.exe` and double-click it.

## Download

Get `NiSHNotes.exe` from the [latest release](https://github.com/nish-vibes/nish-notes/releases/latest)
and put it anywhere (Desktop, Documents, a USB stick). Windows may show "Windows protected your PC"
the first time because the app isn't signed: click **More info → Run anyway**.

## What it does

- **Lined pages** in a handwriting font (switch to plain text with the **Aa** button).
  Everything is **saved automatically** while you type.
- **Folders on the right.** Click a folder to open or close it. Each folder has a coloured tab.
- **Sort by dragging.** Drag pages up and down, or drop them on another folder.
  Drag a folder by its name to move it.
- **Right-click** a folder or page to rename it, change the folder's colour, move or delete.
  Double-click a name to rename it, or just type a new title at the top of the page.
- **Search** finds pages by title and by the text inside them.
- **Drop .txt files** from Explorer onto the window to add them as pages.
- Deleted pages and folders go to a `_Trash` folder inside your notes folder, so nothing is lost by mistake.

Shortcuts: **Ctrl+N** new page · **Ctrl+Shift+N** new folder · **Ctrl+F** search ·
**F2** rename · **Delete** delete the selected page in the menu.

## Where your notes are

Every folder in the menu is a real folder, and every page is an ordinary `.txt` file, so you can
open, copy or back up your notes without the app.

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
