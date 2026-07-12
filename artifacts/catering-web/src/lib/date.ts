const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateLocal(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function isDateOnlyString(value: unknown): value is string {
  return typeof value === "string" && DATE_ONLY_RE.test(value);
}

export function formatLocalDate(
  dateStr: string,
  options: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric", year: "numeric" },
): string {
  return parseDateLocal(dateStr).toLocaleDateString("en-US", options);
}
