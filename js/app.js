// js/app.js
const ORG_DOMAIN = "pukekohehigh.school.nz";
const STORAGE_KEY = "attendance_dashboard_settings_v8";

// Bridge student page URL pattern
function bridgeUrlFor(studentId) {
  return `https://pukekohe.bridge.school.nz/students/student/${encodeURIComponent(studentId)}`;
}

/**
 * Email templates are loaded from:
 *   data/email-templates.json
 * Subject conversions are loaded from:
 *   data/subject-map.json
 *
 * This file contains NO email wording.
 */
let emailConfig = null;
let subjectMap = {};

let reportTitle = "";
let students = [];

/* ------------------------- DOM Elements ------------------------- */

const els = {
  file: document.getElementById("file"),
  search: document.getElementById("search"),
  year: document.getElementById("year"),
  tier: document.getElementById("tier"),
  sort: document.getElementById("sort"),
  flagOnly: document.getElementById("flagOnly"),

  overallThreshold: document.getElementById("overallThreshold"),
  subjectThreshold: document.getElementById("subjectThreshold"),
  unjustThreshold: document.getElementById("unjustThreshold"),
  maxSubjects: document.getElementById("maxSubjects"),

  fLowOverall: document.getElementById("fLowOverall"),
  fHighUnjust: document.getElementById("fHighUnjust"),
  fLowSubject: document.getElementById("fLowSubject"),
  fMissingSubject: document.getElementById("fMissingSubject"),

  advanced: document.getElementById("advanced"),
  closeAdvancedBtn: document.getElementById("closeAdvancedBtn"),

  export: document.getElementById("export"),
  reset: document.getElementById("reset"),
  grid: document.getElementById("grid"),
  empty: document.getElementById("empty"),

  statStudents: document.getElementById("statStudents"),
  statFlagged: document.getElementById("statFlagged"),
  statRedOrange: document.getElementById("statRedOrange"),
  statHighUnjust: document.getElementById("statHighUnjust"),
  statTitle: document.getElementById("statTitle"),
};

// Status banner (helps diagnose GitHub Pages issues)
const statusBar = document.createElement("div");
statusBar.style.maxWidth = "1200px";
statusBar.style.margin = "0 auto";
statusBar.style.padding = "0 18px 12px";
statusBar.style.color = "rgba(11,18,32,0.7)";
statusBar.style.fontSize = "12px";
statusBar.innerHTML = "Status: Ready.";
document.querySelector("header")?.after(statusBar);

function setStatus(msg) {
  statusBar.innerHTML = `Status: ${msg}`;
  console.log("[Attendance Dashboard]", msg);
}

/* --------------------------- Utilities --------------------------- */

function parseMaybeNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "" || s.toLowerCase() === "nan") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Repairs:
 * - report title line above headers
 * - "one long line" exports by inserting newlines before student IDs
 */
function repairCsvText(text) {
  let t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  // Ensure StudentID header begins at a new line
  const headerIndex = t.indexOf("StudentID,");
  if (headerIndex > 0) {
    const before = t.slice(0, headerIndex).trim();
    const after = t.slice(headerIndex);
    t = before + "\n" + after;
  }

  // If there are too few line breaks, attempt to break into rows before ID patterns
  const newlineCount = (t.match(/\n/g) || []).length;
  if (newlineCount < 5) {
    t = t.replace(/(\s)(\d{4,6},)/g, "\n$2");
  }

  return t;
}

function overallTier(pct) {
  if (pct === null) return "na";
  if (pct < 70) return "bad";
  if (pct < 80) return "warn";
  if (pct < 85) return "watch";
  return "good";
}

function tierLabel(tier) {
  if (tier === "bad") return "🔴 Critical";
  if (tier === "warn") return "🟠 Concern";
  if (tier === "watch") return "🟡 Watch";
  if (tier === "good") return "🟢 OK";
  return "—";
}

function subjectChipClass(pct, subjThresh) {
  if (pct === null) return "na";
  if (pct < subjThresh) return "low";
  if (pct < subjThresh + 10) return "med";
  return "ok";
}

/* ---------------------- JSON Loading (safe) ---------------------- */

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return await res.json();
}

