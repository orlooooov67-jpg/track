/**
 * Storm Mail — backend API
 *
 * Единственный источник правды для трекера лидов: все страницы
 * (на любых компьютерах) читают и пишут в одну и ту же базу Postgres,
 * поэтому данные всегда одинаковые везде, а не "разные на разных компах".
 *
 * Деплой: Railway.
 *  1. Railway → New Project → Deploy from GitHub repo → выбрать этот репозиторий/папку.
 *  2. В этом же проекте: + New → Database → Add PostgreSQL.
 *     Railway сам создаст переменную окружения DATABASE_URL и подключит её к сервису.
 *  3. (необязательно, но рекомендуется) Settings → Variables → добавить API_KEY
 *     с любым секретным значением — тогда API будет проверять заголовок x-api-key.
 *     Это значение нужно будет указать в HTML-странице (константа API_KEY).
 *  4. Settings → Networking → Generate Domain — получите публичный URL вида
 *     https://storm-mail-backend-production.up.railway.app
 *  5. Этот же сервис теперь отдаёт и саму страницу index.html по адресу "/" —
 *     отдельно хостить на GitHub Pages не нужно.
 */

const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Отдаёт index.html и любые другие статические файлы, лежащие в корне репозитория.
app.use(express.static(path.join(__dirname)));

const API_KEY = process.env.API_KEY || '';
const DEFAULT_STATUSES = ['CallBack', 'Hung Up', 'Depositor', 'N/A', 'No Interest', 'Wrong info', 'Wrong Number', 'Wrong Country', 'Trash', 'Other'];

// Простая защита ключом (опционально). Если API_KEY не задан на сервере — открыт всем.
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/api/health') return next();
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] === API_KEY) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized: неверный или отсутствующий x-api-key' });
});

if (!process.env.DATABASE_URL) {
  console.error('ВНИМАНИЕ: переменная DATABASE_URL не задана. Добавьте PostgreSQL плагин в Railway.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      date TEXT PRIMARY KEY,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      statuses JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);
}

// Главная страница — отдаём саму HTML-страницу трекера вместо текстовой заглушки.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'DB unreachable: ' + err.message });
  }
});

// ---- entries ----

app.get('/api/entries', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT date, metrics, statuses FROM entries ORDER BY date DESC');
    res.json({ ok: true, entries: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/entries/:date', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT date, metrics, statuses FROM entries WHERE date = $1', [req.params.date]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, entry: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Полная перезапись значений за дату (не накопление) — страница всегда
// присылает актуальное состояние дня целиком.
app.put('/api/entries/:date', async (req, res) => {
  try {
    const date = req.params.date;
    const metrics = req.body.metrics || {};
    const statuses = req.body.statuses || {};
    await pool.query(
      `INSERT INTO entries (date, metrics, statuses, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, now())
       ON CONFLICT (date) DO UPDATE SET metrics = $2::jsonb, statuses = $3::jsonb, updated_at = now()`,
      [date, JSON.stringify(metrics), JSON.stringify(statuses)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/entries/:date', async (req, res) => {
  try {
    await pool.query('DELETE FROM entries WHERE date = $1', [req.params.date]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- shared status list ----

app.get('/api/statuses', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'status_list'");
    res.json({ ok: true, statusList: rows.length ? rows[0].value : DEFAULT_STATUSES });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/statuses', async (req, res) => {
  try {
    const statusList = Array.isArray(req.body.statusList) ? req.body.statusList : [];
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('status_list', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`,
      [JSON.stringify(statusList)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log('Storm Mail backend listening on port ' + PORT));
  })
  .catch((err) => {
    console.error('Не удалось инициализировать базу данных:', err);
    process.exit(1);
  });
