const fs = require("fs");
const WebSocket = require("ws");

// Porta gestita da Render
const PORT = process.env.PORT || 10000;

// Percorso persistente su Render
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

// Decodifica numero → stringa (HEX → UTF8)
function decodeNumber(num) {
  try {
    // num deve essere un numero, non undefined
    if (typeof num !== "number" || isNaN(num)) return "";

    // Converti numero → HEX
    const hex = num.toString(16);

    // Converti HEX → UTF8
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return "";
  }
}

// Codifica stringa → HEX
function encodeString(str) {
  return Buffer.from(str, "utf8").toString("hex");
}

const wss = new WebSocket.Server({ port: PORT });
console.log("Cloud server online sulla porta " + PORT);

wss.on("connection", ws => {
  ws.on("message", raw => {
    let msg = {};
    try { msg = JSON.parse(raw); } catch {}

    const name = msg.name;
    const value = msg.value;

    // Ignora messaggi vuoti o non validi
    if (!name || value === undefined || value === null) {
      console.log("Ignorato messaggio vuoto");
      return;
    }

    // Decodifica valore
    const decoded = decodeNumber(value);

    // Salva nel database
    db[name] = decoded;
    saveDB();

    console.log("Salvato:", name, "=", decoded);

    // Codifica per risposta
    const encoded = encodeString(db[name]);

    // TurboWarp accetta SOLO numeri → HEX → numero
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
