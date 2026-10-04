const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

const state = {
  view: 'browse',
  items: [],
  favorites: [],
  albums: [],
  currentAlbum: null,
  selected: new Set(),
  offset: 0,
  limit: 60,
  total: 0,
  loading: false,
  lightboxIndex: -1,
  lightboxItems: [],
  searchTimer: null,
};

const els = {
  grid: $('#grid'),
  favGrid: $('#fav-grid'),
  albumGrid: $('#album-grid'),
  albumsList: $('#albums-list'),
  albumDetail: $('#album-detail'),
  empty: $('#empty-state'),
  loader: $('#loader'),
  stats: $('#stats-text'),
  selectionBar: $('#selection-bar'),
  selectionCount: $('#selection-count'),
  lightbox: $('#lightbox'),
  lbContent: $('#lb-content'),
  lbMeta: $('#lb-meta'),
  modal: $('#modal'),
  toast: $('#toast'),
};

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(els.toast._t);
  els.toast._t = setTimeout(() => { els.toast.hidden = true; }, 2800);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  if (res.headers.get('content-type')?.includes('application/json')) return res.json();
  return res;
}

function getFilters() {
  const sizeMin = $('#filter-size-min').value;
  const sizeMax = $('#filter-size-max').value;
  return {
    q: $('#search').value.trim(),
    folder: $('#filter-folder').value,
    mediaType: $('#filter-type').value,
    format: $('#filter-format').value,
    year: $('#filter-year').value,
    dateFrom: $('#filter-date-from').value,
    dateTo: $('#filter-date-to').value,
    sizeMin: sizeMin ? parseInt(sizeMin, 10) * 1024 : '',
    sizeMax: sizeMax ? parseInt(sizeMax, 10) * 1048576 : '',
    sort: $('#sort').value,
    favorite: state.view === 'favorites' ? 'true' : '',
  };
}

function buildQuery(params) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, v); });
  q.set('limit', state.limit);
  q.set('offset', state.offset);
  return q.toString();
}

function renderCard(item, opts = {}) {
  const { selectable = true, onClick } = opts;
  const card = document.createElement('div');
  card.className = 'card' + (state.selected.has(item.id) ? ' selected' : '');
  card.dataset.id = item.id;

  if (selectable) {
    const check = document.createElement('div');
    check.className = 'card-check';
    check.textContent = state.selected.has(item.id) ? '✓' : '';
    check.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelect(item.id);
    });
    card.appendChild(check);
  }

  const fav = document.createElement('button');
  fav.className = 'card-fav' + (item.is_favorite ? ' active' : '');
  fav.innerHTML = item.is_favorite ? '♥' : '♡';
  fav.title = 'Toggle favorite';
  fav.addEventListener('click', async (e) => {
    e.stopPropagation();
    await toggleFavorite(item.id);
  });
  card.appendChild(fav);

  const thumb = document.createElement('div');
  thumb.className = 'card-thumb' + (item.media_type === 'video' ? ' card-thumb-video' : '');
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.src = `/api/media/${item.id}/thumb`;
  img.alt = item.name;
  img.onerror = () => {
    img.src = `/icons/${item.media_type}.svg`;
    img.className = 'type-icon';
    thumb.querySelector('.play-badge')?.remove();
    thumb.classList.remove('card-thumb-video');
  };
  thumb.appendChild(img);
  if (item.media_type === 'video') {
    const badge = document.createElement('div');
    badge.className = 'play-badge';
    thumb.appendChild(badge);
  }
  card.appendChild(thumb);

  const info = document.createElement('div');
  info.className = 'card-info';
  info.innerHTML = `
    <div class="card-name" title="${esc(item.name)}">${esc(item.name)}</div>
    <div class="card-meta">
      <span>${item.extension.toUpperCase()}</span>
      <span>${fmtSize(item.size)}</span>
      <span>${fmtDate(item.mtime)}</span>
    </div>`;
  card.appendChild(info);

  card.addEventListener('click', () => {
    if (onClick) onClick(item);
    else openLightbox(item);
  });

  return card;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  updateSelectionUI();
  refreshCardSelection();
}

