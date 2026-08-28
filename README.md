# Filo — app di messaggistica (demo)

App di messaggistica in tempo reale con interfaccia ispirata a WhatsApp Web,
ma con nome, logo e branding originali. Backend Node.js/Express + SQLite (modulo integrato node:sqlite) +
Socket.IO, pensata per il deploy su [Render.com](https://render.com) come
semplice **Web Service**, senza database esterni da collegare e senza
variabili d'ambiente obbligatorie.

## ⚠️ Autenticazione dimostrativa

Il login richiede **solo il numero di telefono**, senza alcun invio di SMS/OTP:
il numero viene usato esclusivamente come identificativo dell'utente. Questo va
bene per una demo, ma **non è sicuro per un'app reale**: chiunque può accedere
con il numero di chiunque altro. In produzione andrebbe sostituito con una vera
verifica del numero (OTP via SMS) o un altro sistema di autenticazione sicuro.

## ⚠️ Persistenza dei dati

Il database è un file **SQLite** salvato su disco locale al servizio
(`data/filo.db`), per non richiedere alcuna configurazione. Sui piani Render
senza "Persistent Disk" (es. il piano Free), il filesystem viene azzerato ad
ogni deploy/riavvio: utenti, chat e messaggi vengono persi. Per dati che
persistono nel tempo:
- aggiungi un **Persistent Disk** al servizio (Dashboard → servizio → *Disks*,
  richiede un piano a pagamento), montato su `/opt/render/project/src/data`; oppure
- passa a un database gestito esterno (in tal caso andrebbe reintrodotta una
  variabile `DATABASE_URL` e il relativo driver — chiedimelo se ti serve).

Allo stesso modo, se non imposti `SESSION_SECRET`, il server ne genera uno
casuale ad ogni avvio: gli utenti restano disconnessi dopo ogni redeploy.
Impostalo tra le variabili d'ambiente se vuoi evitarlo (facoltativo).

## Struttura del progetto

```
filo-chat/
├── server.js          # server Express + API REST + Socket.IO
├── package.json
├── .env.example         # variabili d'ambiente opzionali
├── db/
│   └── schema.sql       # schema SQLite (creato automaticamente all'avvio)
├── data/                 # contiene il file filo.db (creato al primo avvio)
└── public/
    ├── index.html        # interfaccia (schermata login + app)
    └── app.js             # logica client (fetch API + Socket.IO)
```

## Sviluppo locale

Requisiti: Node.js 22.5+ (per il modulo integrato node:sqlite; il repo include un file .node-version con la versione consigliata).

```bash
npm install
npm start
```

Il server crea automaticamente il file SQLite e le tabelle necessarie
all'avvio, e serve sia le API (`/api/...`) sia il frontend statico. Apri
`http://localhost:3000`.

## Deploy su Render.com (Web Service)

1. Carica questo progetto in un repository Git (GitHub/GitLab).
2. Su Render: **New** → **Web Service**, collega il repository.
3. Imposta:
   - Build command: `npm install`
   - Start command: `npm start`
4. Deploy — **non è necessario impostare alcuna variabile d'ambiente.**
   (Puoi comunque aggiungere `SESSION_SECRET` in seguito, dalla sezione
   *Environment*, se vuoi che le sessioni non si azzerino ad ogni redeploy.)

## Sicurezza implementata

- Validazione e normalizzazione degli input (numeri di telefono, contenuto messaggi).
- Query parametrizzate su tutte le chiamate al database (nessuna concatenazione di stringhe → niente SQL injection).
- Escaping dei contenuti lato client prima dell'inserimento nel DOM (nessun HTML non filtrato).
- Sessioni server-side firmate, cookie `httpOnly` e `secure` in produzione.
- CORS configurato (di default riflette l'origine della richiesta, dato che frontend e backend sono sullo stesso dominio).
- Rate limiting di base su login, invio messaggi e ricerca contatti.
- Nessuna credenziale hard-coded nel codice sorgente.

## Limiti noti (demo)

- Autenticazione senza verifica del numero (vedi sopra).
- Dati non persistenti sui piani Render senza Persistent Disk (vedi sopra).
- Solo conversazioni 1:1 (nessun gruppo).
- Nessun upload di media (solo testo).
- Sessioni in memoria: adatte a una singola istanza del servizio (va bene sul piano Free, che ne esegue una sola).
