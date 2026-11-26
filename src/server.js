require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { q, one, txq, inTx, init, db } = require('./db');
const { computeDeltas } = require('./rating');

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  JWT_SECRET,
  ADMIN_IDS = '',
  FRONTEND_URL = '/',
  PORT = 3000,
  NODE_ENV,
} = process.env;

const configured = Boolean(JWT_SECRET && DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_REDIRECT_URI);
if (!configured) console.warn('Не заданы переменные окружения (JWT_SECRET, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI): вход через Discord отключён');

const isProd = NODE_ENV === 'production';
const admins = new Set(ADMIN_IDS.split(',').map((s) => s.trim()).filter(Boolean));
const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: isProd };

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/auth', (_req, res, next) =>
  configured ? next() : res.status(503).send('Сервер не настроен: задайте переменные окружения'));

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (res, code, msg) => res.status(code).json({ error: msg });

app.use(wrap(async (req, _res, next) => {
  const token = req.cookies.token;
  if (token && JWT_SECRET) {
    try {
      const { sub } = jwt.verify(token, JWT_SECRET);
      req.user = await one('SELECT * FROM users WHERE id = ?', [sub]);
      if (req.user) req.user.isAdmin = admins.has(req.user.id);
    } catch { /* невалидный токен или ошибка базы — считаем гостем */ }
  }
  next();
}));

const requireAuth = (req, res, next) =>
  req.user ? next() : fail(res, 401, 'Нужно войти через Discord');

async function getMatch(id) {
  const match = await one(`
    SELECT m.*, h.username AS host_name
    FROM matches m JOIN users h ON h.id = m.host_id WHERE m.id = ?`, [id]);
  if (!match) return null;
  match.players = await q(`
    SELECT mp.user_id, u.username, u.avatar, u.rating, mp.side, mp.country,
           mp.rating_before, mp.rating_delta
    FROM match_players mp JOIN users u ON u.id = mp.user_id
    WHERE mp.match_id = ? ORDER BY mp.side, u.rating DESC`, [id]);
  return match;
}

const canManage = (user, match) => user.isAdmin || user.id === match.host_id;

// ---------- Discord OAuth ----------
app.get('/auth/discord', (_req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { ...cookieOpts, maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', wrap(async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.cookies.oauth_state) return res.status(400).send('Неверный state');
  res.clearCookie('oauth_state');

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: DISCORD_REDIRECT_URI,
    }),
  });
  if (!tokenRes.ok) return res.status(502).send('Discord не выдал токен');
  const { access_token } = await tokenRes.json();

  const meRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!meRes.ok) return res.status(502).send('Не удалось получить профиль Discord');
  const me = await meRes.json();

  await db.execute({
    sql: `INSERT INTO users (id, username, avatar) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET username = excluded.username, avatar = excluded.avatar`,
    args: [me.id, me.global_name || me.username, me.avatar],
  });

  const token = jwt.sign({ sub: me.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { ...cookieOpts, maxAge: 30 * 24 * 3600 * 1000 });
  res.redirect(FRONTEND_URL);
}));

app.post('/auth/logout', (_req, res) => {
  res.clearCookie('token', cookieOpts);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return fail(res, 401, 'Не авторизован');
  const { id, username, avatar, rating, wins, losses, isAdmin } = req.user;
  res.json({ id, username, avatar, rating, wins, losses, isAdmin });
});

// ---------- matches ----------
app.get('/api/matches', wrap(async (req, res) => {
  const status = ['open', 'in_progress', 'finished', 'cancelled'].includes(req.query.status) ? req.query.status : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  res.json(await q(`
    SELECT m.*, h.username AS host_name,
      (SELECT COUNT(*) FROM match_players WHERE match_id = m.id) AS players_count
    FROM matches m JOIN users h ON h.id = m.host_id
    ${status ? 'WHERE m.status = ?' : ''}
    ORDER BY m.created_at DESC LIMIT ?`, status ? [status, limit] : [limit]));
}));

