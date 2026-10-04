const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const sharp = require('sharp');
const db = require('./db');

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'lumina.db');
const THUMB_DIR = path.join(DATA_DIR, 'thumbnails');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_DB_BACKUPS = 5;

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'heif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v']);
const AUDIO_EXT = new Set(['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac']);

let scanning = false;
let lastScan = null;

function getMediaType(ext) {
  const e = ext.toLowerCase();
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  return 'other';
}

function extractNameYear(filename) {
  const base = path.basename(filename, path.extname(filename));
  const match = base.match(/^(\d{4})/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  return year >= 1970 && year <= 2100 ? year : null;
}

function loadConfig() {
  const configPath = process.env.CONFIG_PATH || path.join(__dirname, '..', 'config', 'settings.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

function mediaPathReady(dir) {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).some((name) => !name.startsWith('.'));
  } catch {
    return false;
  }
}

function waitForMediaPaths(config) {
  const sources = config.mediaPaths || [];
  if (!sources.length) return;

  const maxSec = parseInt(process.env.MEDIA_MOUNT_WAIT_SEC || '120', 10);
  const deadline = Date.now() + maxSec * 1000;

  while (Date.now() < deadline) {
    const pending = sources.filter((src) => !mediaPathReady(src.path));
    if (!pending.length) {
      console.log('Media mounts ready');
      return;
    }
    console.warn(
      `Waiting for media mounts (${pending.map((p) => p.path).join(', ')})…`
    );
    execFileSync('sleep', ['2']);
  }

  console.warn(`Media mounts not ready after ${maxSec}s — starting anyway`);
}

function walkDir(dir, allowed, results = []) {
  if (!fs.existsSync(dir)) return results;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) walkDir(full, allowed, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (allowed.has(ext)) {
        try {
          const stat = fs.statSync(full);
          results.push({ path: full, name: entry.name, ext, size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) });
        } catch { /* skip unreadable */ }
      }
    }
  }
  return results;
}

async function generateVideoThumbnail(filePath, mediaId, size) {
  if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
  const thumbPath = path.join(THUMB_DIR, `${mediaId}.webp`);
  if (fs.existsSync(thumbPath)) return thumbPath;

  const tmpFrame = path.join(THUMB_DIR, `${mediaId}.frame.jpg`);
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-ss', '1',
      '-i', filePath,
      '-frames:v', '1',
      '-vf', `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`,
      '-q:v', '3',
      '-y', tmpFrame,
    ], { timeout: 60000 });

    await sharp(tmpFrame).webp({ quality: 80 }).toFile(thumbPath);
    return thumbPath;
  } catch {
    try {
      await execFileAsync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-ss', '0',
        '-i', filePath,
        '-frames:v', '1',
        '-vf', `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`,
        '-q:v', '3',
        '-y', tmpFrame,
      ], { timeout: 60000 });
      await sharp(tmpFrame).webp({ quality: 80 }).toFile(thumbPath);
      return thumbPath;
    } catch {
      return null;
    }
  } finally {
    if (fs.existsSync(tmpFrame)) fs.unlinkSync(tmpFrame);
  }
}

