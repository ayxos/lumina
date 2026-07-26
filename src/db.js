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
`);

const hasNameYear = db.prepare(
  "SELECT COUNT(*) AS c FROM pragma_table_info('media') WHERE name = 'name_year'"
).get().c;
if (!hasNameYear) {
  db.exec('ALTER TABLE media ADD COLUMN name_year INTEGER');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_media_name_year ON media(name_year)');

db.exec(`
  CREATE TABLE IF NOT EXISTS favorites (
    media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS album_items (
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (album_id, media_id)
  );
`);

module.exports = db;
