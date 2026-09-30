const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const store = require("./lib/store");
const { buildPdf } = require("./lib/pdf");
const { sendMail, mailMode, resultEmailHtml } = require("./lib/mail");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
if (!ADMIN_PASSWORD) console.warn("⚠  ADMIN_PASSWORD is not set — the admin panel is disabled until you set it.");

const MAX_FILE_MB = 10;
const upload = multer({ dest: store.UPLOAD_TMP, limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20 } });

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const db = store.db;
const newId = () => crypto.randomBytes(12).toString("hex");
const normEmail = e => String(e || "").trim().toLowerCase();
const safeName = n => String(n || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 120);

/* ---------------- admin auth (signed cookie) ---------------- */
function sign(exp) { return crypto.createHmac("sha256", ADMIN_PASSWORD).update("admin:" + exp).digest("hex"); }
function getCookie(req, name) {
  const m = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const tok = getCookie(req, "admin");
  if (!tok) return false;
  const [sig, exp] = tok.split(".");
  if (!exp || Date.now() > Number(exp)) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const requireAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: "Not signed in" });

app.post("/api/admin/login", (req, res) => {
  const pw = String(req.body.password || "");
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "ADMIN_PASSWORD is not set on the server." });
  const ok = pw.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: "Wrong password" });
  const exp = Date.now() + 12 * 3600 * 1000;
  res.setHeader("Set-Cookie", `admin=${sign(exp)}.${exp}; HttpOnly; Path=/; Max-Age=43200; SameSite=Strict${req.secure ? "; Secure" : ""}`);
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", "admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict");
  res.json({ ok: true });
});
app.get("/api/admin/me", (req, res) => res.json({ admin: isAdmin(req), mail: mailMode() }));

/* ---------------- candidate API ---------------- */
function publicTest() {
  const c = db().config;
  return {
    ready: c.questions.length > 0,
    title: c.title, duration: c.duration, maxViolations: c.maxViolations, version: c.updatedAt,
    maxFileMb: MAX_FILE_MB,
    questions: c.questions.map(q => q.type === "mcq" ? { type: "mcq", q: q.q, options: q.options } : { type: q.type, q: q.q })
  };
}
app.get("/api/test", (req, res) => res.json(publicTest()));

app.post("/api/start", async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 120);
  const email = normEmail(req.body.email);
  if (name.length < 2) return res.status(400).json({ error: "Enter your full name." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!db().config.questions.length) return res.status(400).json({ error: "The test isn't ready yet." });
  if (db().results.some(r => r.email === email)) return res.status(409).json({ error: "This email has already completed the test." });

  // resume an unfinished session for the same email (e.g. browser crash) instead of restarting the clock
  const existing = Object.entries(db().sessions).find(([, s]) => s.email === email && !s.used);
  if (existing) return res.json({ sessionId: existing[0], startedAt: existing[1].startedAt, resumed: true });

  const sessionId = newId();
  db().sessions[sessionId] = { name, email, startedAt: Date.now(), used: false, version: db().config.updatedAt };
  await store.save();
  res.json({ sessionId, startedAt: db().sessions[sessionId].startedAt });
});