function refreshCardSelection() {
  $$('.card').forEach((c) => {
    const id = parseInt(c.dataset.id, 10);
    c.classList.toggle('selected', state.selected.has(id));
    const check = c.querySelector('.card-check');
    if (check) check.textContent = state.selected.has(id) ? '✓' : '';
  });
}

function clearSelection() {
  state.selected.clear();
  updateSelectionUI();
  refreshCardSelection();
}

function inAlbumDetail() {
  return state.view === 'albums' && state.currentAlbum;
}

function updateSelectionUI() {
  const n = state.selected.size;
  const albumMode = !!inAlbumDetail();
  els.selectionBar.hidden = n === 0 && !albumMode;
  els.selectionCount.textContent = n ? `${n} selected` : '';
  els.selectionCount.hidden = n === 0;

  $('#add-to-album-btn').hidden = albumMode || n === 0;
  $('#copy-to-album-btn').hidden = !albumMode || n === 0;
  $('#move-to-album-btn').hidden = !albumMode || n === 0;
  $('#remove-from-album-btn').hidden = !albumMode || n === 0;
  $('#download-selected-btn').hidden = n === 0;
  $('#select-all-btn').hidden = !albumMode;
  $('#clear-selection').hidden = n === 0;

  if (albumMode && n === 0) {
    els.selectionBar.hidden = false;
  }
}

async function loadMedia(append = false) {
  if (state.loading) return;
  state.loading = true;
  els.loader.hidden = !append;
  if (!append) { state.offset = 0; els.grid.innerHTML = ''; }

  try {
    const filters = getFilters();
    const data = await api(`/api/media?${buildQuery(filters)}`);
    state.total = data.total;
    if (append) state.items.push(...data.items);
    else state.items = data.items;

    data.items.forEach((item) => els.grid.appendChild(renderCard(item)));
    els.empty.hidden = state.items.length > 0;
    els.stats.textContent = `${state.total.toLocaleString()} files`;
  } catch (err) {
    toast(err.message);
  } finally {
    state.loading = false;
    els.loader.hidden = true;
  }
}

async function loadFavorites() {
  els.favGrid.innerHTML = '';
  try {
    const data = await api('/api/media?favorite=true&limit=200');
    data.items.forEach((item) => {
      item.is_favorite = 1;
      els.favGrid.appendChild(renderCard(item, { selectable: false }));
    });
  } catch (err) {
    toast(err.message);
  }
}

async function loadAlbums() {
  try {
    state.albums = await api('/api/albums');
    renderAlbumsList();
  } catch (err) {
    toast(err.message);
  }
}

