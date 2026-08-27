const fs = require("fs");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const DB_FILE = "database.json";

// Carica DB in modo sicuro
let db = {};
try {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify({}));
    db = {};
  }
} catch (e) {
  console.error("Errore caricamento DB:", e);
  db = {};
  try { fs.writeFileSync(DB_FILE, JSON.stringify({})); } catch {}
}

function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error("Errore salvataggio DB:", e); }
}

function encode(str) {
  if (!str) return 0;
  const hex = Buffer.from(String(str), "utf8").toString("hex");
  const n = parseInt(hex, 16);
  return Number.isNaN(n) ? 0 : n;
}

function decode(num) {
  try {
    if (typeof num !== "number" || Number.isNaN(num)) return "";
    const hex = num.toString(16);
    if (!hex) return "";
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return "";
  }
}

function extractNameValue(msg) {
  if (msg && typeof msg === "object" && !Array.isArray(msg)) {
    const possibleName = msg.name || msg.key || msg.variable || msg.k || msg.v;
    const possibleValue = msg.value ?? msg.val ?? msg.v ?? msg.data ?? msg[0];
    if (possibleName) return { name: possibleName, value: possibleValue };
  }
  if (Array.isArray(msg) && msg.length > 0) {
    for (const item of msg) {
      if (item && typeof item === "object") {
        const n = item.name || item.key || item.variable || item.k;
        const v = item.value ?? item.val ?? item.v ?? item.data;
        if (n) return { name: n, value: v };
      }
    }
  }
  if (msg && typeof msg === "string") {
    try {
      const parsed = JSON.parse(msg);
      return extractNameValue(parsed);
    } catch {}
  }
  return { name: null, value: null };
}

const wss = new WebSocket.Server({ port: PORT });
console.log("Server online sulla porta " + PORT);

wss.on("connection", ws => {
  ws.on("message", raw => {
    // Se raw è Buffer, converti in stringa
    let text;
    try {
      if (Buffer.isBuffer(raw)) {
        text = raw.toString("utf8");
      } else if (typeof raw === "string") {
        text = raw;
      } else {
        text = String(raw);
      }
    } catch (e) {
      text = "";
    }

    // Log leggibile per debug
    console.log("RAW as string:", text);

    // Prova a parsare la stringa JSON
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // se non è JSON, passa il testo grezzo a extractNameValue che gestisce stringhe JSON annidate
      parsed = text;
    }

    const { name, value } = extractNameValue(parsed);
    console.log("Estratto:", { name, value });

    if (!name) {
      const fallback = JSON.stringify({ name: "unknown", value: 0 });
      try { ws.send(fallback); } catch (e) { console.error("Errore invio fallback:", e); }
      console.log("Messaggio senza name ricevuto: inviato fallback");
      return;
    }

    if (typeof value === "number") {
      const decoded = decode(value);
      db[name] = decoded;
      saveDB();
      console.log("Salvato:", name, "=", decoded);
    } else {
      if (db[name] === undefined) {
        db[name] = "";
        saveDB();
        console.log("Chiave non trovata, creata vuota:", name);
      } else {
        console.log("Letto:", name, "=", db[name]);
      }
    }

    const responseNumber = encode(db[name] || "");
    const response = JSON.stringify({ name, value: responseNumber });

    try { ws.send(response); } catch (e) { console.error("Errore invio risposta:", e); }
  });
});
