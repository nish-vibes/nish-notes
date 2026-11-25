/* NiSH Notes - the page. Talks to Python through window.pywebview.api (see app.py). */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const tree = $('tree');
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
  let prefs = {};
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
    FIGURE: 'div', ADDRESS: 'div', DL: 'div', DT: 'div', DD: 'div', CENTER: 'div',
    TABLE: 'table', TBODY: 'tbody', THEAD: 'tbody', TFOOT: 'tbody', TR: 'tr', TD: 'td', TH: 'td' };
  const DROP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'HEAD', 'TITLE', 'META', 'LINK', 'NOSCRIPT',
    'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'PICTURE', 'SOURCE', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'FORM', 'XML']);
  // inTable: we are inside a table cell, so a table found here is flattened to its text
  // (a table inside a table can't be edited sensibly and broke the page's lines).
  function copyClean(src, dst, inTable) {
    for (const n of Array.from(src.childNodes)) {
      if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toUpperCase();
      if (DROP.has(tag) || tag.includes(':')) continue;
      const name = KEEP[tag];
      if (!name) {                                    // span, a, font, td ... keep the text only
        copyClean(n, dst, inTable);
        continue;
      }
      if (name === 'table' && inTable) {              // a table in a cell: one line per row, cells apart by a tab
        for (const tr of Array.from(n.querySelectorAll('tr'))) {
          const line = document.createElement('div');
          const cells = Array.from(tr.children).filter((c) => /^(TD|TH)$/.test(c.tagName));
          cells.forEach((c, i) => { if (i) line.appendChild(document.createTextNode('\t')); copyClean(c, line, true); });
          line.querySelectorAll('div, h1, h2, h3, pre').forEach((b) => { b.after(document.createTextNode(' ')); while (b.firstChild) b.before(b.firstChild); b.remove(); });
          if (!line.firstChild) line.appendChild(document.createElement('br'));
          dst.appendChild(line);
        }
        continue;
      }
      if ((name === 'tr' && !/^(TABLE|TBODY)$/.test(dst.tagName || '')) || (name === 'td' && dst.tagName !== 'TR') || (name === 'tbody' && dst.tagName !== 'TABLE')) {
        copyClean(n, dst, inTable); continue;         // a stray table part: keep its text
      }
      if (/^(h1|h2|h3|pre)$/.test(name) && n.querySelector('ul, ol, table, h1, h2, h3, pre, div, p, li')) {
        copyClean(n, dst, inTable); continue;         // a heading wrapped around a list or other blocks: keep the blocks
      }
      const el = document.createElement(name);
      if (name === 'ul') {
        const c = n.getAttribute('class') || '';
        if (/\bchecklist\b/.test(c)) el.className = 'checklist'; else if (/\bdashed\b/.test(c)) el.className = 'dashed';
      }
      if (name === 'li' && n.hasAttribute('data-checked')) el.setAttribute('data-checked', '');
      if (name === 'div' && /^m[0-9a-z]{6,32}$/.test(n.getAttribute('data-memo') || '')) {   // a voice memo in the margin
        el.setAttribute('data-memo', n.getAttribute('data-memo'));
        el.setAttribute('data-sec', String(Math.max(0, Math.min(36000, parseInt(n.getAttribute('data-sec'), 10) || 0))));
        el.textContent = memoLabel(+el.getAttribute('data-sec'));
        dst.appendChild(el); continue;
      }
      if (name !== 'br') copyClean(n, el, inTable || name === 'td');
      if (name === 'td' && !el.firstChild) el.appendChild(document.createElement('br'));
      if ((name === 'table' || name === 'tbody' || name === 'tr') && !el.querySelector('td')) continue;   // empty table parts
      dst.appendChild(el);
    }
  }
  function sanitize(html, inTable) {
    const doc = new DOMParser().parseFromString('<!doctype html><body>' + String(html || ''), 'text/html');
    const box = document.createElement('div');
    copyClean(doc.body, box, !!inTable);
    return box.innerHTML;
  }
  const memoLabel = (sec) => 'Voice memo ' + Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');

  // ---------- keeping the live page tidy ----------
  // The browser adds styled <span>s when lines are joined or text is pasted (a body line joined
  // onto a heading came out small inside it, then grew on reopening), and can put a list inside
  // a heading. This puts things right after every change, keeping the cursor where it was.
  const UNTIDY = 'span, font, a, [style], :is(h1, h2, h3, pre) :is(ul, ol, table, div, h1, h2, h3, pre), td table, :scope > div > :is(ul, ol, table)';
  // Where the selection is, as (text node number, offset): tidying only moves text nodes, it
  // never splits, joins or reorders them, so the same numbers find the same places afterwards.
  function selOffsets(ed) {
    const s = getSelection(); if (!s.rangeCount || !ed.contains(s.anchorNode)) return null;
    const r = s.getRangeAt(0), texts = [];
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let n;
    while ((n = walker.nextNode())) texts.push(n);
    const at = (node, off) => {
      if (node.nodeType === 3) return { i: texts.indexOf(node), o: off };
      const after = node.childNodes[off];       // between elements: just before the next text
      if (after) { const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); w.currentNode = after;
        const first = after.nodeType === 3 ? after : w.nextNode(); if (first && texts.indexOf(first) >= 0) return { i: texts.indexOf(first), o: 0 }; }
      return null;
    };
    const a = at(r.startContainer, r.startOffset), b = at(r.endContainer, r.endOffset);
    return a && b ? { a, b } : null;
  }
  function setOffsets(ed, o) {
    if (!o) return;
    const texts = []; const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let n;
    while ((n = walker.nextNode())) texts.push(n);
    const pa = texts[o.a.i], pb = texts[o.b.i];
    if (!pa || !pb) return;
    const r = document.createRange();
    try { r.setStart(pa, Math.min(o.a.o, pa.length)); r.setEnd(pb, Math.min(o.b.o, pb.length)); } catch (e) { return; }
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function unwrap(el) { while (el.firstChild) el.before(el.firstChild); el.remove(); }
  function tidy(ed) {
    if (!ed || !ed.querySelector(UNTIDY)) return false;
    const o = selOffsets(ed);
    for (const el of Array.from(ed.querySelectorAll('[style]'))) el.removeAttribute('style');
    for (const el of Array.from(ed.querySelectorAll('span, font, a'))) unwrap(el);
    for (const h of Array.from(ed.querySelectorAll('h1, h2, h3, pre'))) {
      if (h.isConnected && h.querySelector('ul, ol, table, div, h1, h2, h3, pre')) unwrap(h);
    }
    for (const d of Array.from(ed.querySelectorAll(':scope > div'))) {
      if (d.querySelector(':scope > :is(ul, ol, table)')) unwrap(d);
    }
    for (const t of Array.from(ed.querySelectorAll('td table'))) {
      if (!t.isConnected) continue;
      const box = document.createElement('div'); box.innerHTML = sanitize(t.outerHTML, true);
      while (box.firstChild) t.before(box.firstChild);
      t.remove();
    }
    setOffsets(ed, o);
    return true;
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

  // ---------- the page name is its first line ----------
  function firstLine(ed) {
    for (const n of Array.from((ed || editor).childNodes)) {
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 120);
    }
    return '';
  }
  function pageTitle() { return firstLine() || 'New page'; }
  function titleChanged() {
    const hit = activeId && findPage(activeId); if (!hit) return;
    const t = pageTitle();
    if (t === hit.page.title) return;
    hit.page.title = t;
    pendingTitle = { id: activeId, title: t };
    const el = tree.querySelector('[data-page="' + CSS.escape(activeId) + '"] .t'); if (el) el.textContent = t;
    announceTitle();
    clearTimeout(renameTimer); renameTimer = setTimeout(flushTitle, 900);
  }
  function announceTitle() {
    const hit = activeId && findPage(activeId);
    const t = hit ? hit.page.title : '';
    $('pageName').textContent = t || 'No page open';
    if (api && api.set_title) api.set_title(t);
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

  // ---------- the folder menu ----------
  const pagesWord = (n) => n + (n === 1 ? ' page' : ' pages');
  function renderTree() {
    const focused = document.activeElement;
    let focusKey = null;
    if (focused && tree.contains(focused) && !focused.classList.contains('rename')) {
      const pg = focused.closest('[data-page]'), fo = focused.closest('[data-folder]');
      focusKey = pg ? 'p:' + pg.dataset.page : fo ? 'f:' + fo.dataset.folder : null;
    }
    const html = [];
    if (searchHits) {                                 // search: one card per page, with a preview
      for (const h of searchHits) {
        const hit = findPage(h.id); if (!hit) continue;
        html.push('<button type="button" class="result" data-page="' + esc(h.id) + '">' +
          '<span class="rt"><span class="swatch" style="background:' + esc(hit.folder.color) + '"></span>' + esc(hit.page.title) +
          '<span class="rf">' + esc(hit.folder.name) + '</span></span>' +
          '<span class="rs">' + esc(h.pre) + (h.hit ? '<mark>' + esc(h.hit) + '</mark>' : '') + esc(h.post) + '</span></button>');
      }
      if (!html.length) html.push('<p class="pages" style="padding:8px 4px;color:var(--muted)">No pages match.</p>');
    } else {
      for (const f of nb.folders) {
        html.push(
          '<section class="folder' + (f.open ? ' open' : '') + '" data-folder="' + esc(f.id) + '" style="--fc:' + esc(f.color) + '">' +
            '<div class="folder-row">' +
              '<span class="grip" title="Drag to move" aria-hidden="true">' + ICON.grip + '</span>' +
              '<button type="button" class="folder-head" aria-expanded="' + f.open + '" aria-label="' + esc(f.name + ', ' + pagesWord(f.pages.length)) + '">' +
                ICON.chev + '<span class="swatch"></span><span class="folder-name">' + esc(f.name) + '</span>' +
                '<span class="count" aria-hidden="true">' + f.pages.length + '</span></button>' +
              '<button type="button" class="row-more" aria-label="Options for ' + esc(f.name) + '" aria-haspopup="menu" title="Options">' + ICON.more + '</button>' +
            '</div>' +
            '<ul class="pages">' +
              (f.pages.length ? f.pages.map((p) =>
                '<li class="page' + (p.id === activeId ? ' active' : '') + '" data-page="' + esc(p.id) + '">' +
                  '<span class="grip" title="Drag to move" aria-hidden="true">' + ICON.grip + '</span>' +
                  '<button type="button" class="page-btn"' + (p.id === activeId ? ' aria-current="page"' : '') + '>' +
                    '<span class="t">' + esc(p.title) + '</span><span class="d">' + esc(fmtShort(p.created)) + '</span></button>' +
                  '<button type="button" class="row-more" aria-label="Options for ' + esc(p.title) + '" aria-haspopup="menu" title="Options">' + ICON.more + '</button></li>').join('')
                : '<li class="none">Drop a page here</li>') +
            '</ul></section>');
      }
      if (!nb.folders.length) html.push('<p class="pages" style="padding:8px 4px;color:var(--muted)">No folders yet.</p>');
    }
    tree.innerHTML = html.join('');
    $('searchCount').textContent = searchHits ? (searchHits.length ? pagesWord(searchHits.length) + (searchHits.length === 1 ? ' matches' : ' match') + ' “' + $('search').value.trim() + '”' : 'No pages match') : '';
    renderBin();
    if (focusKey) {
      const id = focusKey.slice(2);
      const el = focusKey[0] === 'p' ? tree.querySelector('[data-page="' + CSS.escape(id) + '"] .page-btn, .result[data-page="' + CSS.escape(id) + '"]')
        : tree.querySelector('[data-folder="' + CSS.escape(id) + '"] .folder-head');
      if (el) el.focus();
    }
  }

  // Recently deleted, at the bottom of the folder menu
  function renderBin() {
    const items = nb.trash || [];
    $('binCount').textContent = items.length;
    $('binBtn').setAttribute('aria-label', 'Recently deleted, ' + pagesWord(items.length));
    const list = $('binList');
    list.innerHTML = items.map((t) => '<div class="bin-item"><button type="button" class="bin-open" data-preview="' + esc(t.id) + '"' +
      (preview && preview.id === t.id ? ' aria-current="true"' : '') + ' title="Read “' + esc(t.title) + '” without putting it back">' + esc(t.title) + '</button>' +
      '<button type="button" data-restore="' + esc(t.id) + '" aria-label="Put back ' + esc(t.title) + '">Put back</button></div>').join('') +
      '<p class="bin-note">' + (items.length ? 'Pages stay here for ' + (nb.keepDays || 30) + ' days, then they are removed for good.' : 'Nothing here.') + '</p>';
  }
  $('binBtn').addEventListener('click', () => {
    const open = $('binList').hidden;
    $('binList').hidden = !open; $('binBtn').setAttribute('aria-expanded', String(open));
  });
  $('binList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-restore]'); if (b) { endPreview(); restore([b.dataset.restore], true); return; }
    const v = e.target.closest('[data-preview]'); if (v) previewTrash(v.dataset.preview);
  });

  // ---------- reading a deleted page without putting it back ----------
  let preview = null;                               // { id, back: the page that was open }
  async function previewTrash(tid) {
    await flushTitle(); if (!(await flush())) return;
    if (rec.mr) await stopMemo(false);
    if (ink.on) setScribble(false);
    let doc;
    try { doc = await call('read_trash', tid); } catch (e) { return; }
    if (!preview) preview = { back: activeId };
    preview.id = tid;
    activeId = null;
    loadDoc(doc, null);
    setEditable(false);
    document.querySelector('.sheet').classList.add('previewing');
    const when = fmtShort(doc.deleted);
    $('previewText').textContent = '“' + doc.title + '” is in Recently deleted' + (doc.folder ? ' (from ' + doc.folder + ')' : '') + (when ? ', since ' + when : '') + '. You can read it here.';
    $('previewBar').hidden = false;
    renderHead(); renderTree();
    $('pageName').textContent = doc.title + ' (Recently deleted)';
    if (api.set_title) api.set_title(doc.title + ' (Recently deleted)');
    $('previewRestore').focus();
  }
  function endPreview() {
    if (!preview) return null;
    const back = preview.back; preview = null;
    document.querySelector('.sheet').classList.remove('previewing');
    $('previewBar').hidden = true;
    setEditable(!ink.on);
    return back;
  }
  async function closePreview() {
    const back = endPreview();
    const first = nb.folders.find((f) => f.pages.length);
    if (back && findPage(back)) await openPage(back);
    else if (first) await openPage(first.pages[0].id);
    else { loadDoc({ text: '', margin: '', ink: [] }); renderHead(); renderTree(); }
  }
  $('previewClose').addEventListener('click', closePreview);
  $('previewRestore').addEventListener('click', () => { const id = preview && preview.id; endPreview(); if (id) restore([id], true); });

  function renderHead() {
    const hit = activeId && findPage(activeId);
    $('empty').hidden = !!hit || !!preview;
    document.querySelectorAll('.ed-tool').forEach((b) => { b.disabled = !hit; });
    if (hit) syncFormat();
    $('folderDot').style.setProperty('--fc', hit ? hit.folder.color : 'transparent');
    $('crumbSep').hidden = !hit;
    $('folderLabel').textContent = hit ? hit.folder.name : '';
    $('date').textContent = hit ? fmtLong(hit.page.created) : '';
    announceTitle();
  }

  // ---------- pages ----------
  function setEditable(on) {
    for (const el of [editor, margin]) el.contentEditable = on ? 'true' : 'false';
  }
  function updateEmpty() {
    for (const el of [editor, margin]) el.classList.toggle('is-empty', !el.textContent && !el.querySelector('li, table'));
  }
  const histStore = new Map();                      // undo history per page, while the app is open
  function loadDoc(doc, pageId) {
    if (activeHistId && hist.stack.length) histStore.set(activeHistId, { stack: hist.stack, i: hist.i });
    // A fresh element per page keeps the browser's undo history from reaching into the previous page.
    for (const [old, html] of [[editor, doc.text], [margin, doc.margin]]) {
      const fresh = old.cloneNode(false);
      fresh.innerHTML = sanitize(html);
      old.replaceWith(fresh);
      if (old === editor) editor = fresh; else margin = fresh;
    }
    bindEditor(editor); bindEditor(margin);
    lastEd = editor;
    // Pages from before 1.4 kept their name apart from the text: put it on the first line.
    const hit = pageId && findPage(pageId);
    if (hit && hit.page.title && !/^(Untitled|New page)( \(\d+\))?$/.test(hit.page.title) && firstLine() !== hit.page.title) {
      editor.insertAdjacentHTML('afterbegin', '<h1>' + esc(hit.page.title) + '</h1>');
    }
    if (hit && !editor.textContent.trim() && !editor.querySelector('li, table')) editor.innerHTML = '<h1><br></h1>';
    decorateMemos();
    ink.strokes = Array.isArray(doc.ink) ? doc.ink : [];
    renderInk(); updateEmpty(); syncInkButtons();
    activeHistId = pageId || null;
    const kept = pageId && histStore.get(pageId);
    if (kept) { hist.stack = kept.stack; hist.i = kept.i; hist.pending = false; hist.stack[hist.i] = snap(); syncUndo(); } else histReset();
    if (ink.on) setEditable(false);
    paper.scrollTop = 0;
    placeChips();
  }
  let activeHistId = null;

  async function openPage(id, opts) {
    if (rec.mr) await stopMemo(false);              // a recording is saved on the page it was started on
    endPreview();
    await flushTitle();
    if (!(await flush())) { reportSaveError(new Error('The last change could not be saved.'), true); return false; }
    const hit = findPage(id);
    if (!hit) { activeId = null; loadDoc({ text: '', margin: '', ink: [] }); renderHead(); renderTree(); return false; }
    activeId = id;
    let doc = { text: '', margin: '', ink: [] };
    try { doc = await call('read_page', id); } catch (e) { /* toast shown */ }
    if (activeId !== id) return false;
    loadDoc(doc || {}, id);
    save.dirty = false;
    renderHead(); renderTree();
    api.set_pref('last_page', id);
    if (opts && opts.focusTitle) selectFirstLine();
    return true;
  }
  function selectFirstLine() {
    const first = Array.from(editor.childNodes).find((n) => (n.textContent || '').trim() || n.nodeName === 'H1') || editor;
    editor.focus();
    const r = document.createRange(); r.selectNodeContents(first);
    if (!(first.textContent || '').trim()) r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    paper.scrollTop = 0;
  }

  function currentFolderId() {
    const hit = activeId && findPage(activeId);
    if (hit) return hit.folder.id;
    return nb.folders.length ? nb.folders[0].id : null;
  }

  async function refresh() { nb = await call('snapshot'); }

  async function newPage(folderId, title, html) {
    await flushTitle();
    if (!(await flush())) { reportSaveError(new Error('The last change could not be saved.'), true); return null; }
    let fid = folderId || currentFolderId();
    if (!fid) fid = await call('create_folder', 'Inbox');
    const id = await call('create_page', fid, title || 'New page', null);
    if (html) await call('save_page', id, { text: html, margin: '', ink: [] });
    await refresh();
    if (searchHits) clearSearch();
    await openPage(id, { focusTitle: true });
    return id;
  }

  async function newFolder(name) {
    const id = await call('create_folder', name || 'New folder', null);
    await refresh(); renderTree();
    if (!name) startRenameFolder(id);
    return id;
  }

  // ---------- deleting: no question first, an Undo notice after ----------
  const undoBox = { ids: null, timer: 0, left: 0, started: 0, paused: false };
  function showUndo(text, ids) {
    clearTimeout(undoBox.timer);
    undoBox.ids = ids; undoBox.left = 10000; undoBox.paused = false;
    $('undoText').textContent = text;
    const t = $('undoToast'); t.hidden = false; t.classList.remove('paused');
    const bar = t.querySelector('.bar'); bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = '';
    $('kbTip').hidden = true;
    runUndoTimer();
  }
  function runUndoTimer() { undoBox.started = Date.now(); undoBox.timer = setTimeout(hideUndo, undoBox.left); }
  function pauseUndo() { if (undoBox.paused || $('undoToast').hidden) return; undoBox.paused = true; clearTimeout(undoBox.timer); undoBox.left -= Date.now() - undoBox.started; $('undoToast').classList.add('paused'); $('undoHint').textContent = 'Paused'; }
  function resumeUndo() { if (!undoBox.paused) return; if ($('undoToast').contains(document.activeElement)) return; undoBox.paused = false; $('undoToast').classList.remove('paused'); $('undoHint').textContent = 'Ctrl+Z'; runUndoTimer(); }
  function hideUndo() { clearTimeout(undoBox.timer); $('undoToast').hidden = true; undoBox.ids = null; }
  $('undoToast').addEventListener('mouseenter', pauseUndo);
  $('undoToast').addEventListener('mouseleave', resumeUndo);
  $('undoToast').addEventListener('focusin', pauseUndo);
  $('undoToast').addEventListener('focusout', () => setTimeout(resumeUndo, 0));
  $('undoDel').addEventListener('click', () => undoDelete());
  $('undoClose').addEventListener('click', hideUndo);
  async function undoDelete() { const ids = undoBox.ids; hideUndo(); if (ids) await restore(ids, true); }

  async function restore(ids, open) {
    await flushTitle(); if (!(await flush())) return;
    const res = await call('restore', ids);
    nb = res.notebook;
    if (open && res.restored.length) await openPage(res.restored[0]); else { renderTree(); renderHead(); }
    toast(res.restored.length === 1 ? 'Put back.' : pagesWord(res.restored.length) + ' put back.');
  }

  async function deletePage(id) {
    const hit = findPage(id); if (!hit) return;
    if (id === activeId) { await flushTitle(); await flush(); }
    const list = hit.folder.pages, i = list.indexOf(hit.page), title = hit.page.title;
    const tid = await call('delete_page', id);
    histStore.delete(id);
    await refresh();
    if (id === activeId) {
      const sib = findFolder(hit.folder.id), next = sib && (sib.pages[i] || sib.pages[i - 1]);
      activeId = null; activeHistId = null;
      if (next) await openPage(next.id); else { loadDoc({ text: '', margin: '', ink: [] }); renderHead(); renderTree(); }
      const b = next && tree.querySelector('[data-page="' + CSS.escape(next.id) + '"] .page-btn');
      (b || $('newPageBtn')).focus();
    } else renderTree();
    showUndo('Deleted “' + title + '”', [tid]);
  }

  async function deleteFolder(id) {
    const f = findFolder(id); if (!f) return;
    const hadActive = activeId && f.pages.some((p) => p.id === activeId);
    if (hadActive) { await flushTitle(); await flush(); }
    const name = f.name, n = f.pages.length;
    const ids = await call('delete_folder', id);
    f.pages.forEach((p) => histStore.delete(p.id));
    await refresh();
    if (hadActive) {
      activeId = null; activeHistId = null;
      const first = nb.folders.find((x) => x.pages.length);
      if (first) await openPage(first.pages[0].id); else { loadDoc({ text: '', margin: '', ink: [] }); renderHead(); renderTree(); }
    } else renderTree();
    const h = tree.querySelector('.folder-head'); (h || $('newFolderBtn')).focus();
    if (n) showUndo('Deleted “' + name + '” and ' + pagesWord(n), ids);
    else toast('Deleted “' + name + '”.');
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
  function nudgePage(id, d) {
    const hit = findPage(id); if (!hit) return;
    const i = hit.folder.pages.indexOf(hit.page);
    if (d < 0 && i > 0) movePage(id, hit.folder.id, i - 1);
    else if (d > 0 && i < hit.folder.pages.length - 1) movePage(id, hit.folder.id, i + 2);
    setTimeout(() => { const b = tree.querySelector('[data-page="' + CSS.escape(id) + '"] .page-btn'); if (b) b.focus(); }, 0);
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
  function nudgeFolder(id, d) {
    const i = nb.folders.findIndex((f) => f.id === id);
    if (d < 0 && i > 0) moveFolder(id, i - 1); else if (d > 0 && i < nb.folders.length - 1) moveFolder(id, i + 2);
    setTimeout(() => { const h = tree.querySelector('[data-folder="' + CSS.escape(id) + '"] .folder-head'); if (h) h.focus(); }, 0);
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
    f.color = color; renderTree(); renderHead();
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

  // A page is renamed by changing its first line.
  async function startRenamePage(id) {
    if (id !== activeId) await openPage(id);
    selectFirstLine();
  }

  // ---------- menus (arrow keys move, Esc goes back to where you were) ----------
  let menuOpener = null;
  function openMenu(x, y, items, opener) {
    closeFormat();
    menuOpener = opener || document.activeElement;
    menu.innerHTML = '';
    for (const it of items) {
      if (it === '-') { const hr = document.createElement('hr'); hr.setAttribute('role', 'separator'); menu.appendChild(hr); continue; }
      if (it.colors) {
        const row = document.createElement('div'); row.className = 'colors'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Folder colour');
        for (const c of COLORS) {
          const b = document.createElement('button'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', 'Colour ' + c);
          b.setAttribute('role', 'menuitemradio');
          b.setAttribute('aria-checked', String(c.toLowerCase() === (it.current || '').toLowerCase()));
          b.addEventListener('click', () => { closeMenu(true); it.colors(c); });
          row.appendChild(b);
        }
        menu.appendChild(row); continue;
      }
      if (it.note) { const p = document.createElement('div'); p.className = 'note'; p.textContent = it.note; menu.appendChild(p); continue; }
      const b = document.createElement('button'); b.type = 'button'; b.className = 'item' + (it.danger ? ' danger-item' : '');
      b.setAttribute('role', it.checked == null ? 'menuitem' : 'menuitemcheckbox');
      if (it.checked != null) b.setAttribute('aria-checked', String(!!it.checked));
      if (it.disabled) b.disabled = true;
      const label = document.createElement('span'); label.className = 'label'; label.textContent = it.label; b.appendChild(label);
      if (it.keys) { const k = document.createElement('kbd'); k.textContent = it.keys; b.appendChild(k); b.setAttribute('aria-keyshortcuts', it.aria || it.keys); }
      if (it.checked) b.insertAdjacentHTML('beforeend', ICON.check);
      b.addEventListener('click', () => { const back = it.keepFocus; closeMenu(!back); it.run(); });
      menu.appendChild(b);
    }
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    const first = menu.querySelector('button:not(:disabled)'); if (first) first.focus();
  }
  function closeMenu(returnFocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (returnFocus && menuOpener && document.contains(menuOpener) && menuOpener.focus) menuOpener.focus();
    menuOpener = null;
  }
  menu.addEventListener('keydown', (e) => {
    const items = Array.from(menu.querySelectorAll('button:not(:disabled)'));
    const i = items.indexOf(document.activeElement);
    let j = null;
    if (e.key === 'ArrowDown') j = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
    else if (e.key === 'ArrowRight' && document.activeElement.parentNode.classList.contains('colors')) j = Math.min(i + 1, items.length - 1);
    else if (e.key === 'ArrowLeft' && document.activeElement.parentNode.classList.contains('colors')) j = Math.max(i - 1, 0);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    else if (e.key === 'Tab') { e.preventDefault(); closeMenu(true); return; }
    if (j !== null) { e.preventDefault(); items[j].focus(); }
  });

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

  function folderMenu(id, x, y, opener) {
    const f = findFolder(id); if (!f) return;
    const i = nb.folders.indexOf(f);
    openMenu(x, y, [
      { label: 'New page here', run: () => newPage(id) },
      { label: 'Rename', keys: 'F2', run: () => startRenameFolder(id) },
      { colors: (c) => setColor(id, c), current: f.color },
      '-',
      { label: 'Move up', keys: 'Alt+↑', aria: 'Alt+ArrowUp', disabled: i === 0, run: () => nudgeFolder(id, -1) },
      { label: 'Move down', keys: 'Alt+↓', aria: 'Alt+ArrowDown', disabled: i === nb.folders.length - 1, run: () => nudgeFolder(id, 1) },
      '-',
      { label: 'Delete folder', keys: 'Del', aria: 'Delete', danger: true, run: () => deleteFolder(id) },
    ], opener);
  }

  function pageMenu(id, x, y, opener) {
    const hit = findPage(id); if (!hit) return;
    const i = hit.folder.pages.indexOf(hit.page);
    const others = nb.folders.filter((f) => f !== hit.folder).slice(0, 8);
    openMenu(x, y, [
      { label: 'Rename', keys: 'F2', run: () => startRenamePage(id) },
      { label: 'Move up', keys: 'Alt+↑', aria: 'Alt+ArrowUp', disabled: i === 0, run: () => nudgePage(id, -1) },
      { label: 'Move down', keys: 'Alt+↓', aria: 'Alt+ArrowDown', disabled: i === hit.folder.pages.length - 1, run: () => nudgePage(id, 1) },
      ...(others.length ? ['-'] : []),
      ...others.map((f) => ({ label: 'Move to ' + f.name, run: () => movePage(id, f.id, f.pages.length) })),
      '-',
      { label: 'Delete page', keys: 'Del', aria: 'Delete', danger: true, run: () => deletePage(id) },
    ], opener);
  }

  function moreMenu() {
    const r = $('moreBtn').getBoundingClientRect();
    const hand = !document.body.classList.contains('font-clean');
    const items = [{ label: 'Handwriting font', checked: hand, run: () => { applyFont(hand ? 'clean' : 'hand'); api.set_pref('font', hand ? 'clean' : 'hand'); } }, '-'];
    if (prefs.trayAvailable) {
      items.push({ label: 'Keep running when closed', checked: !!prefs.keepRunning, run: async () => {
        const want = !prefs.keepRunning;
        const on = !!(await call('set_pref', 'keep_running', want));
        prefs.keepRunning = on;
        toast(on ? 'The X now hides NiSH Notes in the tray. Right-click the tray icon to quit.'
          : want ? 'Could not add the tray icon, so the X still closes NiSH Notes.' : 'The X closes NiSH Notes again.');
      } });
      items.push('-');
    }
    if (!api.mock && api.window_frame) {
      const dots = document.body.classList.contains('has-dots');
      items.push({ label: 'Hide the Windows title bar', checked: dots, run: async () => {
        const on = !!(await call('set_pref', 'frame', dots ? 'windows' : 'dots'));
        showDots(on);
        if (!dots && !on) toast('The Windows title bar could not be hidden on this computer.');
      } });
      items.push('-');
    }
    if (!api.mock) {
      items.push({ label: 'Open notes folder', run: () => call('open_notes_folder') });
      items.push({ label: 'Change notes folder…', run: changeFolder });
      items.push({ label: 'Reload from disk', run: reloadFromDisk });
      items.push('-');
    }
    items.push({ note: 'Notes are saved in: ' + nb.root });
    items.push({ note: 'NiSH Notes ' + version });
    openMenu(r.right - 240, r.bottom + 6, items, $('moreBtn'));
  }
  function applyFont(font) {
    document.body.classList.toggle('font-clean', font === 'clean');
    document.body.classList.toggle('font-hand', font !== 'clean');
    queueChips();
  }

  async function changeFolder() {
    await flushTitle(); if (!(await flush())) return;
    const snap = await call('choose_notes_folder');
    if (!snap) return;
    nb = snap; activeId = null; activeHistId = null; histStore.clear(); clearSearch(true);
    const first = nb.folders.find((f) => f.pages.length);
    if (first) await openPage(first.pages[0].id); else { loadDoc({ text: '', margin: '', ink: [] }); renderHead(); renderTree(); }
    toast('Now using ' + nb.root);
  }

  async function reloadFromDisk() {
    await flushTitle(); if (!(await flush())) return;
    nb = await call('reload');
    histStore.clear(); activeHistId = null;
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
      if (li) pageMenu(li.dataset.page, r.left, r.bottom + 4, more); else folderMenu(more.closest('.folder').dataset.folder, r.left, r.bottom + 4, more);
      return;
    }
    const result = e.target.closest('.result');
    if (result) { openFromList(result.dataset.page); return; }
    const pageBtn = e.target.closest('.page-btn');
    if (pageBtn) { openFromList(pageBtn.closest('.page').dataset.page); return; }
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
    const btn = e.target.closest('button');
    if (page && page.dataset.page) pageMenu(page.dataset.page, e.clientX, e.clientY, btn);
    else if (folder) folderMenu(folder.dataset.folder, e.clientX, e.clientY, btn);
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
      if (page) pageMenu(page.dataset.page, r.left + 20, r.bottom, e.target); else if (head) folderMenu(fid, r.left + 20, r.bottom, e.target);
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !searchHits) {   // move with the keyboard
      e.preventDefault();
      const d = e.key === 'ArrowUp' ? -1 : 1;
      if (page) nudgePage(page.dataset.page, d); else if (head) nudgeFolder(fid, d);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (e.key === 'ArrowUp' && e.target === tree.querySelector('.result, .folder-head')) { e.preventDefault(); $('search').focus(); return; }
      const all = Array.from(tree.querySelectorAll('.result, .folder-head, .folder.open .page-btn'));
      const i = all.indexOf(e.target);
      if (i >= 0) { e.preventDefault(); const next = all[i + (e.key === 'ArrowDown' ? 1 : -1)]; if (next) next.focus(); }
    }
  });

  // ---------- writing: the two columns ----------
  function bindEditor(el) {
    el.addEventListener('focus', () => { lastEd = el; if (Date.now() - lastKeyNav < 400) showKbTip(); });
    el.addEventListener('input', (e) => {
      if (!e.isComposing) tidy(el);
      if (e.inputType === 'insertParagraph') {           // a new checklist line starts unticked
        const li = blockAt('LI');
        if (li && li.hasAttribute('data-checked') && !li.textContent.trim()) li.removeAttribute('data-checked');
      }
      updateEmpty(); changed(); histTyping(); if (!fmt.hidden) syncFormat();
      if (el === editor) { titleChanged(); queueChips(); }
    });
    el.addEventListener('beforeinput', (e) => {         // the browser's own undo would skip the drawing
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); if (e.inputType === 'historyUndo') undo(); else redo(); }
    });
    el.addEventListener('contextmenu', (e) => {
      const td = e.target.closest && e.target.closest('td');
      if (td && el === editor && !ink.on) { e.preventDefault(); caretIn(td, true); tableMenu(e.clientX, e.clientY, el); }
    });
    el.addEventListener('paste', (e) => {
      const cd = e.clipboardData; if (!cd) return;
      e.preventDefault();
      if (hist.pending) histCommit();
      const html = cd.getData('text/html'), text = cd.getData('text/plain');
      if (html && !pastePlain) {
        // No tables inside a table, and none in the margin: they come in as lines of text.
        let clean = sanitize(html, el === margin || !!blockAt('TD'));
        // A word or one line goes into the line you are on, in that line's style (bold and
        // italic stay). Whole lines pasted onto an empty line keep their own style.
        const box = document.createElement('div'); box.innerHTML = clean;
        const only = box.childNodes.length === 1 && box.firstChild.nodeType === 1 && /^(DIV|H1|H2|H3|PRE)$/.test(box.firstChild.tagName) ? box.firstChild : null;
        const line = lineAt(el);
        if (only && !(line && !line.textContent.trim() && only.tagName !== 'DIV')) clean = only.innerHTML;
        if (clean.replace(/<br>/g, '')) document.execCommand('insertHTML', false, clean);
        else if (text) document.execCommand('insertText', false, text);
      } else if (text) document.execCommand('insertText', false, text);
      pastePlain = false;
      tidy(el); afterEdit(); histCommit();
    });
    // Copying puts plain, tidy text on the clipboard (no handwriting font or paper colour in
    // other programs), and the page's own styles for pasting back into NiSH Notes.
    const copyOut = (e) => {
      const s = getSelection(); if (!s.rangeCount || s.isCollapsed || !el.contains(s.anchorNode)) return false;
      const box = document.createElement('div'); box.appendChild(s.getRangeAt(0).cloneContents());
      e.clipboardData.setData('text/html', sanitize(box.innerHTML));
      e.clipboardData.setData('text/plain', s.toString());
      e.preventDefault();
      return true;
    };
    el.addEventListener('copy', copyOut);
    el.addEventListener('cut', (e) => {
      if (!copyOut(e) || el.contentEditable !== 'true') return;
      if (hist.pending) histCommit();
      document.execCommand('delete'); tidy(el); afterEdit(); histCommit();
    });
    el.addEventListener('mousedown', (e) => {                 // click a checklist circle to tick it
      const li = e.target.closest && e.target.closest('ul.checklist > li');
      if (li && el.contains(li) && e.clientX < li.getBoundingClientRect().left) {
        e.preventDefault();
        if (hist.pending) histCommit();
        li.toggleAttribute('data-checked');
        changed(); histCommit();
      }
    });
    el.addEventListener('keydown', onEditorKey);
    el.addEventListener('blur', () => { flush(); });
    el.addEventListener('drop', (e) => { if (!hasFiles(e)) setTimeout(() => { updateEmpty(); changed(); }, 0); });
  }
  let pastePlain = false;

  function lineAt(ed) {                         // the line (block) the cursor is in
    const s = getSelection(); if (!s.rangeCount) return null;
    let n = s.anchorNode;
    while (n && n.parentNode !== ed) n = n.parentNode;
    if (n && n.nodeType === 1 && /^(UL|OL|TABLE)$/.test(n.tagName)) { let m = s.anchorNode; while (m && !/^(LI|TD)$/.test(m.nodeName)) m = m.parentNode; return m; }
    return n && n.nodeType === 1 ? n : null;
  }
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
    if (fmtSaved && !fmt.hidden && fmt.contains(document.activeElement)) {   // the Aa panel has the keyboard
      fmtSaved.ed.focus({ preventScroll: true });
      const s = getSelection(); s.removeAllRanges(); s.addRange(fmtSaved.range);
      return;
    }
    if (activeEd()) {
      const ed = activeEd();
      if (document.activeElement !== ed) { const r = getSelection().getRangeAt(0).cloneRange(); ed.focus({ preventScroll: true }); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      return;
    }
    const ed = document.contains(lastEd) ? lastEd : editor;
    ed.focus();
    const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function exec(cmd, val) {
    if (!activeId || ink.on) return;
    ensureFocus();
    if (hist.pending) histCommit();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(cmd, false, val);
    tidy(activeEd()); afterEdit(); histCommit();
  }
  function afterEdit() { updateEmpty(); changed(); syncFormat(); queueChips(); titleChanged(); }
  function setBlock(tag) {
    if (!activeId || ink.on) return;
    ensureFocus();
    const list = currentList();
    if (list) {                                // a list line becomes an ordinary line first (a heading can't hold a list)
      if (hist.pending) histCommit();
      document.execCommand(list.el.tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
      if (currentList()) { exec('outdent'); }
    }
    exec('formatBlock', tag === 'div' ? 'div' : tag);
  }
  function setList(kind) {
    if (!activeId || ink.on) return;
    ensureFocus();
    const cur = currentList();
    if (cur && cur.kind === kind) { exec(cur.el.tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList'); return; }
    const want = kind === 'check' ? 'checklist' : kind === 'dashed' ? 'dashed' : '';
    const ed = activeEd();
    if (hist.pending) histCommit();
    if (!cur && currentBlock() !== 'div') document.execCommand('formatBlock', false, 'div');   // list lines are body text
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
    tidy(ed); afterEdit(); histCommit();
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
    if (more && now && now.el !== cur.el && now.el.tagName === 'UL' && cur.el.tagName === 'UL' && cur.el.className) { now.el.className = cur.el.className; histCommit(); }
  }

  function onEditorKey(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape' && menu.hidden && fmt.hidden && !ink.on && !e.shiftKey) {     // leave the page (no keyboard trap)
      e.preventDefault(); e.stopPropagation();
      hideKbTip();
      const tool = Array.from(document.querySelectorAll('.head-tools .tool')).find((b) => !b.disabled);
      if (tool) tool.focus();
      return;
    }
    if (e.key === 'Tab' && !ctrl && !e.altKey) {
      e.preventDefault();
      const td = blockAt('TD');
      if (td) moveCell(td, e.shiftKey ? -1 : 1);
      else if (currentList()) indent(!e.shiftKey);
      else if (!e.shiftKey) { document.execCommand('insertText', false, '\t'); }
      return;
    }
    if (ctrl && e.altKey && !e.shiftKey && e.code === 'KeyT') { e.preventDefault(); insertTable(); return; }
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
  let fmtSaved = null;
  function saveFmtSel() {
    const ed = activeEd(), s = getSelection();
    fmtSaved = ed && s.rangeCount ? { ed, range: s.getRangeAt(0).cloneRange() } : null;
  }
  function openFormat(fromKeyboard) {
    if (!activeId || ink.on) return;
    closeMenu();
    ensureFocus();
    saveFmtSel();
    const r = $('formatBtn').getBoundingClientRect();
    fmt.hidden = false;
    const w = fmt.getBoundingClientRect().width;
    fmt.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
    fmt.style.top = (r.bottom + 8) + 'px';
    $('formatBtn').setAttribute('aria-expanded', 'true');
    syncFormat();
    if (fromKeyboard) (fmt.querySelector('[data-block][aria-current="true"]') || fmt.querySelector('button')).focus();
  }
  function closeFormat(backToText) {
    if (fmt.hidden) return;
    const hadKeys = fmt.contains(document.activeElement);
    fmt.hidden = true; $('formatBtn').setAttribute('aria-expanded', 'false');
    if ((backToText || hadKeys) && fmtSaved && document.contains(fmtSaved.ed)) {
      fmtSaved.ed.focus({ preventScroll: true });
      const s = getSelection(); s.removeAllRanges(); s.addRange(fmtSaved.range);
    }
  }
  fmt.addEventListener('keydown', (e) => {
    const items = Array.from(fmt.querySelectorAll('button:not(:disabled)'));
    const i = items.indexOf(document.activeElement);
    let j = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') j = (i + 1) % items.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') j = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    else if (e.key === 'Tab') j = (i + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFormat(true); return; }
    if (j !== null) { e.preventDefault(); items[j].focus(); }
  });
  const STYLE_NAMES = { h1: 'Title', h2: 'Heading', h3: 'Subheading', div: 'Body', pre: 'Monostyled' };
  function syncFormat() {                     // the toolbar and the style panel show where the cursor is
    if (!activeId || ink.on) return;
    const block = currentBlock(), list = currentList();
    fmt.querySelectorAll('[data-block]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.block === block && !list)));
    const name = list ? 'List' : (STYLE_NAMES[block] || 'Body');
    if ($('styleName').textContent !== name) { $('styleName').textContent = name; $('formatBtn').setAttribute('aria-label', 'Paragraph style: ' + name); }
    const marks = { bold: 'B,STRONG', italic: 'I,EM', underline: 'U', strikeThrough: 'S,STRIKE,DEL' };   // headings are bold by nature: only real marks count
    document.querySelectorAll('#fmt [data-mark], .head-tools [data-mark]').forEach((b) => b.setAttribute('aria-pressed', String(!!marks[b.dataset.mark].split(',').some((t) => blockAt(t)))));
    document.querySelectorAll('#fmt [data-list], .head-tools [data-list]').forEach((b) => b.setAttribute('aria-pressed', String(!!list && list.kind === b.dataset.list)));
    fmt.querySelectorAll('[data-indent]').forEach((b) => { b.disabled = !list; });
    const noTable = activeEd() === margin || !!blockAt('TABLE');
    document.querySelectorAll('#tableBtn, #fmt [data-table]').forEach((b) => { b.disabled = noTable; });
  }
  fmt.addEventListener('mousedown', (e) => e.preventDefault());          // keep the text selection
  fmt.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const kb = e.detail === 0 && fmt.contains(document.activeElement);
    if (b.dataset.table) { if (kb) ensureFocus(); fmt.hidden = true; $('formatBtn').setAttribute('aria-expanded', 'false'); insertTable(); return; }
    if (b.dataset.block) setBlock(b.dataset.block);
    else if (b.dataset.mark) exec(b.dataset.mark);
    else if (b.dataset.list) setList(b.dataset.list);
    else if (b.dataset.indent) indent(b.dataset.indent === 'indent');
    if (kb && !fmt.hidden) { saveFmtSel(); syncFormat(); b.focus(); }      // keep working from the keyboard
  });
  let syncQueued = false;
  document.addEventListener('selectionchange', () => {
    if (syncQueued) return; syncQueued = true;
    requestAnimationFrame(() => { syncQueued = false; syncFormat(); });
  });
  // the toolbar's text buttons: bold, italic, underline, strikethrough, lists, table
  const headTools = document.querySelector('.head-tools');
  headTools.addEventListener('mousedown', (e) => { if (e.target.closest('[data-mark], [data-list], #tableBtn')) e.preventDefault(); });   // keep the selection
  headTools.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mark], [data-list], #tableBtn'); if (!b || b.disabled) return;
    if (b.id === 'tableBtn') insertTable();
    else if (b.dataset.mark) exec(b.dataset.mark);
    else setList(b.dataset.list);
    syncFormat();
  });
  $('formatBtn').addEventListener('mousedown', (e) => e.preventDefault());
  $('formatBtn').addEventListener('click', (e) => { if (fmt.hidden) openFormat(e.detail === 0); else closeFormat(); });

  // ---------- one undo history per page: text, margin notes and drawing together ----------
  // Each step is a snapshot of the page. Typing is grouped into one step per pause; a command,
  // a stroke, an erase or a table change is a step of its own. Ctrl+Z / Ctrl+Y walk through them.
  const hist = { stack: [], i: 0, timer: 0, pending: false };
  function caretInfo() {
    const ed = activeEd(); if (!ed) return null;
    const s = getSelection();
    const r = document.createRange(); r.selectNodeContents(ed);
    try { r.setEnd(s.anchorNode, s.anchorOffset); } catch (e) { return null; }
    return { m: ed === margin, o: r.toString().length };
  }
  function snap() { return { text: editor.innerHTML, margin: margin.innerHTML, ink: ink.strokes.slice(), caret: caretInfo() }; }
  function sameSnap(a, b) { return a.text === b.text && a.margin === b.margin && a.ink.length === b.ink.length && a.ink.every((x, i) => x === b.ink[i]); }
  function histReset() { clearTimeout(hist.timer); hist.pending = false; hist.stack = [snap()]; hist.i = 0; syncUndo(); }
  function histCommit() {
    clearTimeout(hist.timer); hist.pending = false;
    if (!activeId) return;
    const now = snap(), cur = hist.stack[hist.i];
    if (cur && sameSnap(cur, now)) { cur.caret = now.caret || cur.caret; syncUndo(); return; }
    hist.stack.splice(hist.i + 1); hist.stack.push(now); hist.i = hist.stack.length - 1;
    if (hist.stack.length > 400) { hist.stack.shift(); hist.i--; }
    syncUndo();
  }
  function histTyping() { hist.pending = true; clearTimeout(hist.timer); hist.timer = setTimeout(histCommit, 700); syncUndo(); }
  function histGo(step) {
    if (!activeId) return false;
    if (hist.pending) histCommit();
    const j = hist.i + step;
    if (j < 0 || j >= hist.stack.length) return false;
    hist.i = j;
    const st = hist.stack[j];
    editor.innerHTML = st.text; margin.innerHTML = st.margin; ink.strokes = st.ink.slice();
    decorateMemos(); renderInk(); updateEmpty(); restoreCaret(st.caret);
    changed(); syncUndo(); placeChips();
    if (!fmt.hidden) syncFormat();
    return true;
  }
  function undo() { if (!histGo(-1)) flashButton('undoBtn'); }
  function redo() { if (!histGo(1)) flashButton('redoBtn'); }
  function flashButton(id) { const b = $(id); if (b.animate) b.animate([{ transform: 'translateX(-2px)' }, { transform: 'translateX(2px)' }, { transform: 'none' }], 160); }
  function restoreCaret(c) {
    if (!c || ink.on) return;
    const ed = c.m ? margin : editor;
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let left = c.o, n, node = null, off = 0;
    while ((n = walker.nextNode())) { if (n.nodeValue.length >= left) { node = n; off = left; break; } left -= n.nodeValue.length; }
    const r = document.createRange();
    if (node) r.setStart(node, off); else { r.selectNodeContents(ed); r.collapse(false); }
    r.collapse(true);
    ed.focus({ preventScroll: true });
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    const rect = r.getBoundingClientRect(), pr = paper.getBoundingClientRect();
    if (rect.top && (rect.top < pr.top || rect.bottom > pr.bottom)) paper.scrollTop += rect.top - pr.top - pr.height / 3;
  }
  function syncUndo() {
    const can = !!activeId && (hist.pending || hist.i > 0), again = !!activeId && !hist.pending && hist.i < hist.stack.length - 1;
    for (const id of ['undoBtn', 'inkUndo']) $(id).disabled = !can;
    for (const id of ['redoBtn', 'inkRedo']) $(id).disabled = !again;
  }
  for (const [id, fn] of [['undoBtn', undo], ['redoBtn', redo]]) {
    $(id).addEventListener('mousedown', (e) => e.preventDefault());     // keep the caret where it is
    $(id).addEventListener('click', fn);
  }

  // ---------- tables ----------
  const newCell = () => { const td = document.createElement('td'); td.appendChild(document.createElement('br')); return td; };
  function caretIn(el, atEnd) {
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(!atEnd);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function insertTable(rows, cols) {
    if (!activeId || ink.on) return;
    if (activeEd() !== editor) { editor.focus(); caretIn(editor, true); }
    if (blockAt('TABLE')) { toast('A table can’t go inside another table.'); return; }
    if (hist.pending) histCommit();
    const row = '<tr>' + '<td><br></td>'.repeat(cols || 2) + '</tr>';
    document.execCommand('insertHTML', false, '<table data-new=""><tbody>' + row.repeat(rows || 3) + '</tbody></table><div><br></div>');
    const t = editor.querySelector('table[data-new]');
    if (t) { t.removeAttribute('data-new'); caretIn(t.rows[0].cells[0], false); }
    afterEdit(); histCommit(); placeChips();
  }
  function tableOp(op) {
    const td = blockAt('TD'); if (!td) return;
    if (hist.pending) histCommit();
    const tr = td.parentNode, table = td.closest('table'), col = Array.from(tr.cells).indexOf(td);
    if (op === 'rowAbove' || op === 'rowBelow') {
      const nr = document.createElement('tr');
      for (let i = 0; i < tr.cells.length; i++) nr.appendChild(newCell());
      tr.parentNode.insertBefore(nr, op === 'rowBelow' ? tr.nextSibling : tr);
      caretIn(nr.cells[col], false);
    } else if (op === 'colLeft' || op === 'colRight') {
      for (const row of Array.from(table.rows)) {
        const ref = row.cells[Math.min(col, row.cells.length - 1)];
        row.insertBefore(newCell(), op === 'colRight' ? ref.nextSibling : ref);
      }
      caretIn(tr.cells[op === 'colRight' ? col + 1 : col], false);
    } else if (op === 'delRow' && table.rows.length > 1) {
      const next = tr.nextElementSibling || tr.previousElementSibling;
      tr.remove(); caretIn(next.cells[Math.min(col, next.cells.length - 1)], true);
    } else if (op === 'delCol' && tr.cells.length > 1) {
      for (const row of Array.from(table.rows)) if (row.cells[col]) row.cells[col].remove();
      caretIn(tr.cells[Math.min(col, tr.cells.length - 1)], true);
    } else {                                       // the whole table (or its last row or column)
      const after = table.nextElementSibling;
      table.remove();
      if (after) caretIn(after, false); else caretIn(editor, true);
    }
    afterEdit(); histCommit(); placeChips();
  }
  function moveCell(td, dir) {
    const cells = Array.from(td.closest('table').querySelectorAll('td'));
    const i = cells.indexOf(td) + dir;
    if (i < 0) return;
    if (i >= cells.length) {                                   // Tab in the last cell adds a row
      tableOp('rowBelow');
      const row = td.closest('tr').nextElementSibling; if (row) caretIn(row.cells[0], false);
      return;
    }
    caretIn(cells[i], true);
    placeChips();
  }
  function tableMenu(x, y, opener) {
    const done = () => { if (opener) opener.setAttribute('aria-expanded', 'false'); };
    setTimeout(() => { const mo = new MutationObserver(() => { if (menu.hidden) { done(); mo.disconnect(); } }); mo.observe(menu, { attributes: true, attributeFilter: ['hidden'] }); }, 0);
    openMenu(x, y, [
      { label: 'Add row above', run: () => tableOp('rowAbove') },
      { label: 'Add row below', run: () => tableOp('rowBelow') },
      { label: 'Add column left', run: () => tableOp('colLeft') },
      { label: 'Add column right', run: () => tableOp('colRight') },
      '-',
      { label: 'Delete row', run: () => tableOp('delRow') },
      { label: 'Delete column', run: () => tableOp('delCol') },
      { label: 'Delete table', danger: true, run: () => tableOp('delTable') },
    ], opener);
  }
  // Each table gets a small handle in the margin, next to its first row.
  const TABLE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M3.5 9.7h17M3.5 14.3h17M12 5v14"/></svg><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  let chipsQueued = false;
  function queueChips() { if (chipsQueued) return; chipsQueued = true; requestAnimationFrame(() => { chipsQueued = false; placeChips(); }); }
  function placeChips() {
    const box = $('chips'); if (!box) return;
    const tables = Array.from(editor.querySelectorAll('table'));
    while (box.children.length > tables.length) box.lastChild.remove();
    tables.forEach((t, i) => {
      let b = box.children[i];
      if (!b) {
        b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.innerHTML = TABLE_ICON;
        b.setAttribute('aria-haspopup', 'menu'); b.title = 'Table: add or remove rows and columns';
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => {
          const table = editor.querySelectorAll('table')[Array.from(box.children).indexOf(b)]; if (!table) return;
          if (!blockAt('TD') || blockAt('TABLE') !== table) caretIn(table.rows[0].cells[0], false);
          const r = b.getBoundingClientRect();
          b.setAttribute('aria-expanded', 'true');
          tableMenu(r.left, r.bottom + 4, b);
        });
        box.appendChild(b);
      }
      b.setAttribute('aria-label', 'Table ' + (i + 1) + ' options');
      b.style.top = (editor.offsetTop + t.offsetTop + 3) + 'px';
    });
  }
  window.addEventListener('resize', queueChips);

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
    if (hist.pending) histCommit();
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
      if (ink.erased.length) { changed(); histCommit(); }
      ink.erased = null; syncInkButtons(); return;
    }
    if (!ink.cur) return;
    ink.strokes.push(ink.cur);
    ink.cur = null; ink.curEl = null;
    renderInk(); syncInkButtons(); changed(); histCommit();
  }
  inkSvg.addEventListener('pointerup', endStroke);
  inkSvg.addEventListener('pointercancel', endStroke);
  inkSvg.addEventListener('lostpointercapture', endStroke);

  async function inkClear() {
    if (!ink.strokes.length) return;
    if (!(await dialog({ title: 'Clear the drawing?', text: 'All drawing on this page is removed. You can bring it back with Undo.', ok: 'Clear' }))) return;
    ink.strokes = [];
    renderInk(); syncInkButtons(); changed(); histCommit();
  }
  function syncInkButtons() {
    syncUndo(); $('inkClear').disabled = !ink.strokes.length;
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
    placeChips();
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
    $('inkUndo').addEventListener('click', undo);
    $('inkRedo').addEventListener('click', redo);
    $('inkClear').addEventListener('click', inkClear);
    $('inkDone').addEventListener('click', () => setScribble(false));
    $('scribbleBtn').addEventListener('click', () => setScribble(!ink.on));
  })();

  // ---------- voice memos, in the margin ----------
  // A recording goes into the margin on the line you were writing on. The sound is a file in the
  // notes folder (_Voice memos); the margin keeps a small "Voice memo 0:12" line that plays it.
  const rec = { mr: null, stream: null, chunks: [], start: 0, timer: 0, cancel: false, line: 0, pageId: null, done: null };
  const memoUrls = new Map();
  const player = new Audio();
  let playing = null;
  function decorateMemos() {
    margin.querySelectorAll('[data-memo]').forEach((m) => {
      m.contentEditable = 'false'; m.tabIndex = 0; m.setAttribute('role', 'button');
      const sec = +m.dataset.sec || 0;
      m.textContent = memoLabel(sec).slice(11);                  // the margin is narrow: the length is enough
      m.title = memoLabel(sec);
      m.setAttribute('aria-label', 'Play voice memo, ' + (sec < 60 ? sec + ' seconds' : memoLabel(sec).slice(11)));
    });
  }
  function caretLine() {
    const s = getSelection(), top = leaf.getBoundingClientRect().top;
    let y = null;
    if (s.rangeCount && (editor.contains(s.anchorNode) || margin.contains(s.anchorNode))) {
      const r = s.getRangeAt(0), rects = r.getClientRects();
      const box = rects.length ? rects[0] : (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentNode).getBoundingClientRect();
      y = box.top + 4;
    }
    if (y === null) y = paper.getBoundingClientRect().top + 24;
    return Math.max(0, Math.floor((y - top - 8) / 32));
  }
  async function startMemo() {
    if (!activeId || ink.on || rec.mr) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Recording isn’t available on this computer.'); return; }
    rec.line = caretLine(); rec.pageId = activeId;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (e) {
      toast(e && e.name === 'NotAllowedError' ? 'NiSH Notes may not use the microphone. Turn it on in Windows Settings › Privacy › Microphone.'
        : 'No microphone found. Plug one in and try again.');
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    Object.assign(rec, { mr, stream, chunks: [], cancel: false, start: Date.now() });
    rec.done = new Promise((resolve) => { mr.onstop = () => finishMemo().then(resolve, resolve); });
    mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    mr.start(1000);
    const tick = () => { const sec = Math.floor((Date.now() - rec.start) / 1000); $('recText').textContent = 'Recording ' + memoLabel(sec).slice(11); };
    tick(); rec.timer = setInterval(tick, 500);
    $('recBar').hidden = false; $('memoBtn').setAttribute('aria-pressed', 'true');
    $('recStop').focus();
  }
  function stopMemo(cancel) {
    if (!rec.mr) return Promise.resolve();
    rec.cancel = !!cancel;
    const done = rec.done;
    if (rec.mr.state !== 'inactive') rec.mr.stop();
    return done;
  }
  const toB64 = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = reject; r.readAsDataURL(blob); });
  async function finishMemo() {
    clearInterval(rec.timer);
    rec.stream.getTracks().forEach((t) => t.stop());
    const mr = rec.mr; rec.mr = null;
    $('recBar').hidden = true; $('memoBtn').setAttribute('aria-pressed', 'false');
    if (rec.cancel || !rec.chunks.length) { toast(rec.cancel ? 'Recording thrown away.' : 'Nothing was recorded.'); return; }
    const sec = Math.max(1, Math.round((Date.now() - rec.start) / 1000));
    const blob = new Blob(rec.chunks, { type: (mr.mimeType || 'audio/webm').split(';')[0] });
    const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try { await call('save_memo', id, blob.type, await toB64(blob)); } catch (e) { return; }
    memoUrls.set(id, URL.createObjectURL(blob));
    if (activeId !== rec.pageId) { toast('Recording saved, but its page is closed.'); return; }
    insertMemo(id, sec, rec.line);
    toast('Voice memo saved in the margin.');
  }
  function insertMemo(id, sec, line) {
    if (hist.pending) histCommit();
    const memo = document.createElement('div');
    memo.dataset.memo = id; memo.dataset.sec = String(sec);
    const lineOf = (el) => Math.round((el.offsetTop - margin.offsetTop - 8) / 32);
    let placed = false;
    for (const k of Array.from(margin.children)) {
      const l = lineOf(k);
      if (l === line && !k.textContent.trim() && !k.dataset.memo && !k.querySelector('li, table')) { k.replaceWith(memo); placed = true; break; }
      if (l >= line) { k.before(memo); placed = true; break; }
    }
    if (!placed) {
      const last = margin.lastElementChild;
      let count = last ? lineOf(last) + Math.max(1, Math.round(last.offsetHeight / 32)) : 0;
      for (; count < line; count++) { const d = document.createElement('div'); d.appendChild(document.createElement('br')); margin.appendChild(d); }
      margin.appendChild(memo);
    }
    decorateMemos(); updateEmpty(); changed(); histCommit();
  }
  async function playMemo(el) {
    const id = el.dataset.memo;
    if (playing === el && !player.paused) { player.pause(); return; }
    let url = memoUrls.get(id);
    if (!url) {
      try {
        const m = await api.read_memo(id);
        const bytes = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: m.mime }));
        memoUrls.set(id, url);
      } catch (e) {
        el.classList.add('missing');
        toast('This recording is missing from the notes folder (_Voice memos).');
        return;
      }
    }
    if (playing) playing.classList.remove('playing');
    playing = el; el.classList.add('playing');
    player.src = url;
    try { await player.play(); } catch (e) { el.classList.remove('playing'); toast('Could not play the recording: ' + errText(e)); }
  }
  for (const ev of ['pause', 'ended']) player.addEventListener(ev, () => { if (playing) playing.classList.remove('playing'); if (ev === 'ended') playing = null; });
  document.addEventListener('mousedown', (e) => {
    const m = e.target.closest && e.target.closest('#margin [data-memo]');
    if (m && e.button === 0 && !ink.on) { e.preventDefault(); playMemo(m); }
  });
  document.addEventListener('keydown', (e) => {
    const m = e.target.closest && e.target.closest('#margin [data-memo]');
    if (m && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); playMemo(m); }
    else if (m && (e.key === 'Delete' || e.key === 'Backspace') && !preview) { e.preventDefault(); e.stopPropagation(); removeMemo(m); }
  }, true);
  document.addEventListener('contextmenu', (e) => {
    const m = e.target.closest && e.target.closest('#margin [data-memo]');
    if (!m || preview) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { label: player.paused || playing !== m ? 'Play' : 'Pause', run: () => playMemo(m) },
      '-',
      { label: 'Delete voice memo', danger: true, keys: 'Del', aria: 'Delete', run: () => removeMemo(m) },
    ], m);
  });
  function removeMemo(m) {
    if (hist.pending) histCommit();
    if (playing === m) { player.pause(); playing = null; }
    const empty = document.createElement('div'); empty.appendChild(document.createElement('br'));
    m.replaceWith(empty);                           // keeps the margin notes below it on their lines
    updateEmpty(); changed(); histCommit();
    toast('Voice memo deleted. Ctrl+Z brings it back.');
  }
  $('memoBtn').addEventListener('mousedown', (e) => e.preventDefault());   // keep the cursor's line
  $('memoBtn').addEventListener('click', () => { if (rec.mr) stopMemo(false); else startMemo(); });
  $('recStop').addEventListener('click', () => stopMemo(false));
  $('recCancel').addEventListener('click', () => stopMemo(true));

  // ---------- search ----------
  function clearSearch(keepText) {
    if (!keepText) $('search').value = '';
    searchHits = null; renderTree();
  }
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('search').value.trim();
      if (!q) { clearSearch(true); return; }
      await flush();
      const hits = await call('search', q);
      if ($('search').value.trim() === q) { searchHits = hits; renderTree(); }
    }, 200);
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('search').value) { e.stopPropagation(); clearSearch(); }
    if (e.key === 'Enter') { const b = tree.querySelector('.result, .page-btn'); if (b) b.click(); }
    if (e.key === 'ArrowDown') { const b = tree.querySelector('.result, .folder-head'); if (b) { e.preventDefault(); b.focus(); } }
  });
  async function openFromList(id) {
    if (id !== activeId) await openPage(id);
    if (narrow() && document.body.classList.contains('side-shown')) { setSide(false); editor.focus(); }
  }

  // ---------- hiding the folders (button, Ctrl+\, or by itself when the window is narrow) ----------
  const side = document.querySelector('.side');
  const narrow = () => matchMedia('(max-width: 720px)').matches;
  const sideVisible = () => getComputedStyle(side).display !== 'none';
  function syncSideBtn() {
    const on = sideVisible(), b = $('sideBtn');
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', 'Folders');
    b.title = (on ? 'Hide folders' : 'Show folders') + ' (Ctrl+\\)';
  }
  function setSide(show) {
    document.body.classList.toggle('side-hidden', !show);
    document.body.classList.toggle('side-shown', !!show && narrow());
    $('sideBack').hidden = !(show && narrow());
    if (!narrow()) api.set_pref('side', show ? 'shown' : 'hidden');
    syncSideBtn();
    if (show) { const t = tree.querySelector('.page.active .page-btn') || tree.querySelector('.folder-head'); if (t && narrow()) t.focus(); }
  }
  $('sideBtn').addEventListener('click', () => setSide(!sideVisible()));
  window.addEventListener('resize', () => { if (!narrow()) { document.body.classList.remove('side-shown'); $('sideBack').hidden = true; } syncSideBtn(); });
  $('sideClose').addEventListener('click', () => { setSide(false); $('sideBtn').focus(); });
  $('sideBack').addEventListener('mousedown', (e) => { e.preventDefault(); setSide(false); });

  // ---------- keyboard: F6 moves between areas, a tip says how to leave the page ----------
  let lastKeyNav = 0;
  document.addEventListener('keydown', (e) => {          // only keys that bring you into the page from outside it
    const inPage = e.target === editor || e.target === margin || editor.contains(e.target) || margin.contains(e.target);
    if ((e.key === 'Tab' && !inPage) || e.key === 'F6') lastKeyNav = Date.now();
  }, true);
  let kbTipTimer = 0;
  function showKbTip() {
    if (prefs.kbTip === 'off' || !activeId || !$('undoToast').hidden) return;
    $('kbTip').hidden = false;
    clearTimeout(kbTipTimer); kbTipTimer = setTimeout(hideKbTip, 9000);
  }
  function hideKbTip() { clearTimeout(kbTipTimer); $('kbTip').hidden = true; }
  $('kbTipClose').addEventListener('click', () => { hideKbTip(); prefs.kbTip = 'off'; api.set_pref('kb_tip', 'off'); editor.focus(); });
  paper.addEventListener('mousedown', hideKbTip);
  function cycleArea(back) {
    const areas = [
      () => editor,
      () => margin,
      () => sideVisible() ? (tree.querySelector('.page.active .page-btn') || tree.querySelector('.result, .folder-head') || $('search')) : null,
      () => Array.from(document.querySelectorAll('.head-tools .tool')).find((b) => !b.disabled),
    ];
    const a = document.activeElement;
    let cur = a === editor || editor.contains(a) ? 0 : a === margin || margin.contains(a) ? 1 : side.contains(a) ? 2 : document.querySelector('.head-tools').contains(a) ? 3 : -1;
    for (let k = 1; k <= areas.length; k++) {
      const el = areas[(cur + (back ? -k : k) + areas.length * 2) % areas.length]();
      if (el && !(activeId === null && (el === editor || el === margin))) { el.focus(); return; }
    }
  }

  $('newPageBtn').addEventListener('click', () => newPage());
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
      if (!menu.hidden) { closeMenu(true); return; }
      if (!fmt.hidden) { closeFormat(true); return; }
      if (ink.on) { setScribble(false); return; }
      if (rec.mr) { stopMemo(false); return; }
      if (preview) { closePreview(); return; }
      if (!$('kbTip').hidden) { hideKbTip(); return; }
      if (narrow() && document.body.classList.contains('side-shown')) { setSide(false); return; }
    }
    if (e.key === 'F6') { e.preventDefault(); hideKbTip(); cycleArea(e.shiftKey); return; }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ink.on && !ctrl && !e.altKey && document.activeElement === document.body || (ink.on && $('inkBar').contains(document.activeElement) && !ctrl)) {
      const tools = { p: 'pen', m: 'marker', e: 'eraser' };
      if (tools[e.key.toLowerCase()]) { ink.tool = tools[e.key.toLowerCase()]; syncInkButtons(); return; }
    }
    if (!ctrl || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.code === 'Backslash' || k === '\\') { e.preventDefault(); setSide(!sideVisible()); return; }
    if ((k === 'z' || k === 'y') && e.target.tagName !== 'INPUT') {      // search and rename boxes keep their own undo
      e.preventDefault();
      // Right after a delete, Ctrl+Z brings the page back (unless you have already changed the next page).
      if (k === 'z' && !e.shiftKey && undoBox.ids && !$('undoToast').hidden && !hist.pending && hist.i === 0) { undoDelete(); return; }
      if (k === 'z' && !e.shiftKey) undo(); else redo();
      return;
    }
    if ((k === 'w' || k === 'q') && !e.shiftKey) { e.preventDefault(); toBackground(); return; }
    if (k === 'n' && e.shiftKey) { e.preventDefault(); newFolder(); }
    else if (k === 'n') { e.preventDefault(); newPage(); }
    else if (k === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); }
    else if (k === 's') { e.preventDefault(); flushTitle(); flush(); }
    else if (['p', 'r', 'o', 'g', 'h', 'j'].includes(k) && !e.shiftKey) e.preventDefault();   // browser shortcuts
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { flushTitle(); flush(); } });
  window.addEventListener('pagehide', () => { flushTitle(); flush(); });

  // ---------- the window: no Windows title bar, buttons in an island at the top right ----------
  function showDots(on) {
    document.body.classList.toggle('has-dots', !!on); $('titlebar').hidden = !on;
  }
  function showFilled(on) {
    const b = $('winZoom'), label = on ? 'Back to window size' : 'Fill the screen';
    b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.setAttribute('aria-label', label); b.title = label;
  }
  async function setupFrame() {
    if (api.mock) { if (/[?&]dots\b/.test(location.search)) showDots(true); return; }   // preview of the window buttons
    if (!api.window_frame) return;
    try { showDots(await api.window_frame()); } catch (e) { showDots(false); }
    try { showFilled(await api.window_maximized()); } catch (e) { /* the button still works */ }
  }
  async function saveAll() { await flushTitle(); await flush(); }
  async function toBackground() {           // Ctrl+W, Ctrl+Q: the window closes, NiSH Notes keeps running
    if (rec.mr) await stopMemo(false);
    await saveAll();
    if (api.mock) { toast('In the app, Ctrl+W closes the window and NiSH Notes keeps running in the tray.'); return; }
    api.window_hide();
  }
  async function zoom() {
    if (api.mock) { showFilled($('winZoom').getAttribute('aria-pressed') !== 'true'); return; }
    try { showFilled(await api.window_zoom()); } catch (e) { /* nothing to show */ }
  }
  $('winClose').addEventListener('click', async () => {
    if (api.mock) { toast('In the app, this closes the window.'); return; }
    if (rec.mr) await stopMemo(false);
    await saveAll(); api.window_close();
  });
  $('winMin').addEventListener('click', () => { if (api.mock) toast('In the app, this minimizes the window.'); else api.window_minimize(); });
  $('winZoom').addEventListener('click', zoom);
  let deskDown = 0;
  document.addEventListener('pointerdown', (e) => {          // the desk around the page moves the window
    if (e.button !== 0 || !document.body.classList.contains('has-dots')) return;
    if (e.target !== document.querySelector('.app')) return;
    e.preventDefault();
    const t = Date.now();
    if (t - deskDown < 450) { deskDown = 0; zoom(); return; }   // double-click: fill the screen
    deskDown = t;
    if (!api.mock) api.window_move();
  });

  // ---------- tools: almost hidden, they light up when the pointer comes near ----------
  const NEAR = 72;                                   // px around a group of tools
  const toolZones = () => [document.querySelector('.head-tools'), document.querySelector('.side-tools'), $('titlebar')];
  function lightTools(x, y) {
    for (const z of toolZones()) {
      if (!z || z.hidden) continue;
      const r = z.getBoundingClientRect();
      const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
      z.classList.toggle('near', dx * dx + dy * dy <= NEAR * NEAR);
    }
  }
  document.addEventListener('pointermove', (e) => lightTools(e.clientX, e.clientY), { passive: true });
  document.documentElement.addEventListener('pointerleave', () => toolZones().forEach((z) => z && z.classList.remove('near')));

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
    nb = info.notebook; version = info.version || ''; prefs = info.prefs || {};
    applyFont(info.prefs && info.prefs.font);
    setupFrame();
    if (prefs.side === 'hidden') document.body.classList.add('side-hidden');
    syncSideBtn();
    const last = info.prefs && info.prefs.lastPage;
    const first = nb.folders.find((f) => f.pages.length);
    if (last && findPage(last)) await openPage(last);
    else if (first) await openPage(first.pages[0].id);
    else { renderHead(); renderTree(); }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueChips);
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
      const key = (el, k, extra) => el.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra || {})));
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
      check('new page starts with a name line and the cursor in it', activeId && editor.querySelector('h1') && document.activeElement === editor && blockAt('H1'));
      await movePage(activeId, a, 0);
      const pid = activeId;
      editor.focus();
      editor.innerHTML = '<h1>Smoke page</h1><div>Hello from the smoke test</div><div>Second line</div>';
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      check('the first line names the page', findPage(pid).page.title === 'Smoke page' && tree.querySelector('[data-page="' + pid + '"] .t').textContent === 'Smoke page' && $('pageName').textContent === 'Smoke page');
      selectText(editor, 'Hello'); exec('bold');
      selectText(editor, 'Second line'); setBlock('h2');
      check('bold and heading', editor.querySelector('b') && editor.querySelector('h2'));
      $('formatBtn').click(); await sleep(50);
      check('Aa popover shows the current style', !fmt.hidden && fmt.querySelector('[data-block="h2"]').getAttribute('aria-current') === 'true');
      closeFormat();
      selectText(editor, 'Second line'); openFormat(true); await sleep(30);
      const kbOpen = fmt.contains(document.activeElement) && document.activeElement.dataset.block === 'h2';
      key(document.activeElement, 'ArrowDown'); const moved = document.activeElement.dataset.block === 'h3';
      document.activeElement.click(); await sleep(30);
      const applied = !!editor.querySelector('h3') && fmt.contains(document.activeElement);
      key(document.activeElement, 'Escape');
      check('Aa panel works from the keyboard', kbOpen && moved && applied && fmt.hidden && document.activeElement === editor);
      selectText(editor, 'Second line'); setBlock('h2');
      editor.insertAdjacentHTML('beforeend', '<div>Buy milk</div>');
      selectText(editor, 'Buy milk'); $('checkBtn').click();
      const li = editor.querySelector('ul.checklist > li');
      check('checklist', li && li.textContent === 'Buy milk');
      const lr = li.getBoundingClientRect();
      li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: lr.left - 10, clientY: lr.top + 10 }));
      check('ticking a checklist item', li.hasAttribute('data-checked'));
      check('a ticked item is announced as done', /Done/.test(getComputedStyle(li, '::before').content));
      margin.focus(); margin.innerHTML = '<div>Margin note</div>'; margin.dispatchEvent(new InputEvent('input', { bubbles: true }));
      check('margin column is separate from the page', margin.textContent === 'Margin note' && !editor.textContent.includes('Margin note'));
      editor.focus(); key(editor, 'Escape');
      check('Esc leaves the page', document.querySelector('.head-tools').contains(document.activeElement));
      editor.focus(); key(document.body, 'F6');
      check('F6 moves to the next area', document.activeElement === margin);
      $('scribbleBtn').click();
      check('scribble mode', ink.on && !$('inkBar').hidden && editor.contentEditable === 'false');
      pointer('pointerdown', 200, 60); pointer('pointermove', 240, 80); pointer('pointermove', 300, 70); pointer('pointerup', 300, 70);
      check('drawing a stroke', ink.strokes.length === 1 && inkSvg.querySelectorAll('path').length === 1);
      ink.tool = 'eraser'; pointer('pointerdown', 240, 80); pointer('pointerup', 240, 80);
      check('eraser removes the stroke', ink.strokes.length === 0);
      undo();
      check('undo brings the stroke back', ink.strokes.length === 1);
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
      editor.focus(); caretIn(editor, true);
      document.execCommand('insertText', false, ' undo-me');
      await sleep(800);
      setScribble(true);
      pointer('pointerdown', 400, 200); pointer('pointermove', 450, 220); pointer('pointerup', 450, 220);
      setScribble(false);
      const strokes = ink.strokes.length;
      undo();
      const a1 = ink.strokes.length === strokes - 1 && editor.textContent.includes('undo-me');
      undo();
      const a2 = !editor.textContent.includes('undo-me');
      redo(); redo();
      check('undo and redo walk through typing and drawing together', a1 && a2 && editor.textContent.includes('undo-me') && ink.strokes.length === strokes);
      editor.focus(); caretIn(editor, true);
      $('tableBtn').click();
      let t = editor.querySelector('table');
      await sleep(50);
      check('insert a table, with a handle in the margin', t && t.rows.length === 3 && t.rows[0].cells.length === 2 && blockAt('TD') === t.rows[0].cells[0] && $('chips').children.length === 1);
      document.execCommand('insertText', false, 'Day');
      onEditorKey(new KeyboardEvent('keydown', { key: 'Tab' })); document.execCommand('insertText', false, 'Task');
      check('Tab moves to the next cell', t.rows[0].cells[1].textContent === 'Task');
      caretIn(t.rows[2].cells[1], true); onEditorKey(new KeyboardEvent('keydown', { key: 'Tab' }));
      check('Tab in the last cell adds a row', t.rows.length === 4);
      tableOp('colRight'); const cols3 = t.rows[0].cells.length === 3; tableOp('delCol'); tableOp('delRow');
      check('add and delete rows and columns', cols3 && t.rows[0].cells.length === 2 && t.rows.length === 3);
      undo(); undo();
      t = editor.querySelector('table');
      check('table changes can be undone', t && t.rows.length === 4 && t.rows[0].cells.length === 3);
      redo(); redo();
      $('chips').children[0].click(); await sleep(30);
      check('the table handle opens the table menu', !menu.hidden && menu.textContent.includes('Add row below'));
      key(menu, 'Escape'); await sleep(30);
      check('Esc closes a menu and goes back to its button', menu.hidden && document.activeElement === $('chips').children[0]);
      await sleep(600); await save.chain;
      check('the table is saved', (await api.read_page(pid)).text.includes('<td>Day</td>'));
      editor.querySelector('h1').textContent = 'Renamed page';
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await sleep(1000); await flushTitle();
      const snap = await api.snapshot();
      check('renaming a page by changing its first line', snap.folders.some((f) => f.pages.some((p) => p.id === pid && p.title === 'Renamed page')) && $('pageName').textContent === 'Renamed page');
      await movePage(pid, b, 0);
      const fb = (await api.snapshot()).folders.find((f) => f.id === b);
      check('moving a page to another folder', fb && fb.pages[0] && fb.pages[0].id === pid);
      await moveFolder(b, 0);
      check('sorting folders', (await api.snapshot()).folders[0].id === b);
      const opener = tree.querySelector('[data-folder="' + b + '"] .row-more');
      folderMenu(b, 10, 10, opener); await sleep(20);
      const firstItem = document.activeElement; key(menu, 'ArrowDown');
      const arrows = document.activeElement !== firstItem && menu.contains(document.activeElement);
      Array.from(menu.querySelectorAll('.item')).find((x) => x.textContent.startsWith('Move down')).click(); await sleep(300);
      check('menus: arrow keys, and Move down without dragging', arrows && (await api.snapshot()).folders[1].id === b);
      check('folders and pages have drag handles', !!tree.querySelector('.folder-row .grip') && !!tree.querySelector('.page .grip'));
      toggleFolder(a); const closed = !findFolder(a).open; toggleFolder(a);
      check('opening and closing a folder', closed && findFolder(a).open);
      const tmp = await newPage(a, 'Delete me');
      await deletePage(tmp);
      const gone = !findPage(tmp) && (nb.trash || []).some((x) => x.title === 'Delete me');
      check('deleting asks nothing and shows Undo', gone && !$('undoToast').hidden && $('modal').hidden);
      await undoDelete();
      check('Undo puts the page back', !!findPage(tmp) && $('undoToast').hidden);
      await deletePage(tmp); hideUndo();
      $('binBtn').click(); await sleep(20);
      const put = $('binList').querySelector('[data-restore]');
      put.click(); await sleep(400);
      check('Recently deleted: Put back', !!findPage(tmp) && !(nb.trash || []).some((x) => x.title === 'Delete me'));
      $('binBtn').click();
      await deletePage(tmp); hideUndo();
      type($('search'), 'smoke test'); await sleep(600);
      const card = tree.querySelector('.result[data-page="' + pid + '"]');
      check('search shows a preview with the words marked', card && card.querySelector('mark') && /smoke test/i.test(card.querySelector('mark').textContent + card.textContent) && /match/.test($('searchCount').textContent));
      clearSearch();
      await setColor(a, COLORS[3]);
      check('folder colour', (await api.snapshot()).folders.find((f) => f.id === a).color === COLORS[3]);
      setSide(false); const hidden = !sideVisible(); setSide(true);
      check('hide and show the folders', hidden && sideVisible() && $('sideBtn').getAttribute('aria-pressed') === 'true');
      // 1.5: tidy editing
      const tp = await newPage(a, 'Tidy');
      editor.innerHTML = '<h1>Tidy</h1><h2>Sub</h2><div>body text</div>';
      editor.focus(); caretIn(editor.querySelector('div'), false);
      editor.querySelector('h2').insertAdjacentHTML('beforeend', '<span style="font-size: 21px;">x</span>');
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      check('joining a line onto a heading leaves no small text inside it', !editor.querySelector('span, [style]') && editor.querySelector('h2').textContent === 'Subx');
      editor.innerHTML = '<h1>Tidy</h1><table><tbody><tr><td>a</td><td>b</td></tr></tbody></table><div><br></div>';
      caretIn(editor.querySelector('td'), true);
      const dt = new DataTransfer(); dt.setData('text/html', '<table><tr><td>x</td><td>y</td></tr></table>'); dt.setData('text/plain', 'x\ty');
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      check('a table pasted into a table cell comes in as text', editor.querySelectorAll('table').length === 1 && editor.querySelector('td').textContent.includes('x\ty'));
      editor.innerHTML = '<h1>Tidy</h1><h2>Heading line</h2>';
      selectText(editor, 'Heading line'); setList('bullet');
      check('a list made from a heading is a list of body text', editor.querySelector('ul > li') && !editor.querySelector('h2') && !editor.querySelector('h2 ul, :scope > div > ul'));
      selectText(editor, 'Heading line'); setBlock('h2');
      check('a heading made from a list line leaves the list', editor.querySelector('h2') && !editor.querySelector('h2 ul, ul h2'));
      // voice memo in the margin (the recording itself needs a microphone, so the file is made here)
      const mid = 'mtest' + Date.now().toString(36);
      await api.save_memo(mid, 'audio/webm', btoa('not really audio'));
      insertMemo(mid, 75, 2);
      const memoEl = margin.querySelector('[data-memo]');
      check('a voice memo sits in the margin on its line', memoEl && memoEl.textContent === '1:15' && Math.round((memoEl.offsetTop - margin.offsetTop - 8) / 32) === 2 && memoEl.contentEditable === 'false');
      await sleep(600); await save.chain;
      const back = await api.read_page(tp);
      check('the voice memo is saved with the page, the sound next to it', back.margin.includes('data-memo="' + mid + '"') && (await api.read_memo(mid)).data === btoa('not really audio'));
      // reading a deleted page without putting it back
      await deletePage(tp); hideUndo();
      const tid = (nb.trash || []).find((x) => x.title === 'Tidy').id;
      await previewTrash(tid);
      check('Recently deleted: read a page without putting it back', !!preview && editor.contentEditable === 'false' && editor.textContent.includes('Heading line') && !$('previewBar').hidden && !findPage(tp) && $('empty').hidden);
      await closePreview();
      check('closing the preview goes back to a page', !preview && $('previewBar').hidden && editor.contentEditable === 'true' && !!activeId);
      await previewTrash(tid); $('previewRestore').click(); await sleep(400);
      check('Put back from the preview', !preview && !!activeId && firstLine() === 'Tidy');
      await deletePage(activeId); hideUndo();
      await openPage(pid);
      check('reopening a page shows everything', editor.textContent.includes('Hello from the smoke test') && margin.textContent === 'Margin note' &&
        inkSvg.querySelectorAll('path').length === 2 && !!editor.querySelector('table') && firstLine() === 'Renamed page');
    } catch (e) {
      steps.push({ name: 'self-test crashed: ' + errText(e) + ' ' + (e && e.stack ? e.stack.split('\n')[1] : ''), ok: false });
    }
    window.NN_TEST = { steps };
    return steps;
  }

  function setKeepRunning(on) { prefs.keepRunning = !!on; }
  window.NN = { ready: false, setKeepRunning, selfTest, newPage, newFolder, openPage, movePage, moveFolder, deletePage, sanitize, showDots, showFilled };
  start().catch((e) => toast('NiSH Notes could not start: ' + errText(e)));
})();