async function initConfigs() {
  // Email templates
  try {
    emailConfig = await loadJSON("data/email-templates.json");
    if (!emailConfig?.templates) {
      setStatus("Email templates loaded but invalid (missing templates key). Emails disabled.");
      emailConfig = null;
    } else {
      setStatus("Email templates loaded ✅");
    }
  } catch (e) {
    setStatus("Email templates not loaded (check /data/email-templates.json). Emails disabled.");
    console.warn(e);
    emailConfig = null;
  }

  // Subject map
  try {
    subjectMap = await loadJSON("data/subject-map.json");
    if (!subjectMap || typeof subjectMap !== "object") subjectMap = {};
    setStatus("Subject mappings loaded ✅");
  } catch (e) {
    setStatus("Subject mappings not loaded → using raw subject codes.");
    console.warn(e);
    subjectMap = {};
  }
}

/* ---------------------- Subject Mapping ---------------------- */

function convertSubjectName(codeOrName) {
  const raw = String(codeOrName ?? "").trim();
  if (!raw) return raw;
  return subjectMap[raw] ?? raw;
}

/* ------------------------- Data parsing ------------------------- */

function normalizeData(rows) {
  if (!rows || !rows.length) return [];
  const headers = Object.keys(rows[0]);

  // Detect subject blocks: Subject i, Attendance %, Stats
  const subjectBlocks = [];
  for (let i = 1; i <= 12; i++) {
    const subjCol = `Subject ${i}`;
    const subjIdx = headers.indexOf(subjCol);
    if (subjIdx === -1) continue;
    const attCol = headers[subjIdx + 1] ?? null;
    const statsCol = headers[subjIdx + 2] ?? null;
    subjectBlocks.push({ subjCol, attCol, statsCol });
  }

  const out = [];
  for (const r of rows) {
    const id = String(r["StudentID"] ?? "").trim();
    if (!id) continue;

    const s = {
      studentId: id,
      lastName: String(r["LastName"] ?? "").trim(),
      firstName: String(r["FirstName"] ?? "").trim(),
      gender: String(r["Gender"] ?? "").trim(),
      yearLevel: String(r["YearLevel"] ?? "").trim(),
      formClass: String(r["Form Class"] ?? "").trim(),
      timetableClass: String(r["Timetable Class"] ?? "").trim(),
      presentPct: parseMaybeNumber(r["Present %"]),
      justified: parseMaybeNumber(r["Justified"]) ?? 0,
      unjustified: parseMaybeNumber(r["Unjustified"]) ?? 0,
      overseas: parseMaybeNumber(r["Overseas"]) ?? 0,
      total: parseMaybeNumber(r["Total"]) ?? null,
      subjects: [],
    };

    for (const b of subjectBlocks) {
      const code = String(r[b.subjCol] ?? "").trim();
      if (!code) continue;

      const name = convertSubjectName(code);
      const attendance = parseMaybeNumber(r[b.attCol]);

      let open = null, unjust = null, all = null;
      const statsRaw = r[b.statsCol];
      if (statsRaw !== null && statsRaw !== undefined && String(statsRaw).trim() !== "") {
        const parts = String(statsRaw).split("|").map(x => parseMaybeNumber(x));
        if (parts.length === 3) [open, unjust, all] = parts;
      }

      s.subjects.push({ code, name, attendance, open, unjust, all });
    }

    out.push(s);
  }

  return out;
}

