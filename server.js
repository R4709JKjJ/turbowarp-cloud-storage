/**
 * Filo — server backend
 * -----------------------------------------------------------------------
 * Express + PostgreSQL + Socket.IO, pensato per il deploy su Render.com.
 *
 * ATTENZIONE — AUTENTICAZIONE DIMOSTRATIVA
 * L'accesso avviene inserendo solo un numero di telefono, senza alcuna
 * verifica (nessun OTP/SMS). Il numero è usato esclusivamente come
 * identificativo dell'utente ai fini di questa demo. NON è adatto a un
 * ambiente di produzione: un'app reale dovrebbe richiedere una verifica
 * del numero (OTP via SMS) o un sistema di autenticazione sicuro
 * equivalente (es. password con hashing + provider OAuth).
 * -----------------------------------------------------------------------
 */

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server: SocketIOServer } = require('socket.io');

// ----------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const CORS_ORIGIN = process.env.CORS_ORIGIN || true; // true = riflette l'origine della richiesta
const IS_PROD = process.env.NODE_ENV === 'production';

if (!SESSION_SECRET) {
  console.error('ERRORE: variabile d\'ambiente SESSION_SECRET mancante. Impostala prima di avviare il server.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('ERRORE: variabile d\'ambiente DATABASE_URL mancante (stringa di connessione PostgreSQL).');
  process.exit(1);
}

// ----------------------------------------------------------------------
// Database
// ----------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function ensureSchema() {
  const fs = require('fs');
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
  console.log('Schema del database verificato/creato.');
}

// ----------------------------------------------------------------------
// Utility: normalizzazione numero di telefono
// ----------------------------------------------------------------------
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Mantiene un eventuale "+" iniziale e solo cifre per il resto.
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return null; // range E.164 plausibile
  return (hasPlus ? '+' : '') + digits;
}

function sanitizeDisplayName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 80);
  return trimmed || null;
}

function sanitizeMessageContent(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4000) return null;
  return trimmed;
}

// ----------------------------------------------------------------------
// App / middleware
// ----------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // necessario dietro il proxy di Render per i cookie "secure"

app.use(express.json({ limit: '100kb' }));
app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: true,
  })
);

const sessionMiddleware = session({
  store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'filo.sid',
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 giorni
  },
});
app.use(sessionMiddleware);

// Rate limiting di base sugli endpoint sensibili
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const messageLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const searchLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Non autenticato.' });
  }
  next();
}