app.get('/api/matches/:id', wrap(async (req, res) => {
  const match = await getMatch(req.params.id);
  return match ? res.json(match) : fail(res, 404, 'Матч не найден');
}));

app.post('/api/matches', requireAuth, wrap(async (req, res) => {
  const title = String(req.body.title || '').trim();
  const teamSize = parseInt(req.body.team_size, 10) || 1;
  let scheduled = null;
  if (req.body.scheduled_at) {
    const d = new Date(req.body.scheduled_at);
    if (isNaN(d)) return fail(res, 400, 'Неверная дата');
    scheduled = d.toISOString();
  }
  if (title.length < 3 || title.length > 80) return fail(res, 400, 'Название: 3–80 символов');
  if (teamSize < 1 || teamSize > 16) return fail(res, 400, 'Размер команды: 1–16');
  const id = crypto.randomUUID();
  await db.execute({
    sql: 'INSERT INTO matches (id, host_id, title, team_size, scheduled_at) VALUES (?, ?, ?, ?, ?)',
    args: [id, req.user.id, title, teamSize, scheduled],
  });
  res.status(201).json(await getMatch(id));
}));

app.post('/api/matches/:id/join', requireAuth, wrap(async (req, res) => {
  const side = req.body.side;
  const country = req.body.country ? String(req.body.country).toUpperCase() : null;
  if (!['A', 'B'].includes(side)) return fail(res, 400, 'side должен быть A или B');
  if (country && !/^[A-Z0-9]{3}$/.test(country)) return fail(res, 400, 'Тег страны: 3 символа, например GER');

  const err = await inTx(async (tx) => {
    const [m] = await txq(tx, 'SELECT * FROM matches WHERE id = ?', [req.params.id]);
    if (!m) return [404, 'Матч не найден'];
    if (m.status !== 'open') return [409, 'Набор в матч закрыт'];
    if ((await txq(tx, 'SELECT 1 FROM match_players WHERE match_id = ? AND user_id = ?', [m.id, req.user.id])).length)
      return [409, 'Вы уже в этом матче'];
    const [{ c }] = await txq(tx, 'SELECT COUNT(*) AS c FROM match_players WHERE match_id = ? AND side = ?', [m.id, side]);
    if (c >= m.team_size) return [409, 'Эта сторона заполнена'];
    if (country && (await txq(tx, 'SELECT 1 FROM match_players WHERE match_id = ? AND country = ?', [m.id, country])).length)
      return [409, 'Эта страна уже занята'];
    await tx.execute({
      sql: 'INSERT INTO match_players (match_id, user_id, side, country) VALUES (?, ?, ?, ?)',
      args: [m.id, req.user.id, side, country],
    });
    return null;
  });
  return err ? fail(res, err[0], err[1]) : res.json(await getMatch(req.params.id));
}));

app.post('/api/matches/:id/leave', requireAuth, wrap(async (req, res) => {
  const match = await one('SELECT * FROM matches WHERE id = ?', [req.params.id]);
  if (!match) return fail(res, 404, 'Матч не найден');
  if (match.status !== 'open') return fail(res, 409, 'Нельзя выйти после начала матча');
  await db.execute({ sql: 'DELETE FROM match_players WHERE match_id = ? AND user_id = ?', args: [match.id, req.user.id] });
  res.json(await getMatch(match.id));
}));

app.post('/api/matches/:id/start', requireAuth, wrap(async (req, res) => {
  const match = await getMatch(req.params.id);
  if (!match) return fail(res, 404, 'Матч не найден');
  if (!canManage(req.user, match)) return fail(res, 403, 'Только организатор или админ');
  if (match.status !== 'open') return fail(res, 409, 'Матч уже начат или закрыт');
  const a = match.players.filter((p) => p.side === 'A').length;
  const b = match.players.filter((p) => p.side === 'B').length;
  if (a === 0 || b === 0) return fail(res, 409, 'На каждой стороне нужен хотя бы один игрок');
  await db.execute({ sql: "UPDATE matches SET status = 'in_progress' WHERE id = ?", args: [match.id] });
  res.json(await getMatch(match.id));
}));

