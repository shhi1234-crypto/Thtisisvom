import { ApiError, isRegistrationOpen, newToken, tokenHash, validateVideo } from "../supabase/functions/_shared/ot-core.ts";
import { handle as room } from "../supabase/functions/ot-room/index.ts";
import { handle as review } from "../supabase/functions/ot-review/index.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition { if (!condition) throw new Error(message); }
async function status(response: Response, expected: number) { assert(response.status === expected, "expected " + expected + ", got " + response.status + ": " + await response.clone().text()); }
const token = "a".repeat(64);
const userId = "b".repeat(36);
const inviteId = "8d98f633-2f22-4cd5-9a8b-690228e125a5";
const openNow = () => new Date("2026-10-07T01:00:00Z");

// A small behavior fake covers trust boundaries; database atomicity is tested
// separately against PostgreSQL with the actual migration and existing schema.
function fake(options: Record<string, any> = {}) {
  const state = { removed: [] as string[], uploaded: [] as string[], rpcCalls: [] as any[], operations: [] as any[], committed: false };
  const user = options.user ?? { id: userId };
  function query(table: string) {
    let operation = "select", input: any, columns = "", filters: any[] = [];
    const q: any = {};
    for (const name of ["eq", "is", "gt", "lte", "or", "in", "order", "limit"]) q[name] = (...args: any[]) => { filters.push([name, ...args]); return q; };
    q.select = (value: string) => { columns = value; return q; };
    q.update = (value: any) => { operation = "update"; input = value; return q; };
    q.insert = (value: any) => { operation = "insert"; input = value; return q; };
    function result() {
      state.operations.push({ table, operation, input, columns, filters });
      if (table === "admins") return { data: options.admin ? { user_id: userId } : null, error: null };
      if (table === "members") return { data: options.member || null, error: null };
      if (table === "ot_room_operator_access") return { data: options.member && options.operatorAccess !== false ? { member_id: options.member.id } : null, error: null };
      if (table === "ot_room_invites") {
        if (operation === "update") {
          if (input.upload_claim_id && options.reserveBusy) return { data: null, error: null };
          return { data: { id: inviteId }, error: null };
        }
        if (options.inviteMissing) return { data: null, error: null };
        return { data: { id: inviteId, expires_at: options.expiresAt || "2026-10-09T00:00:00Z", revoked_at: options.revoked ? "2026-10-06T00:00:00Z" : null, review_id: state.committed || options.submitted ? 1 : null, somoim_nickname: "VOM 새 회원" }, error: null };
      }
      if (table === "ot_reviews") {
        if (operation === "update" && input.notification_claimed_at) return { data: null, error: null };
        return { data: { status: "IN_REVIEW", video_source: "FILE", video_file_path: "reviews/safe/video.mp4", completed_at: null }, error: null };
      }
      return { data: [], error: null };
    }
    q.maybeSingle = q.single = async () => result();
    q.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
    return q;
  }
  const client: any = {
    auth: { getUser: async () => ({ data: { user: options.unauthenticated ? null : user }, error: options.unauthenticated ? { message: "bad token" } : null }) },
    from: query,
    rpc: async (name: string, input: any) => {
      state.rpcCalls.push({ name, input });
      if (options.commitLost) { state.committed = true; return { data: null, error: { message: "network failure" } }; }
      if (options.rpcClosed) return { data: null, error: { message: "room_closed" } };
      state.committed = true; return { data: { id: 1, status: "IN_REVIEW" }, error: null };
    },
    storage: { from: () => ({
      upload: async (path: string) => { state.uploaded.push(path); return { error: null }; },
      remove: async (paths: string[]) => { state.removed.push(...paths); return { error: null }; },
      download: async () => ({ data: new Blob([new Uint8Array([1,2,3])], { type: "video/mp4" }), error: null }),
    }) },
  };
  return { client, state };
}
function infoRequest(candidateToken = token) { return new Request("https://edge.invalid/ot-room", { method: "POST", headers: { "Content-Type": "application/json", "x-ot-invite": candidateToken }, body: JSON.stringify({ action: "info" }) }); }
function videoFile() { const bytes = new Uint8Array(24); bytes.set(new TextEncoder().encode("ftypisom"), 4); return new File([bytes], "voice.mp4", { type: "video/mp4" }); }
function uploadRequest(file = videoFile()) { const form = new FormData(); form.set("candidate_name", "신규 회원"); form.set("somoim_nickname", "내 소모임 닉네임"); form.set("consent", "yes"); form.set("video", file); return new Request("https://edge.invalid/ot-room", { method: "POST", headers: { "x-ot-invite": token }, body: form }); }
function operatorRequest(body: any, withToken = true) { return new Request("https://edge.invalid/ot-review", { method: "POST", headers: { "Content-Type": "application/json", ...(withToken ? { Authorization: "Bearer legitimate-token" } : {}) }, body: JSON.stringify(body) }); }

