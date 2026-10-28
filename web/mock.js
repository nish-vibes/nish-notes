// A stand-in for the Python side, used only when the page is opened in an ordinary browser
// (for previews and tests). In the app, window.pywebview.api is used instead.
window.makeMockApi = function () {
  let n = 0;
  const id = (p) => p + (++n).toString(36) + Math.random().toString(36).slice(2, 6);
  const stamp = () => new Date().toISOString();
  const folders = [
    { id: id('f'), name: 'Inbox', color: '#E3A93E', open: true, pages: [
      { id: id('p'), title: 'Welcome to NiSH Notes!', created: stamp(), updated: stamp(), doc: { text: '<h1>Welcome to NiSH Notes!</h1><div>This is a preview running in the browser, so nothing is saved to disk.</div>', margin: '<div>Preview</div>', ink: [] } },
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
  const snap = () => ({ root: '(browser preview)', keepDays: 30, folders: folders.map((f) => ({ id: f.id, name: f.name, color: f.color, open: f.open,
    pages: f.pages.map((p) => ({ id: p.id, title: p.title, created: p.created, updated: p.updated })) })),
    trash: trash.slice().reverse().map((t) => ({ id: t.id, title: t.page.title, folder: t.folder.name, deleted: t.deleted })) });
  const toTrash = (f, p, fi, pi) => { const t = { id: id('t'), page: p, folder: f, fi, pi, deleted: stamp() }; trash.push(t); return t.id; };
  const wait = (v) => new Promise((r) => setTimeout(() => r(v), 5));
  return {
    mock: true,
    init: () => wait({ notebook: snap(), version: 'preview', prefs: { font: 'hand', lastPage: null } }),
    reload: () => wait(snap()),
    snapshot: () => wait(snap()),
    read_page: (pid) => wait(JSON.parse(JSON.stringify(findPage(pid)[1].doc || { text: '', margin: '', ink: [] }))),
    save_page: (pid, doc) => { const p = findPage(pid)[1]; p.doc = JSON.parse(JSON.stringify(doc)); p.updated = stamp(); return wait(p.updated); },
    create_page: (fid, title, index) => { const f = findFolder(fid); const p = { id: id('p'), title: title || 'Untitled', created: stamp(), updated: stamp(), doc: { text: '', margin: '', ink: [] } };
      f.pages.splice(clamp(index, f.pages.length), 0, p); f.open = true; return wait(p.id); },
    rename_page: (pid, title) => { const p = findPage(pid)[1]; p.title = (title || '').trim() || 'Untitled'; return wait(p.title); },
    move_page: (pid, fid, index) => { const [src, p] = findPage(pid); const dst = findFolder(fid); src.pages.splice(src.pages.indexOf(p), 1);
      dst.pages.splice(clamp(index, dst.pages.length), 0, p); return wait(null); },
    delete_page: (pid) => { const [f, p] = findPage(pid); const i = f.pages.indexOf(p); f.pages.splice(i, 1); return wait(toTrash(f, p, folders.indexOf(f), i)); },
    restore: (ids) => { const out = [];
      for (const t of trash.filter((x) => ids.includes(x.id)).sort((x, y) => x.pi - y.pi)) {
        let f = folders.find((x) => x.id === t.folder.id);
        if (!f) { f = t.folder; f.pages = []; folders.splice(Math.min(t.fi, folders.length), 0, f); }
        f.pages.splice(Math.min(t.pi, f.pages.length), 0, t.page); trash.splice(trash.indexOf(t), 1); out.push(t.page.id); }
      return wait({ restored: out, notebook: snap() }); },
    set_title: () => wait(null),
    create_folder: (name, index) => { let base = (name || 'New folder').trim(), nm = base, k = 1;
      while (folders.some((f) => f.name.toLowerCase() === nm.toLowerCase())) nm = base + ' (' + (++k) + ')';
      const f = { id: id('f'), name: nm, color: ['#E3A93E', '#6A9BD1', '#D97B63', '#79AE7F', '#A58BD6', '#8C8A84'][folders.length % 6], open: true, pages: [] };
      folders.splice(clamp(index, folders.length), 0, f); return wait(f.id); },
    rename_folder: (fid, name) => { const f = findFolder(fid); f.name = (name || '').trim() || f.name; return wait(f.name); },
    set_folder: (fid, color, open) => { const f = findFolder(fid); if (color) f.color = color; if (open != null) f.open = !!open; return wait(null); },
    move_folder: (fid, index) => { const f = findFolder(fid); folders.splice(folders.indexOf(f), 1); folders.splice(clamp(index, folders.length), 0, f); return wait(null); },
    delete_folder: (fid) => { const f = findFolder(fid), fi = folders.indexOf(f); const ids = f.pages.map((p, i) => toTrash(f, p, fi, i)); folders.splice(fi, 1); return wait(ids); },
    search: (q) => { const words = (q || '').toLowerCase().split(/\s+/).filter(Boolean); const hits = [];
      folders.forEach((f) => f.pages.forEach((p) => { const d = p.doc || {}; const text = ((d.text || '') + ' ' + (d.margin || '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const hay = (p.title + '\n' + text).toLowerCase(); if (words.length && words.every((w) => hay.includes(w))) {
          const i = text.toLowerCase().indexOf(words[0]); hits.push(i < 0 ? { id: p.id, pre: '', hit: '', post: text.slice(0, 80) } : { id: p.id, pre: text.slice(Math.max(0, i - 30), i), hit: text.slice(i, i + words[0].length), post: text.slice(i + words[0].length, i + 70) }); } }));
      return wait(hits); },
    set_pref: () => wait(null),
    open_notes_folder: () => wait(null),
    choose_notes_folder: () => wait(null),
  };
};
