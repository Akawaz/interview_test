const PDFDocument = require("pdfkit");

const INK = "#18263A", MUTED = "#5B6878", ACCENT = "#2F5D8C", GOOD = "#2E7D4F", BAD = "#B3261E", LINE = "#D7DDE5";

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Build the result PDF and resolve to a Buffer. */
function buildPdf(result, { candidateCopy = false } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `${result.testTitle} - ${result.name}` } });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - 100;

    doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(20).text(result.testTitle || "Assessment");
    doc.moveDown(0.2).fillColor(MUTED).font("Helvetica").fontSize(10).text(candidateCopy ? "Your submitted answers (candidate copy)" : "Candidate result report");
    doc.moveDown(0.8);

    const y0 = doc.y;
    doc.rect(50, y0, W, 92).strokeColor(LINE).lineWidth(1).stroke();
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(result.name, 64, y0 + 12, { width: W - 150 });
    doc.font("Helvetica").fontSize(10).fillColor(MUTED)
      .text(result.email, 64, y0 + 30, { width: W - 150 })
      .text(`Submitted: ${new Date(result.finishedAt).toLocaleString("en-GB", { timeZone: "Asia/Bahrain" })} (Bahrain time)`, 64, y0 + 46, { width: W - 150 })
      .text(`Time taken: ${fmtDuration(result.finishedAt - result.startedAt)}  |  ${result.reason}`, 64, y0 + 62, { width: W - 150 });
    if (!candidateCopy) {
      doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(26)
        .text(`${result.score} / ${result.outOf}`, 50, y0 + 18, { width: W - 14, align: "right" });
      doc.fillColor(MUTED).font("Helvetica").fontSize(9)
        .text("multiple-choice score", 50, y0 + 52, { width: W - 14, align: "right" });
    }
    doc.y = y0 + 106; doc.x = 50;

    if (result.strikes > 0) {
      doc.fillColor(BAD).font("Helvetica-Bold").fontSize(11).text(`${result.strikes} violation(s) recorded`);
      doc.font("Helvetica").fontSize(10);
      (result.log || []).forEach(l => doc.text(`- ${l.t}  ${l.reason}`));
      doc.moveDown(0.8);
    }

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(13).text("Answers");
    doc.moveDown(0.4);
    (result.questions || []).forEach((q, i) => {
      if (doc.y > doc.page.height - 140) doc.addPage();
      const a = result.answers ? result.answers[i] : undefined;
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(`${i + 1}. ${q.q}`, { width: W });
      doc.moveDown(0.2).font("Helvetica").fontSize(10);
      if (q.type === "mcq") {
        const given = (a === undefined || a === null) ? "No answer" : q.options[a];
        if (candidateCopy) {
          doc.fillColor(INK).text(`Your answer: ${given}`, { width: W });
        } else {
          const ok = a === q.correct;
          doc.fillColor(ok ? GOOD : BAD).text(`${ok ? "Correct" : "Wrong"}: answered "${given}"`, { width: W });
          if (!ok) doc.fillColor(MUTED).text(`Correct answer: ${q.options[q.correct]}`, { width: W });
        }
      } else if (q.type === "file") {
        const files = (result.files || []).filter(f => f.question === i);
        doc.fillColor(MUTED).text(files.length ? `Attached: ${files.map(f => f.originalName).join(", ")}` : "No file attached", { width: W });
      } else {
        doc.fillColor(INK).text((a && String(a).trim()) ? String(a) : "No answer", { width: W });
        if (!candidateCopy) doc.fillColor(MUTED).fontSize(9).text("Written answer, review manually");
      }
      doc.moveDown(0.3);
      doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).strokeColor(LINE).stroke();
      doc.moveDown(0.6);
    });

    doc.end();
  });
}

module.exports = { buildPdf };
