const fs = require("fs");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const DB_FILE = "database.json";

let db = {};
if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
} else {
  fs.writeFileSync(DB_FILE, JSON.stringify({}));
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function decodeNumber(num) {
  try {
    return Buffer.from(num.toString(), "hex").toString("utf8");
  } catch {
    return "";
  }
}

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

    const decoded = decodeNumber(value);

    db[name] = decoded;
    saveDB();

    console.log("Salvato:", name, "=", decoded);

    const encoded = encodeString(db[name]);
    const response = JSON.stringify({ name, value: encoded });

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(response);
      }
    });
  });
});
