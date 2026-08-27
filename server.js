const fs = require("fs");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const DB_FILE = "database.json";

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

// Codifica stringa → numero
function encode(str) {
  return parseInt(Buffer.from(str, "utf8").toString("hex"), 16);
}

// Decodifica numero → stringa
function decode(num) {
  try {
    const hex = num.toString(16);
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return "";
  }
}

const wss = new WebSocket.Server({ port: PORT });
console.log("Server online sulla porta " + PORT);

wss.on("connection", ws => {
  ws.on("message", raw => {
    let msg = {};
    try { msg = JSON.parse(raw); } catch {}

    const name = msg.name;
    const value = msg.value;

    // Se TurboWarp invia un valore non numerico → usa il valore salvato
    let decoded;

    if (typeof value === "number") {
      decoded = decode(value);
      db[name] = decoded;
      saveDB();
      console.log("Salvato:", name, "=", decoded);
    } else {
      // TurboWarp sta chiedendo il valore salvato
      decoded = db[name] || "";
      console.log("Letto:", name, "=", decoded);
    }

    // Rispondi SEMPRE con un numero
    const encoded = encode(decoded);

    ws.send(JSON.stringify({
      name,
      value: encoded
    }));
  });
});
