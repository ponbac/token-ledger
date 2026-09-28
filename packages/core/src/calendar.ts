import { DateTime, Schema } from "effect";

import type { Day } from "./model.ts";

const decodeCalendarParts = Schema.decodeUnknownSync(
  Schema.Struct({
    era: Schema.Literals(["BC", "AD"]),
    year: Schema.NumberFromString,
    month: Schema.NumberFromString,
    day: Schema.NumberFromString,
    hour: Schema.NumberFromString,
    minute: Schema.NumberFromString,
    second: Schema.NumberFromString,
  }),
);

/** A half-open range of instants in epoch milliseconds. */
export interface InstantRange {
  /** Inclusive. */
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

/** Local calendar days from `since` through `until`; `start` begins `since` and `end` follows `until`. */
export interface DayWindow extends InstantRange {
  /** The local day containing an instant, or `undefined` outside `[start, end)`. */
  readonly dayOf: (timestamp: number) => Day | undefined;
}

/** Moves a zone-free calendar day by whole days. */
export function addDays(day: Day, days: number): Day {
  return DateTime.formatIsoDateUtc(DateTime.add(DateTime.makeUnsafe(day), { days }));
}

/**
 * Resolves an inclusive range of local days to UTC instants. Each day starts at local
 * midnight, or when the clocks jump past a skipped midnight, so a day can last 23 or 25 hours.
 */
export function dayWindow(since: Day, until: Day, timeZone: DateTime.TimeZone): DayWindow {
  const first = DateTime.makeUnsafe(since);

  const eraFormatter = DateTime.isTimeZoneNamed(timeZone)
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: timeZone.id,
        calendar: "gregory",
        numberingSystem: "latn",
        era: "short",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        hourCycle: "h23",
      })
    : undefined;

  // Count days numerically: the day after 9999-12-31 has no four-digit form to compare.
  const count = Math.max(
    0,
    Math.round(
      (DateTime.toEpochMillis(DateTime.makeUnsafe(until)) - first.epochMilliseconds) / 86_400_000,
    ) + 1,
  );

  const midnight = (offset: number) => {
    const local = DateTime.add(first, { days: offset });

    if (eraFormatter !== undefined) {
      const { era, year, ...parts } = decodeCalendarParts(
        Object.fromEntries(
          eraFormatter
            .formatToParts(local.epochMilliseconds)
            .map((part) => [part.type, part.value]),
        ),
      );

      if (era === "BC") {
        // Pinned Effect omits Intl's era in its historical-offset fallback. BC year n
        // is astronomical year 1 - n; IANA's initial offsets are fixed in this era.
        const adjusted = DateTime.makeUnsafe({ ...parts, year: 1 - year });
        const zoneOffset = adjusted.epochMilliseconds - local.epochMilliseconds;

        return local.epochMilliseconds - zoneOffset;
      }
    }

    return DateTime.toEpochMillis(
      DateTime.setZone(local, timeZone, {
        adjustForTimeZone: true,
      }),
    );
  };

  const days = Array.from({ length: count }, (_, offset) => ({
    day: addDays(since, offset),
    start: midnight(offset),
  }));

  const end = midnight(count);
  const start = days[0]?.start ?? end;

  return {
    start,
    end,
    dayOf(timestamp) {
      if (!(timestamp >= start && timestamp < end)) return undefined;
      // Binary search for the last day starting at or before the instant.
      let low = 0;
      let high = days.length - 1;

      while (low < high) {
        const middle = Math.ceil((low + high) / 2);

        if ((days[middle]?.start ?? end) <= timestamp) low = middle;
        else high = middle - 1;
      }

      return days[low]?.day;
    },
  };
}
