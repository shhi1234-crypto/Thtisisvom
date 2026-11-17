export function memberMessageNextAttemptAt(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  const reportedHour = Number(get("hour"));
  const hour = reportedHour === 24 ? 0 : reportedHour;
  const minute = Number(get("minute"));
  if (!(hour >= 22 || hour < 8)) return null;

  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day")) + (hour >= 22 ? 1 : 0);
  // 08:00 in Seoul is 23:00 UTC on the previous calendar date.
  return new Date(Date.UTC(year, month - 1, day, -1, 0, 0)).toISOString();
}

export function retryDelayMs(attempt: number) {
  const delays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
  return delays[Math.max(0, Math.min(delays.length - 1, Math.trunc(attempt) - 1))];
}

export function retryableProviderFailure(httpStatus: number, providerStatus: unknown) {
  const code = String(providerStatus ?? "");
  return httpStatus === 408 || httpStatus === 425 || httpStatus === 429 || httpStatus >= 500 ||
    code === "408" || code === "425" || code === "429" || /^5\d\d$/.test(code);
}

