// server.js (minimale e robusto)
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors({ origin: true, credentials: true }));
app.options('*', (req, res) => res.sendStatus(204));
app.use(express.static(path.join(__dirname, 'public')));

// ensure users file
try {
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
} catch (e) {
  console.error('FS init error', e);
  process.exit(1);
}

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '[]'); }
  catch (e) { console.error('readUsers error', e); return []; }
}
function writeUsers(users) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
  catch (e) { console.error('writeUsers error', e); }
}

app.get('/api/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post('/api/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: 'username, email e password richiesti' });
    const users = readUsers();
    if (users.find(u => u.email === email)) return res.status(409).json({ error: 'Email già registrata' });
    if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Username già in uso' });
    const hash = await bcrypt.hash(password, 10);
    users.push({ id: Date.now(), username, email, passwordHash: hash, createdAt: new Date().toISOString() });
    writeUsers(users);
    return res.json({ success: true, message: 'Account creato' });
  } catch (err) {
    console.error('signup error', err);
    return res.status(500).json({ error: 'Errore server' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body || {};
    if (!emailOrUsername || !password) return res.status(400).json({ error: 'emailOrUsername e password richiesti' });
    const users = readUsers();
    const user = users.find(u => u.email === emailOrUsername || u.username === emailOrUsername);
    if (!user) return res.status(401).json({ error: 'Credenziali non valide' });
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Credenziali non valide' });
    return res.json({ success: true, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    console.error('login error', err);
    return res.status(500).json({ error: 'Errore server' });
  }
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`)).on('error', (err) => {
  console.error('Server start error', err);
  process.exit(1);
});
