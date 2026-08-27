const fs = require("fs");
const WebSocket = require("ws");

// Render passa automaticamente la porta via process.env.PORT
const PORT = process.env.PORT || 10000;

// Percorso sicuro e persistente su Render
const DB_FILE = "/var/data/database.json";

// Carica database
let db = {};
if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
} else {
  fs.writeFileSync(DB_FILE, JSON.stringify({}));
}

// Salva database
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Decodifica numero → stringa
function decodeNumber(num) {
  try {
    return Buffer.from(num.toString(16), "hex").toString("utf8");
  } catch {
    return "";
  }
}

// Codifica stringa → HEX
function encodeString(str) {
  return Buffer.from(str, "utf8").toString("hex");
}

// Server WebSocket
const wss = new WebSocket.Server({ port: PORT });
console.log("Cloud server online sulla porta " + PORT);

wss.on("connection", ws => {
  ws.on("message", raw => {
    let msg = {};
    try { msg = JSON.parse(raw); } catch {}

    const name = msg.name;
    const value = msg.value;

    // Decodifica valore ricevuto da TurboWarp
    const decoded = decodeNumber(value);

    // Salva nel database
    db[name] = decoded;
    saveDB();

    console.log("Salvato:", name, "=", decoded);

    // Codifica per risposta
    const encoded = encodeString(db[name]);

    // TurboWarp accetta SOLO numeri → convertiamo HEX in numero
    const numericValue = parseInt(encoded, 16);

    const response = JSON.stringify({
      name,
      value: numericValue
    });

    // Invia a tutti i client
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(response);
      }
    });
  });
});
