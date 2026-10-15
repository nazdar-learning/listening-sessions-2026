// Builds prep/kit.enc: the HR prep kit's search data, gzipped then encrypted.
// The plain text never enters this repo. Run from the repo root:
//   PREP_PASS=... node tools/build-prep.mjs "<Meeting Transcripts folder>" [topics.json] [attendees.json]
// Keep topics.json and attendees.json outside this repo; they hold HR notes and names.
// Encryption: PBKDF2-SHA256 (600k rounds) -> AES-256-GCM. prep/index.html reverses it.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { webcrypto as crypto } from "node:crypto";
import { join } from "node:path";

const [dir, topicsPath, attendeesPath] = process.argv.slice(2);
const pass = process.env.PREP_PASS;
if (!dir || !pass) throw new Error("usage: PREP_PASS=... node tools/build-prep.mjs <dir> [topics.json] [attendees.json]");

// Session keys match data.js (a..h in date order).
const SESS = [
  ["a", "Session 1", "Sep 22", "Day"], ["b", "Session 4", "Sep 29", "Day"], ["c", "Mid-Shift Session 1", "Sep 30", "Mid"],
  ["d", "Session 3", "Oct 1", "Day"], ["e", "Session 6", "Oct 5", "Day"], ["f", "Session 5", "Oct 7", "Day"],
  ["g", "Mid-Shift Session 2", "Oct 8", "Mid"], ["h", "Session 2", "Oct 13", "Day"],
];
const keyFor = (title) => {
  const t = title.replace(/—/g, "-");
  const m = SESS.find(([, name]) => new RegExp("^" + name.replace(/-/g, "-") + " -").test(t));
  if (!m) throw new Error("no session for " + title);
  return m[0];
};

// Otter turns: "Speaker Name  mm:ss" then text lines until a blank line.
const turnsOf = (lines, src) => {
  const out = [];
  let cur = null;
  for (const line of lines) {
    // Names may include digits: Otter labels unknown voices "Speaker 12".
    const h = line.match(/^([A-Z][A-Za-z0-9 .'-]{1,40}?)\s{2,}(\d{1,2}:\d{2}(?::\d{2})?)$/);
    if (h) { cur = { src, sp: h[1].trim(), tm: h[2], x: "" }; out.push(cur); continue; }
    if (cur && line.trim()) cur.x += (cur.x ? " " : "") + line.trim();
  }
  return out.filter((t) => t.x);
};

// 1. Session transcripts (two phones for most sessions; both kept, labeled).
const combined = readFileSync(join(dir, "Listening Sessions - Combined Transcripts.txt"), "utf8").split(/\r?\n/);
const recordings = [];
let turns = [];
for (let i = 0; i < combined.length; i++) {
  const m = combined[i].match(/^(\d+)\. (.+ 2026)(?: — (\w+) phone)?$/);
  if (!m || combined[i - 1]?.[0] !== "=") continue;
  const start = combined.indexOf("--- FULL TRANSCRIPT ---", i);
  let end = combined.findIndex((l, j) => j > start && /^={20}/.test(l));
  if (end < 0) end = combined.length;
  const r = recordings.length;
  recordings.push({ s: keyFor(m[2]), phone: m[3] || "" });
  turns = turns.concat(turnsOf(combined.slice(start + 1, end), r));
}

// HR huddles are deliberately left out: their content reaches the kit only
// through the talking-point cards (topics.json). Only listening sessions are quoted.

// 2. Recap notes: one entry per bullet or table row, with its heading path.
const recapDir = join(dir, "Listening Session Recaps");
const notes = [];
readdirSync(recapDir).filter((f) => /^\d\d .*\.md$/.test(f)).sort().forEach((f, n) => {
  const s = SESS[n][0];
  let h2 = "", h3 = "", sub = "";
  for (const raw of readFileSync(join(recapDir, f), "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^\|?\s*-{3}/.test(line) || /^# /.test(line)) continue;
    if (/^## /.test(line)) { h2 = line.slice(3); h3 = sub = ""; continue; }
    // HR's own notes (chat cross-checks, next-session planning, series wrap-up) are not shown.
    if (/^(Cross-check|Next session|Wrapping up)/.test(h2)) continue;
    if (/^### /.test(line)) { h3 = line.slice(4); sub = ""; continue; }
    if (/^\*\*[^*]+\*\*$/.test(line)) { sub = line.slice(2, -2); continue; }
    const x = line.replace(/^[-*] |^\d+\. /, "").replace(/^\|\s*|\s*\|$/g, "").replace(/\s*\|\s*/g, " · ");
    notes.push({ s, h: [h2, h3, sub].filter(Boolean).join(" / "), x });
  }
});

// Rosters come from the original page's data script (window.LISTENING_DATA.SESSIONS[].people).
function rosters(path) {
  const window = {};
  new Function("window", readFileSync(path, "utf8"))(window);
  return Object.fromEntries(window.LISTENING_DATA.SESSIONS.map((s) => [s.k, s.people || []]));
}

const kit = {
  built: new Date().toISOString().slice(0, 10),
  sessions: SESS.map(([k, name, label, shift]) => ({ k, name, label, shift })),
  recordings, turns, notes,
  topics: topicsPath ? JSON.parse(readFileSync(topicsPath, "utf8")) : [],
  attendees: attendeesPath ? rosters(attendeesPath) : {},
};

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, gzipSync(JSON.stringify(kit))));
writeFileSync("prep/kit.enc", Buffer.concat([salt, iv, ct]));
console.log(`recordings ${recordings.length}, turns ${turns.length}, notes ${notes.length}, topics ${kit.topics.length}, bytes ${16 + 12 + ct.length}`);
