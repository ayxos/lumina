const express = require('express');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const mime = require('mime-types');
const db = require('./db');
const {
  loadConfig,
  scanMedia,
  getScanStatus,
  generateThumbnail,
  buildMediaQuery,
  backupDatabase,
  IMAGE_EXT,
  THUMB_DIR,
} = require('./scanner');

const app = express();
const PORT = process.env.PORT || 3080;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function getConfigSafe() {
  try {
    return loadConfig();
  } catch (err) {
    return { mediaPaths: [], allowedExtensions: [], error: err.message };
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/settings', (_req, res) => {
  const config = getConfigSafe();
  res.json({
    mediaPaths: (config.mediaPaths || []).map((p) => ({ name: p.name, path: p.path })),
    scanIntervalMinutes: config.scanIntervalMinutes || 60,
    thumbnailSize: config.thumbnailSize || 320,
    allowedExtensions: config.allowedExtensions || [],
  });
});

app.get('/api/stats', (_req, res) => {
  const scan = getScanStatus();
  const byType = db.prepare('SELECT media_type, COUNT(*) AS count FROM media GROUP BY media_type').all();
  const byFolder = db.prepare('SELECT folder_source, COUNT(*) AS count FROM media GROUP BY folder_source').all();
  res.json({ ...scan, byType, byFolder });
});

app.post('/api/scan', (_req, res) => {
  const config = getConfigSafe();
  const result = scanMedia(config);
  res.json(result);
});

app.get('/api/formats', (_req, res) => {
  const rows = db.prepare('SELECT extension, COUNT(*) AS count FROM media GROUP BY extension ORDER BY count DESC').all();
  res.json(rows);
});

app.get('/api/folders', (_req, res) => {
  const rows = db.prepare('SELECT folder_source AS name, COUNT(*) AS count FROM media GROUP BY folder_source ORDER BY name').all();
  res.json(rows);
});

app.get('/api/years', (_req, res) => {
  const rows = db.prepare(`
    SELECT name_year AS year, COUNT(*) AS count
    FROM media
    WHERE name_year IS NOT NULL
    GROUP BY name_year
    ORDER BY name_year DESC
  `).all();
  res.json(rows);
});

app.get('/api/media', (req, res) => {
  const { countSql, dataSql, params } = buildMediaQuery(req.query);
  const total = db.prepare(countSql).get(params).total;
  const items = db.prepare(dataSql).all(params);
  res.json({ items, total, limit: params.limit, offset: params.offset });
});

app.get('/api/media/:id', (req, res) => {
  const row = db.prepare(`
    SELECT m.*, CASE WHEN f.media_path IS NOT NULL THEN 1 ELSE 0 END AS is_favorite
    FROM media m LEFT JOIN favorites f ON f.media_path = m.path
    WHERE m.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.get('/api/media/:id/file', (req, res) => {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row || !fs.existsSync(row.path)) return res.status(404).json({ error: 'Not found' });

  const stat = fs.statSync(row.path);
  const fileSize = stat.size;
  const type = mime.lookup(row.path) || 'application/octet-stream';

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.name)}"`);

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', fileSize);
    fs.createReadStream(row.path).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
    res.end();
    return;
  }

  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
    res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
    res.end();
    return;
  }

  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  res.setHeader('Content-Length', chunkSize);
  fs.createReadStream(row.path, { start, end }).pipe(res);
});

app.get('/api/media/:id/thumb', async (req, res) => {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const config = getConfigSafe();
  const size = config.thumbnailSize || 320;

  if (row.media_type === 'image' || row.media_type === 'video') {
    const thumb = await generateThumbnail(row.path, row.id, size, row.media_type);
    if (thumb && fs.existsSync(thumb)) {
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return fs.createReadStream(thumb).pipe(res);
    }
    if (row.media_type === 'image' && fs.existsSync(row.path)) {
      res.setHeader('Content-Type', mime.lookup(row.path) || 'image/jpeg');
      return fs.createReadStream(row.path).pipe(res);
    }
  }

  res.redirect(302, `/icons/${row.media_type}.svg`);
});

