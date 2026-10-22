/* NiSH Notes - the page. Talks to Python through window.pywebview.api (see app.py). */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const tree = $('tree'), editor = $('editor'), titleInput = $('title'), statusEl = $('status'), statusText = $('statusText');
  const ICON = {
    chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
    grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
  };
  const COLORS = ['#E3A93E', '#6A9BD1', '#D97B63', '#79AE7F', '#A58BD6', '#8C8A84'];

  let api = null;
  let nb = { root: '', folders: [] };
  let version = '';
  let activeId = null;
  let dirty = false, saveTimer = 0, saving = Promise.resolve();
  let renameTimer = 0, pendingTitle = null;
  let searchHits = null, searchTimer = 0;
  let drag = null;

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function findPage(id) {
    for (const f of nb.folders) { const p = f.pages.find((x) => x.id === id); if (p) return { folder: f, page: p }; }
    return null;
  }
  const findFolder = (id) => nb.folders.find((f) => f.id === id) || null;
  function fmtLong(iso) {
    const d = new Date(iso); if (isNaN(d)) return '';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(',', '');
  }
  function fmtShort(iso) {
    const d = new Date(iso); if (isNaN(d)) return '';
    const opts = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = '2-digit';
    return d.toLocaleDateString('en-GB', opts);
  }
  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }
  const errText = (e) => (e && (e.message || e.toString())) || 'unknown error';
  async function call(name, ...args) {
    try { return await api[name](...args); }
    catch (e) { toast('Something went wrong: ' + errText(e)); throw e; }
  }
  function setStatus(state) {
    statusEl.dataset.state = state;
    statusText.textContent = state === 'saving' ? 'Saving…' : state === 'error' ? 'Not saved' : 'Saved';
  }

  // ---------- the folder menu ----------
  function renderTree() {
    const focused = document.activeElement;
    const focusKey = focused && tree.contains(focused)
      ? (focused.closest('[data-page]') ? 'p:' + focused.closest('[data-page]').dataset.page
        : focused.closest('[data-folder]') ? 'f:' + focused.closest('[data-folder]').dataset.folder : null) : null;
    const html = [];
    for (const f of nb.folders) {
      const pages = searchHits ? f.pages.filter((p) => searchHits.has(p.id)) : f.pages;
      if (searchHits && !pages.length) continue;
      const open = searchHits ? true : f.open;
      html.push(
        '<section class="folder' + (open ? ' open' : '') + '" data-folder="' + esc(f.id) + '" style="--fc:' + esc(f.color) + '">' +
          '<button type="button" class="folder-head" draggable="true" aria-expanded="' + open + '">' +
            ICON.chev + '<span class="swatch"></span><span class="folder-name">' + esc(f.name) + '</span>' +
            '<span class="count">' + f.pages.length + '</span></button>' +
          '<ul class="pages">' +
            (pages.length ? pages.map((p) =>
              '<li class="page' + (p.id === activeId ? ' active' : '') + '" data-page="' + esc(p.id) + '" draggable="true">' +
                '<span class="grip" title="Drag to sort" aria-hidden="true">' + ICON.grip + '</span>' +
                '<button type="button" class="page-btn"' + (p.id === activeId ? ' aria-current="page"' : '') + '>' +
                  '<span class="t">' + esc(p.title) + '</span><span class="d">' + esc(fmtShort(p.created)) + '</span></button></li>').join('')
              : '<li class="none">Empty – drop a page here</li>') +
          '</ul></section>');
    }
    if (searchHits && !html.length) html.push('<p class="pages none" style="padding:8px 4px">No pages match.</p>');
    if (!nb.folders.length) html.push('<p class="pages none" style="padding:8px 4px">No folders yet.</p>');
    tree.innerHTML = html.join('');
    if (focusKey) {
      const [k, id] = [focusKey[0], focusKey.slice(2)];
      const el = k === 'p' ? tree.querySelector('[data-page="' + CSS.escape(id) + '"] .page-btn')
        : tree.querySelector('[data-folder="' + CSS.escape(id) + '"] .folder-head');
      if (el) el.focus();
    }
  }

  function renderHead() {
    const hit = activeId && findPage(activeId);
    $('empty').hidden = !!hit;
    editor.disabled = titleInput.disabled = $('deletePageBtn').disabled = !hit;
    if (!hit) {
      editor.value = ''; titleInput.value = ''; $('folderLabel').textContent = ''; $('date').textContent = '';
      return;
    }
    $('folderLabel').textContent = hit.folder.name;
    $('date').textContent = fmtLong(hit.page.created);
    if (document.activeElement !== titleInput) titleInput.value = hit.page.title;
  }

  // ---------- pages ----------
  async function flush() {
    clearTimeout(saveTimer);
    if (dirty && activeId) {
      const id = activeId, text = editor.value;
      dirty = false;
      saving = saving.then(() => api.save_page(id, text)).then((updated) => {
        const hit = findPage(id); if (hit) hit.page.updated = updated;
        if (!dirty) setStatus('saved');
      }).catch((e) => {
        if (id === activeId) dirty = true;
        setStatus('error'); toast('Could not save the page: ' + errText(e));
      });
    }
    return saving;
  }

  async function flushTitle() {
    clearTimeout(renameTimer);
    if (pendingTitle && findPage(pendingTitle.id)) {
      const { id, title } = pendingTitle; pendingTitle = null;
      try {
        const real = await api.rename_page(id, title);
        const hit = findPage(id); if (hit) hit.page.title = real;
      } catch (e) { toast('Could not rename the page: ' + errText(e)); }
    }
    pendingTitle = null;
  }

  async function openPage(id, opts) {
    await flushTitle(); await flush();
    const hit = findPage(id);
    if (!hit) { activeId = null; renderHead(); renderTree(); return; }
    activeId = id;
    let text = '';
    try { text = await call('read_page', id); } catch (e) { text = ''; }
    if (activeId !== id) return;
    editor.value = text; editor.scrollTop = 0; dirty = false; setStatus('saved');
    renderHead(); renderTree();
    api.set_pref('last_page', id);
    if (opts && opts.focusTitle) { titleInput.focus(); titleInput.select(); }
  }

  function currentFolderId() {
    const hit = activeId && findPage(activeId);
    if (hit) return hit.folder.id;
    return nb.folders.length ? nb.folders[0].id : null;
  }

  async function refresh() { nb = await call('snapshot'); }

  async function newPage(folderId, title, text) {
    await flushTitle(); await flush();
    let fid = folderId || currentFolderId();
    if (!fid) fid = await call('create_folder', 'Inbox');
    const id = await call('create_page', fid, title || 'Untitled', null);
    if (text) await call('save_page', id, text);
    await refresh();
    if (searchHits) { $('search').value = ''; searchHits = null; }
    await openPage(id, { focusTitle: !title });
    return id;
  }

  async function newFolder(name) {
    const id = await call('create_folder', name || 'New folder', null);
    await refresh(); renderTree();
    if (!name) startRenameFolder(id);
    return id;
  }

  async function deletePage(id, skipConfirm) {
    const hit = findPage(id); if (!hit) return;
    if (!skipConfirm && !(await confirmBox('Delete page?',
      '“' + hit.page.title + '” will be moved to the _Trash folder inside your notes folder.'))) return;
    if (id === activeId) { await flushTitle(); await flush(); }
    const list = hit.folder.pages, i = list.indexOf(hit.page);
    await call('delete_page', id);
    list.splice(i, 1);
    if (id === activeId) {
      const next = list[i] || list[i - 1];
      activeId = null;
      if (next) await openPage(next.id); else { renderHead(); renderTree(); }
    } else renderTree();
  }

  async function deleteFolder(id) {
    const f = findFolder(id); if (!f) return;
    const n = f.pages.length;
    if (!(await confirmBox('Delete folder?', '“' + f.name + '”' + (n ? ' and its ' + n + (n === 1 ? ' page' : ' pages') : '') +
      ' will be moved to the _Trash folder inside your notes folder.'))) return;
    const hadActive = activeId && f.pages.some((p) => p.id === activeId);
    if (hadActive) { await flushTitle(); await flush(); }
    await call('delete_folder', id);
    nb.folders.splice(nb.folders.indexOf(f), 1);
    if (hadActive) {
      activeId = null;
      const first = nb.folders.find((x) => x.pages.length);
      if (first) await openPage(first.pages[0].id); else { renderHead(); renderTree(); }
    } else renderTree();
  }

  async function movePage(id, folderId, index) {
    const hit = findPage(id), dst = findFolder(folderId); if (!hit || !dst) return;
    const src = hit.folder, from = src.pages.indexOf(hit.page);
    if (src === dst && from < index) index -= 1;
    if (src === dst && from === index) return;
    src.pages.splice(from, 1); dst.pages.splice(Math.max(0, Math.min(index, dst.pages.length)), 0, hit.page);
    if (src !== dst) dst.open = true;
    renderTree(); renderHead();
    try { await call('move_page', id, folderId, index); } catch (e) { await refresh(); renderTree(); renderHead(); }
  }

  async function moveFolder(id, index) {
    const f = findFolder(id); if (!f) return;
    const from = nb.folders.indexOf(f);
    if (from < index) index -= 1;
    if (from === index) return;
    nb.folders.splice(from, 1); nb.folders.splice(index, 0, f);
    renderTree();
    try { await call('move_folder', id, index); } catch (e) { await refresh(); renderTree(); }
  }

  async function toggleFolder(id) {
    if (searchHits) return;
    const f = findFolder(id); if (!f) return;
    f.open = !f.open; renderTree();
    api.set_folder(id, null, f.open);
  }

  async function setColor(id, color) {
    const f = findFolder(id); if (!f) return;
    f.color = color; renderTree();
    await call('set_folder', id, color, null);
  }

  // ---------- inline renaming ----------
  function inlineInput(host, value, done) {
    const input = document.createElement('input');
    input.className = 'rename'; input.value = value; input.setAttribute('aria-label', 'New name');
    host.replaceWith(input); input.focus(); input.select();
    let finished = false;
    const finish = (ok) => { if (finished) return; finished = true; done(ok ? input.value.trim() : null); };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  function startRenameFolder(id) {
    const el = tree.querySelector('[data-folder="' + CSS.escape(id) + '"] .folder-name');
    const f = findFolder(id); if (!el || !f) return;
    el.closest('.folder-head').draggable = false;
    inlineInput(el, f.name, async (name) => {
      if (name && name !== f.name) {
        try { f.name = await call('rename_folder', id, name); } catch (e) { /* toast shown */ }
      }
      renderTree(); renderHead();
      const head = tree.querySelector('[data-folder="' + CSS.escape(id) + '"] .folder-head'); if (head) head.focus();
    });
  }

  function startRenamePage(id) {
    const btn = tree.querySelector('[data-page="' + CSS.escape(id) + '"] .page-btn');
    const hit = findPage(id); if (!btn || !hit) return;
    btn.closest('.page').draggable = false;
    inlineInput(btn, hit.page.title, async (title) => {
      if (title && title !== hit.page.title) {
        if (pendingTitle && pendingTitle.id === id) { clearTimeout(renameTimer); pendingTitle = null; }
        try { hit.page.title = await call('rename_page', id, title); } catch (e) { /* toast shown */ }
      }
      renderTree(); renderHead();
      const b = tree.querySelector('[data-page="' + CSS.escape(id) + '"] .page-btn'); if (b) b.focus();
    });
  }

  // ---------- menus and dialogs ----------
  const menu = $('menu');
  function openMenu(x, y, items) {
    menu.innerHTML = '';
    for (const it of items) {
      if (it === '-') { menu.appendChild(document.createElement('hr')); continue; }
      if (it.colors) {
        const row = document.createElement('div'); row.className = 'colors'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Folder colour');
        for (const c of COLORS) {
          const b = document.createElement('button'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', 'Colour ' + c);
          b.setAttribute('aria-pressed', String(c.toLowerCase() === (it.current || '').toLowerCase()));
          b.addEventListener('click', () => { closeMenu(); it.colors(c); });
          row.appendChild(b);
        }
        menu.appendChild(row); continue;
      }
      if (it.note) { const p = document.createElement('div'); p.className = 'note'; p.textContent = it.note; menu.appendChild(p); continue; }
      const b = document.createElement('button'); b.type = 'button'; b.className = 'item' + (it.danger ? ' danger-item' : '');
      b.setAttribute('role', 'menuitem'); b.textContent = it.label;
      b.addEventListener('click', () => { closeMenu(); it.run(); });
      menu.appendChild(b);
    }
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    const first = menu.querySelector('button'); if (first) first.focus();
  }
  function closeMenu() { menu.hidden = true; }
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);

  function confirmBox(title, text) {
    return new Promise((resolve) => {
      const back = $('modal'), ok = $('modalOk'), cancel = $('modalCancel');
      $('modalTitle').textContent = title; $('modalText').textContent = text;
      const prev = document.activeElement;
      back.hidden = false; cancel.focus();
      const done = (v) => {
        back.hidden = true; ok.onclick = cancel.onclick = back.onmousedown = null; document.removeEventListener('keydown', key, true);
        if (prev && prev.focus) prev.focus();
        resolve(v);
      };
      const key = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === ok ? cancel : ok).focus(); }
      };
      ok.onclick = () => done(true); cancel.onclick = () => done(false);
      back.onmousedown = (e) => { if (e.target === back) done(false); };
      document.addEventListener('keydown', key, true);
    });
  }

  function folderMenu(id, x, y) {
    const f = findFolder(id); if (!f) return;
    openMenu(x, y, [
      { label: 'New page here', run: () => newPage(id) },
      { label: 'Rename folder', run: () => startRenameFolder(id) },
      { colors: (c) => setColor(id, c), current: f.color },
      '-',
      { label: 'Delete folder…', danger: true, run: () => deleteFolder(id) },
    ]);
  }

  function pageMenu(id, x, y) {
    const hit = findPage(id); if (!hit) return;
    const others = nb.folders.filter((f) => f !== hit.folder).slice(0, 8);
    openMenu(x, y, [
      { label: 'Rename page', run: () => startRenamePage(id) },
      ...others.map((f) => ({ label: 'Move to ' + f.name, run: () => movePage(id, f.id, f.pages.length) })),
      '-',
      { label: 'Delete page…', danger: true, run: () => deletePage(id) },
    ]);
  }

  function moreMenu() {
    const r = $('moreBtn').getBoundingClientRect();
    const items = [];
    if (!api.mock) {
      items.push({ label: 'Open notes folder', run: () => call('open_notes_folder') });
      items.push({ label: 'Change notes folder…', run: changeFolder });
      items.push({ label: 'Reload from disk', run: reloadFromDisk });
      items.push('-');
    }
    items.push({ note: 'Notes are saved in: ' + nb.root });
    items.push({ note: 'NiSH Notes ' + version });
    openMenu(r.right - 230, r.bottom + 6, items);
  }

  async function changeFolder() {
    await flushTitle(); await flush();
    const snap = await call('choose_notes_folder');
    if (!snap) return;
    nb = snap; activeId = null; searchHits = null; $('search').value = '';
    const first = nb.folders.find((f) => f.pages.length);
    if (first) await openPage(first.pages[0].id); else { renderHead(); renderTree(); }
    toast('Now using ' + nb.root);
  }

  async function reloadFromDisk() {
    await flushTitle(); await flush();
    nb = await call('reload');
    if (activeId && findPage(activeId)) await openPage(activeId); else {
      activeId = null; const first = nb.folders.find((f) => f.pages.length);
      if (first) await openPage(first.pages[0].id); else { renderHead(); renderTree(); }
    }
  }

  // ---------- drag and drop ----------
  function clearMarks() {
    tree.querySelectorAll('.drop-before,.drop-after,.drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
  }
  function dropTarget(e) {
    if (!drag) return null;
    if (drag.type === 'page') {
      const li = e.target.closest('.page');
      if (li) {
        const hit = findPage(li.dataset.page); if (!hit) return null;
        const r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        const index = hit.folder.pages.indexOf(hit.page) + (after ? 1 : 0);
        return { el: li, cls: after ? 'drop-after' : 'drop-before', folder: hit.folder.id, index };
      }
      const fel = e.target.closest('.folder');
      if (fel) { const f = findFolder(fel.dataset.folder); return f && { el: fel, cls: 'drop-into', folder: f.id, index: f.pages.length }; }
      return null;
    }
    const fel = e.target.closest('.folder');
    if (!fel) return null;
    const f = findFolder(fel.dataset.folder); if (!f) return null;
    const r = fel.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
    return { el: fel, cls: after ? 'drop-after' : 'drop-before', index: nb.folders.indexOf(f) + (after ? 1 : 0) };
  }
  tree.addEventListener('dragstart', (e) => {
    if (searchHits) { e.preventDefault(); toast('Clear the search to sort pages.'); return; }
    const li = e.target.closest && e.target.closest('.page');
    const head = e.target.closest && e.target.closest('.folder-head');
    if (li) { drag = { type: 'page', id: li.dataset.page }; li.classList.add('dragging'); }
    else if (head) { drag = { type: 'folder', id: head.closest('.folder').dataset.folder }; head.closest('.folder').classList.add('dragging'); }
    else return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-nish', drag.id);
    closeMenu();
  });
  tree.addEventListener('dragover', (e) => {
    if (!drag) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    clearMarks();
    const t = dropTarget(e); if (t) t.el.classList.add(t.cls);
    const r = tree.getBoundingClientRect();   // scroll while dragging near the edges
    if (e.clientY < r.top + 30) tree.scrollTop -= 10; else if (e.clientY > r.bottom - 30) tree.scrollTop += 10;
  });
  tree.addEventListener('dragleave', (e) => { if (!tree.contains(e.relatedTarget)) clearMarks(); });
  tree.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    const t = dropTarget(e), d = drag;
    clearMarks(); drag = null;
    if (!t) return;
    if (d.type === 'page') movePage(d.id, t.folder, t.index); else moveFolder(d.id, t.index);
  });
  tree.addEventListener('dragend', () => { drag = null; clearMarks(); tree.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging')); });

  // Dropping .txt files from Explorer anywhere adds them as pages; anything else is ignored
  // (instead of the window navigating away to the file).
  document.addEventListener('dragover', (e) => { if (!drag) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('drop', async (e) => {
    if (drag) return;
    e.preventDefault();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => /\.(txt|md)$/i.test(f.name));
    if (!files.length) { if (e.dataTransfer && e.dataTransfer.files.length) toast('Only .txt and .md files can be added as pages.'); return; }
    let fid = null;
    const fel = e.target.closest && e.target.closest('.folder');
    if (fel) fid = fel.dataset.folder;
    for (const f of files) await newPage(fid, f.name.replace(/\.(txt|md)$/i, ''), await f.text());
    toast(files.length === 1 ? 'Added 1 page.' : 'Added ' + files.length + ' pages.');
  });

  // ---------- events ----------
  tree.addEventListener('click', (e) => {
    const pageBtn = e.target.closest('.page-btn');
    if (pageBtn) { const id = pageBtn.closest('.page').dataset.page; if (id !== activeId) openPage(id); return; }
    const head = e.target.closest('.folder-head');
    if (head) toggleFolder(head.closest('.folder').dataset.folder);
  });
  tree.addEventListener('dblclick', (e) => {
    const name = e.target.closest('.folder-name');
    if (name) { e.preventDefault(); startRenameFolder(name.closest('.folder').dataset.folder); return; }
    const page = e.target.closest('.page-btn');
    if (page) { e.preventDefault(); startRenamePage(page.closest('.page').dataset.page); }
  });
  tree.addEventListener('contextmenu', (e) => {
    const page = e.target.closest('.page'), folder = e.target.closest('.folder');
    if (e.target.closest('.rename')) return;
    e.preventDefault();
    if (page) pageMenu(page.dataset.page, e.clientX, e.clientY);
    else if (folder) folderMenu(folder.dataset.folder, e.clientX, e.clientY);
  });
  tree.addEventListener('keydown', (e) => {
    const page = e.target.closest('.page-btn') && e.target.closest('.page');
    const head = e.target.closest('.folder-head');
    if (e.key === 'F2') { e.preventDefault(); if (page) startRenamePage(page.dataset.page); else if (head) startRenameFolder(head.closest('.folder').dataset.folder); }
    if (e.key === 'Delete') { e.preventDefault(); if (page) deletePage(page.dataset.page); else if (head) deleteFolder(head.closest('.folder').dataset.folder); }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault(); const r = e.target.getBoundingClientRect();
      if (page) pageMenu(page.dataset.page, r.left + 20, r.bottom); else if (head) folderMenu(head.closest('.folder').dataset.folder, r.left + 20, r.bottom);
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const all = Array.from(tree.querySelectorAll('.folder-head, .folder.open .page-btn'));
      const i = all.indexOf(e.target);
      if (i >= 0) { e.preventDefault(); const next = all[i + (e.key === 'ArrowDown' ? 1 : -1)]; if (next) next.focus(); }
    }
  });

  editor.addEventListener('input', () => {
    if (!activeId) return;
    dirty = true; setStatus('saving');
    clearTimeout(saveTimer); saveTimer = setTimeout(flush, 300);
  });
  editor.addEventListener('blur', () => { flush(); });
  editor.addEventListener('keydown', (e) => {   // Tab writes a tab instead of leaving the page
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const s = editor.selectionStart, en = editor.selectionEnd;
      editor.setRangeText('\t', s, en, 'end');
      editor.dispatchEvent(new Event('input'));
    }
  });

  titleInput.addEventListener('input', () => {
    const hit = activeId && findPage(activeId); if (!hit) return;
    hit.page.title = titleInput.value.trim() || 'Untitled';
    pendingTitle = { id: activeId, title: hit.page.title };
    renderTree();
    clearTimeout(renameTimer); renameTimer = setTimeout(flushTitle, 600);
  });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); editor.focus(); editor.setSelectionRange(0, 0); }
  });
  titleInput.addEventListener('blur', () => {
    flushTitle();
    const hit = activeId && findPage(activeId); if (hit && !titleInput.value.trim()) titleInput.value = hit.page.title;
  });

  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('search').value.trim();
      if (!q) { searchHits = null; renderTree(); return; }
      await flush();
      const hits = await call('search', q);
      if ($('search').value.trim() === q) { searchHits = new Set(hits); renderTree(); }
    }, 200);
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('search').value = ''; searchHits = null; renderTree(); }
    if (e.key === 'Enter') { const b = tree.querySelector('.page-btn'); if (b) b.click(); }
  });

  $('newPageBtn').addEventListener('click', () => newPage());
  $('emptyNew').addEventListener('click', () => newPage());
  $('newFolderBtn').addEventListener('click', () => newFolder());
  $('moreBtn').addEventListener('click', moreMenu);
  $('deletePageBtn').addEventListener('click', () => activeId && deletePage(activeId));
  $('fontBtn').addEventListener('click', () => {
    const clean = !document.body.classList.contains('font-clean');
    applyFont(clean ? 'clean' : 'hand');
    api.set_pref('font', clean ? 'clean' : 'hand');
  });
  function applyFont(font) {
    document.body.classList.toggle('font-clean', font === 'clean');
    document.body.classList.toggle('font-hand', font !== 'clean');
    $('fontBtn').title = font === 'clean' ? 'Switch to handwriting' : 'Switch to plain text';
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { closeMenu(); return; }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'n' && e.shiftKey) { e.preventDefault(); newFolder(); }
    else if (k === 'n') { e.preventDefault(); newPage(); }
    else if (k === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); }
    else if (k === 's') { e.preventDefault(); flushTitle(); flush(); }
    else if (k === 'p' || k === 'r' || k === 'o' || k === 'g' || k === 'h' || k === 'j') e.preventDefault();   // browser shortcuts
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { flushTitle(); flush(); } });
  window.addEventListener('pagehide', () => { flushTitle(); flush(); });

  // ---------- start ----------
  function whenApi() {
    return new Promise((resolve) => {
      let done = false;
      const ok = () => window.pywebview && window.pywebview.api && typeof window.pywebview.api.init === 'function';
      const finish = (a) => { if (!done) { done = true; resolve(a); } };
      if (ok()) return finish(window.pywebview.api);
      window.addEventListener('pywebviewready', () => finish(window.pywebview.api));
      setTimeout(() => { if (ok()) finish(window.pywebview.api); else if (!window.pywebview) finish(window.makeMockApi()); }, 1500);
    });
  }

  async function start() {
    renderHead();
    api = await whenApi();
    const info = await api.init();
    nb = info.notebook; version = info.version || '';
    applyFont(info.prefs && info.prefs.font);
    const last = info.prefs && info.prefs.lastPage;
    const first = nb.folders.find((f) => f.pages.length);
    if (last && findPage(last)) await openPage(last);
    else if (first) await openPage(first.pages[0].id);
    else { renderHead(); renderTree(); }
    NN.ready = true;
  }

  // ---------- self-test (run by the GUI smoke test in the build) ----------
  async function selfTest() {
    const steps = [];
    const check = (name, ok) => steps.push({ name, ok: !!ok });
    const type = (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
    try {
      const a = await newFolder('Smoke A');
      const b = await newFolder('Smoke B');
      check('create folders', tree.querySelector('[data-folder="' + a + '"]') && findFolder(b) && findFolder(b).name === 'Smoke B');
      $('newPageBtn').click();
      await sleep(400);
      const hitNew = findPage(activeId);
      check('new page button opens an empty page', hitNew && editor.value === '' && document.activeElement === titleInput);
      await movePage(activeId, a, 0);
      const pid = activeId;
      type(editor, 'Hello from the smoke test\nSecond line');
      check('typing shows Saving…', statusEl.dataset.state === 'saving');
      await sleep(700); await saving;
      check('page saves itself', statusEl.dataset.state === 'saved' && (await api.read_page(pid)) === 'Hello from the smoke test\nSecond line');
      titleInput.focus(); type(titleInput, 'Renamed page');
      await sleep(900); await flushTitle();
      const snap = await api.snapshot();
      check('renaming a page from its title', snap.folders.some((f) => f.pages.some((p) => p.id === pid && p.title === 'Renamed page')));
      await movePage(pid, b, 0);
      const snap2 = await api.snapshot();
      const fb = snap2.folders.find((f) => f.id === b);
      check('moving a page to another folder', fb && fb.pages[0] && fb.pages[0].id === pid && tree.querySelector('[data-folder="' + b + '"] [data-page="' + pid + '"]'));
      await moveFolder(b, 0);
      check('sorting folders', (await api.snapshot()).folders[0].id === b);
      await toggleFolder(a); const closed = !findFolder(a).open; await toggleFolder(a);
      check('opening and closing a folder', closed && findFolder(a).open);
      const tmp = await newPage(a, 'Delete me');
      await deletePage(tmp, true);
      check('deleting a page', !findPage(tmp) && !(await api.snapshot()).folders.some((f) => f.pages.some((p) => p.id === tmp)));
      type($('search'), 'smoke test'); await sleep(600);
      check('search finds text inside pages', searchHits && searchHits.has(pid) && tree.querySelectorAll('.page').length >= 1);
      $('search').value = ''; searchHits = null; renderTree();
      await setColor(a, COLORS[3]);
      check('folder colour', (await api.snapshot()).folders.find((f) => f.id === a).color === COLORS[3]);
      await openPage(pid);
      check('reopening a page shows its text', editor.value.startsWith('Hello from the smoke test') && titleInput.value === 'Renamed page');
    } catch (e) {
      steps.push({ name: 'self-test crashed: ' + errText(e), ok: false });
    }
    window.NN_TEST = { steps };
    return steps;
  }

  window.NN = { ready: false, selfTest, newPage, newFolder, openPage, movePage, moveFolder, deletePage };
  start().catch((e) => toast('NiSH Notes could not start: ' + errText(e)));
})();
