/**
 * Member/applicant Kakao messages are held overnight in Korea.
 * Operator messages should not call this helper.
 */
export function nextMemberKakaoAllowedAt(now = new Date()): string | null {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  const year = Number(value("year"));
  const month = Number(value("month"));
  const day = Number(value("day"));
  const hour = Number(value("hour"));
  if (![year, month, day, hour].every(Number.isFinite)) return null;
  if (hour >= 8 && hour < 22) return null;

  const dayOffset = hour >= 22 ? 1 : 0;
  // 08:00 KST is 23:00 UTC on the previous calendar day.
  return new Date(Date.UTC(year, month - 1, day + dayOffset, -1)).toISOString();
}