async function generateThumbnail(filePath, mediaId, size, mediaType) {
  if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
  const thumbPath = path.join(THUMB_DIR, `${mediaId}.webp`);
  if (fs.existsSync(thumbPath)) return thumbPath;
  const ext = path.extname(filePath).slice(1).toLowerCase();

  if (mediaType === 'video' || VIDEO_EXT.has(ext)) {
    return generateVideoThumbnail(filePath, mediaId, size);
  }
  if (!IMAGE_EXT.has(ext)) return null;

  try {
    await sharp(filePath)
      .rotate()
      .resize(size, size, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(thumbPath);
    return thumbPath;
  } catch {
    return null;
  }
}

function backupDatabase(reason) {
  if (!fs.existsSync(DB_PATH)) return;
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // Flush WAL first — copying the main file alone drops recent albums/favorites.
  db.flush();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `lumina-${reason}-${stamp}.db`);
  fs.copyFileSync(DB_PATH, backupPath);
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter((name) => name.endsWith('.db'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of backups.slice(MAX_DB_BACKUPS)) {
    fs.unlinkSync(path.join(BACKUP_DIR, old.name));
  }
}

function scanMedia(config) {
  if (scanning) return { status: 'already_running' };
  scanning = true;
  const existingCount = db.prepare('SELECT COUNT(*) AS c FROM media').get().c;
  const allowed = new Set((config.allowedExtensions || []).map((e) => e.toLowerCase()));
  const foundPaths = new Set();
  const insert = db.prepare(`
    INSERT INTO media (path, name, folder_source, extension, media_type, size, mtime, name_year)
    VALUES (@path, @name, @folder_source, @extension, @media_type, @size, @mtime, @name_year)
    ON CONFLICT(path) DO UPDATE SET
      name = excluded.name,
      size = excluded.size,
      mtime = excluded.mtime,
      name_year = excluded.name_year,
      indexed_at = strftime('%s', 'now')
  `);
  const tx = db.transaction((items) => {
    for (const item of items) insert.run(item);
  });

  let total = 0;
  for (const source of config.mediaPaths || []) {
    const files = walkDir(source.path, allowed);
    const batch = files.map((f) => {
      foundPaths.add(f.path);
      return {
        path: f.path,
        name: f.name,
        folder_source: source.name,
        extension: f.ext,
        media_type: getMediaType(f.ext),
        size: f.size,
        mtime: f.mtime,
        name_year: extractNameYear(f.name),
      };
    });
    tx(batch);
    total += batch.length;
  }

  if (total === 0 && existingCount > 0) {
    scanning = false;
    console.warn(`Scan skipped: found 0 files but database has ${existingCount} — check media mount`);
    return {
      status: 'skipped',
      reason: 'empty_scan_with_existing_media',
      total: existingCount,
      removed: 0,
      scannedAt: lastScan,
    };
  }

  const existing = db.prepare('SELECT id, path FROM media').all();
  const staleIds = existing.filter((r) => !foundPaths.has(r.path)).map((r) => r.id);
  if (staleIds.length && existingCount > 0) {
    const removeRatio = staleIds.length / existingCount;
    if (removeRatio > 0.5 && existingCount >= 10) {
      scanning = false;
      console.warn(
        `Scan skipped: would remove ${staleIds.length}/${existingCount} files — check media mount`
      );
      return {
        status: 'skipped',
        reason: 'suspicious_mass_removal',
        total: existingCount,
        removed: 0,
        scannedAt: lastScan,
      };
    }
    backupDatabase('pre-removal');
    const remove = db.prepare('DELETE FROM media WHERE id = ?');
    const removeTx = db.transaction((ids) => {
      for (const id of ids) remove.run(id);
    });
    removeTx(staleIds);
  }

  lastScan = new Date().toISOString();
  scanning = false;
  db.flush();
  return { status: 'done', total, removed: staleIds.length, scannedAt: lastScan };
}

function getScanStatus() {
  return { scanning, lastScan, count: db.prepare('SELECT COUNT(*) AS c FROM media').get().c };
}

function buildMediaQuery(filters) {
  const clauses = [];
  const params = {};

  if (filters.q) {
    clauses.push('m.name LIKE @q');
    params.q = `%${filters.q}%`;
  }
  if (filters.format) {
    clauses.push('m.extension = @format');
    params.format = filters.format.toLowerCase();
  }
  if (filters.mediaType) {
    clauses.push('m.media_type = @mediaType');
    params.mediaType = filters.mediaType;
  }
  if (filters.folder) {
    clauses.push('m.folder_source = @folder');
    params.folder = filters.folder;
  }
  if (filters.year) {
    clauses.push('m.name_year = @year');
    params.year = parseInt(filters.year, 10);
  }
  if (filters.dateFrom) {
    clauses.push('m.mtime >= @dateFrom');
    params.dateFrom = Math.floor(new Date(filters.dateFrom).getTime() / 1000);
  }
  if (filters.dateTo) {
    clauses.push('m.mtime <= @dateTo');
    params.dateTo = Math.floor(new Date(filters.dateTo + 'T23:59:59').getTime() / 1000);
  }
  if (filters.sizeMin) {
    clauses.push('m.size >= @sizeMin');
    params.sizeMin = parseInt(filters.sizeMin, 10);
  }
  if (filters.sizeMax) {
    clauses.push('m.size <= @sizeMax');
    params.sizeMax = parseInt(filters.sizeMax, 10);
  }
  if (filters.favorite === 'true' || filters.favorite === '1') {
    clauses.push('f.media_path IS NOT NULL');
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sortMap = {
    name: 'm.name ASC',
    name_desc: 'm.name DESC',
    date: 'm.mtime DESC',
    date_asc: 'm.mtime ASC',
    size: 'm.size DESC',
    size_asc: 'm.size ASC',
  };
  const order = sortMap[filters.sort] || 'm.mtime DESC';
  const limit = Math.min(parseInt(filters.limit, 10) || 60, 200);
  const offset = parseInt(filters.offset, 10) || 0;

  params.limit = limit;
  params.offset = offset;

  const from = filters.favorite === 'true' || filters.favorite === '1'
    ? 'FROM media m INNER JOIN favorites f ON f.media_path = m.path'
    : 'FROM media m LEFT JOIN favorites f ON f.media_path = m.path';

  const countSql = `SELECT COUNT(*) AS total ${from} ${where}`;
  const dataSql = `
    SELECT m.*, CASE WHEN f.media_path IS NOT NULL THEN 1 ELSE 0 END AS is_favorite
    ${from} ${where}
    ORDER BY ${order}
    LIMIT @limit OFFSET @offset
  `;

  return { countSql, dataSql, params };
}

module.exports = {
  loadConfig,
  waitForMediaPaths,
  scanMedia,
  getScanStatus,
  generateThumbnail,
  buildMediaQuery,
  extractNameYear,
  getMediaType,
  backupDatabase,
  IMAGE_EXT,
  THUMB_DIR,
};
