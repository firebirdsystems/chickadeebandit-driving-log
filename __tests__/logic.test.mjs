import { describe, it, expect } from "vitest";
import {
  canSupervise, isCertified, isVoided, fmtDuration, computeProgress, certState, buildCsv, csvCell, DEFAULT_GOAL, searchableFields,
} from "../src/logic.js";

describe("canSupervise mirrors adult write_acl", () => {
  it("adults can", () => expect(canSupervise({ role: "adult" })).toBe(true));
  it("children cannot", () => expect(canSupervise({ role: "child" })).toBe(false));
});

describe("isCertified", () => {
  it("locked is certified", () => expect(isCertified({ status: "locked" })).toBe(true));
  it("pending is not", () => expect(isCertified({ status: "pending" })).toBe(false));
  it("missing is not", () => expect(isCertified(null)).toBe(false));
});

describe("isVoided", () => {
  const notes = [{ drive_id: "d1", kind: "void" }, { drive_id: "d2", kind: "note" }];
  it("detects a void note", () => expect(isVoided("d1", notes)).toBe(true));
  it("plain notes don't void", () => expect(isVoided("d2", notes)).toBe(false));
});

describe("fmtDuration", () => {
  it("formats hours and minutes", () => {
    expect(fmtDuration(3125)).toBe("52h 5m");
    expect(fmtDuration(0)).toBe("0h 0m");
    expect(fmtDuration(-9)).toBe("0h 0m");
  });
});

describe("computeProgress", () => {
  const drives = [
    { id: "d1", minutes: 1800, night_minutes: 300 }, // certified
    { id: "d2", minutes: 1200, night_minutes: 300 }, // certified
    { id: "d3", minutes: 600, night_minutes: 0 },    // pending
    { id: "d4", minutes: 5000, night_minutes: 0 },   // certified but voided
  ];
  const certById = new Map([
    ["d1", { status: "locked" }],
    ["d2", { status: "locked" }],
    ["d3", { status: "pending", driver_attested: 1 }],
    ["d4", { status: "locked" }],
  ]);
  const notes = [{ drive_id: "d4", kind: "void" }];

  it("counts only certified, non-voided drives", () => {
    const p = computeProgress(drives, certById, notes, DEFAULT_GOAL);
    expect(p.total).toBe(3000);        // d1+d2, d4 voided excluded
    expect(p.night).toBe(600);
    expect(p.certifiedCount).toBe(2);
    expect(p.pendingCount).toBe(1);    // d3
    expect(p.totalPct).toBe(100);
    expect(p.nightPct).toBe(100);
    expect(p.complete).toBe(true);
  });

  it("caps percentages at 100 and handles partials", () => {
    const p = computeProgress([{ id: "x", minutes: 750, night_minutes: 0 }],
      new Map([["x", { status: "locked" }]]), [], DEFAULT_GOAL);
    expect(p.totalPct).toBe(25);       // 750/3000
    expect(p.complete).toBe(false);
  });
});

describe("certState", () => {
  const notes = [{ drive_id: "v", kind: "void" }];
  const certs = new Map([
    ["c", { status: "locked" }],
    ["a", { status: "pending", supervisor_signed: 1 }],
  ]);
  it("classifies each drive", () => {
    expect(certState("v", certs, notes)).toBe("voided");
    expect(certState("c", certs, notes)).toBe("certified");
    expect(certState("a", certs, notes)).toBe("awaiting");
    expect(certState("u", certs, notes)).toBe("unsigned");
  });
});

describe("buildCsv", () => {
  const drives = [
    { id: "d1", date: "2026-07-01", driver_id: "t", supervisor_id: "p", minutes: 60, night_minutes: 0, weather: "clear", road: "city" },
    { id: "d2", date: "2026-07-02", driver_id: "t", supervisor_id: "p", minutes: 30, night_minutes: 30, weather: "rain", road: "highway" }, // not certified
  ];
  const certs = new Map([["d1", { status: "locked" }], ["d2", { status: "pending" }]]);
  const nameFn = (id) => (id === "t" ? "Teen, \"T\"" : "Parent");
  it("includes only certified drives and escapes cells", () => {
    const csv = buildCsv(drives, certs, [], nameFn);
    const lines = csv.split("\r\n");
    expect(lines[0]).toMatch(/^Date,Driver/);
    expect(lines).toHaveLength(2);                 // header + d1 only
    expect(lines[1]).toContain('"Teen, ""T"""');   // CSV-escaped
  });

  // This file leaves the household — a DMV examiner or insurer opens it — so a
  // formula smuggled through a member name or a weather note would execute on
  // their machine, not ours. Quoting does not stop that; the apostrophe does.
  it("neutralises a formula smuggled in through a member name", () => {
    const hostile = (id) => (id === "t" ? `=cmd|' /C calc'!A0` : "Parent");
    const csv = buildCsv(drives, certs, [], hostile);
    const cells = csv.split("\r\n")[1].split(",");
    expect(cells.some(c => c.startsWith("=") || c.startsWith('"='))).toBe(false);
    // No comma or quote in the payload, so CSV quoting never triggers — the
    // apostrophe is doing all the work, which is exactly the point.
    expect(csv).toContain(`'=cmd|' /C calc'!A0`);
  });
});

describe("csvCell", () => {
  it("neutralises every formula lead-in a spreadsheet acts on", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    // Excel strips a leading tab/CR before parsing, so both smuggle a formula
    // past a naive "starts with =" check. Only the CR needs CSV quoting.
    expect(csvCell("\t=cmd")).toBe("'\t=cmd");
    expect(csvCell("\r=cmd")).toBe(`"'\r=cmd"`);
  });

  it("still quotes and escapes what CSV itself requires", () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell("Smith, Dana")).toBe('"Smith, Dana"');
    // A dangerous cell that also contains a comma needs both defences.
    expect(csvCell("=A1,B2")).toBe(`"'=A1,B2"`);
  });

  it("leaves ordinary values untouched", () => {
    expect(csvCell("clear")).toBe("clear");
    expect(csvCell("60")).toBe("60");
    expect(csvCell(null)).toBe("");
  });
});

describe("searchableFields", () => {
  it("matches on conditions, which is how a practice log gets reviewed", () => {
    const fields = searchableFields({ date: "2026-03-04", weather: "rain", road: "highway", notes: "first motorway merge" });
    expect(fields).toContain("rain");
    expect(fields).toContain("highway");
    expect(fields).toContain("first motorway merge");
  });
});
