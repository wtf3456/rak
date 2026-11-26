const { createClient } = require('@libsql/client');

// На Render: адрес и токен базы Turso. Локально без них используется файл data.db.
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:data.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const rows = (rs) => rs.rows.map((r) => ({ ...r }));
const q = async (sql, args = []) => rows(await db.execute({ sql, args }));
const one = async (sql, args = []) => (await q(sql, args))[0];
const txq = async (tx, sql, args = []) => rows(await tx.execute({ sql, args }));

// Транзакция: fn возвращает null при успехе или [код, сообщение] при отказе (ничего не записано)
async function inTx(fn) {
  const tx = await db.transaction('write');
  try {
    const r = await fn(tx);
    await tx.commit();
    return r;
  } catch (e) {
    try { await tx.rollback(); } catch { /* уже закрыта */ }
    throw e;
  } finally {
    tx.close();
  }
}

async function init() {
  await db.executeMultiple(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL, avatar TEXT,
  rating INTEGER NOT NULL DEFAULT 1000,
  wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, team_size INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','finished','cancelled')),
  winner TEXT CHECK (winner IN ('A','B')), scheduled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT
);
CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL REFERENCES matches(id), user_id TEXT NOT NULL REFERENCES users(id),
  side TEXT NOT NULL CHECK (side IN ('A','B')), country TEXT,
  rating_before INTEGER, rating_delta INTEGER,
  PRIMARY KEY (match_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_match_country ON match_players(match_id, country) WHERE country IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status, created_at);
CREATE INDEX IF NOT EXISTS idx_users_rating ON users(rating DESC);
`);
}

module.exports = { db, q, one, txq, inTx, init };
