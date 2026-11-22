const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** "Jan 15, 2026". */
export const formatDate = (value: Date | string | number) => dateFormatter.format(new Date(value));

/**
 * "Jan 15", with the year appended once it stops being the current year.
 * The year comparison is UTC on both sides so server and client agree on
 * which branch they took.
 */
export const formatDateCompact = (value: Date | string | number) => {
  const date = new Date(value);

  return date.getUTCFullYear() === new Date().getUTCFullYear()
    ? shortDateFormatter.format(date)
    : dateFormatter.format(date);
};
