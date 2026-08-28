/**
 * Filo — server backend
 * -----------------------------------------------------------------------
 * Express + SQLite (tramite il modulo integrato node:sqlite — nessun
 * pacchetto nativo da compilare) + Socket.IO, pensato per il deploy su
 * Render.com come semplice "Web Service" (nessun database esterno da
 * collegare, nessuna variabile d'ambiente obbligatoria). Richiede
 * Node.js 22.5+ (vedi package.json "engines" e file .node-version).
 *
 * ATTENZIONE — AUTENTICAZIONE DIMOSTRATIVA
 * L'accesso avviene inserendo solo un numero di telefono, senza alcuna
 * verifica (nessun OTP/SMS). Il numero è usato esclusivamente come
 * identificativo dell'utente ai fini di questa demo. NON è adatto a un
 * ambiente di produzione: un'app reale dovrebbe richiedere una verifica
 * del numero (OTP via SMS) o un sistema di autenticazione sicuro
 * equivalente (es. password con hashing + provider OAuth).
 *
 * ATTENZIONE — PERSISTENZA DEI DATI
 * Il database SQLite è un file salvato su disco locale al servizio.
 * Sui piani Render senza "persistent disk" (es. il piano Free), il
 * filesystem viene azzerato a ogni deploy/riavvio: è il compromesso
 * scelto per non richiedere alcuna configurazione manuale. Se vuoi dati
 * persistenti nel tempo, aggiungi un Persistent Disk al servizio su
 * Render (Dashboard → servizio → "Disks") oppure passa a un database
 * gestito esterno (vedi README).
 * -----------------------------------------------------------------------
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { DatabaseSync } = require('node:sqlite'); // modulo integrato in Node.js: nessuna compilazione nativa richiesta
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server: SocketIOServer } = require('socket.io');

// ----------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || true; // true = riflette l'origine della richiesta
const IS_PROD = process.env.NODE_ENV === 'production';

// Il segreto di sessione può essere impostato via variabile d'ambiente
// (consigliato se vuoi che le sessioni sopravvivano ai redeploy), ma se
// manca il server ne genera uno casuale ad ogni avvio, così non è
// obbligatorio configurare nulla per far partire l'app.
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn(
    'Nota: SESSION_SECRET non impostato — ne è stato generato uno temporaneo. ' +
    'Gli utenti verranno disconnessi ad ogni riavvio del servizio. ' +
    'Per evitarlo, imposta SESSION_SECRET tra le variabili d\'ambiente.'
  );
}

// ----------------------------------------------------------------------
// Database (SQLite — file locale, nessuna configurazione richiesta)
// ----------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'filo.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

function ensureSchema() {
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
  console.log('Schema del database verificato/creato (SQLite: ' + DB_PATH + ').');
}

// ----------------------------------------------------------------------
// Utility: normalizzazione numero di telefono
// ----------------------------------------------------------------------
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
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

function nowIso() {
  return new Date().toISOString();
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

// Sessioni in memoria: sufficienti per una singola istanza del servizio
// (come il piano Free di Render) e non richiedono alcuna tabella o
// database esterno da configurare.
const sessionMiddleware = session({
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
// Query preparate (better-sqlite3: API sincrona, niente async/await sul DB)
// ----------------------------------------------------------------------
const stmts = {
  findUserByPhone: db.prepare('SELECT id, phone_number, display_name FROM users WHERE phone_number = ?'),
  insertUser: db.prepare('INSERT INTO users (phone_number, display_name) VALUES (?, ?)'),
  updateUserName: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
  getUserById: db.prepare('SELECT id, phone_number, display_name FROM users WHERE id = ?'),

  insertConversation: db.prepare('INSERT INTO conversations DEFAULT VALUES'),
  insertMember: db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)'),
  isMember: db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'),
  membersOf: db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?'),

  findExistingConversation: db.prepare(`
    SELECT c.id FROM conversations c
    JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
    JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
    LIMIT 1
  `),

  listConversations: db.prepare(`
    SELECT
      c.id AS id,
      other.id AS contact_id,
      other.phone_number AS contact_phone,
      other.display_name AS contact_display_name,
      c.created_at AS created_at,
      (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_message_content,
      (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_message_at,
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND read_at IS NULL) AS unread_count
    FROM conversations c
    JOIN conversation_members cm_me ON cm_me.conversation_id = c.id AND cm_me.user_id = ?
    JOIN conversation_members cm_other ON cm_other.conversation_id = c.id AND cm_other.user_id != ?
    JOIN users other ON other.id = cm_other.user_id
    ORDER BY COALESCE(last_message_at, c.created_at) DESC
  `),

  listMessages: db.prepare(`
    SELECT id, conversation_id, sender_id, content, created_at, read_at
    FROM messages WHERE conversation_id = ?
    ORDER BY created_at ASC, id ASC LIMIT 500
  `),

  insertMessage: db.prepare(`
    INSERT INTO messages (conversation_id, sender_id, content, created_at)
    VALUES (?, ?, ?, ?)
  `),

  markRead: db.prepare(`
    UPDATE messages SET read_at = ?
    WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL
  `),
};

function assertMember(conversationId, userId) {
  return !!stmts.isMember.get(conversationId, userId);
}

// ----------------------------------------------------------------------
// Rotte di autenticazione
// ----------------------------------------------------------------------
app.post('/api/auth/login', loginLimiter, (req, res) => {
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    if (!phone) {
      return res.status(400).json({ error: 'Numero di telefono non valido.' });
    }
    const displayName = sanitizeDisplayName(req.body && req.body.displayName);

    let user = stmts.findUserByPhone.get(phone);
    if (user) {
      if (displayName && displayName !== user.display_name) {
        stmts.updateUserName.run(displayName, user.id);
        user = stmts.getUserById.get(user.id);
      }
    } else {
      const info = stmts.insertUser.run(phone, displayName);
      user = stmts.getUserById.get(Number(info.lastInsertRowid));
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

app.get('/api/auth/me', requireAuth, (req, res) => {
  try {
    const u = stmts.getUserById.get(req.session.userId);
    if (!u) return res.status(401).json({ error: 'Sessione non valida.' });
    res.json({ user: { id: u.id, phone: u.phone_number, displayName: u.display_name } });
  } catch (err) {
    console.error('Errore /auth/me:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

// ----------------------------------------------------------------------
// Rotte conversazioni
// ----------------------------------------------------------------------

app.get('/api/conversations', requireAuth, (req, res) => {
  try {
    const meId = req.session.userId;
    const rows = stmts.listConversations.all(meId, meId, meId);
    res.json({ conversations: rows });
  } catch (err) {
    console.error('Errore lista conversazioni:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.post('/api/conversations', requireAuth, searchLimiter, (req, res) => {
  try {
    const meId = req.session.userId;
    const phone = normalizePhone(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Numero di telefono non valido.' });

    const me = stmts.getUserById.get(meId);
    if (me && me.phone_number === phone) {
      return res.status(400).json({ error: 'Non puoi aggiungere te stesso.' });
    }

    const contact = stmts.findUserByPhone.get(phone);
    if (!contact) {
      return res.status(404).json({ error: 'Nessun utente registrato con questo numero.' });
    }

    let conversationId;
    const existing = stmts.findExistingConversation.get(meId, contact.id);
    if (existing) {
      conversationId = existing.id;
    } else {
      db.exec('BEGIN');
      try {
        const info = stmts.insertConversation.run();
        conversationId = Number(info.lastInsertRowid);
        stmts.insertMember.run(conversationId, meId);
        stmts.insertMember.run(conversationId, contact.id);
        db.exec('COMMIT');
      } catch (txErr) {
        db.exec('ROLLBACK');
        throw txErr;
      }
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

app.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId)) return res.status(400).json({ error: 'ID conversazione non valido.' });
    const meId = req.session.userId;

    if (!assertMember(conversationId, meId)) {
      return res.status(403).json({ error: 'Non hai accesso a questa conversazione.' });
    }

    const rows = stmts.listMessages.all(conversationId);
    res.json({
      messages: rows.map((m) => ({
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

app.post('/api/conversations/:id/messages', requireAuth, messageLimiter, (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId)) return res.status(400).json({ error: 'ID conversazione non valido.' });
    const meId = req.session.userId;

    if (!assertMember(conversationId, meId)) {
      return res.status(403).json({ error: 'Non hai accesso a questa conversazione.' });
    }

    const content = sanitizeMessageContent(req.body && req.body.content);
    if (!content) return res.status(400).json({ error: 'Messaggio vuoto o troppo lungo.' });

    const createdAt = nowIso();
    const info = stmts.insertMessage.run(conversationId, meId, content, createdAt);
    const message = {
      id: Number(info.lastInsertRowid),
      conversationId,
      senderId: meId,
      content,
      createdAt,
      readAt: null,
    };

    const members = stmts.membersOf.all(conversationId);
    for (const { user_id } of members) {
      io.to(userRoom(user_id)).emit('message:new', { message, conversationId });
    }

    res.status(201).json({ message });
  } catch (err) {
    console.error('Errore invio messaggio:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.post('/api/conversations/:id/read', requireAuth, (req, res) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId)) return res.status(400).json({ error: 'ID conversazione non valido.' });
    const meId = req.session.userId;

    if (!assertMember(conversationId, meId)) {
      return res.status(403).json({ error: 'Non hai accesso a questa conversazione.' });
    }

    stmts.markRead.run(nowIso(), conversationId, meId);
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
  const s = socket.request.session;
  if (s && s.userId) {
    socket.userId = s.userId;
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
ensureSchema();
httpServer.listen(PORT, () => {
  console.log(`Filo in ascolto sulla porta ${PORT}`);
});
