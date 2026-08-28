-- Filo — schema del database (PostgreSQL)
-- Eseguito automaticamente all'avvio del server (vedi server.js -> ensureSchema()).

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  phone_number   VARCHAR(32) UNIQUE NOT NULL,
  display_name   VARCHAR(80),
  avatar         VARCHAR(255),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id               SERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at          TIMESTAMPTZ
);

-- Indici per le query più frequenti (lista chat, cronologia messaggi, ricerca per numero)
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_conversation_members_user
  ON conversation_members (user_id);

CREATE INDEX IF NOT EXISTS idx_users_phone
  ON users (phone_number);

-- Vincolo: al massimo due membri per conversazione (chat 1:1).
-- Applicato a livello applicativo in server.js; qui solo gli indici di supporto.
