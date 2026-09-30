const fs = require("fs");
const nodemailer = require("nodemailer");

function mailMode() {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.SMTP_HOST) return "smtp";
  return "none";
}

/** attachments: [{filename, content: Buffer}] or [{filename, path}] */
async function sendMail({ to, subject, html, attachments = [] }) {
  const mode = mailMode();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || "onboarding@resend.dev";
  const files = attachments.map(a => ({ filename: a.filename, content: a.content || fs.readFileSync(a.path) }));

  if (mode === "resend") {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [to], subject, html,
        attachments: files.map(f => ({ filename: f.filename, content: f.content.toString("base64") }))
      })
    });
    if (!r.ok) throw new Error(`Resend error ${r.status}: ${await r.text()}`);
    return { ok: true, mode };
  }

  if (mode === "smtp") {
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE) === "true",
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
    await t.sendMail({ from, to, subject, html, attachments: files });
    return { ok: true, mode };
  }

  throw new Error("Email is not configured. Set RESEND_API_KEY or SMTP_HOST.");
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function resultEmailHtml(r) {
  return `<div style="font-family:Arial,sans-serif;color:#18263A">
    <h2 style="margin:0 0 8px">${esc(r.testTitle)}: new submission</h2>
    <p><b>${esc(r.name)}</b> (${esc(r.email)})<br>
    Score: <b>${r.score} / ${r.outOf}</b> (multiple choice)<br>
    Violations: <b>${r.strikes}</b><br>
    Status: ${esc(r.reason)}</p>
    <p>The full report is attached as a PDF${(r.files || []).length ? ", along with the candidate's uploaded files" : ""}.</p>
  </div>`;
}

module.exports = { sendMail, mailMode, resultEmailHtml };
