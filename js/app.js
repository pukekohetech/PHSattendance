// js/app.js
const ORG_DOMAIN = "pukekohehigh.school.nz";
const STORAGE_KEY = "attendance_dashboard_settings_v5";

// Your Bridge student page pattern (Option A)
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

// A small status banner (helps diagnose GitHub Pages issues)
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

  // Ensure StudentID header begins at a new line (report title may be before it)
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
      setStatus("Email templates loaded but invalid (missing templates key).");
      emailConfig = null;
    } else {
      setStatus("Email templates loaded ✅");
    }
  } catch (e) {
    setStatus("Email templates not loaded (check /data/email-templates.json). Emails will be disabled.");
    console.warn(e);
    emailConfig = null;
  }

  // Subject map
  try {
    subjectMap = await loadJSON("data/subject-map.json");
    if (!subjectMap || typeof subjectMap !== "object") subjectMap = {};
    setStatus("Subject mappings loaded ✅");
  } catch (e) {
    setStatus("Subject mappings not loaded → using raw subject codes (check /data/subject-map.json).");
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

  // Detect blocks: Subject i, Attendance %, Stats...
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

      // Optional stats parsing if present
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
/**
 * Still supports mailto buttons, but *all wording comes from email-templates.json*.
 * If the json is missing or invalid, buttons are disabled.
 */
function openParentEmailViaBridge({ bridgeUrl, mailtoParent }) {
  // 1) Always open Bridge in a new tab (allowed from click)
  window.open(bridgeUrl, "_blank", "noopener,noreferrer");

  // 2) Try to open the mailto (Outlook). Some browsers allow it, some block it.
  // Using setTimeout often helps Chrome treat it as part of the user action.
  setTimeout(() => {
    try {
      window.location.href = mailtoParent;
    } catch (e) {
      // If blocked, fallback
      alert(
        "Bridge profile opened.\n\nYour browser blocked the email window.\nPlease click the button again, or use the Email Parent button."
      );
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
  if (!emailConfig?.templates?.[templateKey]) {
    return null;
  }

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

/* ---------------------------- Render ---------------------------- */

function render() {
  if (!students.length) {
    els.empty.style.display = "block";
    els.empty.textContent = "Upload a report to begin.";
    els.grid.innerHTML = "";
    els.statStudents.textContent = "0";
    els.statFlagged.textContent = "0";
    els.statRedOrange.textContent = "0";
    els.statHighUnjust.textContent = "0";
    els.statTitle.textContent = reportTitle || "—";
    return;
  }

  const q = els.search.value.trim().toLowerCase();
  const y = els.year.value;
  const tierFilter = els.tier.value;
  const sort = els.sort.value;

  const overallThresh = Number(els.overallThreshold.value) || 80;
  const subjThresh = Number(els.subjectThreshold.value) || 80;
  const unjustThresh = Number(els.unjustThreshold.value) || 10;
  const maxSubjects = Math.max(1, Math.min(12, Number(els.maxSubjects.value) || 5));
  const flaggedOnly = els.flagOnly.checked;

  const reasonFilters = {
    lowOverall: els.fLowOverall.checked,
    highUnjust: els.fHighUnjust.checked,
    lowSubject: els.fLowSubject.checked,
    missingSubject: els.fMissingSubject.checked
  };

  const anyReasonOn = Object.values(reasonFilters).some(v => v === true);
  const reasonGate = anyReasonOn ? reasonFilters : { lowOverall: true, highUnjust: true, lowSubject: true, missingSubject: true };

  let filtered = students.filter(s => {
    if (y && String(s.yearLevel) !== String(y)) return false;

    if (tierFilter) {
      const t = overallTier(s.presentPct);
      if (t !== tierFilter) return false;
    }

    if (q) {
      const hay = `${s.lastName} ${s.firstName} ${s.studentId} ${s.formClass} ${s.timetableClass}`.toLowerCase();
      if (!hay.includes(q)) return false;
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

  els.statStudents.textContent = filtered.length;
  els.statFlagged.textContent = flaggedCount;
  els.statRedOrange.textContent = redOrange;
  els.statHighUnjust.textContent = highUnjustCount;
  els.statTitle.textContent = reportTitle || "—";

  els.grid.innerHTML = "";
  if (!filtered.length) {
    els.empty.style.display = "block";
    els.empty.textContent = "No students match your filters.";
    return;
  }
  els.empty.style.display = "none";

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

    const emailDisabled = !mailtoStudent || !mailtoParent;

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

const canEmail = !!mailtoParent && !!mailtoStudent;

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
      canEmail
        ? `<button class="emailBtn secondary" type="button" data-action="parent-via-bridge">
             Email Parent (via Bridge)
           </button>`
        : `<button class="emailBtn secondary" disabled type="button">
             Email Parent (templates missing)
           </button>`
    }

    <a class="emailBtn" href="${mailtoStudent || "#"}"
       onclick="event.stopPropagation(); ${mailtoStudent ? "" : "return false;"}"
       ${mailtoStudent ? "" : "aria-disabled='true' style='opacity:0.5; pointer-events:none;'"}>
      Email Student Check-in
    </a>

    <a class="emailBtn secondary" href="${bridgeUrl}" target="_blank" rel="noreferrer"
       onclick="event.stopPropagation();">
      Open Bridge Profile
    </a>

    <span class="tiny">
      Parent email: click “Email Parent (via Bridge)” → copy email from Bridge → send
    </span>
  </div>

  <div class="details">
    <h4>Worst ${maxSubjects} subjects (click card to collapse)</h4>
    ${detailsHtml || `<div class="empty" style="box-shadow:none;">No subject data found.</div>`}
  </div>
`;


    card.addEventListener("click", () => card.classList.toggle("expanded"));
    els.grid.appendChild(card);
  }
}

/* ---------------------- Wiring ---------------------- */

function wireInputs() {
  els.closeAdvancedBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.advanced.open = false;
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
  wireInputs();
  wireFileUpload();
  await initConfigs();
  setStatus("Ready. Upload a CSV.");
  render();
})();