Deno.test("KST admission boundaries: 09:00 inclusive, 18:00 exclusive and midnight", () => {
  for (const [value, expected] of [["2026-10-06T23:59:59Z", false], ["2026-10-07T00:00:00Z", true], ["2026-10-07T08:59:59Z", true], ["2026-10-07T09:00:00Z", false], ["2026-10-07T15:00:00Z", false]] as const) assert(isRegistrationOpen(new Date(value)) === expected, value);
});
Deno.test("tokens have 256-bit random input and only hashes are persisted", async () => { const first = newToken(), second = newToken(); assert(/^[a-f0-9]{64}$/.test(first)); assert(first !== second); const hash = await tokenHash(first); assert(hash.length === 64 && hash !== first && hash === await tokenHash(first)); });
Deno.test("HTML renamed to mp4 and zero byte media are rejected", async () => { for (const file of [new File(["<html>evil</html>"], "looks.mp4", { type: "video/mp4" }), new File([], "empty.mp4")]) { let rejected = false; try { await validateVideo(file); } catch (e) { rejected = e instanceof ApiError; } assert(rejected); } });
Deno.test("room refuses missing, expired and revoked invitations", async () => { await status(await room(infoRequest("bad"), fake().client, openNow), 404); for (const option of [{ inviteMissing: true }, { expiresAt: "2026-10-06T00:00:00Z" }, { revoked: true }]) await status(await room(infoRequest(), fake(option).client, openNow), 404); });
Deno.test("applicant status works after closing and contains no media or internal identity", async () => { const response = await room(infoRequest(), fake({ submitted: true }).client, () => new Date("2026-10-07T10:00:00Z")); await status(response, 200); const data = await response.text(); assert(!/file_path|video_url|token_hash|userId|eligible_operator/.test(data)); assert(JSON.parse(data).submitted); });
Deno.test("18:00 upload rejected before file storage", async () => { const { client, state } = fake(); await status(await room(uploadRequest(), client, () => new Date("2026-10-07T09:00:00Z")), 403); assert(!state.uploaded.length && !state.rpcCalls.length); });
Deno.test("duplicate and concurrent uploads rejected", async () => { for (const option of [{ submitted: true }, { reserveBusy: true }]) { const { client, state } = fake(option); await status(await room(uploadRequest(), client, openNow), 409); assert(!state.uploaded.length); } });
Deno.test("valid upload commits existing OT review before notification", async () => { const { client, state } = fake(); const response = await room(uploadRequest(), client, openNow); await status(response, 201); assert(state.uploaded.length === 1 && !state.removed.length); assert(state.rpcCalls[0].name === "vom_ot_finalize_upload"); assert(state.rpcCalls[0].input.p_somoim_nickname === "내 소모임 닉네임"); assert(!/file_path|signedUrl|video_url/.test(await response.text())); });
Deno.test("closing during SQL commit removes unregistered bytes and frees claim", async () => { const { client, state } = fake({ rpcClosed: true }); await status(await room(uploadRequest(), client, openNow), 403); assert(state.removed.length === 1); assert(state.operations.some(o => o.input?.upload_claim_id === null)); });
Deno.test("ambiguous RPC response never deletes media from a successful commit", async () => { const { client, state } = fake({ commitLost: true }); await status(await room(uploadRequest(), client, openNow), 409); assert(state.committed && !state.removed.length); });
Deno.test("unauthenticated caller and ordinary member cannot list or play videos", async () => { const ordinary = { id: 2, name: "회원", role: "모임원", is_active: true }; for (const action of ["list", "video", "issue_invite"]) { await status(await review(operatorRequest({ action }, false), fake().client), 401); await status(await review(operatorRequest({ action, review_id: 1 }), fake({ member: ordinary }).client), 403); } });
Deno.test("inactive operator cannot read video", async () => { await status(await review(operatorRequest({ action: "video", review_id: 1 }), fake({ member: { id: 1, role: "운영진", is_active: false } }).client), 403); });
Deno.test("role label alone cannot grant OT access to a newly claimed operator account", async () => { await status(await review(operatorRequest({ action: "video", review_id: 1 }), fake({ member: { id: 1, role: "운영진", is_active: true }, operatorAccess: false }).client), 403); });
Deno.test("operator media is authenticated bytes with no URL and no-store", async () => { const response = await review(operatorRequest({ action: "video", review_id: 1 }), fake({ member: { id: 1, role: "운영진", is_active: true } }).client); await status(response, 200); assert(response.headers.get("Content-Type") === "video/mp4"); assert(response.headers.get("Cache-Control") === "no-store"); assert((await response.arrayBuffer()).byteLength === 3); });
Deno.test("operator cannot vote as another person or auto-complete membership", async () => { const { client, state } = fake({ member: { id: 1, name: "운영진", role: "운영진", is_active: true } }); await status(await review(operatorRequest({ action: "vote", review_id: 1, voter_member_id: 2, decision: "APPROVE" }), client), 403); await status(await review(operatorRequest({ action: "complete", review_id: 1, member_id: 2 }), client), 403); assert(!state.rpcCalls.length); });
Deno.test("shared administrator proxy vote remains available with audit actor", async () => { const { client, state } = fake({ admin: true }); await status(await review(operatorRequest({ action: "vote", review_id: 1, voter_member_id: 7, decision: "APPROVE" }), client), 200); assert(state.rpcCalls[0].input.p_member_id === 7 && state.rpcCalls[0].input.p_actor_id === userId); });
Deno.test("signed media URL route is retired", async () => { await status(await review(operatorRequest({ action: "signed_video_url", review_id: 1 }), fake({ admin: true }).client), 410); });
