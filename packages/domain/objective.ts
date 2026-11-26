/** Date-only deadlines are inclusive for the entire specified local day. */
export type Deadline =
  | { kind: "date"; value: string; timeZone?: string; verified?: boolean }
  | { kind: "instant"; value: string; verified?: boolean };

export type DeadlineStatus = "expired" | "not_expired" | "unknown";

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function validDateString(value: string): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return (
    parts !== null &&
    validDate(Number(parts[1]), Number(parts[2]), Number(parts[3]))
  );
}

function validInstant(value: string): boolean {
  const parts =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!parts || !validDateString(parts[1]!)) return false;
  if (Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59)
    return false;
  const offset = parts[5]!;
  if (
    offset !== "Z" &&
    (Number(offset.slice(1, 3)) > 23 ||
      Number(offset.slice(4, 6)) > 59 ||
      offset === "-00:00")
  )
    return false;
  return Number.isFinite(Date.parse(value));
}

/** An instant expires strictly after its stated timestamp; equality remains open.
 * A date expires only after the local date advances in the explicitly supplied timezone.
 * Invalid, incomplete, unverified or absent data yields unknown, not an inferred expiry.
 */
export function deadlineStatus(
  deadline: Deadline | undefined,
  now: Date,
): DeadlineStatus {
  if (
    !deadline ||
    deadline.verified !== true ||
    !Number.isFinite(now.getTime())
  )
    return "unknown";
  if (deadline.kind === "instant") {
    if (!validInstant(deadline.value)) return "unknown";
    return now.getTime() > Date.parse(deadline.value)
      ? "expired"
      : "not_expired";
  }
  if (!validDateString(deadline.value) || !deadline.timeZone) return "unknown";
  try {
    const parts = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
      timeZone: deadline.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const field = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;
    const year = field("year"),
      month = field("month"),
      day = field("day");
    if (!year || !month || !day) return "unknown";
    const today = `${year.padStart(4, "0")}-${month}-${day}`;
    return today > deadline.value ? "expired" : "not_expired";
  } catch {
    return "unknown";
  }
}

export interface ExperienceInterval {
  /** Inclusive UTC epoch milliseconds; the interval is [start, end). */
  start: number;
  /** Exclusive UTC epoch milliseconds. */
  end: number;
}

/** Counts union duration in milliseconds for reliable, nonempty half-open intervals. */
export function unionDurationMs(
  intervals: readonly ExperienceInterval[],
): number {
  for (const { start, end } of intervals) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= end
    ) {
      throw new RangeError(
        "Experience intervals must have safe integer boundaries with start before end",
      );
    }
  }
  const sorted = [...intervals].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  if (sorted.length === 0) return 0;
  let start = sorted[0]!.start;
  let end = sorted[0]!.end;
  let total = 0;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= end) end = Math.max(end, interval.end);
    else {
      total += end - start;
      start = interval.start;
      end = interval.end;
    }
  }
  total += end - start;
  if (!Number.isSafeInteger(total))
    throw new RangeError("Union duration exceeds the safe integer range");
  return total;
}

export interface ConfirmedNumber {
  value: number;
  unit: string;
  verified?: boolean;
}

/** Compares only explicitly verified values in identical, explicit units.
 * This helper does not decide whether a threshold is mandatory.
 */
export function numericThresholdStatus(
  actual: ConfirmedNumber | undefined,
  threshold: ConfirmedNumber | undefined,
  direction: "minimum" | "maximum",
): "met" | "not_met" | "unknown" {
  if (
    !actual ||
    !threshold ||
    actual.verified !== true ||
    threshold.verified !== true ||
    !Number.isFinite(actual.value) ||
    !Number.isFinite(threshold.value) ||
    actual.unit.trim() === "" ||
    threshold.unit.trim() === "" ||
    actual.unit !== threshold.unit ||
    (direction !== "minimum" && direction !== "maximum")
  )
    return "unknown";
  const matches =
    direction === "minimum"
      ? actual.value >= threshold.value
      : actual.value <= threshold.value;
  return matches ? "met" : "not_met";
}
