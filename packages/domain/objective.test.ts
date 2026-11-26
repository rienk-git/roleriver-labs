import { describe, expect, it } from "vitest";
import {
  deadlineStatus,
  numericThresholdStatus,
  unionDurationMs,
} from "./objective.js";

describe("deadline status", () => {
  const now = new Date("2026-06-01T10:00:00Z");
  it("returns unknown for missing deadlines and date-only values without timezone", () => {
    expect(deadlineStatus(undefined, now)).toBe("unknown");
    expect(
      deadlineStatus(
        { kind: "date", verified: true, value: "2026-05-31" },
        now,
      ),
    ).toBe("unknown");
  });
  it("keeps unverified or implicitly unverified deadlines unknown", () => {
    const value = "2020-01-01T00:00:00Z";
    expect(deadlineStatus({ kind: "instant", value }, now)).toBe("unknown");
    expect(
      deadlineStatus({ kind: "instant", value, verified: false }, now),
    ).toBe("unknown");
    expect(
      deadlineStatus(
        { kind: "date", value: "2020-01-01", timeZone: "UTC" },
        now,
      ),
    ).toBe("unknown");
  });
  it("compares verified instants including offsets, with equality still open", () => {
    expect(
      deadlineStatus(
        { kind: "instant", verified: true, value: "2026-06-01T11:59:59+02:00" },
        now,
      ),
    ).toBe("expired");
    expect(
      deadlineStatus(
        { kind: "instant", verified: true, value: "2026-06-01T12:00:00+02:00" },
        now,
      ),
    ).toBe("not_expired");
    expect(
      deadlineStatus(
        { kind: "instant", verified: true, value: "2026-06-01T10:00:01Z" },
        now,
      ),
    ).toBe("not_expired");
  });
  it("keeps the whole local calendar day open including DST transitions", () => {
    const deadline = {
      kind: "date" as const,
      verified: true,
      value: "2026-03-29",
      timeZone: "Europe/Amsterdam",
    };
    expect(deadlineStatus(deadline, new Date("2026-03-29T21:59:59Z"))).toBe(
      "not_expired",
    );
    expect(deadlineStatus(deadline, new Date("2026-03-29T22:00:00Z"))).toBe(
      "expired",
    );
  });
  it("returns unknown for malformed, nonexistent dates, missing offsets and invalid timezones", () => {
    expect(
      deadlineStatus(
        { kind: "date", verified: true, value: "2026-02-30", timeZone: "UTC" },
        now,
      ),
    ).toBe("unknown");
    expect(
      deadlineStatus(
        { kind: "instant", verified: true, value: "2026-06-01T12:00:00" },
        now,
      ),
    ).toBe("unknown");
    expect(
      deadlineStatus(
        { kind: "instant", verified: true, value: "2026-02-30T12:00:00Z" },
        now,
      ),
    ).toBe("unknown");
    expect(
      deadlineStatus(
        {
          kind: "date",
          verified: true,
          value: "2026-01-01",
          timeZone: "invalid/timezone",
        },
        now,
      ),
    ).toBe("unknown");
    expect(
      deadlineStatus(
        { kind: "instant", verified: true, value: "2026-01-01T12:00:00Z" },
        new Date(NaN),
      ),
    ).toBe("unknown");
  });
});

describe("experience interval union", () => {
  it("counts overlapping, nested and duplicate intervals once, independently of order", () => {
    const intervals = [
      { start: 10, end: 20 },
      { start: 0, end: 15 },
      { start: 3, end: 4 },
      { start: 0, end: 15 },
      { start: 30, end: 35 },
    ];
    expect(unionDurationMs(intervals)).toBe(25);
    expect(unionDurationMs([...intervals].reverse())).toBe(25);
  });
  it("handles adjacent ranges and no ranges", () => {
    expect(
      unionDurationMs([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ]),
    ).toBe(20);
    expect(unionDurationMs([])).toBe(0);
  });
  it.each([
    { start: 1, end: 0 },
    { start: 1, end: 1 },
    { start: NaN, end: 1 },
    { start: 0.5, end: 1 },
  ])("rejects invalid or empty ranges", (interval) => {
    expect(() => unionDurationMs([interval])).toThrow();
  });
});

describe("confirmed numeric thresholds", () => {
  it("compares explicit verified values with matching units at inclusive boundaries", () => {
    const threshold = { value: 100, unit: "EUR/hour", verified: true };
    expect(
      numericThresholdStatus(
        { value: 100, unit: "EUR/hour", verified: true },
        threshold,
        "minimum",
      ),
    ).toBe("met");
    expect(
      numericThresholdStatus(
        { value: 99, unit: "EUR/hour", verified: true },
        threshold,
        "minimum",
      ),
    ).toBe("not_met");
    expect(
      numericThresholdStatus(
        { value: 101, unit: "EUR/hour", verified: true },
        threshold,
        "maximum",
      ),
    ).toBe("not_met");
  });
  it("returns unknown for missing, unverified, invalid, or non-comparable values", () => {
    const threshold = { value: 100, unit: "EUR/hour", verified: true };
    expect(numericThresholdStatus(undefined, threshold, "minimum")).toBe(
      "unknown",
    );
    expect(
      numericThresholdStatus(
        { value: 99, unit: "EUR/hour" },
        threshold,
        "minimum",
      ),
    ).toBe("unknown");
    expect(
      numericThresholdStatus(
        { value: 99, unit: "USD/hour", verified: true },
        threshold,
        "minimum",
      ),
    ).toBe("unknown");
    expect(
      numericThresholdStatus(
        { value: NaN, unit: "EUR/hour", verified: true },
        threshold,
        "minimum",
      ),
    ).toBe("unknown");
    expect(
      numericThresholdStatus(
        { value: 99, unit: " ", verified: true },
        { value: 100, unit: " ", verified: true },
        "minimum",
      ),
    ).toBe("unknown");
  });
});
