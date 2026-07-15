/**
 * Storm Mail — backend API
 *
 * Источник правды: Postgres (Railway). Сайт (index.html) читает и пишет
 * ТОЛЬКО в Postgres через это API — index.html больше не обращается
 * к Google напрямую.
 *
 * Google Таблица — зеркало. При каждом сохранении, удалении записи и при
 * добавлении/удалении статуса сервер (в фоне, не блокируя ответ сайту)
 * дублирует действие в Google Таблицу через веб-приложение Apps Script.
 * Если Google недоступен — сайт всё равно получает успешный ответ,
 * Postgres остаётся единственным источником правды.
 *
 * ВАЖНО: в Google Apps Script должен стоять обновлённый Code.gs (тот, что
 * поддерживает action: 'delete', 'addStatus', 'deleteStatus' — без него
 * зеркалирование удаления и статусов работать не будет).
 *
 * Деплой: Railway (без изменений в процессе, см. предыдущие инструкции).
 */

const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use(express.static(path.join(__dirname)));

const API_KEY = process.env.API_KEY || '';
const DEFAULT_STATUSES = ['CallBack', 'Hung Up', 'Depositor', 'N/A', 'No Interest', 'Wrong info', 'Wrong Number', 'Wrong Country', 'Trash', 'Other'];

const GOOGLE_SHEETS_WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL
  || 'https://script.google.com/macros/s/AKfycbxxwBI09CnBrwb0JuB7A8-gtW_91h7JwKO19ROZygTxzH7rm_snpAJmL0CSK0LPB5ET/exec';

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

// Универсальный helper для похода в Apps Script. Никогда не бросает исключение
// наружу — Postgres остаётся источником правды независимо от доступности Google.
async function callGoogleSheets(payload) {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) return;
  try {
    const res = await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!data || data.ok !== true) {
      console.error('Google Sheets sync ошибка:', payload.action || 'save', data && data.error);
    }
  } catch (err) {
    console.error('Google Sheets sync недоступен:', payload.action || 'save', err.message);
  }
}

function mirrorSaveToGoogleSheets(date, metrics, statuses) {
  callGoogleSheets({ action: 'save', date, metrics, statuses });
}
function mirrorDeleteToGoogleSheets(date) {
  callGoogleSheets({ action: 'delete', date });
}
function mirrorAddStatusToGoogleSheets(name) {
  callGoogleSheets({ action: 'addStatus', name });
}
function mirrorDeleteStatusToGoogleSheets(name) {
  callGoogleSheets({ action: 'deleteStatus', name });
}

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

// Полная перезапись значений за дату (не накопление). Postgres гарантирует
// отсутствие дублей по дате (date TEXT PRIMARY KEY + ON CONFLICT DO UPDATE).
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
    mirrorSaveToGoogleSheets(date, metrics, statuses);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/entries/:date', async (req, res) => {
  try {
    const date = req.params.date;
    await pool.query('DELETE FROM entries WHERE date = $1', [date]);
    res.json({ ok: true });
    // Теперь строка удаляется и из Google Таблицы (нужен обновлённый Code.gs).
    mirrorDeleteToGoogleSheets(date);
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
    const newList = Array.isArray(req.body.statusList) ? req.body.statusList : [];

    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'status_list'");
    const oldList = rows.length ? rows[0].value : DEFAULT_STATUSES;

    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('status_list', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`,
      [JSON.stringify(newList)]
    );
    res.json({ ok: true });

    // Зеркалим разницу в Google Таблицу: новые статусы -> новые колонки,
    // убранные статусы -> удаление колонок.
    const added = newList.filter((n) => !oldList.includes(n));
    const removed = oldList.filter((n) => !newList.includes(n));
    added.forEach((name) => mirrorAddStatusToGoogleSheets(name));
    removed.forEach((name) => mirrorDeleteStatusToGoogleSheets(name));
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
