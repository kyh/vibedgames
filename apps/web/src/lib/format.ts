/**
 * Date formatting for SSR'd UI.
 *
 * Both formatters pin locale AND time zone. The Worker renders in UTC with
 * an `en-US` default while the browser renders in the visitor's locale and
 * zone, so an unpinned `toLocaleDateString()` produces a different string
 * on each side — a hydration mismatch, and for dates near midnight a
 * different calendar day. Formatters are module-level because
 * `Intl.DateTimeFormat` construction is the expensive part.
 */
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});

/** "Jan 15, 2026". */
export const formatDate = (value: Date | string | number): string =>
  dateFormatter.format(new Date(value));

/**
 * "Jan 15", with the year appended once it stops being the current year.
 * The year comparison is UTC on both sides so server and client agree on
 * which branch they took.
 */
export const formatDateCompact = (value: Date | string | number): string => {
  const date = new Date(value);
  return date.getUTCFullYear() === new Date().getUTCFullYear()
    ? shortDateFormatter.format(date)
    : dateFormatter.format(date);
};