app.post('/api/favorites/:id', (req, res) => {
  const row = db.prepare('SELECT id, path FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const existing = db.prepare('SELECT media_path FROM favorites WHERE media_path = ?').get(row.path);
  if (existing) {
    db.prepare('DELETE FROM favorites WHERE media_path = ?').run(row.path);
    return res.json({ is_favorite: false });
  }
  db.prepare('INSERT INTO favorites (media_path) VALUES (?)').run(row.path);
  res.json({ is_favorite: true });
});

app.get('/api/favorites', (_req, res) => {
  const items = db.prepare(`
    SELECT m.*, 1 AS is_favorite
    FROM favorites f JOIN media m ON m.path = f.media_path
    ORDER BY f.created_at DESC
  `).all();
  res.json(items);
});

app.get('/api/albums', (_req, res) => {
  const albums = db.prepare(`
    SELECT a.*, COUNT(ai.media_path) AS item_count
    FROM albums a LEFT JOIN album_items ai ON ai.album_id = a.id
    GROUP BY a.id ORDER BY a.updated_at DESC
  `).all();
  res.json(albums);
});

app.post('/api/albums', (req, res) => {
  const { name, description = '' } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const result = db.prepare('INSERT INTO albums (name, description) VALUES (?, ?)').run(name.trim(), description.trim());
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(album);
});

app.get('/api/albums/:id', (req, res) => {
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(req.params.id);
  if (!album) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare(`
    SELECT m.*, CASE WHEN f.media_path IS NOT NULL THEN 1 ELSE 0 END AS is_favorite
    FROM album_items ai
    JOIN media m ON m.path = ai.media_path
    LEFT JOIN favorites f ON f.media_path = m.path
    WHERE ai.album_id = ?
    ORDER BY ai.sort_order, ai.added_at
  `).all(req.params.id);
  res.json({ ...album, items });
});

app.patch('/api/albums/:id', (req, res) => {
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(req.params.id);
  if (!album) return res.status(404).json({ error: 'Not found' });
  const name = req.body.name !== undefined ? req.body.name.trim() : album.name;
  const description = req.body.description !== undefined ? req.body.description.trim() : album.description;
  db.prepare('UPDATE albums SET name = ?, description = ?, updated_at = strftime(\'%s\', \'now\') WHERE id = ?').run(name, description, req.params.id);
  res.json(db.prepare('SELECT * FROM albums WHERE id = ?').get(req.params.id));
});

app.delete('/api/albums/:id', (req, res) => {
  const result = db.prepare('DELETE FROM albums WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.post('/api/albums/:id/items', (req, res) => {
  const album = db.prepare('SELECT id FROM albums WHERE id = ?').get(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album not found' });
  const ids = Array.isArray(req.body.mediaIds) ? req.body.mediaIds : [];
  if (!ids.length) return res.status(400).json({ error: 'mediaIds required' });
  const mediaRows = db.prepare(
    `SELECT id, path FROM media WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM album_items WHERE album_id = ?').get(req.params.id).m;
  const insert = db.prepare('INSERT OR IGNORE INTO album_items (album_id, media_path, sort_order) VALUES (?, ?, ?)');
  const tx = db.transaction((rows) => {
    rows.forEach((row, i) => insert.run(req.params.id, row.path, maxOrder + i + 1));
  });
  tx(mediaRows);
  db.prepare('UPDATE albums SET updated_at = strftime(\'%s\', \'now\') WHERE id = ?').run(req.params.id);
  res.json({ added: ids.length });
});

app.delete('/api/albums/:id/items/:mediaId', (req, res) => {
  const row = db.prepare('SELECT path FROM media WHERE id = ?').get(req.params.mediaId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM album_items WHERE album_id = ? AND media_path = ?').run(req.params.id, row.path);
  db.prepare('UPDATE albums SET updated_at = strftime(\'%s\', \'now\') WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/albums/:id/download', (req, res) => {
  const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(req.params.id);
  if (!album) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare(`
    SELECT m.path, m.name FROM album_items ai JOIN media m ON m.path = ai.media_path
    WHERE ai.album_id = ? ORDER BY ai.sort_order, ai.added_at
  `).all(req.params.id);
  if (!items.length) return res.status(400).json({ error: 'Album is empty' });

  const safeName = album.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  archive.pipe(res);

  const used = new Set();
  for (const item of items) {
    if (!fs.existsSync(item.path)) continue;
    let entryName = item.name;
    let n = 1;
    while (used.has(entryName)) {
      const ext = path.extname(item.name);
      const base = path.basename(item.name, ext);
      entryName = `${base}_${n++}${ext}`;
    }
    used.add(entryName);
    archive.file(item.path, { name: entryName });
  }
  archive.finalize();
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

app.listen(PORT, () => {
  console.log(`Lumina running on http://0.0.0.0:${PORT}`);
  try {
    backupDatabase('startup');
    const config = loadConfig();
    console.log(`Media sources: ${(config.mediaPaths || []).map((p) => p.name).join(', ') || 'none'}`);
    const result = scanMedia(config);
    if (result.status === 'skipped') {
      console.warn(`Initial scan skipped (${result.reason}) — library unchanged`);
    } else {
      console.log(`Initial scan: ${result.total} files indexed`);
    }
    const interval = (config.scanIntervalMinutes || 60) * 60 * 1000;
    setInterval(() => {
      console.log('Running scheduled scan...');
      const scanResult = scanMedia(loadConfig());
      if (scanResult.status === 'skipped') {
        console.warn(`Scheduled scan skipped (${scanResult.reason}) — library unchanged`);
      }
    }, interval);
  } catch (err) {
    console.error('Startup scan failed:', err.message);
  }
});