app.post('/api/matches/:id/cancel', requireAuth, wrap(async (req, res) => {
  const match = await getMatch(req.params.id);
  if (!match) return fail(res, 404, 'Матч не найден');
  if (!canManage(req.user, match)) return fail(res, 403, 'Только организатор или админ');
  if (!['open', 'in_progress'].includes(match.status)) return fail(res, 409, 'Матч уже завершён или отменён');
  await db.execute({ sql: "UPDATE matches SET status = 'cancelled' WHERE id = ?", args: [match.id] });
  res.json(await getMatch(match.id));
}));

// Результат матча: считаем Elo и обновляем рейтинг всех игроков одной транзакцией
app.post('/api/matches/:id/result', requireAuth, wrap(async (req, res) => {
  const winner = req.body.winner;
  if (!['A', 'B'].includes(winner)) return fail(res, 400, 'winner должен быть A или B');

  const err = await inTx(async (tx) => {
    const [m] = await txq(tx, 'SELECT * FROM matches WHERE id = ?', [req.params.id]);
    if (!m) return [404, 'Матч не найден'];
    if (!canManage(req.user, m)) return [403, 'Только организатор или админ'];
    if (m.status !== 'in_progress') return [409, 'Результат можно внести только для идущего матча'];

    const players = await txq(tx, `SELECT mp.user_id, mp.side, u.rating FROM match_players mp
      JOIN users u ON u.id = mp.user_id WHERE mp.match_id = ?`, [m.id]);
    const ratings = (s) => players.filter((p) => p.side === s).map((p) => p.rating);
    const deltas = computeDeltas(ratings('A'), ratings('B'), winner);

    for (const p of players) {
      const won = p.side === winner;
      await tx.execute({
        sql: 'UPDATE users SET rating = rating + ?, wins = wins + ?, losses = losses + ? WHERE id = ?',
        args: [deltas[p.side], won ? 1 : 0, won ? 0 : 1, p.user_id],
      });
      await tx.execute({
        sql: 'UPDATE match_players SET rating_before = ?, rating_delta = ? WHERE match_id = ? AND user_id = ?',
        args: [p.rating, deltas[p.side], m.id, p.user_id],
      });
    }
    await tx.execute({
      sql: "UPDATE matches SET status = 'finished', winner = ?, finished_at = datetime('now') WHERE id = ?",
      args: [winner, m.id],
    });
    return null;
  });
  return err ? fail(res, err[0], err[1]) : res.json(await getMatch(req.params.id));
}));

// ---------- leaderboard / players ----------
app.get('/api/leaderboard', wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
  res.json(await q(`
    SELECT id, username, avatar, rating, wins, losses
    FROM users WHERE wins + losses > 0
    ORDER BY rating DESC, wins DESC LIMIT ?`, [limit]));
}));

app.get('/api/players/:id', wrap(async (req, res) => {
  const user = await one('SELECT id, username, avatar, rating, wins, losses, created_at FROM users WHERE id = ?', [req.params.id]);
  if (!user) return fail(res, 404, 'Игрок не найден');
  user.history = await q(`
    SELECT m.id, m.title, m.winner, m.finished_at, mp.side, mp.country, mp.rating_delta
    FROM match_players mp JOIN matches m ON m.id = mp.match_id
    WHERE mp.user_id = ? AND m.status = 'finished'
    ORDER BY m.finished_at DESC LIMIT 20`, [user.id]);
  res.json(user);
}));

// ---------- errors ----------
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

init()
  .then(() => app.listen(PORT, () => console.log(`API запущен на порту ${PORT}`)))
  .catch((e) => { console.error('Не удалось подключиться к базе:', e.message); process.exit(1); });
