// Tiny JSON-file store. Keep DATA_DIR on a persistent volume in production.
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const DB_FILE = path.join(DATA_DIR, "db.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const UPLOAD_TMP = path.join(DATA_DIR, "tmp");
[DATA_DIR, UPLOAD_DIR, UPLOAD_TMP].forEach(d => fs.mkdirSync(d, { recursive: true }));

const DEFAULT = {
  config: {
    title: "Interview Assessment",
    duration: 20,          // minutes
    maxViolations: 2,
    adminEmail: process.env.ADMIN_EMAIL || "anzal@iconic.bh",
    questions: [],
    updatedAt: 0
  },
  sessions: {},            // sessionId -> {name,email,startedAt,used}
  results: []
};

let db;
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
catch { db = JSON.parse(JSON.stringify(DEFAULT)); }
db.config = Object.assign({}, DEFAULT.config, db.config || {});
db.sessions = db.sessions || {};
db.results = db.results || [];

let writing = Promise.resolve();
function save() {
  // serialize writes; write to temp then rename so a crash never corrupts the file
  writing = writing.then(() => new Promise(res => {
    const tmp = DB_FILE + ".tmp";
    fs.writeFile(tmp, JSON.stringify(db, null, 2), err => {
      if (err) { console.error("DB write failed", err); return res(); }
      fs.rename(tmp, DB_FILE, e => { if (e) console.error("DB rename failed", e); res(); });
    });
  }));
  return writing;
}

module.exports = { db: () => db, save, DATA_DIR, UPLOAD_DIR, UPLOAD_TMP };
