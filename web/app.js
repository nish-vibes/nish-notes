/* NiSH Notes - the page. Talks to Python through window.pywebview.api (see app.py). */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const tree = $('tree'), titleInput = $('title');
  let editor = $('editor'), margin = $('margin');
  const paper = $('paper'), leaf = $('leaf'), inkSvg = $('ink'), fmt = $('fmt'), menu = $('menu');
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICON = {
    chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
    grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>',
    check: '<svg class="check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  };
  const COLORS = ['#E3A93E', '#6A9BD1', '#D97B63', '#79AE7F', '#A58BD6', '#8C8A84'];
  const INK_COLORS = [['#22304A', 'Ink blue'], ['#1F1F1F', 'Black'], ['#C2362F', 'Red'], ['#2E7D4F', 'Green'], ['#2F5E9E', 'Blue'], ['#F2C200', 'Yellow']];
  const INK_SIZES = { pen: [2, 3.5, 6], marker: [10, 16, 24] };

  let api = null;
  let nb = { root: '', folders: [] };
  let version = '';
  let activeId = null;
  let searchHits = null, searchTimer = 0;
  let renameTimer = 0, pendingTitle = null;
  let lastEd = editor;                        // the column the format commands act on
  const save = { dirty: false, timer: 0, chain: Promise.resolve(true), failed: false, retry: 0, shown: false };
  const ink = { strokes: [], undo: [], redo: [], on: false, tool: 'pen', color: { pen: '#22304A', marker: '#F2C200' }, size: { pen: 1, marker: 1 }, cur: null, curEl: null, erased: null };

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errText = (e) => (e && (e.message || e.toString())) || 'unknown error';
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
  async function call(name, ...args) {
    try { return await api[name](...args); }
    catch (e) { toast('Something went wrong: ' + errText(e)); throw e; }
  }

  // ---------- keeping pasted and loaded text safe and tidy ----------
  // Only these tags survive; everything else is unwrapped (its text kept) or dropped.
  const KEEP = { DIV: 'div', P: 'div', BR: 'br', H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h3', H5: 'h3', H6: 'h3', PRE: 'pre',
    B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', S: 's', STRIKE: 's', DEL: 's', UL: 'ul', OL: 'ol', LI: 'li',
    BLOCKQUOTE: 'div', SECTION: 'div', ARTICLE: 'div', HEADER: 'div', FOOTER: 'div', ASIDE: 'div', MAIN: 'div', NAV: 'div',
    FIGURE: 'div', ADDRESS: 'div', TABLE: 'div', TR: 'div', DL: 'div', DT: 'div', DD: 'div', CENTER: 'div' };
  const DROP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'HEAD', 'TITLE', 'META', 'LINK', 'NOSCRIPT',
    'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'PICTURE', 'SOURCE', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'FORM', 'XML']);
  function copyClean(src, dst) {
    for (const n of Array.from(src.childNodes)) {
      if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toUpperCase();
      if (DROP.has(tag) || tag.includes(':')) continue;
      const name = KEEP[tag];
      if (!name) {                                    // span, a, font, td ... keep the text only
        copyClean(n, dst);
        if (tag === 'TD' || tag === 'TH') dst.appendChild(document.createTextNode(' '));
        continue;
      }
      const el = document.createElement(name);
      if (name === 'ul') {
        const c = n.getAttribute('class') || '';
        if (/\bchecklist\b/.test(c)) el.className = 'checklist'; else if (/\bdashed\b/.test(c)) el.className = 'dashed';
      }
      if (name === 'li' && n.hasAttribute('data-checked')) el.setAttribute('data-checked', '');
      if (name !== 'br') copyClean(n, el);
      dst.appendChild(el);
    }
  }
  function sanitize(html) {
    const doc = new DOMParser().parseFromString('<!doctype html><body>' + String(html || ''), 'text/html');
    const box = document.createElement('div');
    copyClean(doc.body, box);
    return box.innerHTML;
  }
  function edHTML(el) {
    const html = sanitize(el.innerHTML);
    return /^(<div>)?(<br>)?(<\/div>)?$/.test(html) ? '' : html;
  }
  const textToHtml = (t) => String(t || '').replace(/\r\n?/g, '\n').split('\n').map((l) => '<div>' + (esc(l) || '<br>') + '</div>').join('');

  // ---------- saving ----------
  // Pages save themselves a moment after each change. "Saved" is the normal state, so nothing is
  // shown for it; only a failed save is reported, in a popup.
  function changed() {
    if (!activeId) return;
    save.dirty = true;
    clearTimeout(save.timer); save.timer = setTimeout(flush, 350);
  }
  function serialize() { return { text: edHTML(editor), margin: edHTML(margin), ink: ink.strokes }; }
  function flush() {
    clearTimeout(save.timer);
    if (!save.dirty || !activeId) return save.chain;
    const id = activeId, doc = serialize();
    save.dirty = false;
    save.chain = save.chain.then(async () => {
      try {
        const updated = await api.save_page(id, doc);
        const hit = findPage(id); if (hit) hit.page.updated = updated;
        if (save.failed && !save.dirty) {
          save.failed = false; save.shown = false; clearTimeout(save.retry);
          if (dialogState && dialogState.kind === 'save') closeDialog(true);
          toast('Saved.');
        }
        return true;
      } catch (e) {
        if (id === activeId) save.dirty = true;
        save.failed = true;
        reportSaveError(e);
        clearTimeout(save.retry); save.retry = setTimeout(() => { if (save.dirty) flush(); }, 8000);
        return false;
      }
    });
    return save.chain;
  }
  function reportSaveError(e, force) {
    if ((save.shown && !force) || (dialogState && dialogState.kind !== 'save')) return;
    save.shown = true;
    const hit = activeId && findPage(activeId);
    dialog({
      kind: 'save', title: 'Couldn’t save ' + (hit ? '“' + hit.page.title + '”' : 'the page'),
      text: 'Your writing is still here, but it isn’t on the disk yet. NiSH Notes keeps trying every few seconds.\n\n' +
        'This can happen when the notes folder is on a USB stick that was removed, or OneDrive is busy.\n\nReason: ' + errText(e),
      ok: 'Try again', cancel: 'OK', calm: true,
    }).then((again) => { if (again) flush(); });
  }

  // ---------- title ----------
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

  // ---------- the folder menu ----------
  function renderTree() {
    const focused = document.activeElement;
    let focusKey = null;
    if (focused && tree.contains(focused) && !focused.classList.contains('rename')) {
      const pg = focused.closest('[data-page]'), fo = focused.closest('[data-folder]');
      focusKey = pg ? 'p:' + pg.dataset.page : fo ? 'f:' + fo.dataset.folder : null;
    }
    const html = [];
    for (const f of nb.folders) {
      const pages = searchHits ? f.pages.filter((p) => searchHits.has(p.id)) : f.pages;
      if (searchHits && !pages.length) continue;
      const open = searchHits ? true : f.open;
      html.push(
        '<section class="folder' + (open ? ' open' : '') + '" data-folder="' + esc(f.id) + '" style="--fc:' + esc(f.color) + '">' +
          '<div class="folder-row">' +
            '<span class="grip" title="Drag to move" aria-hidden="true">' + ICON.grip + '</span>' +
            '<button type="button" class="folder-head" aria-expanded="' + open + '">' +
              ICON.chev + '<span class="swatch"></span><span class="folder-name">' + esc(f.name) + '</span>' +
              '<span class="count">' + f.pages.length + '</span></button>' +
            '<button type="button" class="row-more" aria-label="Folder options" title="Options">' + ICON.more + '</button>' +
          '</div>' +
          '<ul class="pages">' +
            (pages.length ? pages.map((p) =>
              '<li class="page' + (p.id === activeId ? ' active' : '') + '" data-page="' + esc(p.id) + '">' +
                '<span class="grip" title="Drag to move" aria-hidden="true">' + ICON.grip + '</span>' +
                '<button type="button" class="page-btn"' + (p.id === activeId ? ' aria-current="page"' : '') + '>' +
                  '<span class="t">' + esc(p.title) + '</span><span class="d">' + esc(fmtShort(p.created)) + '</span></button>' +
                '<button type="button" class="row-more" aria-label="Page options" title="Options">' + ICON.more + '</button></li>').join('')
              : '<li class="none">Empty – drop a page here</li>') +
          '</ul></section>');
    }
    if (searchHits && !html.length) html.push('<p class="pages none" style="padding:8px 4px">No pages match.</p>');
    if (!nb.folders.length) html.push('<p class="pages none" style="padding:8px 4px">No folders yet.</p>');
    tree.innerHTML = html.join('');
    if (focusKey) {
      const id = focusKey.slice(2);
      const el = focusKey[0] === 'p' ? tree.querySelector('[data-page="' + CSS.escape(id) + '"] .page-btn')
        : tree.querySelector('[data-folder="' + CSS.escape(id) + '"] .folder-head');
      if (el) el.focus();
    }
  }

  function renderHead() {
    const hit = activeId && findPage(activeId);
    $('empty').hidden = !!hit;
    for (const id of ['formatBtn', 'checkBtn', 'scribbleBtn', 'deletePageBtn']) $(id).disabled = !hit;
    titleInput.disabled = !hit;
    if (!hit) { titleInput.value = ''; $('folderLabel').textContent = ''; $('date').textContent = ''; return; }
    $('folderLabel').textContent = hit.folder.name;
    $('date').textContent = fmtLong(hit.page.created);
    if (document.activeElement !== titleInput) titleInput.value = hit.page.title;
  }

  // ---------- pages ----------
  function setEditable(on) {
    for (const el of [editor, margin]) el.contentEditable = on ? 'true' : 'false';
  }
  function updateEmpty() {
    for (const el of [editor, margin]) el.classList.toggle('is-empty', !el.textContent && !el.querySelector('li'));
  }
  function loadDoc(doc) {
    // A fresh element per page keeps the browser's undo history from reaching into the previous page.
    for (const [old, html] of [[editor, doc.text], [margin, doc.margin]]) {
      const fresh = old.cloneNode(false);
      fresh.innerHTML = sanitize(html);
      old.replaceWith(fresh);
      if (old === editor) editor = fresh; else margin = fresh;
    }
    bindEditor(editor); bindEditor(margin);
    lastEd = editor;
    ink.strokes = Array.isArray(doc.ink) ? doc.ink : [];
    ink.undo = []; ink.redo = [];
    renderInk(); updateEmpty(); syncInkButtons();
    if (ink.on) setEditable(false);
    paper.scrollTop = 0;
  }

  async function openPage(id, opts) {
    await flushTitle();
    if (!(await flush())) { reportSaveError(new Error('The last change could not be saved.'), true); return false; }
    const hit = findPage(id);
    if (!hit) { activeId = null; loadDoc({ text: '', margin: '', ink: [] }); renderHead(); renderTree(); return false; }
    activeId = id;
    let doc = { text: '', margin: '', ink: [] };
    try { doc = await call('read_page', id); } catch (e) { /* toast shown */ }
    if (activeId !== id) return false;
    loadDoc(doc || {});
    save.dirty = false;
    renderHead(); renderTree();
    api.set_pref('last_page', id);
    if (opts && opts.focusTitle) { titleInput.focus(); titleInput.select(); }
    return true;
  }

  function currentFolderId() {
    const hit = activeId && findPage(activeId);
    if (hit) return hit.folder.id;
    return nb.folders.length ? nb.folders[0].id : null;
  }

  async function refresh() { nb = await call('snapshot'); }

  let creating = false, wantBody = false;
  function caretToStart() {
    editor.focus();
    const r = document.createRange(); r.selectNodeContents(editor); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  async function newPage(folderId, title, html) {
    await flushTitle();
    if (!title) {                 // take typing at once; it becomes the new page's title
      creating = true;
      titleInput.disabled = false; titleInput.value = ''; titleInput.focus();
    }
    try { return await createPage(folderId, title, html); } finally { creating = false; }
  }
  async function createPage(folderId, title, html) {
    if (!(await flush())) { reportSaveError(new Error('The last change could not be saved.'), true); return null; }
    let fid = folderId || currentFolderId();
    if (!fid) fid = await call('create_folder', 'Inbox');
    const id = await call('create_page', fid, title || 'Untitled', null);
    if (html) await call('save_page', id, { text: html, margin: '', ink: [] });
    await refresh();
    if (searchHits) { $('search').value = ''; searchHits = null; }
    await openPage(id);
    creating = false;
    if (!title) {
      if (titleInput.value.trim()) titleInput.dispatchEvent(new Event('input'));
      if (wantBody) caretToStart(); else if (!titleInput.value.trim()) { titleInput.focus(); titleInput.select(); }
    }
    wantBody = false;
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
    if (!skipConfirm && !(await dialog({ title: 'Delete page?', ok: 'Delete',
      text: '“' + hit.page.title + '” will be moved to the _Trash folder inside your notes folder.' }))) return;
    if (id === activeId) { await flushTitle(); clearTimeout(save.timer); save.dirty = false; await save.chain; }
    const list = hit.folder.pages, i = list.indexOf(hit.page);
    await call('delete_page', id);
    list.splice(i, 1);
    if (id === activeId) {
      const next = list[i] || list[i - 1];
      activeId = null;
      if (next) await openPage(next.id); else { loadDoc({ text: '', margin: '', ink: [] }); renderHead(); renderTree(); }
    } else renderTree();
  }

  async function deleteFolder(id) {
    const f = findFolder(id); if (!f) return;
    const n = f.pages.length;
    if (!(await dialog({ title: 'Delete folder?', ok: 'Delete', text: '“' + f.name + '”' + (n ? ' and its ' + n + (n === 1 ? ' page' : ' pages') : '') +
      ' will be moved to the _Trash folder inside your notes folder.' }))) return;
    const hadActive = activeId && f.pages.some((p) => p.id === activeId);
    if (hadActive) { await flushTitle(); clearTimeout(save.timer); save.dirty = false; await save.chain; }
    await call('delete_folder', id);
    nb.folders.splice(nb.folders.indexOf(f), 1);
    if (hadActive) {
      activeId = null;
      const first = nb.folders.find((x) => x.pages.length);
      if (first) await openPage(first.pages[0].id); else { loadDoc({ text: '', margin: '', ink: [] }); renderHead(); renderTree(); }
    } else renderTree();
  }

  async function movePage(id, folderId, index) {
    const hit = findPage(id), dst = findFolder(folderId); if (!hit || !dst) return;
    const src = hit.folder, from = src.pages.indexOf(hit.page);
    if (src === dst && from < index) index -= 1;
    if (src === dst && from === index) return;
    index = Math.max(0, Math.min(index, dst.pages.length - (src === dst ? 1 : 0)));
    src.pages.splice(from, 1); dst.pages.splice(index, 0, hit.page);
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

  function toggleFolder(id) {
    if (searchHits) return;
    const f = findFolder(id); if (!f) return;
    f.open = !f.open;
    // Updated in place, not redrawn, so a double-click on the name still reaches the same element.
    const sec = tree.querySelector('[data-folder="' + CSS.escape(id) + '"]');
    if (sec) { sec.classList.toggle('open', f.open); sec.querySelector('.folder-head').setAttribute('aria-expanded', String(f.open)); } else renderTree();
    api.set_folder(id, null, f.open);
  }

  async function setColor(id, color) {
    const f = findFolder(id); if (!f) return;
    f.color = color; renderTree();
    await call('set_folder', id, color, null);
  }

  // ---------- renaming in the menu ----------
  // The text box replaces the button (never sits inside it), so Space types a space.
  function inlineInput(host, value, done) {
    const input = document.createElement('input');
    input.className = 'rename'; input.value = value; input.setAttribute('aria-label', 'New name');
    input.spellcheck = false;
    host.replaceWith(input); input.focus(); input.select();
    let finished = false;
    const finish = (ok) => { if (finished) return; finished = true; done(ok ? input.value.trim() : null); };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('blur', () => finish(true));
    for (const t of ['click', 'mousedown', 'pointerdown', 'dblclick']) input.addEventListener(t, (e) => e.stopPropagation());
  }

  function startRenameFolder(id) {
    const head = tree.querySelector('[data-folder="' + CSS.escape(id) + '"] .folder-head');
    const f = findFolder(id); if (!head || !f) return;
    inlineInput(head, f.name, async (name) => {
      if (name && name !== f.name) {
        try { f.name = await call('rename_folder', id, name); } catch (e) { /* toast shown */ }
      }
      renderTree(); renderHead();
      const h = tree.querySelector('[data-folder="' + CSS.escape(id) + '"] .folder-head'); if (h) h.focus();
    });
  }

  function startRenamePage(id) {
    const btn = tree.querySelector('[data-page="' + CSS.escape(id) + '"] .page-btn');
    const hit = findPage(id); if (!btn || !hit) return;
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
  function openMenu(x, y, items) {
    closeFormat();
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
      b.setAttribute('role', it.checked == null ? 'menuitem' : 'menuitemcheckbox');
      if (it.checked != null) b.setAttribute('aria-checked', String(!!it.checked));
      b.textContent = it.label;
      if (it.checked) b.insertAdjacentHTML('beforeend', ICON.check);
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

  let dialogState = null;
  function closeDialog(value) { if (dialogState) dialogState.done(value); }
  function dialog(o) {
    if (dialogState) closeDialog(false);
    return new Promise((resolve) => {
      const back = $('modal'), ok = $('modalOk'), cancel = $('modalCancel');
      $('modalTitle').textContent = o.title; $('modalText').textContent = o.text || '';
      ok.textContent = o.ok || 'OK'; ok.className = 'danger' + (o.calm ? ' calm' : '');
      cancel.textContent = o.cancel || 'Cancel';
      const prev = document.activeElement;
      back.hidden = false; (o.calm ? ok : cancel).focus();
      const key = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === ok ? cancel : ok).focus(); }
      };
      const done = (v) => {
        back.hidden = true; ok.onclick = cancel.onclick = back.onmousedown = null; document.removeEventListener('keydown', key, true);
        dialogState = null;
        if (prev && prev.focus && document.contains(prev)) prev.focus();
        resolve(!!v);
      };
      dialogState = { kind: o.kind || 'confirm', done };
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
    const hand = !document.body.classList.contains('font-clean');
    const items = [{ label: 'Handwriting font', checked: hand, run: () => { applyFont(hand ? 'clean' : 'hand'); api.set_pref('font', hand ? 'clean' : 'hand'); } }, '-'];
    if (!api.mock) {
      items.push({ label: 'Open notes folder', run: () => call('open_notes_folder') });
      items.push({ label: 'Change notes folder…', run: changeFolder });
      items.push({ label: 'Reload from disk', run: reloadFromDisk });
      items.push('-');
    }
    items.push({ note: 'Notes are saved in: ' + nb.root });
    items.push({ note: 'NiSH Notes ' + version });
    openMenu(r.right - 240, r.bottom + 6, items);
  }
  function applyFont(font) {
    document.body.classList.toggle('font-clean', font === 'clean');
    document.body.classList.toggle('font-hand', font !== 'clean');
  }

  async function changeFolder() {
    await flushTitle(); if (!(await flush())) return;
    const snap = await call('choose_notes_folder');
    if (!snap) return;
    nb = snap; activeId = null; searchHits = null; $('search').value = '';
    const first = nb.folders.find((f) => f.pages.length);
    if (first) await openPage(first.pages[0].id); else { loadDoc({ text: '', margin: '', ink: [] }); renderHead(); renderTree(); }
    toast('Now using ' + nb.root);
  }

  async function reloadFromDisk() {
    await flushTitle(); if (!(await flush())) return;
    nb = await call('reload');
    const keep = activeId && findPage(activeId) ? activeId : null;
    activeId = null;
    const first = nb.folders.find((f) => f.pages.length);
    if (keep) await openPage(keep); else if (first) await openPage(first.pages[0].id); else { loadDoc({ text: '', margin: '', ink: [] }); renderHead(); renderTree(); }
  }

  // ---------- dragging folders and pages (by the handle, or the whole row) ----------
  let drag = null, suppressClick = false;
  function clearMarks() {
    tree.querySelectorAll('.drop-before,.drop-after,.drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
  }
  function dropTarget(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || !tree.contains(el)) return null;
    if (drag.type === 'page') {
      const li = el.closest('.page');
      if (li && li.dataset.page) {
        const hit = findPage(li.dataset.page); if (!hit) return null;
        const r = li.getBoundingClientRect(), after = y > r.top + r.height / 2;
        return { el: li, cls: after ? 'drop-after' : 'drop-before', folder: hit.folder.id, index: hit.folder.pages.indexOf(hit.page) + (after ? 1 : 0) };
      }
      const fel = el.closest('.folder');
      if (fel) { const f = findFolder(fel.dataset.folder); return f && { el: fel, cls: 'drop-into', folder: f.id, index: f.pages.length }; }
      return null;
    }
    const sections = Array.from(tree.querySelectorAll('.folder'));
    if (!sections.length) return null;
    let fel = el.closest('.folder');
    if (!fel) {                                     // in the gaps between folders: the nearest one
      fel = sections.reduce((best, s) => { const r = s.getBoundingClientRect(); const d = Math.abs(y - (r.top + r.height / 2)); return !best || d < best.d ? { s, d } : best; }, null).s;
    }
    const f = findFolder(fel.dataset.folder); if (!f) return null;
    const r = fel.getBoundingClientRect(), after = y > r.top + Math.min(r.height / 2, 30);
    return { el: fel, cls: after ? 'drop-after' : 'drop-before', index: nb.folders.indexOf(f) + (after ? 1 : 0) };
  }
  function startDrag() {
    const d = drag;
    const ghost = document.createElement('div');
    if (d.type === 'page') {
      const hit = findPage(d.id);
      ghost.className = 'ghost page-ghost'; ghost.textContent = hit ? hit.page.title : '';
    } else {
      const f = findFolder(d.id);
      ghost.className = 'ghost folder-ghost'; ghost.style.setProperty('--fc', f ? f.color : '#999');
      ghost.innerHTML = '<span class="swatch"></span><span></span>'; ghost.lastChild.textContent = f ? f.name : '';
    }
    ghost.style.width = Math.min(d.row.getBoundingClientRect().width, 280) + 'px';
    document.body.appendChild(ghost);
    d.ghost = ghost; d.started = true;
    d.row.classList.add('is-source');
    document.body.classList.add('dragging-now');
    closeMenu(); closeFormat();
    d.timer = setInterval(() => {                   // scroll the menu when dragging near its edges
      const r = tree.getBoundingClientRect();
      if (d.y < r.top + 36) tree.scrollTop -= 12; else if (d.y > r.bottom - 36) tree.scrollTop += 12;
    }, 30);
  }
  function moveDrag(x, y) {
    drag.x = x; drag.y = y;
    drag.ghost.style.left = (x + 12) + 'px'; drag.ghost.style.top = (y - 18) + 'px';
    clearMarks();
    const t = dropTarget(x, y); drag.target = t;
    if (t) t.el.classList.add(t.cls);
  }
  function endDrag(commit) {
    const d = drag; drag = null;
    if (!d) return;
    if (d.started) {
      clearInterval(d.timer); d.ghost.remove(); clearMarks();
      document.body.classList.remove('dragging-now');
      d.row.classList.remove('is-source');
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
      if (commit && d.target) {
        if (d.type === 'page') movePage(d.id, d.target.folder, d.target.index); else moveFolder(d.id, d.target.index);
      }
    }
  }
  tree.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.rename, .row-more')) return;
    const li = e.target.closest('.page'), row = e.target.closest('.folder-row');
    if (!(li && li.dataset.page) && !row) return;
    if (searchHits) { if (e.target.closest('.grip')) toast('Clear the search to sort pages.'); return; }
    drag = li && li.dataset.page ? { type: 'page', id: li.dataset.page, row: li } : { type: 'folder', id: row.closest('.folder').dataset.folder, row: row.closest('.folder') };
    drag.sx = drag.x = e.clientX; drag.sy = drag.y = e.clientY;
    if (e.target.closest('.grip')) e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
      startDrag();
    }
    e.preventDefault();
    moveDrag(e.clientX, e.clientY);
  });
  window.addEventListener('pointerup', () => endDrag(true));
  window.addEventListener('pointercancel', () => endDrag(false));
  window.addEventListener('blur', () => endDrag(false));
  tree.addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);

  // Dropping .txt, .md or .html files from Explorer adds them as pages.
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []).filter((f) => /\.(txt|md|html?)$/i.test(f.name));
    if (!files.length) { toast('Only .txt, .md and .html files can be added as pages.'); return; }
    const fel = e.target.closest && e.target.closest('.folder');
    const fid = fel ? fel.dataset.folder : null;
    for (const f of files) {
      const raw = await f.text();
      await newPage(fid, f.name.replace(/\.(txt|md|html?)$/i, ''), /\.html?$/i.test(f.name) ? sanitize(raw) || '<div><br></div>' : textToHtml(raw) || '<div><br></div>');
    }
    toast(files.length === 1 ? 'Added 1 page.' : 'Added ' + files.length + ' pages.');
  });

  // ---------- folder menu events ----------
  tree.addEventListener('click', (e) => {
    const more = e.target.closest('.row-more');
    if (more) {
      const r = more.getBoundingClientRect(), li = more.closest('.page');
      if (li) pageMenu(li.dataset.page, r.left, r.bottom + 4); else folderMenu(more.closest('.folder').dataset.folder, r.left, r.bottom + 4);
      return;
    }
    const pageBtn = e.target.closest('.page-btn');
    if (pageBtn) { const id = pageBtn.closest('.page').dataset.page; if (id !== activeId) openPage(id); return; }
    const head = e.target.closest('.folder-head');
    if (head) toggleFolder(head.closest('.folder').dataset.folder);
  });
  tree.addEventListener('dblclick', (e) => {
    if (e.target.closest('.rename')) return;
    const name = e.target.closest('.folder-name');
    if (name) { e.preventDefault(); startRenameFolder(name.closest('.folder').dataset.folder); return; }
    const page = e.target.closest('.page-btn');
    if (page) { e.preventDefault(); startRenamePage(page.closest('.page').dataset.page); }
  });
  tree.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.rename')) return;
    const page = e.target.closest('.page'), folder = e.target.closest('.folder');
    e.preventDefault();
    if (page && page.dataset.page) pageMenu(page.dataset.page, e.clientX, e.clientY);
    else if (folder) folderMenu(folder.dataset.folder, e.clientX, e.clientY);
  });
  tree.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('rename')) return;
    const page = e.target.closest('.page-btn') && e.target.closest('.page');
    const head = e.target.closest('.folder-head');
    const fid = head && head.closest('.folder').dataset.folder;
    if (e.key === 'F2') { e.preventDefault(); if (page) startRenamePage(page.dataset.page); else if (head) startRenameFolder(fid); }
    if (e.key === 'Delete') { e.preventDefault(); if (page) deletePage(page.dataset.page); else if (head) deleteFolder(fid); }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault(); const r = e.target.getBoundingClientRect();
      if (page) pageMenu(page.dataset.page, r.left + 20, r.bottom); else if (head) folderMenu(fid, r.left + 20, r.bottom);
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !searchHits) {   // move with the keyboard
      e.preventDefault();
      const up = e.key === 'ArrowUp';
      if (page) {
        const hit = findPage(page.dataset.page), i = hit.folder.pages.indexOf(hit.page);
        if (up && i > 0) movePage(hit.page.id, hit.folder.id, i - 1);
        else if (!up && i < hit.folder.pages.length - 1) movePage(hit.page.id, hit.folder.id, i + 2);
      } else if (head) {
        const i = nb.folders.findIndex((f) => f.id === fid);
        if (up && i > 0) moveFolder(fid, i - 1); else if (!up && i < nb.folders.length - 1) moveFolder(fid, i + 2);
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const all = Array.from(tree.querySelectorAll('.folder-head, .folder.open .page-btn'));
      const i = all.indexOf(e.target);
      if (i >= 0) { e.preventDefault(); const next = all[i + (e.key === 'ArrowDown' ? 1 : -1)]; if (next) next.focus(); }
    }
  });

  // ---------- writing: the two columns ----------
  function bindEditor(el) {
    el.addEventListener('focus', () => { lastEd = el; });
    el.addEventListener('input', (e) => {
      if (e.inputType === 'insertParagraph') {           // a new checklist line starts unticked
        const li = blockAt('LI');
        if (li && li.hasAttribute('data-checked') && !li.textContent.trim()) li.removeAttribute('data-checked');
      }
      updateEmpty(); changed(); if (!fmt.hidden) syncFormat();
    });
    el.addEventListener('paste', (e) => {
      const cd = e.clipboardData; if (!cd) return;
      e.preventDefault();
      const html = cd.getData('text/html'), text = cd.getData('text/plain');
      if (html && !pastePlain) document.execCommand('insertHTML', false, sanitize(html));
      else document.execCommand('insertText', false, text);
      pastePlain = false;
    });
    el.addEventListener('mousedown', (e) => {                 // click a checklist circle to tick it
      const li = e.target.closest && e.target.closest('ul.checklist > li');
      if (li && el.contains(li) && e.clientX < li.getBoundingClientRect().left) {
        e.preventDefault();
        li.toggleAttribute('data-checked');
        changed();
      }
    });
    el.addEventListener('keydown', onEditorKey);
    el.addEventListener('blur', () => { flush(); });
    el.addEventListener('drop', (e) => { if (!hasFiles(e)) setTimeout(() => { updateEmpty(); changed(); }, 0); });
  }
  let pastePlain = false;

  function selectionIn(el) {
    const s = getSelection();
    return s.rangeCount && el.contains(s.anchorNode) ? s : null;
  }
  function activeEd() {
    const s = getSelection();
    if (s.rangeCount) { if (editor.contains(s.anchorNode)) return editor; if (margin.contains(s.anchorNode)) return margin; }
    return null;
  }
  function blockAt(tag) {
    const ed = activeEd(); if (!ed) return null;
    let n = getSelection().anchorNode;
    while (n && n !== ed) { if (n.nodeType === 1 && n.tagName === tag) return n; n = n.parentNode; }
    return null;
  }
  function currentBlock() {
    const ed = activeEd(); if (!ed) return 'div';
    let n = getSelection().anchorNode;
    while (n && n !== ed) { if (n.nodeType === 1 && /^(H1|H2|H3|PRE)$/.test(n.tagName)) return n.tagName.toLowerCase(); n = n.parentNode; }
    return 'div';
  }
  function currentList() {
    const ed = activeEd(); if (!ed) return null;
    let n = getSelection().anchorNode;
    while (n && n !== ed) {
      if (n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL')) {
        const kind = n.tagName === 'OL' ? 'number' : n.classList.contains('checklist') ? 'check' : n.classList.contains('dashed') ? 'dashed' : 'bullet';
        return { el: n, kind };
      }
      n = n.parentNode;
    }
    return null;
  }
  function ensureFocus() {
    if (activeEd()) return;
    const ed = document.contains(lastEd) ? lastEd : editor;
    ed.focus();
    const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function exec(cmd, val) {
    if (!activeId || ink.on) return;
    ensureFocus();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(cmd, false, val);
    afterEdit();
  }
  function afterEdit() { updateEmpty(); changed(); if (!fmt.hidden) syncFormat(); }
  function setBlock(tag) { exec('formatBlock', tag === 'div' ? 'div' : tag); }
  function setList(kind) {
    if (!activeId || ink.on) return;
    ensureFocus();
    const cur = currentList();
    if (cur && cur.kind === kind) { exec(cur.el.tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList'); return; }
    const want = kind === 'check' ? 'checklist' : kind === 'dashed' ? 'dashed' : '';
    const ed = activeEd();
    if (kind === 'number' || !cur || cur.el.tagName === 'OL') {
      const lists = new Map(Array.from(ed.querySelectorAll('ul, ol')).map((l) => [l, l.className]));
      const items = new Set(ed.querySelectorAll('li'));
      document.execCommand(kind === 'number' ? 'insertOrderedList' : 'insertUnorderedList');
      const now = currentList();
      // The browser joins a new list onto a list right next to it. If that list is of another
      // kind (a checklist above new bullets), split the new lines off instead of converting it.
      if (now && lists.has(now.el) && (kind === 'number' || lists.get(now.el) !== want)) splitNewItems(now.el, items, want);
      else if (now && now.el.tagName === 'UL') { now.el.removeAttribute('class'); if (want) now.el.className = want; }
    } else {                                   // switch the whole list to another kind
      cur.el.removeAttribute('class'); if (want) cur.el.className = want;
    }
    afterEdit();
  }
  function splitNewItems(list, oldItems, want) {
    const fresh = Array.from(list.children).filter((li) => li.tagName === 'LI' && !oldItems.has(li));
    if (!fresh.length) { list.removeAttribute('class'); if (want) list.className = want; return; }
    const sel = getSelection(), r = sel.rangeCount ? sel.getRangeAt(0) : null;
    const keep = r && [r.startContainer, r.startOffset, r.endContainer, r.endOffset];
    const nl = document.createElement(list.tagName === 'OL' ? 'ol' : 'ul');
    if (want && nl.tagName === 'UL') nl.className = want;
    const firstNew = list.children[0] === fresh[0];
    const lastNew = list.lastElementChild === fresh[fresh.length - 1];
    if (firstNew) list.before(nl);
    else if (lastNew) list.after(nl);
    else {                                     // in the middle: the old items after them get a list of their own
      const tail = list.cloneNode(false);
      let n = fresh[fresh.length - 1].nextSibling;
      while (n) { const next = n.nextSibling; tail.appendChild(n); n = next; }
      list.after(nl); nl.after(tail);
    }
    fresh.forEach((li) => nl.appendChild(li));
    if (keep) { const nr = document.createRange(); nr.setStart(keep[0], keep[1]); nr.setEnd(keep[2], keep[3]); sel.removeAllRanges(); sel.addRange(nr); }
  }
  function indent(more) {
    const cur = currentList(); if (!cur) return;
    exec(more ? 'indent' : 'outdent');
    const now = currentList();                       // a nested list keeps its parent's look
    if (more && now && now.el !== cur.el && now.el.tagName === 'UL' && cur.el.tagName === 'UL' && cur.el.className) now.el.className = cur.el.className;
  }

  function onEditorKey(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Tab' && !ctrl && !e.altKey) {
      e.preventDefault();
      if (currentList()) indent(!e.shiftKey);
      else if (!e.shiftKey) { document.execCommand('insertText', false, '\t'); }
      return;
    }
    if (!ctrl || e.altKey) return;
    const k = e.key.toLowerCase();
    if (!e.shiftKey) {
      if (k === 'b') { e.preventDefault(); exec('bold'); }
      else if (k === 'i') { e.preventDefault(); exec('italic'); }
      else if (k === 'u') { e.preventDefault(); exec('underline'); }
      else if (e.code === 'BracketRight') { e.preventDefault(); indent(true); }
      else if (e.code === 'BracketLeft') { e.preventDefault(); indent(false); }
      return;
    }
    const blocks = { t: 'h1', h: 'h2', j: 'h3', b: 'div', m: 'pre' };
    if (blocks[k]) { e.preventDefault(); setBlock(blocks[k]); }
    else if (k === 'x') { e.preventDefault(); exec('strikeThrough'); }
    else if (k === 'l') { e.preventDefault(); setList('check'); }
    else if (k === 'v') { pastePlain = true; }
    else if (e.code === 'Digit7') { e.preventDefault(); setList('bullet'); }
    else if (e.code === 'Digit8') { e.preventDefault(); setList('dashed'); }
    else if (e.code === 'Digit9') { e.preventDefault(); setList('number'); }
  }

  // ---------- the Aa popover ----------
  function openFormat() {
    if (!activeId || ink.on) return;
    closeMenu();
    ensureFocus();
    const r = $('formatBtn').getBoundingClientRect();
    fmt.hidden = false;
    const w = fmt.getBoundingClientRect().width;
    fmt.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
    fmt.style.top = (r.bottom + 8) + 'px';
    $('formatBtn').setAttribute('aria-expanded', 'true');
    syncFormat();
  }
  function closeFormat() { fmt.hidden = true; $('formatBtn').setAttribute('aria-expanded', 'false'); }
  function syncFormat() {
    const block = currentBlock(), list = currentList();
    fmt.querySelectorAll('[data-block]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.block === block && !list)));
    fmt.querySelectorAll('[data-mark]').forEach((b) => b.setAttribute('aria-pressed', String(!!document.queryCommandState(b.dataset.mark))));
    fmt.querySelectorAll('[data-list]').forEach((b) => b.setAttribute('aria-pressed', String(!!list && list.kind === b.dataset.list)));
    fmt.querySelectorAll('[data-indent]').forEach((b) => { b.disabled = !list; });
  }
  fmt.addEventListener('mousedown', (e) => e.preventDefault());          // keep the text selection
  fmt.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.block) setBlock(b.dataset.block);
    else if (b.dataset.mark) exec(b.dataset.mark);
    else if (b.dataset.list) setList(b.dataset.list);
    else if (b.dataset.indent) indent(b.dataset.indent === 'indent');
  });
  document.addEventListener('selectionchange', () => { if (!fmt.hidden) syncFormat(); });
  $('formatBtn').addEventListener('mousedown', (e) => e.preventDefault());
  $('formatBtn').addEventListener('click', () => { if (fmt.hidden) openFormat(); else closeFormat(); });
  $('checkBtn').addEventListener('mousedown', (e) => e.preventDefault());
  $('checkBtn').addEventListener('click', () => setList('check'));

  // ---------- Scribble ----------
  function strokePath(s) {
    const p = s.p;
    if (p.length <= 2) return 'M' + p[0] + ' ' + p[1] + ' l0.1 0';
    let d = 'M' + p[0] + ' ' + p[1];
    for (let i = 2; i < p.length - 2; i += 2) {            // smooth: curve through the midpoints
      const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
      d += ' Q' + p[i] + ' ' + p[i + 1] + ' ' + mx.toFixed(1) + ' ' + my.toFixed(1);
    }
    return d + ' L' + p[p.length - 2] + ' ' + p[p.length - 1];
  }
  function strokeEl(s) {
    const el = document.createElementNS(SVGNS, 'path');
    el.setAttribute('d', strokePath(s));
    el.setAttribute('fill', 'none'); el.setAttribute('stroke', s.c); el.setAttribute('stroke-width', s.w);
    el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
    if (s.t === 'marker') { el.setAttribute('opacity', '0.35'); el.setAttribute('class', 'marker'); }
    return el;
  }
  function renderInk() {
    inkSvg.replaceChildren(...ink.strokes.map(strokeEl));
    let maxY = 0;
    for (const s of ink.strokes) for (let i = 1; i < s.p.length; i += 2) if (s.p[i] > maxY) maxY = s.p[i];
    leaf.style.setProperty('--ink-h', maxY ? Math.ceil(maxY + 120) + 'px' : '0px');
  }
  function inkPos(e) {
    const r = leaf.getBoundingClientRect();
    return [Math.round((e.clientX - r.left) * 10) / 10, Math.round((e.clientY - r.top) * 10) / 10];
  }
  function nearStroke(s, x, y, rad) {
    const r2 = (rad + s.w / 2) ** 2, p = s.p;
    if (p.length === 2) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= r2;
    for (let i = 0; i < p.length - 2; i += 2) {
      const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
      if ((ax + t * dx - x) ** 2 + (ay + t * dy - y) ** 2 <= r2) return true;
    }
    return false;
  }
  function eraseAt(x, y) {
    let hit = false;
    for (let i = ink.strokes.length - 1; i >= 0; i--) {
      if (nearStroke(ink.strokes[i], x, y, 8)) { ink.erased.push({ s: ink.strokes[i], i }); ink.strokes.splice(i, 1); hit = true; }
    }
    if (hit) renderInk();
  }
  inkSvg.addEventListener('pointerdown', (e) => {
    if (!ink.on || e.button !== 0) return;
    e.preventDefault();
    try { inkSvg.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no pointer */ }
    const [x, y] = inkPos(e);
    if (ink.tool === 'eraser') { ink.erased = []; eraseAt(x, y); return; }
    const t = ink.tool;
    ink.cur = { t, c: ink.color[t], w: INK_SIZES[t][ink.size[t]], p: [x, y] };
    ink.curEl = strokeEl(ink.cur);
    inkSvg.appendChild(ink.curEl);
  });
  inkSvg.addEventListener('pointermove', (e) => {
    if (!ink.on) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (events.length ? events : [e])) {
      const [x, y] = inkPos(ev);
      if (ink.erased) { eraseAt(x, y); continue; }
      if (!ink.cur) return;
      const p = ink.cur.p, lx = p[p.length - 2], ly = p[p.length - 1];
      if ((x - lx) ** 2 + (y - ly) ** 2 < 2.25) continue;
      p.push(x, y);
    }
    if (ink.cur) ink.curEl.setAttribute('d', strokePath(ink.cur));
  });
  function endStroke() {
    if (ink.erased) {
      if (ink.erased.length) { ink.undo.push({ type: 'erase', items: ink.erased }); ink.redo = []; changed(); }
      ink.erased = null; syncInkButtons(); return;
    }
    if (!ink.cur) return;
    ink.strokes.push(ink.cur);
    ink.undo.push({ type: 'add', s: ink.cur }); ink.redo = [];
    ink.cur = null; ink.curEl = null;
    renderInk(); syncInkButtons(); changed();
  }
  inkSvg.addEventListener('pointerup', endStroke);
  inkSvg.addEventListener('pointercancel', endStroke);
  inkSvg.addEventListener('lostpointercapture', endStroke);

  function applyInk(step, back) {
    if (step.type === 'add') {
      if (back) ink.strokes.splice(ink.strokes.lastIndexOf(step.s), 1); else ink.strokes.push(step.s);
    } else if (step.type === 'erase' || step.type === 'clear') {
      if (back) step.items.slice().reverse().forEach(({ s, i }) => ink.strokes.splice(Math.min(i, ink.strokes.length), 0, s));
      else step.items.forEach(({ s }) => { const i = ink.strokes.indexOf(s); if (i >= 0) ink.strokes.splice(i, 1); });
    }
  }
  function inkUndo() { const st = ink.undo.pop(); if (!st) return; applyInk(st, true); ink.redo.push(st); renderInk(); syncInkButtons(); changed(); }
  function inkRedo() { const st = ink.redo.pop(); if (!st) return; applyInk(st, false); ink.undo.push(st); renderInk(); syncInkButtons(); changed(); }
  async function inkClear() {
    if (!ink.strokes.length) return;
    if (!(await dialog({ title: 'Clear the drawing?', text: 'All drawing on this page is removed. You can bring it back with Undo.', ok: 'Clear' }))) return;
    const items = ink.strokes.map((s, i) => ({ s, i }));
    ink.strokes = []; ink.undo.push({ type: 'clear', items }); ink.redo = [];
    renderInk(); syncInkButtons(); changed();
  }
  function syncInkButtons() {
    $('inkUndo').disabled = !ink.undo.length; $('inkRedo').disabled = !ink.redo.length; $('inkClear').disabled = !ink.strokes.length;
    document.querySelectorAll('#inkBar [data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === ink.tool)));
    const t = ink.tool === 'eraser' ? null : ink.tool;
    $('inkColors').hidden = !t; $('inkSizes').hidden = !t;
    leaf.classList.toggle('erasing', ink.tool === 'eraser');
    if (!t) return;
    $('inkColors').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === ink.color[t])));
    $('inkSizes').querySelectorAll('button').forEach((b, i) => {
      b.setAttribute('aria-pressed', String(i === ink.size[t]));
      const d = Math.max(4, Math.min(18, INK_SIZES[t][i] * (t === 'marker' ? 0.7 : 1.6)));
      b.firstChild.style.width = b.firstChild.style.height = d + 'px';
      b.firstChild.style.background = ink.color[t]; b.firstChild.style.opacity = t === 'marker' ? '.55' : '1';
    });
  }
  function setScribble(on) {
    if (on && !activeId) return;
    ink.on = on;
    closeFormat();
    leaf.classList.toggle('scribbling', on);
    $('inkBar').hidden = !on;
    $('scribbleBtn').setAttribute('aria-pressed', String(on));
    setEditable(!on);
    if (on) { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); syncInkButtons(); $('inkBar').querySelector('[aria-pressed="true"]').focus(); }
    else { flush(); }
  }
  (function buildInkBar() {
    $('inkColors').innerHTML = INK_COLORS.map(([c, n]) => '<button type="button" data-color="' + c + '" style="background:' + c + '" aria-label="' + n + '" title="' + n + '"></button>').join('');
    $('inkSizes').innerHTML = ['Thin', 'Medium', 'Thick'].map((n) => '<button type="button" aria-label="' + n + '" title="' + n + '"><i></i></button>').join('');
    $('inkBar').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.tool) ink.tool = b.dataset.tool;
      else if (b.dataset.color && ink.tool !== 'eraser') ink.color[ink.tool] = b.dataset.color;
      else if (b.parentNode.id === 'inkSizes' && ink.tool !== 'eraser') ink.size[ink.tool] = Array.from(b.parentNode.children).indexOf(b);
      syncInkButtons();
    });
    $('inkUndo').addEventListener('click', inkUndo);
    $('inkRedo').addEventListener('click', inkRedo);
    $('inkClear').addEventListener('click', inkClear);
    $('inkDone').addEventListener('click', () => setScribble(false));
    $('scribbleBtn').addEventListener('click', () => setScribble(!ink.on));
  })();

  // ---------- page header ----------
  titleInput.addEventListener('input', () => {
    if (creating) return;
    const hit = activeId && findPage(activeId); if (!hit) return;
    hit.page.title = titleInput.value.trim() || 'Untitled';
    pendingTitle = { id: activeId, title: hit.page.title };
    renderTree();
    clearTimeout(renameTimer); renameTimer = setTimeout(flushTitle, 600);
  });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (creating) wantBody = true; else caretToStart();
    }
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

  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
    if (!fmt.hidden && !fmt.contains(e.target) && !e.target.closest('#formatBtn')) closeFormat();
  });
  window.addEventListener('resize', () => { closeMenu(); closeFormat(); });

  document.addEventListener('keydown', (e) => {
    if (dialogState) return;
    if (e.key === 'Escape') {
      if (drag) { endDrag(false); return; }
      if (!menu.hidden) { closeMenu(); return; }
      if (!fmt.hidden) { closeFormat(); if (document.contains(lastEd)) lastEd.focus(); return; }
      if (ink.on) { setScribble(false); return; }
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ink.on && !ctrl && !e.altKey && document.activeElement === document.body || (ink.on && $('inkBar').contains(document.activeElement) && !ctrl)) {
      const tools = { p: 'pen', m: 'marker', e: 'eraser' };
      if (tools[e.key.toLowerCase()]) { ink.tool = tools[e.key.toLowerCase()]; syncInkButtons(); return; }
    }
    if (!ctrl || e.altKey) return;
    const k = e.key.toLowerCase();
    if (ink.on && k === 'z' && !e.shiftKey) { e.preventDefault(); inkUndo(); return; }
    if (ink.on && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); inkRedo(); return; }
    if (k === 'n' && e.shiftKey) { e.preventDefault(); newFolder(); }
    else if (k === 'n') { e.preventDefault(); newPage(); }
    else if (k === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); }
    else if (k === 's') { e.preventDefault(); flushTitle(); flush(); }
    else if (['p', 'r', 'o', 'g', 'h', 'j'].includes(k) && !e.shiftKey) e.preventDefault();   // browser shortcuts
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
    document.execCommand('defaultParagraphSeparator', false, 'div');
    bindEditor(editor); bindEditor(margin);
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
    const selectText = (el, text) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n; while ((n = walker.nextNode())) { const i = n.nodeValue.indexOf(text); if (i >= 0) {
        el.focus(); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + text.length);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } }
      return false;
    };
    const pointer = (type, x, y) => {
      const r = leaf.getBoundingClientRect();
      inkSvg.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + x, clientY: r.top + y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse' }));
    };
    try {
      const a = await newFolder('Smoke A');
      const b = await newFolder('Smoke B');
      check('create folders', findFolder(a) && findFolder(b) && findFolder(b).name === 'Smoke B');
      startRenameFolder(a);
      const box = tree.querySelector('.rename');
      box.value = 'Smoke A with spaces'; box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(300);
      check('folder names can have spaces', findFolder(a).name === 'Smoke A with spaces' && !box.closest('button'));
      $('newPageBtn').click();
      await sleep(400);
      check('new page button opens an empty page', activeId && editor.innerHTML === '' && document.activeElement === titleInput);
      await movePage(activeId, a, 0);
      const pid = activeId;
      editor.focus();
      editor.innerHTML = '<div>Hello from the smoke test</div><div>Second line</div>';
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      selectText(editor, 'Hello'); exec('bold');
      selectText(editor, 'Second line'); setBlock('h2');
      check('bold and heading', editor.querySelector('b') && editor.querySelector('h2'));
      $('formatBtn').click(); await sleep(50);
      check('Aa popover shows the current style', !fmt.hidden && fmt.querySelector('[data-block="h2"]').getAttribute('aria-current') === 'true');
      closeFormat();
      editor.insertAdjacentHTML('beforeend', '<div>Buy milk</div>');
      selectText(editor, 'Buy milk'); $('checkBtn').click();
      const li = editor.querySelector('ul.checklist > li');
      check('checklist', li && li.textContent === 'Buy milk');
      const lr = li.getBoundingClientRect();
      li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: lr.left - 10, clientY: lr.top + 10 }));
      check('ticking a checklist item', li.hasAttribute('data-checked'));
      margin.focus(); margin.innerHTML = '<div>Margin note</div>'; margin.dispatchEvent(new InputEvent('input', { bubbles: true }));
      check('margin column is separate from the page', margin.textContent === 'Margin note' && !editor.textContent.includes('Margin note'));
      $('scribbleBtn').click();
      check('scribble mode', ink.on && !$('inkBar').hidden && editor.contentEditable === 'false');
      pointer('pointerdown', 200, 60); pointer('pointermove', 240, 80); pointer('pointermove', 300, 70); pointer('pointerup', 300, 70);
      check('drawing a stroke', ink.strokes.length === 1 && inkSvg.querySelectorAll('path').length === 1);
      ink.tool = 'eraser'; pointer('pointerdown', 240, 80); pointer('pointerup', 240, 80);
      check('eraser removes the stroke', ink.strokes.length === 0);
      inkUndo();
      check('undo brings it back', ink.strokes.length === 1);
      ink.tool = 'pen'; setScribble(false);
      check('leaving scribble mode', !ink.on && editor.contentEditable === 'true');
      await sleep(600); await save.chain;
      const doc = await api.read_page(pid);
      check('page saves itself (text, formatting, margin, drawing)', doc.text.includes('<b>Hello</b>') && doc.text.includes('<h2>') &&
        doc.text.includes('data-checked') && doc.margin.includes('Margin note') && doc.ink.length === 1);
      const realSave = api.save_page;
      api.save_page = () => Promise.reject(new Error('disk full (test)'));
      editor.insertAdjacentHTML('beforeend', '<div>more</div>'); editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await sleep(600); await save.chain;
      check('a failed save shows a popup', !$('modal').hidden && $('modalTitle').textContent.startsWith('Couldn’t save'));
      api.save_page = realSave;
      $('modalOk').click(); await sleep(100); await save.chain;
      check('Try again saves it', $('modal').hidden && !save.failed && (await api.read_page(pid)).text.includes('more'));
      titleInput.focus(); type(titleInput, 'Renamed page');
      await sleep(900); await flushTitle();
      const snap = await api.snapshot();
      check('renaming a page from its title', snap.folders.some((f) => f.pages.some((p) => p.id === pid && p.title === 'Renamed page')));
      await movePage(pid, b, 0);
      const fb = (await api.snapshot()).folders.find((f) => f.id === b);
      check('moving a page to another folder', fb && fb.pages[0] && fb.pages[0].id === pid);
      await moveFolder(b, 0);
      check('sorting folders', (await api.snapshot()).folders[0].id === b);
      const grip = tree.querySelector('[data-folder="' + a + '"] .folder-row .grip');
      check('folders have drag handles', !!grip);
      toggleFolder(a); const closed = !findFolder(a).open; toggleFolder(a);
      check('opening and closing a folder', closed && findFolder(a).open);
      const tmp = await newPage(a, 'Delete me');
      await deletePage(tmp, true);
      check('deleting a page', !findPage(tmp) && !(await api.snapshot()).folders.some((f) => f.pages.some((p) => p.id === tmp)));
      type($('search'), 'smoke test'); await sleep(600);
      check('search finds text inside pages', searchHits && searchHits.has(pid));
      $('search').value = ''; searchHits = null; renderTree();
      await setColor(a, COLORS[3]);
      check('folder colour', (await api.snapshot()).folders.find((f) => f.id === a).color === COLORS[3]);
      await openPage(pid);
      check('reopening a page shows everything', editor.textContent.startsWith('Hello from the smoke test') && margin.textContent === 'Margin note' &&
        inkSvg.querySelectorAll('path').length === 1 && titleInput.value === 'Renamed page');
    } catch (e) {
      steps.push({ name: 'self-test crashed: ' + errText(e) + ' ' + (e && e.stack ? e.stack.split('\n')[1] : ''), ok: false });
    }
    window.NN_TEST = { steps };
    return steps;
  }

  window.NN = { ready: false, selfTest, newPage, newFolder, openPage, movePage, moveFolder, deletePage, sanitize };
  start().catch((e) => toast('NiSH Notes could not start: ' + errText(e)));
})();