// ----------------------------------------------------------------------
// Rotte di autenticazione
// ----------------------------------------------------------------------
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    if (!phone) {
      return res.status(400).json({ error: 'Numero di telefono non valido.' });
    }
    const displayName = sanitizeDisplayName(req.body && req.body.displayName);

    const existing = await pool.query('SELECT id, phone_number, display_name FROM users WHERE phone_number = $1', [phone]);
    let user;
    if (existing.rows.length > 0) {
      user = existing.rows[0];
      if (displayName && displayName !== user.display_name) {
        const updated = await pool.query(
          'UPDATE users SET display_name = $1 WHERE id = $2 RETURNING id, phone_number, display_name',
          [displayName, user.id]
        );
        user = updated.rows[0];
      }
    } else {
      const inserted = await pool.query(
        'INSERT INTO users (phone_number, display_name) VALUES ($1, $2) RETURNING id, phone_number, display_name',
        [phone, displayName]
      );
      user = inserted.rows[0];
    }

    req.session.userId = user.id;
    res.json({ user: { id: user.id, phone: user.phone_number, displayName: user.display_name } });
  } catch (err) {
    console.error('Errore login:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('filo.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, phone_number, display_name FROM users WHERE id = $1', [req.session.userId]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Sessione non valida.' });
    const u = result.rows[0];
    res.json({ user: { id: u.id, phone: u.phone_number, displayName: u.display_name } });
  } catch (err) {
    console.error('Errore /auth/me:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

// ----------------------------------------------------------------------
// Rotte conversazioni
// ----------------------------------------------------------------------

// Elenco conversazioni dell'utente, con ultimo messaggio e conteggio non letti,
// ordinate dalla più recente.
app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const meId = req.session.userId;
    const result = await pool.query(
      `
      SELECT
        c.id,
        other.id AS contact_id,
        other.phone_number AS contact_phone,
        other.display_name AS contact_display_name,
        lm.content AS last_message_content,
        lm.created_at AS last_message_at,
        COALESCE(unread.count, 0)::int AS unread_count
      FROM conversations c
      JOIN conversation_members cm_me ON cm_me.conversation_id = c.id AND cm_me.user_id = $1
      JOIN conversation_members cm_other ON cm_other.conversation_id = c.id AND cm_other.user_id != $1
      JOIN users other ON other.id = cm_other.user_id
      LEFT JOIN LATERAL (
        SELECT content, created_at FROM messages
        WHERE conversation_id = c.id
        ORDER BY created_at DESC LIMIT 1
      ) lm ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS count FROM messages
        WHERE conversation_id = c.id AND sender_id != $1 AND read_at IS NULL
      ) unread ON true
      ORDER BY COALESCE(lm.created_at, c.created_at) DESC
      `,
      [meId]
    );
    res.json({ conversations: result.rows });
  } catch (err) {
    console.error('Errore lista conversazioni:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

// Crea (o recupera) una conversazione 1:1 con un contatto cercato per numero.
app.post('/api/conversations', requireAuth, searchLimiter, async (req, res) => {
  try {
    const meId = req.session.userId;
    const phone = normalizePhone(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Numero di telefono non valido.' });

    const meRes = await pool.query('SELECT phone_number FROM users WHERE id = $1', [meId]);
    if (meRes.rows.length && meRes.rows[0].phone_number === phone) {
      return res.status(400).json({ error: 'Non puoi aggiungere te stesso.' });
    }

    const contactRes = await pool.query('SELECT id, phone_number, display_name FROM users WHERE phone_number = $1', [phone]);
    if (contactRes.rows.length === 0) {
      return res.status(404).json({ error: 'Nessun utente registrato con questo numero.' });
    }
    const contact = contactRes.rows[0];

    // Cerca una conversazione 1:1 già esistente tra i due utenti.
    const existingConv = await pool.query(
      `
      SELECT c.id FROM conversations c
      JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
      JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = $2
      LIMIT 1
      `,
      [meId, contact.id]
    );

    let conversationId;
    if (existingConv.rows.length > 0) {
      conversationId = existingConv.rows[0].id;
    } else {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const convInsert = await client.query('INSERT INTO conversations DEFAULT VALUES RETURNING id');
        conversationId = convInsert.rows[0].id;
        await client.query(
          'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
          [conversationId, meId, contact.id]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }
      // Notifica il contatto (se online) che esiste una nuova conversazione.
      io.to(userRoom(contact.id)).emit('conversation:new', { conversationId });
    }

    res.json({
      conversation: {
        id: conversationId,
        contact_id: contact.id,
        contact_phone: contact.phone_number,
        contact_display_name: contact.display_name,
      },
    });
  } catch (err) {
    console.error('Errore creazione conversazione:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

async function assertMember(conversationId, userId) {
  const r = await pool.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  );
  return r.rows.length > 0;
}

// Cronologia messaggi di una conversazione.
app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId)) return res.status(400).json({ error: 'ID conversazione non valido.' });
    const meId = req.session.userId;

    if (!(await assertMember(conversationId, meId))) {
      return res.status(403).json({ error: 'Non hai accesso a questa conversazione.' });
    }

    const result = await pool.query(
      `SELECT id, conversation_id, sender_id, content, created_at, read_at
       FROM messages WHERE conversation_id = $1
       ORDER BY created_at ASC LIMIT 500`,
      [conversationId]
    );
    res.json({
      messages: result.rows.map((m) => ({
        id: m.id,
        conversationId: m.conversation_id,
        senderId: m.sender_id,
        content: m.content,
        createdAt: m.created_at,
        readAt: m.read_at,
      })),
    });
  } catch (err) {
    console.error('Errore lettura messaggi:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

// Invio di un nuovo messaggio.
app.post('/api/conversations/:id/messages', requireAuth, messageLimiter, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId)) return res.status(400).json({ error: 'ID conversazione non valido.' });
    const meId = req.session.userId;

    if (!(await assertMember(conversationId, meId))) {
      return res.status(403).json({ error: 'Non hai accesso a questa conversazione.' });
    }

    const content = sanitizeMessageContent(req.body && req.body.content);
    if (!content) return res.status(400).json({ error: 'Messaggio vuoto o troppo lungo.' });

    const inserted = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1, $2, $3)
       RETURNING id, conversation_id, sender_id, content, created_at, read_at`,
      [conversationId, meId, content]
    );
    const row = inserted.rows[0];
    const message = {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      content: row.content,
      createdAt: row.created_at,
      readAt: row.read_at,
    };

    // Notifica in tempo reale tutti i membri della conversazione (incluso il mittente,
    // così eventuali altre schede/dispositivi restano sincronizzati).
    const membersRes = await pool.query('SELECT user_id FROM conversation_members WHERE conversation_id = $1', [conversationId]);
    for (const { user_id } of membersRes.rows) {
      io.to(userRoom(user_id)).emit('message:new', { message, conversationId });
    }

    res.status(201).json({ message });
  } catch (err) {
    console.error('Errore invio messaggio:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

// Segna come letti i messaggi ricevuti in una conversazione.
app.post('/api/conversations/:id/read', requireAuth, async (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId)) return res.status(400).json({ error: 'ID conversazione non valido.' });
    const meId = req.session.userId;

    if (!(await assertMember(conversationId, meId))) {
      return res.status(403).json({ error: 'Non hai accesso a questa conversazione.' });
    }

    await pool.query(
      `UPDATE messages SET read_at = now()
       WHERE conversation_id = $1 AND sender_id != $2 AND read_at IS NULL`,
      [conversationId, meId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Errore segna-come-letto:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

// File statici del frontend (public/index.html, app.js, ...)
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Non trovato.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----------------------------------------------------------------------
// Server HTTP + Socket.IO
// ----------------------------------------------------------------------
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: CORS_ORIGIN, credentials: true },
});

// Condivide la sessione Express con Socket.IO, così ogni socket sa
// a quale utente autenticato appartiene.
io.engine.use(sessionMiddleware);

function userRoom(userId) {
  return `user:${userId}`;
}

io.use((socket, next) => {
  const session = socket.request.session;
  if (session && session.userId) {
    socket.userId = session.userId;
    return next();
  }
  next(new Error('Non autenticato.'));
});

io.on('connection', (socket) => {
  socket.join(userRoom(socket.userId));
  socket.on('disconnect', () => {});
});

// ----------------------------------------------------------------------
// Avvio
// ----------------------------------------------------------------------
ensureSchema()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`Filo in ascolto sulla porta ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Impossibile inizializzare lo schema del database:', err);
    process.exit(1);
  });