function populateYearFilter(list) {
  const years = [...new Set(list.map(s => s.yearLevel).filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b));

  els.year.innerHTML =
    `<option value="">All</option>` +
    years.map(y => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join("");
}

/* ------------------------- Flagging ------------------------- */

function isFlagged(s, overallThresh, subjThresh, unjustThresh, reasonFilters) {
  const lowOverall = (s.presentPct !== null && s.presentPct < overallThresh);
  const highUnjust = (s.unjustified || 0) >= unjustThresh;
  const lowSubject = s.subjects.some(sub => sub.attendance !== null && sub.attendance < subjThresh);
  const missingSubject = s.subjects.some(sub => sub.attendance === null);

  return (reasonFilters.lowOverall && lowOverall) ||
    (reasonFilters.highUnjust && highUnjust) ||
    (reasonFilters.lowSubject && lowSubject) ||
    (reasonFilters.missingSubject && missingSubject);
}

function getReasons(s, overallThresh, subjThresh, unjustThresh) {
  const reasons = [];

  if (s.presentPct !== null && s.presentPct < overallThresh) {
    reasons.push({ type: "bad", text: `Low overall (${s.presentPct.toFixed(1)}%)` });
  }

  const lowSubs = s.subjects.filter(sub => sub.attendance !== null && sub.attendance < subjThresh);
  if (lowSubs.length) reasons.push({ type: "warn", text: `${lowSubs.length} low subject(s)` });

  const missing = s.subjects.filter(sub => sub.attendance === null);
  if (missing.length) reasons.push({ type: "watch", text: `Missing data (${missing.length})` });

  if ((s.unjustified || 0) >= unjustThresh) reasons.push({ type: "bad", text: `Unjustified ${s.unjustified}` });

  if (!reasons.length) reasons.push({ type: "good", text: "No flags" });

  return reasons;
}

function riskScore(s, overallThresh, subjThresh, unjustThresh) {
  let score = 0;
  if (s.presentPct === null) score += 10;
  else score += Math.max(0, overallThresh - s.presentPct) * 2;

  score += s.subjects.filter(sub => sub.attendance !== null && sub.attendance < subjThresh).length * 10;
  score += s.subjects.filter(sub => sub.attendance === null).length * 4;
  score += Math.min(50, (s.unjustified || 0)) * 1.4;
  return score;
}

function severityPercent(score) {
  const capped = Math.min(120, Math.max(0, score));
  return Math.round((capped / 120) * 100);
}

/* ------------------------- Email helpers (template-driven) ------------------------- */

function openParentEmailViaBridge({ bridgeUrl, mailtoParent }) {
  // 1) Always open Bridge (new tab)
  window.open(bridgeUrl, "_blank", "noopener,noreferrer");

  // 2) Try open Outlook mailto
  setTimeout(() => {
    try {
      window.location.href = mailtoParent;
    } catch (e) {
      alert("Bridge opened.\n\nIf Outlook didn't open, click Email Parent again.");
    }
  }, 150);
}

function joinLines(lines) {
  return (lines || []).join("\n");
}

function formatLowSubjectsBulletList(student, subjThresh) {
  const lowSubs = student.subjects
    .filter(s => s.attendance !== null && s.attendance < subjThresh)
    .sort((a, b) => (a.attendance ?? 999) - (b.attendance ?? 999))
    .slice(0, 5);

  if (!lowSubs.length) return "• (No low subjects identified in this report)";
  return lowSubs.map(s => `• ${s.name}: ${s.attendance.toFixed(1)}%`).join("\n");
}

function fillTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] ?? ""));
}

