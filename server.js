/**
 * Storm Mail — backend API
 *
 * Источник правды: Postgres (Railway). Все страницы (на любых компьютерах)
 * читают и пишут в одну и ту же базу, поэтому данные всегда одинаковые везде.
 *
 * Дополнительно: при каждом сохранении записи сервер дублирует те же данные
 * в Google Таблицу через веб-приложение Apps Script (см. GOOGLE_SHEETS_WEBHOOK_URL
 * ниже). Это just-in-case резервная копия/журнал — сайт её не читает обратно,
 * читает и показывает всегда только Postgres.
 *
 * ВАЖНО: удаление записи (DELETE /api/entries/:date) НЕ удаляет строку
 * из Google Таблицы — текущий Apps Script код не поддерживает удаление,
 * только добавление/перезапись. Таблица накапливает историю.
 *
 * Деплой: Railway.
 *  1. Railway → New Project → Deploy from GitHub repo → выбрать этот репозиторий/папку.
 *  2. В этом же проекте: + New → Database → Add PostgreSQL.
 *     Railway сам создаст переменную окружения DATABASE_URL и подключит её к сервису.
 *  3. (необязательно, но рекомендуется) Settings → Variables → добавить API_KEY
 *     с любым секретным значением — тогда API будет проверять заголовок x-api-key.
 *     Это значение нужно будет указать в HTML-странице (константа API_KEY).
 *  4. Settings → Variables → добавить GOOGLE_SHEETS_WEBHOOK_URL со значением
 *     вашего /exec адреса Apps Script (или просто оставить дефолт ниже в коде).
 *  5. Settings → Networking → Generate Domain — получите публичный URL вида
 *     https://storm-mail-backend-production.up.railway.app
 *  6. Этот же сервис отдаёт и саму страницу index.html по адресу "/".
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

// Адрес веб-приложения Apps Script (заканчивается на /exec). Можно переопределить
// переменной окружения GOOGLE_SHEETS_WEBHOOK_URL в Railway, не трогая код.
const GOOGLE_SHEETS_WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL
  || 'https://script.google.com/macros/s/AKfycbxxwBI09CnBrwb0JuB7A8-gtW_91h7JwKO19ROZygTxzH7rm_snpAJmL0CSK0LPB5ET/exec';

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

// Дублирует запись за день в Google Таблицу. Никогда не бросает исключение
// наружу — если Google недоступен, основной ответ сайту всё равно уйдёт
// успешно (Postgres — источник правды, Sheets — просто зеркало).
async function mirrorToGoogleSheets(date, metrics, statuses) {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) return;
  try {
    const res = await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, metrics, statuses }),
    });
    const data = await res.json().catch(() => null);
    if (!data || data.ok !== true) {
      console.error('Google Sheets sync: сервер Apps Script ответил ошибкой:', data && data.error);
    }
  } catch (err) {
    console.error('Google Sheets sync: не удалось отправить данные:', err.message);
  }
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
// присылает актуальное состояние дня целиком. После успешной записи в
// Postgres то же самое дублируется в Google Таблицу.
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
    // Дублирование в Google Таблицу выполняется уже после ответа сайту,
    // чтобы не задерживать сохранение, если Google отвечает медленно.
    mirrorToGoogleSheets(date, metrics, statuses);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/entries/:date', async (req, res) => {
  try {
    await pool.query('DELETE FROM entries WHERE date = $1', [req.params.date]);
    res.json({ ok: true });
    // Примечание: в Google Таблице строка НЕ удаляется — Apps Script
    // сейчас не поддерживает удаление, только добавление/обновление.
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
