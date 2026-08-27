const fs = require("fs");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const DB_FILE = "database.json";

// Carica database
let db = {};
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (e) {
    console.error("Errore parsing DB, ricreo file:", e);
    db = {};
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
  }
} else {
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("Errore salvataggio DB:", e);
  }
}

// Codifica stringa -> numero (ritorna 0 per stringhe vuote)
function encode(str) {
  if (!str || str.length === 0) return 0;
  const hex = Buffer.from(String(str), "utf8").toString("hex");
  const num = parseInt(hex, 16);
  return Number.isNaN(num) ? 0 : num;
}

// Decodifica numero -> stringa (gestisce NaN e valori non numerici)
function decode(num) {
  try {
    if (typeof num !== "number" || Number.isNaN(num)) return "";
    const hex = num.toString(16);
    if (!hex || hex.length === 0) return "";
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return "";
  }
}

const wss = new WebSocket.Server({ port: PORT });
console.log("Server online sulla porta " + PORT);

wss.on("connection", ws => {
  ws.on("message", raw => {
    // Log grezzo per debug
    console.log("RAW MESSAGE:", raw);

    let msg = {};
    try { msg = JSON.parse(raw); } catch (e) {
      console.log("Messaggio non JSON, ignorato");
      return;
    }

    const name = msg.name;
    const value = msg.value;

    // Log dettagli per debug
    console.log("Parsed message:", { name, value });

    // Se manca il name, rispondi con errore leggibile e non crashare
    if (!name) {
      console.log("Messaggio senza name, ignorato");
      return;
    }

    // Se value è numero -> TurboWarp sta scrivendo: decodifica e salva
    if (typeof value === "number") {
      const decoded = decode(value);
      db[name] = decoded;
      saveDB();
      console.log("Salvato:", name, "=", decoded);
    } else {
      // TurboWarp chiede il valore: se non esiste, restituisci stringa vuota
      if (db[name] === undefined) {
        db[name] = "";
        saveDB();
        console.log("Chiave non trovata, creata vuota:", name);
      } else {
        console.log("Letto:", name, "=", db[name]);
      }
    }

    // Rispondi sempre con un numero valido
    const responseNumber = encode(db[name] || "");
    const response = JSON.stringify({ name, value: responseNumber });

    // Invia a chi ha richiesto (o a tutti se preferisci)
    try {
      ws.send(response);
    } catch (e) {
      console.error("Errore invio risposta:", e);
    }
  });
});