app.post("/api/submit", upload.any(), async (req, res) => {
  const cleanupTmp = () => (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
  let p;
  try { p = JSON.parse(req.body.payload || "{}"); } catch { cleanupTmp(); return res.status(400).json({ error: "Bad payload" }); }
  const s = db().sessions[p.sessionId];
  if (!s) { cleanupTmp(); return res.status(404).json({ error: "Test session not found." }); }
  if (s.used) { cleanupTmp(); return res.status(409).json({ error: "This test was already submitted." }); }
  s.used = true;

  const cfg = db().config;
  const questions = JSON.parse(JSON.stringify(cfg.questions));
  const answers = {};
  questions.forEach((q, i) => {
    const a = p.answers ? p.answers[i] : undefined;
    if (q.type === "mcq" && Number.isInteger(a) && a >= 0 && a < q.options.length) answers[i] = a;
    if (q.type === "text" && typeof a === "string") answers[i] = a.slice(0, 20000);
  });
  const mcq = questions.map((q, i) => ({ q, i })).filter(x => x.q.type === "mcq");
  const finishedAt = Date.now();
  const limitMs = cfg.duration * 60000 + 60000; // 1 min grace
  let reason = String(p.reason || "Submitted by candidate").slice(0, 200);
  if (finishedAt - s.startedAt > limitMs) reason += " (after time limit)";

  const id = newId();
  const dir = path.join(store.UPLOAD_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  (req.files || []).forEach(f => {
    const m = /^file_(\d+)$/.exec(f.fieldname);
    const qi = m ? Number(m[1]) : -1;
    if (!m || !questions[qi] || questions[qi].type !== "file") { fs.unlink(f.path, () => {}); return; }
    const stored = `${files.length + 1}-${safeName(f.originalname)}`;
    fs.renameSync(f.path, path.join(dir, stored));
    files.push({ question: qi, originalName: safeName(f.originalname), stored, size: f.size });
  });

  const result = {
    id, name: s.name, email: s.email, testTitle: cfg.title, questions, answers, files,
    score: mcq.filter(x => answers[x.i] === x.q.correct).length, outOf: mcq.length,
    startedAt: s.startedAt, finishedAt,
    strikes: Math.max(0, Math.min(99, Number(p.strikes) || 0)),
    log: Array.isArray(p.log) ? p.log.slice(0, 50).map(l => ({ t: String(l.t || "").slice(0, 10), reason: String(l.reason || "").slice(0, 120) })) : [],
    reason, email_status: "pending"
  };

  // Admin PDF (with score + answer key) is stored and emailed; the candidate gets a copy without the key.
  let candidatePdf;
  try {
    fs.writeFileSync(path.join(dir, "result.pdf"), await buildPdf(result));
    candidatePdf = await buildPdf(result, { candidateCopy: true });
  } catch (e) { console.error("PDF failed", e); }

  db().results.push(result);
  await store.save();

  // email the admin (don't make the candidate wait for it)
  emailResult(result).catch(() => {});

  const fname = `${safeName(result.name).replace(/ /g, "_")}_result.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
  res.send(candidatePdf || Buffer.from(""));
});

async function emailResult(r) {
  const dir = path.join(store.UPLOAD_DIR, r.id);
  const attachments = [{ filename: `${safeName(r.name)} - result.pdf`, path: path.join(dir, "result.pdf") }]
    .concat(r.files.map(f => ({ filename: f.originalName, path: path.join(dir, f.stored) })));
  try {
    await sendMail({ to: db().config.adminEmail, subject: `Test result: ${r.name} (${r.score}/${r.outOf})`, html: resultEmailHtml(r), attachments });
    r.email_status = "sent";
  } catch (e) {
    console.error("Email failed:", e.message);
    r.email_status = "failed: " + e.message.slice(0, 200);
  }
  await store.save();
}

/* ---------------- admin API ---------------- */
app.get("/api/admin/config", requireAdmin, (req, res) => res.json(db().config));
app.put("/api/admin/config", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const qs = Array.isArray(b.questions) ? b.questions : [];
  for (const [i, q] of qs.entries()) {
    if (!q || !String(q.q || "").trim()) return res.status(400).json({ error: `Question ${i + 1} has no text.` });
    if (!["mcq", "text", "file"].includes(q.type)) return res.status(400).json({ error: `Question ${i + 1} has an unknown type.` });
    if (q.type === "mcq") {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.some(o => !String(o).trim())) return res.status(400).json({ error: `Question ${i + 1} needs at least 2 filled options.` });
      if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) return res.status(400).json({ error: `Pick the correct answer for question ${i + 1}.` });
    }
  }
  const email = normEmail(b.adminEmail);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid results email." });
  db().config = {
    title: String(b.title || "Interview Assessment").trim().slice(0, 150),
    duration: Math.min(600, Math.max(1, parseInt(b.duration) || 20)),
    maxViolations: Math.min(10, Math.max(1, parseInt(b.maxViolations) || 2)),
    adminEmail: email,
    questions: qs.map(q => q.type === "mcq"
      ? { type: "mcq", q: String(q.q).trim(), options: q.options.map(o => String(o).trim()), correct: q.correct }
      : { type: q.type, q: String(q.q).trim() }),
    updatedAt: Date.now()
  };
  await store.save();
  res.json(db().config);
});

app.post("/api/admin/test-email", requireAdmin, async (req, res) => {
  try {
    await sendMail({ to: db().config.adminEmail, subject: "Interview test: email check", html: "<p>Email delivery is working. Results will arrive at this address.</p>" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/results", requireAdmin, (req, res) => {
  res.json(db().results.slice().reverse().map(r => ({ ...r })));
});
app.get("/api/admin/results/:id/pdf", requireAdmin, (req, res) => {
  const r = db().results.find(x => x.id === req.params.id);
  if (!r) return res.status(404).send("Not found");
  const f = path.join(store.UPLOAD_DIR, r.id, "result.pdf");
  if (!fs.existsSync(f)) return res.status(404).send("PDF missing");
  res.setHeader("Content-Disposition", `inline; filename="${safeName(r.name)}_result.pdf"`);
  res.sendFile(f);
});
app.get("/api/admin/results/:id/files/:stored", requireAdmin, (req, res) => {
  const r = db().results.find(x => x.id === req.params.id);
  const file = r && r.files.find(f => f.stored === req.params.stored);
  if (!file) return res.status(404).send("Not found");
  res.download(path.join(store.UPLOAD_DIR, r.id, file.stored), file.originalName);
});
app.post("/api/admin/results/:id/resend", requireAdmin, async (req, res) => {
  const r = db().results.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: "Not found" });
  await emailResult(r);
  res.json({ email_status: r.email_status });
});
app.delete("/api/admin/results/:id", requireAdmin, async (req, res) => {
  const i = db().results.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "Not found" });
  const [r] = db().results.splice(i, 1);
  Object.keys(db().sessions).forEach(k => { if (db().sessions[k].email === r.email) delete db().sessions[k]; });
  fs.rm(path.join(store.UPLOAD_DIR, r.id), { recursive: true, force: true }, () => {});
  await store.save();
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: `A file is larger than ${MAX_FILE_MB} MB.` });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

app.listen(PORT, () => console.log(`Interview test running on port ${PORT} · data in ${store.DATA_DIR} · email: ${mailMode()}`));
