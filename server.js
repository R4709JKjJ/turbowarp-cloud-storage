// server.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

// Compatibilità fetch: usa global.fetch su Node 18+, altrimenti prova node-fetch
let fetchLib = null;
if (typeof fetch !== 'undefined') {
  fetchLib = fetch;
} else {
  try {
    // node-fetch v2 compatibile con require
    fetchLib = require('node-fetch');
  } catch (e) {
    console.error('node-fetch non disponibile. Se usi Node <18, installa node-fetch.');
    fetchLib = null;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// CORS per debug. In produzione sostituire origin: true con il dominio specifico
const cors = require('cors');
app.use(cors({ origin: true, credentials: true }));
app.options('*', (req, res) => res.sendStatus(204));

// Serve file statici dalla cartella public
app.use(express.static(path.join(__dirname, 'public')));

// Ensure users file exists
try {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([]));
  }
} catch (err) {
  console.error('Errore file system all\'avvio', err);
  process.exit(1);
}

function readUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    console.error('Errore lettura users.json', e);
    return [];
  }
}

function writeUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (e) {
    console.error('Errore scrittura users.json', e);
  }
}

// Health check GET
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Optional: accept POST /api/ping
app.post('/api/ping', (req, res) => {
  res.json({ ok: true, method: 'POST', body: req.body || null });
});

// Signup
app.post('/api/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email e password richiesti' });
    }

    const users = readUsers();
    if (users.find(u => u.email === email)) {
      return res.status(409).json({ error: 'Email già registrata' });
    }
    if (users.find(u => u.username === username)) {
      return res.status(409).json({ error: 'Username già in uso' });
    }

    const saltRounds = 10;
    const hash = await bcrypt.hash(password, saltRounds);
    const newUser = {
      id: Date.now(),
      username,
      email,
      passwordHash: hash,
      createdAt: new Date().toISOString()
    };
    users.push(newUser);
    writeUsers(users);
    return res.json({ success: true, message: 'Account creato' });
  } catch (err) {
    console.error('Signup error', err);
    return res.status(500).json({ error: 'Errore server' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body || {};
    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'emailOrUsername e password richiesti' });
    }

    const users = readUsers();
    const user = users.find(u => u.email === emailOrUsername || u.username === emailOrUsername);
    if (!user) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    return res.json({ success: true, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    console.error('Login error', err);
    return res.status(500).json({ error: 'Errore server' });
  }
});

// Simple proxy (opzionale) per inoltrare richieste a turbowarp-cloud-storage.onrender.com
app.post('/proxy/*', async (req, res) => {
  if (!fetchLib) {
    return res.status(500).json({ error: 'fetch non disponibile sul server' });
  }
  try {
    const targetPath = req.params[0] || '';
    const targetUrl = `https://turbowarp-cloud-storage.onrender.com/${targetPath}`;
    const response = await fetchLib(targetUrl, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const text = await response.text();
    res.status(response.status).send(text);
  } catch (err) {
    console.error('Proxy error', err);
    res.status(500).json({ error: 'Proxy error' });
  }
});

// SPA fallback: serve index.html per tutte le altre rotte
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Avvio server con gestione errori
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
}).on('error', (err) => {
  console.error('Errore avvio server', err);
  process.exit(1);
});