function renderAlbumsList() {
  els.albumsList.innerHTML = '';
  if (!state.albums.length) {
    els.albumsList.innerHTML = '<div class="empty"><p>No albums yet</p><span>Create one to collect files</span></div>';
    return;
  }
  state.albums.forEach((album) => {
    const card = document.createElement('div');
    card.className = 'album-card';
    card.innerHTML = `
      <h3>${esc(album.name)}</h3>
      <p>${album.item_count} item${album.item_count !== 1 ? 's' : ''}${album.description ? ' · ' + esc(album.description) : ''}</p>
      <div class="album-actions">
        <button class="btn sm open-album">Open</button>
        <button class="btn ghost sm delete-album">Delete</button>
      </div>`;
    card.querySelector('.open-album').addEventListener('click', (e) => {
      e.stopPropagation();
      openAlbum(album.id);
    });
    card.querySelector('.delete-album').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete album "${album.name}"?`)) {
        await api(`/api/albums/${album.id}`, { method: 'DELETE' });
        toast('Album deleted');
        loadAlbums();
      }
    });
    card.addEventListener('click', () => openAlbum(album.id));
    els.albumsList.appendChild(card);
  });
}

async function openAlbum(id) {
  try {
    const album = await api(`/api/albums/${id}`);
    state.currentAlbum = album;
    clearSelection();
    $('#album-detail-name').textContent = album.name;
    $('#album-detail-count').textContent = `${album.items.length} items`;
    els.albumsList.hidden = true;
    $('.albums-header').hidden = true;
    els.albumDetail.hidden = false;
    els.albumGrid.innerHTML = '';
    album.items.forEach((item) => {
      els.albumGrid.appendChild(renderCard(item, {
        selectable: true,
        onClick: (it) => {
          state.lightboxItems = album.items;
          state.lightboxIndex = album.items.findIndex((x) => x.id === it.id);
          showLightbox(it);
        },
      }));
    });
    updateSelectionUI();
  } catch (err) {
    toast(err.message);
  }
}

async function toggleFavorite(id) {
  try {
    const res = await api(`/api/favorites/${id}`, { method: 'POST' });
    const updateItem = (items) => {
      const item = items.find((i) => i.id === id);
      if (item) item.is_favorite = res.is_favorite ? 1 : 0;
    };
    updateItem(state.items);
    $$('.card').forEach((c) => {
      if (parseInt(c.dataset.id, 10) === id) {
        const btn = c.querySelector('.card-fav');
        btn.classList.toggle('active', res.is_favorite);
        btn.innerHTML = res.is_favorite ? '♥' : '♡';
      }
    });
    if (state.view === 'favorites') loadFavorites();
    toast(res.is_favorite ? 'Added to favorites' : 'Removed from favorites');
  } catch (err) {
    toast(err.message);
  }
}

function openLightbox(item) {
  state.lightboxItems = state.view === 'albums' && state.currentAlbum
    ? state.currentAlbum.items
    : state.items;
  state.lightboxIndex = state.lightboxItems.findIndex((x) => x.id === item.id);
  showLightbox(item);
}

function showLightbox(item) {
  els.lightbox.hidden = false;
  document.body.style.overflow = 'hidden';
  renderLightboxContent(item);
}

function renderLightboxContent(item) {
  els.lbContent.innerHTML = '';
  const url = `/api/media/${item.id}/file`;

  if (item.media_type === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = item.name;
    els.lbContent.appendChild(img);
  } else if (item.media_type === 'video') {
    const vid = document.createElement('video');
    vid.src = url;
    vid.controls = true;
    vid.playsInline = true;
    vid.preload = 'auto';
    els.lbContent.appendChild(vid);
    vid.play().catch(() => {});
  } else if (item.media_type === 'audio') {
    const aud = document.createElement('audio');
    aud.src = url;
    aud.controls = true;
    aud.preload = 'auto';
    els.lbContent.appendChild(aud);
    aud.play().catch(() => {});
  } else {
    els.lbContent.innerHTML = `<p style="color:white">Preview not available</p>`;
  }

  els.lbMeta.textContent = `${item.name} · ${item.extension.toUpperCase()} · ${fmtSize(item.size)} · ${fmtDate(item.mtime)} · ${item.folder_source}`;

  const favBtn = $('#lb-fav');
  favBtn.textContent = item.is_favorite ? '♥ Favorited' : '♡ Favorite';
  favBtn.onclick = async () => {
    await toggleFavorite(item.id);
    item.is_favorite = item.is_favorite ? 0 : 1;
    favBtn.textContent = item.is_favorite ? '♥ Favorited' : '♡ Favorite';
  };

  $('#lb-download').href = url;
  $('#lb-download').download = item.name;
  $('#lb-album').onclick = () => showAddToAlbumModal([item.id]);

  $('#lb-prev').style.visibility = state.lightboxIndex > 0 ? 'visible' : 'hidden';
  $('#lb-next').style.visibility = state.lightboxIndex < state.lightboxItems.length - 1 ? 'visible' : 'hidden';
}

function closeLightbox() {
  els.lightbox.hidden = true;
  document.body.style.overflow = '';
  els.lbContent.innerHTML = '';
}

function showModal(title, bodyHtml, onConfirm) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  els.modal.hidden = false;
  const confirm = $('#modal-confirm');
  const cancel = $('#modal-cancel');
  confirm.hidden = false;
  const cleanup = () => { els.modal.hidden = true; confirm.onclick = null; confirm.hidden = false; };
  cancel.onclick = cleanup;
  $('#modal-backdrop').onclick = cleanup;
  confirm.onclick = async () => {
    await onConfirm();
    cleanup();
  };
}

function toastAlbumAddResult(res, mode = 'add') {
  const added = res?.added ?? 0;
  const skipped = res?.skipped ?? 0;
  if (added === 0 && skipped > 0) {
    toast(skipped === 1 ? 'Already in album' : `All ${skipped} already in album`);
    return;
  }
  const verb = mode === 'copy' ? 'Copied' : mode === 'move' ? 'Moved' : 'Added';
  if (skipped > 0) toast(`${verb} ${added}, ${skipped} already in album`);
  else toast(`${verb} ${added} file${added !== 1 ? 's' : ''}`);
}

async function refreshAfterAlbumChange(targetAlbumId) {
  await loadAlbums();
  if (state.view === 'albums' && state.currentAlbum && String(state.currentAlbum.id) === String(targetAlbumId)) {
    await openAlbum(state.currentAlbum.id);
  }
}

function showNewAlbumModal(mediaIds = []) {
  showModal('New album', '<input id="album-name-input" placeholder="Album name" autofocus>', async () => {
    const name = $('#album-name-input').value.trim();
    if (!name) return toast('Name required');
    const album = await api('/api/albums', { method: 'POST', body: { name } });
    if (mediaIds.length) {
      const res = await api(`/api/albums/${album.id}/items`, { method: 'POST', body: { mediaIds } });
      toastAlbumAddResult(res, 'add');
    } else {
      toast(`Album "${name}" created`);
    }
    clearSelection();
    await loadAlbums();
    if (state.view !== 'albums') switchView('albums');
  });
  setTimeout(() => $('#album-name-input')?.focus(), 50);
}

async function showAlbumPickerModal(mediaIds, { mode = 'add', excludeAlbumId = null } = {}) {
  const albums = state.albums.filter((a) => String(a.id) !== String(excludeAlbumId));
  if (!albums.length) {
    showModal('New album', '<input id="album-name-input" placeholder="Album name" autofocus>', async () => {
      const name = $('#album-name-input').value.trim();
      if (!name) return toast('Name required');
      const album = await api('/api/albums', { method: 'POST', body: { name } });
      const res = await api(`/api/albums/${album.id}/items`, { method: 'POST', body: { mediaIds } });
      if (mode === 'move' && state.currentAlbum) {
        await api(`/api/albums/${state.currentAlbum.id}/items/remove`, {
          method: 'POST',
          body: { mediaIds },
        });
        toastAlbumAddResult({ ...res, added: res.added }, 'move');
        clearSelection();
        openAlbum(state.currentAlbum.id);
      } else {
        toastAlbumAddResult(res, mode === 'copy' ? 'copy' : 'add');
        clearSelection();
        await refreshAfterAlbumChange(album.id);
      }
    });
    setTimeout(() => $('#album-name-input')?.focus(), 50);
    return;
  }
  const titles = { add: 'Add to album', copy: 'Copy to album', move: 'Move to album' };
  const items = albums.map((a) =>
    `<div class="album-picker-item" data-id="${a.id}">${esc(a.name)} (${a.item_count})</div>`
  ).join('');
  const confirmBtn = $('#modal-confirm');
  confirmBtn.hidden = true;
  showModal(titles[mode] || titles.add, `<div class="album-picker">${items}</div>`, async () => {});
  $$('.album-picker-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const albumId = el.dataset.id;
      try {
        const res = await api(`/api/albums/${albumId}/items`, { method: 'POST', body: { mediaIds } });
        if (mode === 'move' && state.currentAlbum) {
          await api(`/api/albums/${state.currentAlbum.id}/items/remove`, {
            method: 'POST',
            body: { mediaIds },
          });
          toastAlbumAddResult(res, 'move');
          clearSelection();
          openAlbum(state.currentAlbum.id);
        } else {
          toastAlbumAddResult(res, mode === 'copy' ? 'copy' : 'add');
          clearSelection();
          await refreshAfterAlbumChange(albumId);
        }
        els.modal.hidden = true;
        confirmBtn.hidden = false;
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

async function showAddToAlbumModal(mediaIds) {
  if (!state.albums.length) await loadAlbums();
  if (!state.albums.length) {
    showNewAlbumModal(mediaIds);
    return;
  }
  showAlbumPickerModal(mediaIds, { mode: 'add' });
}

async function downloadSelected(mediaIds) {
  try {
    const res = await fetch('/api/media/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaIds }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'selection.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`Downloading ${mediaIds.length} file(s)`);
  } catch (err) {
    toast(err.message);
  }
}

async function removeSelectedFromAlbum(mediaIds) {
  if (!state.currentAlbum) return;
  if (!confirm(`Remove ${mediaIds.length} item(s) from this album?`)) return;
  try {
    await api(`/api/albums/${state.currentAlbum.id}/items/remove`, {
      method: 'POST',
      body: { mediaIds },
    });
    toast(`Removed ${mediaIds.length} item(s)`);
    clearSelection();
    openAlbum(state.currentAlbum.id);
  } catch (err) {
    toast(err.message);
  }
}

function selectAllInAlbum() {
  if (!state.currentAlbum) return;
  state.currentAlbum.items.forEach((item) => state.selected.add(item.id));
  updateSelectionUI();
  refreshCardSelection();
}

function countActiveFilters() {
  let n = 0;
  if ($('#filter-folder').value) n++;
  if ($('#filter-type').value) n++;
  if ($('#filter-format').value) n++;
  if ($('#filter-year').value) n++;
  if ($('#filter-date-from').value) n++;
  if ($('#filter-date-to').value) n++;
  if ($('#filter-size-min').value) n++;
  if ($('#filter-size-max').value) n++;
  return n;
}

function updateFilterBadge() {
  const n = countActiveFilters();
  const badge = $('#filter-badge');
  if (!badge) return;
  badge.hidden = n === 0;
  badge.textContent = n;
}

function openFilters() {
  $('#filters-backdrop').hidden = false;
  $('#filters-panel').classList.add('open');
  document.body.classList.add('filters-open');
}

function closeFilters() {
  $('#filters-panel').classList.remove('open');
  $('#filters-backdrop').hidden = true;
  document.body.classList.remove('filters-open');
}

function switchView(view) {
  state.view = view;
  state.currentAlbum = null;
  clearSelection();
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  $$('.view').forEach((v) => v.classList.remove('active'));
  $(`#view-${view}`).classList.add('active');
  const isBrowse = view === 'browse';
  $('#filters-panel').classList.toggle('browse-only-hidden', !isBrowse);
  $('#filter-toggle').hidden = !isBrowse;
  if (!isBrowse) closeFilters();

  if (view === 'browse') loadMedia();
  else if (view === 'favorites') loadFavorites();
  else if (view === 'albums') {
    els.albumDetail.hidden = true;
    els.albumsList.hidden = false;
    $('.albums-header').hidden = false;
    loadAlbums();
  }
}

async function loadFilterOptions() {
  try {
    const [formats, folders, years] = await Promise.all([
      api('/api/formats'),
      api('/api/folders'),
      api('/api/years'),
    ]);
    const fmtSel = $('#filter-format');
    formats.forEach((f) => {
      const o = document.createElement('option');
      o.value = f.extension;
      o.textContent = `${f.extension.toUpperCase()} (${f.count})`;
      fmtSel.appendChild(o);
    });
    const folderSel = $('#filter-folder');
    folders.forEach((f) => {
      const o = document.createElement('option');
      o.value = f.name;
      o.textContent = `${f.name} (${f.count})`;
      folderSel.appendChild(o);
    });
    const yearSel = $('#filter-year');
    years.forEach((y) => {
      const o = document.createElement('option');
      o.value = y.year;
      o.textContent = `${y.year} (${y.count})`;
      yearSel.appendChild(o);
    });
  } catch { /* ignore on first load */ }
}

function setupEvents() {
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  $('#search').addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => loadMedia(), 300);
  });

  ['filter-folder', 'filter-type', 'filter-format', 'filter-year', 'filter-date-from', 'filter-date-to', 'filter-size-min', 'filter-size-max', 'sort'].forEach((id) => {
    $(`#${id}`).addEventListener('change', () => {
      updateFilterBadge();
      loadMedia();
    });
  });

  $('#filter-toggle').addEventListener('click', openFilters);
  $('#filters-close').addEventListener('click', closeFilters);
  $('#filters-backdrop').addEventListener('click', closeFilters);

  $('#clear-filters').addEventListener('click', () => {
    $('#search').value = '';
    $('#filter-folder').value = '';
    $('#filter-type').value = '';
    $('#filter-format').value = '';
    $('#filter-year').value = '';
    $('#filter-date-from').value = '';
    $('#filter-date-to').value = '';
    $('#filter-size-min').value = '';
    $('#filter-size-max').value = '';
    updateFilterBadge();
    loadMedia();
  });

  $('#rescan-btn').addEventListener('click', async () => {
    toast('Scanning…');
    const res = await api('/api/scan', { method: 'POST' });
    toast(`Scan done: ${res.total} files`);
    loadMedia();
    loadFilterOptions();
  });

  $('#new-album-btn').addEventListener('click', () => showNewAlbumModal());

  $('#add-to-album-btn').addEventListener('click', () => {
    if (state.selected.size) showAddToAlbumModal([...state.selected]);
  });

  $('#copy-to-album-btn').addEventListener('click', async () => {
    if (!state.selected.size || !state.currentAlbum) return;
    if (!state.albums.length) await loadAlbums();
    showAlbumPickerModal([...state.selected], {
      mode: 'copy',
      excludeAlbumId: state.currentAlbum.id,
    });
  });

  $('#move-to-album-btn').addEventListener('click', async () => {
    if (!state.selected.size || !state.currentAlbum) return;
    if (!state.albums.length) await loadAlbums();
    showAlbumPickerModal([...state.selected], {
      mode: 'move',
      excludeAlbumId: state.currentAlbum.id,
    });
  });

  $('#remove-from-album-btn').addEventListener('click', () => {
    if (state.selected.size) removeSelectedFromAlbum([...state.selected]);
  });

  $('#download-selected-btn').addEventListener('click', () => {
    if (state.selected.size) downloadSelected([...state.selected]);
  });

  $('#select-all-btn').addEventListener('click', selectAllInAlbum);

  $('#clear-selection').addEventListener('click', clearSelection);

  $('#back-albums').addEventListener('click', () => {
    els.albumDetail.hidden = true;
    els.albumsList.hidden = false;
    $('.albums-header').hidden = false;
    state.currentAlbum = null;
    clearSelection();
  });

  $('#download-album-btn').addEventListener('click', () => {
    if (state.currentAlbum) {
      window.location.href = `/api/albums/${state.currentAlbum.id}/download`;
    }
  });

  $('#lb-close').addEventListener('click', closeLightbox);
  els.lightbox.addEventListener('click', (e) => { if (e.target === els.lightbox) closeLightbox(); });

  $('#lb-prev').addEventListener('click', () => {
    if (state.lightboxIndex > 0) {
      state.lightboxIndex--;
      showLightbox(state.lightboxItems[state.lightboxIndex]);
    }
  });

  $('#lb-next').addEventListener('click', () => {
    if (state.lightboxIndex < state.lightboxItems.length - 1) {
      state.lightboxIndex++;
      showLightbox(state.lightboxItems[state.lightboxIndex]);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (els.lightbox.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') $('#lb-prev').click();
    if (e.key === 'ArrowRight') $('#lb-next').click();
  });

  window.addEventListener('scroll', () => {
    if (state.view !== 'browse' || state.loading) return;
    if (state.items.length >= state.total) return;
    const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
    if (scrollTop + clientHeight >= scrollHeight - 400) {
      state.offset += state.limit;
      loadMedia(true);
    }
  });
}

async function init() {
  setupEvents();
  await loadFilterOptions();
  await loadMedia();
}

init();
