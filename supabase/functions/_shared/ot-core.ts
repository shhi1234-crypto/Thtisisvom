export const VIDEO_BUCKET = "ot-review-videos";
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const REVIEW_MINUTES = 180;
export const APP_ORIGINS = new Set(["https://thisisvom.vercel.app", "https://www.thisisvom.vercel.app"]);
export const DEFAULT_ORIGIN = "https://thisisvom.vercel.app";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = "request_failed") { super(message); }
}

export function isRegistrationOpen(now = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", hour: "2-digit", hourCycle: "h23" }).format(now));
  return hour >= 9 && hour < 18;
}

export function requireOpen(now = new Date()) {
  if (!isRegistrationOpen(now)) throw new ApiError(403, "영상·음성 등록은 한국시간 오전 9시부터 오후 6시 전까지 가능합니다.", "room_closed");
}

export function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function newToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
}

export async function tokenHash(token: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), b => b.toString(16).padStart(2, "0")).join("");
}

export function textField(value: unknown, max: number, label: string) {
  if (typeof value !== "string") throw new ApiError(400, `${label}을 입력해 주세요.`);
  const valueTrimmed = value.trim();
  if (!valueTrimmed || Array.from(valueTrimmed).length > max || /[\x00-\x1f\x7f]/.test(valueTrimmed)) throw new ApiError(400, `${label}을 ${max}자 이내로 입력해 주세요.`);
  return valueTrimmed;
}

export function positiveInt(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ApiError(400, "요청 번호를 확인해 주세요.");
  return parsed;
}

export function signupDetails(body: any, now = new Date()) {
  const year = String(body.birth_year ?? "");
  const currentYear = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" }).format(now));
  if (!/^\d{4}$/.test(year) || Number(year) < 1900 || Number(year) > currentYear) throw new ApiError(400, "출생연도를 4자리로 입력해 주세요. 예: 1995");
  const unit = body.busking_experience_unit;
  const raw = String(body.busking_experience ?? "");
  const value = Number(raw);
  if (!["COUNT", "YEARS"].includes(unit) || !/^\d+(?:\.\d{1,2})?$/.test(raw) || !Number.isFinite(value) || value < 0 || value > (unit === "COUNT" ? 10000 : 100) || (unit === "COUNT" && !Number.isInteger(value))) throw new ApiError(400, "버스킹 경험을 횟수 또는 년수로 입력해 주세요. 경험이 없으면 0을 입력합니다.");
  return { birth_year: Number(year), job: textField(body.job, 80, "직업"), busking_experience: value, busking_experience_unit: unit, form_version: 2 };
}

export async function validatePhoto(file: File): Promise<{ mime: string; extension: string }> {
  if (!file.size || file.size > MAX_PHOTO_BYTES) throw new ApiError(400, "본인사진은 5MB 이하로 등록해 주세요.");
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const a = (s: number, e: number) => String.fromCharCode(...b.slice(s, e));
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return { mime: "image/jpeg", extension: "jpg" };
  if (b.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i) => b[i] === v)) return { mime: "image/png", extension: "png" };
  if (b.length >= 12 && a(0,4) === "RIFF" && a(8,12) === "WEBP") return { mime: "image/webp", extension: "webp" };
  throw new ApiError(400, "JPG, PNG 또는 WEBP 본인사진을 선택해 주세요.");
}

export async function validateVideo(file: File): Promise<{ mime: string; extension: string }> {
  if (!file.size || file.size > MAX_VIDEO_BYTES) throw new ApiError(400, "영상·음성 파일은 0바이트보다 크고 50MB 이하여야 합니다.");
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 16 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (/^M4[ABP] /.test(brand) || /\.(m4a|m4b)$/i.test(file.name) || file.type === "audio/mp4") return { mime: "audio/mp4", extension: "m4a" };
    if (brand === "qt  ") return { mime: "video/quicktime", extension: "mov" };
    if (brand.startsWith("3gp")) return { mime: "video/3gpp", extension: "3gp" };
    return { mime: "video/mp4", extension: "mp4" };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { mime: file.type.startsWith("audio/") ? "audio/webm" : "video/webm", extension: "webm" };
  if (ascii(0,4) === "RIFF" && ascii(8,12) === "WAVE") return { mime: "audio/wav", extension: "wav" };
  if (ascii(0,4) === "OggS") return { mime: "audio/ogg", extension: "ogg" };
  if (ascii(0,4) === "fLaC") return { mime: "audio/flac", extension: "flac" };
  if (ascii(0,4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(8,12))) return { mime: "audio/aiff", extension: "aiff" };
  if (bytes.length >= 4 && bytes[0] === 255 && (bytes[1] & 0xf6) === 0xf0) return { mime: "audio/aac", extension: "aac" };
  if (ascii(0,3) === "ID3" || (bytes.length >= 4 && bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0 && (bytes[1] & 24) !== 8 && (bytes[2] >> 4) > 0 && (bytes[2] >> 4) < 15)) return { mime: "audio/mpeg", extension: "mp3" };
  throw new ApiError(400, "MP4·MOV·WEBM·3GP 영상 또는 MP3·M4A·WAV·AAC·OGG·FLAC·AIFF 음성 파일을 선택해 주세요.");
}

export function headers(origin: string) {
  return {
    "Access-Control-Allow-Origin": APP_ORIGINS.has(origin) ? origin : DEFAULT_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-ot-invite",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin",
  };
}

export function json(origin: string, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: headers(origin) });
}

export function checkRequest(req: Request) {
  const origin = req.headers.get("origin") || DEFAULT_ORIGIN;
  if (req.headers.get("origin") && !APP_ORIGINS.has(origin)) throw new ApiError(403, "허용되지 않은 요청입니다.");
  if (req.method !== "POST" && req.method !== "OPTIONS") throw new ApiError(405, "POST 요청만 가능합니다.");
  return origin;
}

export function failure(origin: string, error: unknown) {
  if (error instanceof ApiError) return json(origin, { error: error.message, code: error.code }, error.status);
  // Do not log candidate names, invite tokens, media URLs, or raw database errors.
  console.error("OT request failed", error instanceof Error ? error.name : "server_error");
  return json(origin, { error: "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.", code: "server_error" }, 500);
}

export async function requireOperator(req: Request, service: any) {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new ApiError(401, "운영진 로그인이 필요합니다.");
  const { data, error } = await service.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, "로그인 정보를 확인하지 못했습니다.");
  const [{ data: admin, error: ae }, { data: member, error: me }, { data: access, error: oe }] = await Promise.all([
    service.from("admins").select("user_id").eq("user_id", data.user.id).maybeSingle(),
    service.from("members").select("id,name,role,is_active").eq("auth_user_id", data.user.id).maybeSingle(),
    service.from("ot_room_operator_access").select("member_id").eq("user_id", data.user.id).is("revoked_at", null).maybeSingle(),
  ]);
  if (ae || me || oe) throw new Error("operator_lookup_failed");
  const isAdmin = !!admin;
  if (!isAdmin && !(member?.role === "운영진" && member.is_active && Number(access?.member_id) === Number(member.id))) throw new ApiError(403, "OT 검토 권한이 필요합니다. 관리자에게 계정 확인을 요청해 주세요.");
  return { userId: data.user.id, isAdmin, memberId: member?.role === "운영진" && member.is_active ? Number(member.id) : null, name: member?.name || "관리자" };
}
