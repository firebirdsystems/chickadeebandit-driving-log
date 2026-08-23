import { isAdult } from "./shared.js";
export { isAdult };

export const DEFAULT_GOAL = { total_minutes: 3000, night_minutes: 600 };

// Only adults may append notes / void entries (mirrors notes.write_acl require_role
// adult). The teen driver logs and attests; the supervising adult countersigns/voids.
export function canSupervise(member) {
  return isAdult(member);
}

// A drive is certified iff its (endpoint-written) certification row is locked.
export function isCertified(certification) {
  return !!certification && certification.status === "locked";
}

// A drive is voided iff an adult appended a 'void' note for it.
export function isVoided(driveId, notes) {
  return notes.some((n) => n.drive_id === driveId && n.kind === "void");
}

// Whole-hours + remaining-minutes label, e.g. 3125 → "52h 5m".
export function fmtDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function clampPct(done, goal) {
  if (!goal || goal <= 0) return done > 0 ? 100 : 0;
  return Math.min(100, Math.round((done / goal) * 100));
}

// Progress toward a driver's goal, counting only certified, non-voided drives.
// certById maps drive id → certification row.
export function computeProgress(drives, certById, notes, goal = DEFAULT_GOAL) {
  let total = 0, night = 0, certifiedCount = 0, pendingCount = 0;
  for (const d of drives) {
    if (isVoided(d.id, notes)) continue;
    const cert = certById.get ? certById.get(d.id) : certById[d.id];
    if (isCertified(cert)) {
      total += Number(d.minutes) || 0;
      night += Number(d.night_minutes) || 0;
      certifiedCount++;
    } else {
      pendingCount++;
    }
  }
  return {
    total, night, certifiedCount, pendingCount,
    totalPct: clampPct(total, goal.total_minutes),
    nightPct: clampPct(night, goal.night_minutes),
    complete: total >= goal.total_minutes && night >= goal.night_minutes,
  };
}

// Certification lifecycle state for a single drive, for UI badges.
export function certState(driveId, certById, notes) {
  if (isVoided(driveId, notes)) return "voided";
  const cert = certById.get ? certById.get(driveId) : certById[driveId];
  if (isCertified(cert)) return "certified";
  if (cert && (cert.driver_attested || cert.supervisor_signed)) return "awaiting";
  return "unsigned";
}

// Build a DMV-ready CSV of certified, non-voided drives. nameFn resolves member ids.
export function buildCsv(drives, certById, notes, nameFn) {
  const rows = [["Date", "Driver", "Supervisor", "Minutes", "Night minutes", "Weather", "Road"]];
  for (const d of [...drives].sort((a, b) => a.date.localeCompare(b.date))) {
    if (isVoided(d.id, notes)) continue;
    const cert = certById.get ? certById.get(d.id) : certById[d.id];
    if (!isCertified(cert)) continue;
    rows.push([
      d.date, nameFn(d.driver_id), nameFn(d.supervisor_id),
      String(d.minutes ?? 0), String(d.night_minutes ?? 0), d.weather ?? "", d.road ?? "",
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
/**
 * Leading characters that make a spreadsheet treat a cell as a formula rather
 * than text. Tab and CR are included because Excel strips them before parsing,
 * so `\t=cmd` reaches the formula parser as `=cmd`.
 *
 * Kept character-for-character identical to the hub's own export guard
 * (cloudflare/reports.ts) — one product must not neutralise the same attack
 * two different ways.
 */
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One CSV cell: formula-neutralised, then quoted only where CSV requires it.
 *
 * Quoting is not a defence on its own — a quoted field beginning with a
 * formula lead-in is still handed to the formula parser when the file opens.
 * This export matters more than most: it is a DMV-ready log that LEAVES the
 * household, so the cell that executes may do so on an examiner's or
 * insurer's machine, and the values are free text (weather, road) plus member
 * names. A leading apostrophe is the spreadsheet's own "treat as text" marker.
 *
 * Exported so the guard is directly testable — a defence with no test of its
 * own is one refactor from silently reverting.
 */
export function csvCell(v) {
  const s = String(v ?? "");
  const guarded = CSV_FORMULA_LEAD.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * Fields the in-app search matches against (see hub-sdk `searchMatch`).
 * Weather and road type are searchable because a DMV log is reviewed
 * by condition — "how much night driving in rain" — not by date alone.
 */
export function searchableFields(item) {
  return [item.date, item.weather, item.road, item.notes];
}
