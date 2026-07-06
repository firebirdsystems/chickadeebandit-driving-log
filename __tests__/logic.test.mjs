import { describe, it, expect } from "vitest";
import {
  canSupervise, isCertified, isVoided, fmtDuration, computeProgress, certState, buildCsv, DEFAULT_GOAL,
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
});