function buildMailto(templateKey, student, subjThresh, toEmail) {
  if (!emailConfig?.templates?.[templateKey]) return null;

  const tpl = emailConfig.templates[templateKey];

  const schoolName = emailConfig.school?.name || "Pukekohe High School";
  const valuesLine = emailConfig.school?.valuesLine || "";

  const overallPct = (student.presentPct === null) ? "N/A" : `${student.presentPct.toFixed(1)}%`;
  const lowSubjectsBulletList = formatLowSubjectsBulletList(student, subjThresh);

  const vars = {
    schoolName,
    valuesLine,
    studentId: student.studentId,
    firstName: student.firstName,
    lastName: student.lastName,
    yearLevel: student.yearLevel || "—",
    formClass: student.formClass || "—",
    overallPct,
    unjustified: String(student.unjustified ?? 0),
    lowSubjectsBulletList
  };

  const subject = fillTemplate(tpl.subject, vars);
  const body = fillTemplate(joinLines(tpl.body), vars);

  return `mailto:${encodeURIComponent(toEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/* ------------------------- Filtering + Search helpers ------------------------- */

function buildSearchHaystack(student) {
  const subjectHay = (student.subjects || [])
    .map(sub => `${sub.code} ${sub.name}`)
    .join(" ");

  return `
    ${student.lastName}
    ${student.firstName}
    ${student.studentId}
    ${student.gender}
    ${student.yearLevel}
    ${student.formClass}
    ${student.timetableClass}
    ${subjectHay}
  `.toLowerCase();
}

function getReasonGate() {
  const reasonFilters = {
    lowOverall: !!els.fLowOverall?.checked,
    highUnjust: !!els.fHighUnjust?.checked,
    lowSubject: !!els.fLowSubject?.checked,
    missingSubject: !!els.fMissingSubject?.checked
  };

  const anyReasonOn = Object.values(reasonFilters).some(v => v === true);
  return anyReasonOn
    ? reasonFilters
    : { lowOverall: true, highUnjust: true, lowSubject: true, missingSubject: true };
}

function getCurrentThresholds() {
  return {
    overallThresh: Number(els.overallThreshold?.value) || 80,
    subjThresh: Number(els.subjectThreshold?.value) || 80,
    unjustThresh: Number(els.unjustThreshold?.value) || 10,
    maxSubjects: Math.max(1, Math.min(12, Number(els.maxSubjects?.value) || 5))
  };
}

/* ------------------------- Export Flagged (PDF) - NO POPUPS ------------------------- */

function buildFlaggedListForExport() {
  if (!students.length) return { list: [], thresholds: null };

  const qRaw = els.search?.value?.trim().toLowerCase() || "";
  const qParts = qRaw.split(/\s+/).filter(Boolean);

  const y = els.year?.value || "";
  const tierFilter = els.tier?.value || "";
  const sort = els.sort?.value || "risk";

  const { overallThresh, subjThresh, unjustThresh } = getCurrentThresholds();
  const reasonGate = getReasonGate();

  let filtered = students.filter(s => {
    if (y && String(s.yearLevel) !== String(y)) return false;

    if (tierFilter) {
      const t = overallTier(s.presentPct);
      if (t !== tierFilter) return false;
    }

    if (qParts.length) {
      const hay = buildSearchHaystack(s);
      for (const p of qParts) {
        if (!hay.includes(p)) return false;
      }
    }

    return true;
  });

  filtered.sort((a, b) => {
    if (sort === "name") return `${a.lastName},${a.firstName}`.localeCompare(`${b.lastName},${b.firstName}`);
    if (sort === "attendanceAsc") return (a.presentPct ?? 999) - (b.presentPct ?? 999);
    if (sort === "attendanceDesc") return (b.presentPct ?? -1) - (a.presentPct ?? -1);
    if (sort === "unjust") return (b.unjustified ?? 0) - (a.unjustified ?? 0);
    return riskScore(b, overallThresh, subjThresh, unjustThresh) - riskScore(a, overallThresh, subjThresh, unjustThresh);
  });

  const flagged = filtered.filter(s => isFlagged(s, overallThresh, subjThresh, unjustThresh, reasonGate));

  return {
    list: flagged,
    thresholds: { overallThresh, subjThresh, unjustThresh }
  };
}

function exportFlaggedPDF_NoPopup() {
  const { list, thresholds } = buildFlaggedListForExport();

  if (!list || !list.length) {
    alert("No flagged students in the current view.");
    return;
  }

  // Compact choices
  const MAX_LOW_SUBJECTS = 3;
  const MAX_REASONS = 2;

  const now = new Date();
  const dateStr = now.toLocaleString();
  const report = reportTitle || "Attendance Report";

  const overallThresh = thresholds?.overallThresh ?? (Number(els.overallThreshold.value) || 80);
  const subjThresh = thresholds?.subjThresh ?? (Number(els.subjectThreshold.value) || 80);
  const unjustThresh = thresholds?.unjustThresh ?? (Number(els.unjustThreshold.value) || 10);

  // Summary counts
  let criticalCount = 0;
  let concernCount = 0;
  let highUnjustCount = 0;

  for (const s of list) {
    const t = overallTier(s.presentPct);
    if (t === "bad") criticalCount++;
    if (t === "warn") concernCount++;
    if ((s.unjustified || 0) >= unjustThresh) highUnjustCount++;
  }

  // Build student cards HTML
  const cardsHtml = list.map((s) => {
    const tier = overallTier(s.presentPct);
    const tierText = tierLabel(tier);

    const overall = (s.presentPct == null) ? "N/A" : `${s.presentPct.toFixed(1)}%`;

    const reasonsArr = getReasons(s, overallThresh, subjThresh, unjustThresh)
      .filter(r => r.type !== "good")
      .slice(0, MAX_REASONS);

    const reasonsHtml = reasonsArr.length
      ? reasonsArr.map(r => `<span class="print-pill ${escapeHtml(r.type)}">${escapeHtml(r.text)}</span>`).join("")
      : `<span class="print-pill watch">Flagged</span>`;

    const lowSubs = (s.subjects || [])
      .filter(sub => sub.attendance != null && sub.attendance < subjThresh)
      .sort((a, b) => (a.attendance ?? 999) - (b.attendance ?? 999))
      .slice(0, MAX_LOW_SUBJECTS);

    const subRowsHtml = lowSubs.length
      ? lowSubs.map(sub => {
          const pct = (sub.attendance == null) ? "—" : `${sub.attendance.toFixed(0)}%`;
          return `<div class="subj">${escapeHtml(sub.name)}</div><div class="pct">${escapeHtml(pct)}</div>`;
        }).join("")
      : `<div class="subj" style="grid-column:1 / -1; color:#333;">
           No low subjects below ${escapeHtml(String(subjThresh))}% in this report.
         </div>`;

    return `
      <div class="print-card">
        <div class="print-card-top">
          <div class="print-student">
            <p class="name">${escapeHtml(s.lastName)}, ${escapeHtml(s.firstName)}</p>
            <div class="meta">
              ID: <strong>${escapeHtml(s.studentId)}</strong> •
              Y<strong>${escapeHtml(s.yearLevel || "—")}</strong> •
              <strong>${escapeHtml(s.formClass || "—")}</strong><br>
              Unjustified: <strong>${escapeHtml(String(s.unjustified ?? 0))}</strong>
            </div>
          </div>

          <div class="print-overall">
            <div class="badge ${escapeHtml(tier)}">${escapeHtml(overall)}</div>
            <div class="tier">${escapeHtml(tierText)}</div>
          </div>
        </div>

        <div class="print-reasons">${reasonsHtml}</div>

        <div class="print-subjects">
          <h3>Lowest subjects (below ${escapeHtml(String(subjThresh))}%)</h3>
          <div class="print-subject-list">
            ${subRowsHtml}
          </div>
        </div>
      </div>
    `;
  }).join("");

  // Save original state so we can restore after printing
  const originalHtml = document.body.innerHTML;
  const originalTitle = document.title;

  // Replace body with print-only markup
  document.title = "Flagged Attendance Report";
  document.body.innerHTML = `
    <div class="print-page">
      <div class="print-header">
        <div class="print-title">
          <h1>Flagged Attendance Report</h1>
          <div class="sub">${escapeHtml(report)}<br>${escapeHtml(dateStr)}</div>

          <div class="print-summary">
            <span class="print-kpi bad">Critical: ${escapeHtml(String(criticalCount))}</span>
            <span class="print-kpi warn">Concern: ${escapeHtml(String(concernCount))}</span>
            <span class="print-kpi watch">High unjustified: ${escapeHtml(String(highUnjustCount))}</span>
          </div>
        </div>

        <div class="print-metrics">
          <div><strong>${escapeHtml(String(list.length))}</strong> flagged students</div>
          <div>Overall: ${escapeHtml(String(overallThresh))}%</div>
          <div>Subject: ${escapeHtml(String(subjThresh))}%</div>
          <div>Unjustified: ${escapeHtml(String(unjustThresh))}+</div>
        </div>
      </div>

      <div class="print-cards">
        ${cardsHtml}
      </div>

      <p class="print-small" style="margin-top:10px;">
        Tip: Choose “Save as PDF” in the print dialog.
      </p>
    </div>
  `;

  // Restore app after printing
  const restore = () => {
    document.body.innerHTML = originalHtml;
    document.title = originalTitle;

    // Re-cache DOM and re-wire (important after innerHTML swap)
    cacheDom();
    wireInputs();
    wireFileUpload();
    render();
  };

  window.addEventListener("afterprint", restore, { once: true });

  // Print (delay ensures DOM is ready)
  setTimeout(() => {
    try {
      window.print();
    } catch (err) {
      console.error(err);
      alert("Printing failed. Check pop-up / print permissions.");
      restore();
      return;
    }

    // Fallback restore if afterprint fails
    setTimeout(() => {
      try { restore(); } catch {}
    }, 1000);
  }, 300);
}



/* ------------------------- Render ------------------------- */

function render() {
  if (!students.length) {
    if (els.empty) {
      els.empty.style.display = "block";
      els.empty.textContent = "Upload a report to begin.";
    }
    if (els.grid) els.grid.innerHTML = "";
    if (els.statStudents) els.statStudents.textContent = "0";
    if (els.statFlagged) els.statFlagged.textContent = "0";
    if (els.statRedOrange) els.statRedOrange.textContent = "0";
    if (els.statHighUnjust) els.statHighUnjust.textContent = "0";
    if (els.statTitle) els.statTitle.textContent = reportTitle || "—";
    return;
  }

  const qRaw = els.search?.value?.trim().toLowerCase() || "";
  const qParts = qRaw.split(/\s+/).filter(Boolean);

  const y = els.year?.value || "";
  const tierFilter = els.tier?.value || "";
  const sort = els.sort?.value || "risk";

  const { overallThresh, subjThresh, unjustThresh, maxSubjects } = getCurrentThresholds();
  const flaggedOnly = !!els.flagOnly?.checked;

  const reasonGate = getReasonGate();

  let filtered = students.filter(s => {
    if (y && String(s.yearLevel) !== String(y)) return false;

    if (tierFilter) {
      const t = overallTier(s.presentPct);
      if (t !== tierFilter) return false;
    }

    if (qParts.length) {
      const hay = buildSearchHaystack(s);
      for (const p of qParts) {
        if (!hay.includes(p)) return false;
      }
    }

    const flagged = isFlagged(s, overallThresh, subjThresh, unjustThresh, reasonGate);
    if (flaggedOnly && !flagged) return false;

    return true;
  });

  filtered.sort((a, b) => {
    if (sort === "name") return `${a.lastName},${a.firstName}`.localeCompare(`${b.lastName},${b.firstName}`);
    if (sort === "attendanceAsc") return (a.presentPct ?? 999) - (b.presentPct ?? 999);
    if (sort === "attendanceDesc") return (b.presentPct ?? -1) - (a.presentPct ?? -1);
    if (sort === "unjust") return (b.unjustified ?? 0) - (a.unjustified ?? 0);
    return riskScore(b, overallThresh, subjThresh, unjustThresh) - riskScore(a, overallThresh, subjThresh, unjustThresh);
  });

  const flaggedCount = filtered.filter(s => isFlagged(s, overallThresh, subjThresh, unjustThresh, reasonGate)).length;
  const redOrange = filtered.filter(s => {
    const t = overallTier(s.presentPct);
    return (t === "bad" || t === "warn");
  }).length;
  const highUnjustCount = filtered.filter(s => (s.unjustified || 0) >= unjustThresh).length;

  if (els.statStudents) els.statStudents.textContent = filtered.length;
  if (els.statFlagged) els.statFlagged.textContent = flaggedCount;
  if (els.statRedOrange) els.statRedOrange.textContent = redOrange;
  if (els.statHighUnjust) els.statHighUnjust.textContent = highUnjustCount;
  if (els.statTitle) els.statTitle.textContent = reportTitle || "—";

  if (!els.grid) return;

  els.grid.innerHTML = "";
  if (!filtered.length) {
    if (els.empty) {
      els.empty.style.display = "block";
      els.empty.textContent = "No students match your filters.";
    }
    return;
  }
  if (els.empty) els.empty.style.display = "none";

  for (const s of filtered) {
    const overall = (s.presentPct === null) ? "N/A" : `${s.presentPct.toFixed(1)}%`;
    const tier = overallTier(s.presentPct);
    const tierText = tierLabel(tier);

    const reasons = getReasons(s, overallThresh, subjThresh, unjustThresh);
    const chips = reasons.map(r => `<span class="chip ${r.type}">${escapeHtml(r.text)}</span>`).join("");

    const rScore = riskScore(s, overallThresh, subjThresh, unjustThresh);
    const sev = severityPercent(rScore);
    const sevClass = (tier === "na") ? "na" : tier;

    const worstSubs = s.subjects
      .slice()
      .sort((a, b) => (a.attendance ?? 999) - (b.attendance ?? 999))
      .slice(0, maxSubjects);

    const strip = worstSubs.map(sub => {
      const val = (sub.attendance === null) ? "—" : `${sub.attendance.toFixed(0)}%`;
      const cls = subjectChipClass(sub.attendance, subjThresh);
      return `<span class="subChip ${cls}"><span class="code">${escapeHtml(sub.name)}</span> ${escapeHtml(val)}</span>`;
    }).join("");

    const detailsHtml = worstSubs.map(sub => {
      const val = sub.attendance === null ? "—" : `${sub.attendance.toFixed(1)}%`;
      const cls = sub.attendance === null ? "" : subjectChipClass(sub.attendance, subjThresh);
      const vcls = cls === "low" ? "low" : (cls === "med" ? "med" : "ok");
      return `
        <div class="subrow">
          <div class="subjname">${escapeHtml(sub.name)}</div>
          <div class="subjval ${vcls}">${val}</div>
        </div>
      `;
    }).join("");

    const studentTo = `${s.studentId}@${ORG_DOMAIN}`;
    const parentTo = ""; // teacher pastes parent email from Bridge

    const mailtoStudent = buildMailto("student_warning", s, subjThresh, studentTo);
    const mailtoParent = buildMailto("parent_inform", s, subjThresh, parentTo);
    const bridgeUrl = bridgeUrlFor(s.studentId);

    const emailsEnabled = !!mailtoStudent && !!mailtoParent;

    const card = document.createElement("div");
    card.className = "card";

    card.innerHTML = `
      <div class="severity">
        <div class="fill ${sevClass}" style="width:${sev}%;"></div>
      </div>

      <div class="toprow">
        <div>
          <div class="name">${escapeHtml(s.lastName)}, ${escapeHtml(s.firstName)}</div>
          <div class="meta">
            ID: ${escapeHtml(s.studentId)} • Y${escapeHtml(s.yearLevel)} • ${escapeHtml(s.formClass || "—")}
          </div>
          <div class="tierLabel ${tier}">
            <span class="tierDot"></span> ${escapeHtml(tierText)}
          </div>
        </div>

        <div class="badge ${tier}">${escapeHtml(overall)}</div>
      </div>

      <div class="chips">${chips}</div>

      <div class="subjectStrip">${strip}</div>

      <div class="actions">
        ${
          emailsEnabled
            ? `<button class="emailBtn" type="button" data-action="email-parent">Email Parent</button>`
            : `<button class="emailBtn" disabled type="button">Email Parent (templates missing)</button>`
        }

        ${
          mailtoStudent
            ? `<a class="emailBtn secondary" href="${mailtoStudent}" onclick="event.stopPropagation();">Email Student</a>`
            : `<button class="emailBtn secondary" disabled type="button">Email Student (templates missing)</button>`
        }

        <a class="emailBtn secondary" href="${bridgeUrl}" target="_blank" rel="noreferrer" onclick="event.stopPropagation();">
          Open Bridge Profile
        </a>

        <span class="tiny">
          Email Parent opens Bridge + Outlook template. Paste parent email from Bridge into the “To:” field.
        </span>
      </div>

      <div class="details">
        <h4>Worst ${maxSubjects} subjects (click card to collapse)</h4>
        ${detailsHtml || `<div class="empty" style="box-shadow:none;">No subject data found.</div>`}
      </div>
    `;

    // Wire parent action (Bridge + Outlook)
    const parentBtn = card.querySelector('[data-action="email-parent"]');
    if (parentBtn && mailtoParent) {
      parentBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openParentEmailViaBridge({ bridgeUrl, mailtoParent });
      });
    }

    card.addEventListener("click", () => card.classList.toggle("expanded"));
    els.grid.appendChild(card);
  }
}

/* ---------------------- DOM refresh (for restore after print) ---------------------- */

function cacheDom() {
  // in case restore rebuilt DOM, refresh references
  els.file = document.getElementById("file");
  els.search = document.getElementById("search");
  els.year = document.getElementById("year");
  els.tier = document.getElementById("tier");
  els.sort = document.getElementById("sort");
  els.flagOnly = document.getElementById("flagOnly");

  els.overallThreshold = document.getElementById("overallThreshold");
  els.subjectThreshold = document.getElementById("subjectThreshold");
  els.unjustThreshold = document.getElementById("unjustThreshold");
  els.maxSubjects = document.getElementById("maxSubjects");

  els.fLowOverall = document.getElementById("fLowOverall");
  els.fHighUnjust = document.getElementById("fHighUnjust");
  els.fLowSubject = document.getElementById("fLowSubject");
  els.fMissingSubject = document.getElementById("fMissingSubject");

  els.advanced = document.getElementById("advanced");
  els.closeAdvancedBtn = document.getElementById("closeAdvancedBtn");

  els.export = document.getElementById("export");
  els.reset = document.getElementById("reset");
  els.grid = document.getElementById("grid");
  els.empty = document.getElementById("empty");

  els.statStudents = document.getElementById("statStudents");
  els.statFlagged = document.getElementById("statFlagged");
  els.statRedOrange = document.getElementById("statRedOrange");
  els.statHighUnjust = document.getElementById("statHighUnjust");
  els.statTitle = document.getElementById("statTitle");
}

/* ---------------------- Wiring ---------------------- */

function wireInputs() {
  cacheDom();

  els.closeAdvancedBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (els.advanced) els.advanced.open = false;
  });

  // Export flagged to PDF (no popups)
  els.export?.addEventListener("click", () => {
    if (!students.length) {
      alert("Upload a report first.");
      return;
    }
    exportFlaggedPDF_NoPopup();
  });

  // Reset (optional)
  els.reset?.addEventListener("click", () => {
    if (confirm("Clear the current report and reset filters?")) {
      students = [];
      reportTitle = "";
      if (els.file) els.file.value = "";
      if (els.search) els.search.value = "";
      if (els.year) els.year.value = "";
      if (els.tier) els.tier.value = "";
      if (els.sort) els.sort.value = "risk";
      if (els.flagOnly) els.flagOnly.checked = false;
      render();
    }
  });

  [
    els.search, els.year, els.tier, els.sort, els.flagOnly,
    els.overallThreshold, els.subjectThreshold, els.unjustThreshold, els.maxSubjects,
    els.fLowOverall, els.fHighUnjust, els.fLowSubject, els.fMissingSubject
  ].forEach(el => {
    if (!el) return;
    el.addEventListener("input", render);
    el.addEventListener("change", render);
  });
}

/* ---------------------- File Upload ---------------------- */

function wireFileUpload() {
  cacheDom();
  if (!els.file) return;

  els.file.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setStatus(`Loading file: ${file.name}...`);

    try {
      let text = await file.text();
      text = repairCsvText(text);

      reportTitle = (text.split("\n")[0] ?? "").replace(/^"|"$/g, "").trim();

      const lines = text.split("\n");
      let csvText = text;

      // If first line is title and second line contains StudentID header
      if (lines.length > 1 && !lines[0].includes("StudentID") && lines[1].includes("StudentID")) {
        csvText = lines.slice(1).join("\n");
      }

      if (typeof Papa === "undefined") {
        alert("PapaParse failed to load. Check internet / CDN blocked.");
        return;
      }

      Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          if (!results.data?.length) {
            setStatus("Parsed 0 rows. The CSV may not match expected headers.");
            alert("No data rows found after parsing. This report might be a different export.");
            return;
          }

          students = normalizeData(results.data);
          populateYearFilter(students);

          setStatus(`Loaded ${students.length} students ✅`);
          render();
        },
        error: (err) => {
          console.error(err);
          setStatus("CSV parse error (see console).");
          alert("Could not parse CSV. Check file format.");
        }
      });

    } catch (err) {
      console.error(err);
      setStatus("Failed to read file.");
      alert("Failed to read file.");
    }
  });
}

/* ---------------------- Start ---------------------- */

(async function main() {
  setStatus("Starting...");
  await initConfigs();
  wireInputs();
  wireFileUpload();
  setStatus("Ready. Upload a CSV.");
  render();
})();




