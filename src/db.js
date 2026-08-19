const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'lumina.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function columnExists(table, column) {
  return db.prepare(
    "SELECT COUNT(*) AS c FROM pragma_table_info(?) WHERE name = ?"
  ).get(table, column).c > 0;
}

function tableExists(table) {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(table);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    folder_source TEXT NOT NULL,
    extension TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    name_year INTEGER,
    indexed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_media_name ON media(name);
  CREATE INDEX IF NOT EXISTS idx_media_extension ON media(extension);
  CREATE INDEX IF NOT EXISTS idx_media_mtime ON media(mtime);
  CREATE INDEX IF NOT EXISTS idx_media_size ON media(size);
  CREATE INDEX IF NOT EXISTS idx_media_folder ON media(folder_source);
  CREATE INDEX IF NOT EXISTS idx_media_type ON media(media_type);
  CREATE INDEX IF NOT EXISTS idx_media_name_year ON media(name_year);

  CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );
`);

if (!tableExists('favorites')) {
  db.exec(`
    CREATE TABLE favorites (
      media_path TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
  `);
} else if (columnExists('favorites', 'media_id')) {
  db.exec(`
    CREATE TABLE favorites_new (
      media_path TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    INSERT OR IGNORE INTO favorites_new (media_path, created_at)
      SELECT m.path, f.created_at
      FROM favorites f
      INNER JOIN media m ON m.id = f.media_id;
    DROP TABLE favorites;
    ALTER TABLE favorites_new RENAME TO favorites;
  `);
}

if (!tableExists('album_items')) {
  db.exec(`
    CREATE TABLE album_items (
      album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      media_path TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (album_id, media_path)
    );
  `);
} else if (columnExists('album_items', 'media_id')) {
  db.exec(`
    CREATE TABLE album_items_new (
      album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      media_path TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (album_id, media_path)
    );
    INSERT OR IGNORE INTO album_items_new (album_id, media_path, sort_order, added_at)
      SELECT ai.album_id, m.path, ai.sort_order, ai.added_at
      FROM album_items ai
      INNER JOIN media m ON m.id = ai.media_id;
    DROP TABLE album_items;
    ALTER TABLE album_items_new RENAME TO album_items;
  `);
}

const hasNameYear = db.prepare(
  "SELECT COUNT(*) AS c FROM pragma_table_info('media') WHERE name = 'name_year'"
).get().c;
if (!hasNameYear) {
  db.exec('ALTER TABLE media ADD COLUMN name_year INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_media_name_year ON media(name_year)');
}

module.exports = db;
