// A stand-in for the Python side, used only when the page is opened in an ordinary browser
// (for previews and tests). In the app, window.pywebview.api is used instead.
window.makeMockApi = function () {
  let n = 0;
  const id = (p) => p + (++n).toString(36) + Math.random().toString(36).slice(2, 6);
  const stamp = () => new Date().toISOString();
  const folders = [
    { id: id('f'), name: 'Inbox', color: '#E3A93E', open: true, pages: [
      { id: id('p'), title: 'Welcome', created: stamp(), updated: stamp(), text: 'Welcome to NiSH Notes!\n\nThis is a preview running in the browser, so nothing is saved to disk.' },
    ] },
    { id: id('f'), name: 'School', color: '#6A9BD1', open: true, pages: [] },
  ];
  const trash = [];
  const findPage = (pid) => {
    for (const f of folders) { const p = f.pages.find((x) => x.id === pid); if (p) return [f, p]; }
    throw new Error('No such page');
  };
  const findFolder = (fid) => { const f = folders.find((x) => x.id === fid); if (!f) throw new Error('No such folder'); return f; };
  const clamp = (i, len) => Math.max(0, Math.min(i == null ? len : i, len));
  const snap = () => ({ root: '(browser preview)', folders: folders.map((f) => ({ id: f.id, name: f.name, color: f.color, open: f.open,
    pages: f.pages.map((p) => ({ id: p.id, title: p.title, created: p.created, updated: p.updated })) })) });
  const wait = (v) => new Promise((r) => setTimeout(() => r(v), 5));
  return {
    mock: true,
    init: () => wait({ notebook: snap(), version: 'preview', prefs: { font: 'hand', lastPage: null } }),
    reload: () => wait(snap()),
    snapshot: () => wait(snap()),
    read_page: (pid) => wait(findPage(pid)[1].text || ''),
    save_page: (pid, text) => { const p = findPage(pid)[1]; p.text = text; p.updated = stamp(); return wait(p.updated); },
    create_page: (fid, title, index) => { const f = findFolder(fid); const p = { id: id('p'), title: title || 'Untitled', created: stamp(), updated: stamp(), text: '' };
      f.pages.splice(clamp(index, f.pages.length), 0, p); f.open = true; return wait(p.id); },
    rename_page: (pid, title) => { const p = findPage(pid)[1]; p.title = (title || '').trim() || 'Untitled'; return wait(p.title); },
    move_page: (pid, fid, index) => { const [src, p] = findPage(pid); const dst = findFolder(fid); src.pages.splice(src.pages.indexOf(p), 1);
      dst.pages.splice(clamp(index, dst.pages.length), 0, p); return wait(null); },
    delete_page: (pid) => { const [f, p] = findPage(pid); f.pages.splice(f.pages.indexOf(p), 1); trash.push(p); return wait(null); },
    create_folder: (name, index) => { let base = (name || 'New folder').trim(), nm = base, k = 1;
      while (folders.some((f) => f.name.toLowerCase() === nm.toLowerCase())) nm = base + ' (' + (++k) + ')';
      const f = { id: id('f'), name: nm, color: ['#E3A93E', '#6A9BD1', '#D97B63', '#79AE7F', '#A58BD6', '#8C8A84'][folders.length % 6], open: true, pages: [] };
      folders.splice(clamp(index, folders.length), 0, f); return wait(f.id); },
    rename_folder: (fid, name) => { const f = findFolder(fid); f.name = (name || '').trim() || f.name; return wait(f.name); },
    set_folder: (fid, color, open) => { const f = findFolder(fid); if (color) f.color = color; if (open != null) f.open = !!open; return wait(null); },
    move_folder: (fid, index) => { const f = findFolder(fid); folders.splice(folders.indexOf(f), 1); folders.splice(clamp(index, folders.length), 0, f); return wait(null); },
    delete_folder: (fid) => { const f = findFolder(fid); folders.splice(folders.indexOf(f), 1); trash.push(f); return wait(null); },
    search: (q) => { const words = (q || '').toLowerCase().split(/\s+/).filter(Boolean); const hits = [];
      folders.forEach((f) => f.pages.forEach((p) => { const hay = (p.title + '\n' + (p.text || '')).toLowerCase(); if (words.length && words.every((w) => hay.includes(w))) hits.push(p.id); }));
      return wait(hits); },
    set_pref: () => wait(null),
    open_notes_folder: () => wait(null),
    choose_notes_folder: () => wait(null),
  };
};
