// Offline tests run the actual request handler with synthetic SQL results.
// No credentials, network requests, or live database mutations.
function assert(value: unknown, message = "Assertion failed"): asserts value { if (!value) throw new Error(message); }
function assertEquals(actual: unknown, expected: unknown, message = "Values differ") { assert(JSON.stringify(actual) === JSON.stringify(expected), message + `: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`); }
let handler: (request: Request) => Promise<Response>;
let actor: Record<string, unknown> | null;
let queries: { text: string; values: unknown[] }[] = [];
let duplicate = false;
let matches = true;
const actorId = "00000000-0000-4000-8000-000000000001";
const targetId = "00000000-0000-4000-8000-000000000002";
const fakeSql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join("?").replace(/\s+/g, " ");
  queries.push({ text, values });
  if (text.includes("FROM public.site_sessions s JOIN")) return actor ? [actor] : [];
  if (text.includes("FROM public.site_sessions AS s")) return actor ? [{ id: targetId }] : [];
  if (text.includes("SELECT setting_key, setting_value")) return [{ setting_key: "reservation_phone_1", setting_value: "7708615443" }];
  if (text.includes("SELECT id FROM public.site_users WHERE lower")) return duplicate ? [{ id: targetId }] : [];
  if (text.includes("SELECT id FROM public.site_users WHERE id")) return [{ id: targetId }];
  if (text.includes("SELECT failed_attempts")) return [{ failed_attempts: 0, locked_until: null, matches }];
  if (text.includes("SELECT id, username")) return [{ id: actorId, username: "synthetic", display_name: "Synthetic", is_admin: true, is_active: true, created_at: "2026-01-01" }];
  if (text.includes("RETURNING id")) return [{ id: targetId }];
  return [];
}, { begin: async (callback: (tx: unknown) => unknown) => await callback(fakeSql) });
Object.assign(globalThis, { __sql: fakeSql, __capture: (fn: typeof handler) => { handler = fn; } });
const source = (await Deno.readTextFile(new URL("../supabase/functions/uno-site-api/index.ts", import.meta.url)))
  .replace('import postgres from "npm:postgres@3.4.7";', 'const postgres = () => (globalThis as any).__sql;')
  .replace('Deno.env.get("SUPABASE_DB_URL")', '"synthetic"')
  .replace('Deno.serve(', '(globalThis as any).__capture(');
await import(`data:application/typescript;base64,${btoa(source)}`);
function reset(admin: boolean | null = true) {
  actor = admin === null ? null : { user_id: actorId, session_id: targetId, is_admin: admin };
  queries = []; duplicate = false; matches = true;
}
async function request(action: string, fields: Record<string, unknown> = {}, authenticated = true) {
  return await handler(new Request("https://example.invalid", { method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: "Bearer synthetic" } : {}) }, body: JSON.stringify({ action, ...fields }) }));
}
const actions = ["admin_users","admin_add_user","admin_user_active","admin_reset_pin","admin_rules","admin_save_rules","admin_games","admin_save_game","admin_delete_game","admin_bonus","admin_save_bonus","admin_delete_bonus","admin_settings","admin_save_settings"];
Deno.test("every management action rejects missing/expired/inactive sessions and non-admins before writes", async () => {
  for (const action of actions) {
    reset(); assertEquals((await request(action, {}, false)).status, 401); assertEquals(queries.length, 0);
    reset(null); assertEquals((await request(action)).status, 401); assertEquals(queries.length, 1);
    assert(queries[0].text.includes("s.expires_at > now() AND u.is_active = true"));
    reset(false); const res = await request(action); assertEquals(res.status, 403); assertEquals(res.headers.get("Cache-Control"), "no-store"); assertEquals(queries.length, 1);
  }
});
Deno.test("self-disable and self-reset forbidden; hash never selected in user list", async () => {
  for (const action of ["admin_user_active", "admin_reset_pin"]) {
    reset(); assertEquals((await request(action, { id: actorId, is_active: false, pin: "1234" })).status, 400);
    assertEquals(queries.length, 1);
  }
  reset(); const res = await request("admin_users"); const body = await res.json();
  assertEquals(body.current_user_id, actorId); assert(!JSON.stringify(body).includes("pin_hash"));
  assert(!queries.some(q => q.text.includes("pin_hash")));
});
Deno.test("creation validates input, handles duplicates, and hashes only in SQL", async () => {
  reset(); const fields = { username: "Example", display_name: "Example", pin: "1234", is_admin: false };
  assertEquals((await request("admin_add_user", { ...fields, pin: "bad" })).status, 400);
  assert(!queries.some(q => q.text.includes("INSERT")));
  reset(); duplicate = true; assertEquals((await request("admin_add_user", fields)).status, 409);
  reset(); const res = await request("admin_add_user", fields); assertEquals(await res.json(), { ok: true });
  const insert = queries.find(q => q.text.includes("INSERT"))!;
  assert(insert.text.includes("extensions.crypt(?, extensions.gen_salt('bf', 10))"));
  assert(insert.values.includes("1234")); assert(!insert.text.includes("1234"));
});
Deno.test("disable and PIN reset revoke sessions; PIN changes validate current PIN", async () => {
  for (const action of ["admin_user_active", "admin_reset_pin"]) {
    reset(); assertEquals((await request(action, { id: targetId, is_active: false, pin: "1234" })).status, 200);
    assert(queries.some(q => q.text.includes("DELETE FROM public.site_sessions")));
  }
  reset(false); matches = false;
  assertEquals((await request("change_pin", { current_pin: "1234", new_pin: "5678", confirm_pin: "5678" })).status, 400);
  assert(queries.some(q => q.text.includes("failed_attempts =")));
  assert(!queries.some(q => q.text.includes("SET pin_hash")));
  reset(false); assertEquals((await request("change_pin", { current_pin: "1234", new_pin: "5678", confirm_pin: "5678" })).status, 200);
  assert(queries.some(q => q.text.includes("extensions.gen_salt('bf', 10)")));
  assert(queries.some(q => q.text.includes("AND id <>")));
});
Deno.test("management save/delete routes parameterize validated values", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["admin_save_rules",{body:"<synthetic>"}],
    ["admin_save_game",{day_name:"Monday",day_sort:1,game_name:"Synthetic",start_time:"19:30",sort_order:2,is_active:true}],
    ["admin_save_bonus",{hand_name:"Synthetic",payout_text:"",description:"",sort_order:1,is_active:false}],
    ["admin_delete_game",{id:targetId}], ["admin_delete_bonus",{id:targetId}],
    ["admin_save_settings",{reservation_phone_1:"",reservation_phone_2:"+15555550100"}],
  ];
  for (const [action,fields] of cases) {
    reset(); assertEquals((await request(action,fields)).status,200,action);
    assert(queries.some(q => /INSERT|UPDATE|DELETE/.test(q.text) && !q.text.includes("FOR UPDATE")));
    assert(!queries.some(q => q.text.includes("<synthetic>") || q.text.includes("+15555550100")));
  }
  reset(); assertEquals((await request("admin_save_game",{...cases[1][1],day_sort:1.5})).status,400);
  reset(); assertEquals((await request("admin_save_settings",{reservation_phone_1:"javascript:bad",reservation_phone_2:""})).status,400);
  reset(); assertEquals((await request("admin_delete_bonus",{id:"bad"})).status,400);
});
Deno.test("health/CORS preserved; malformed body rejected without leaking details", async () => {
  reset(); const res = await request("health",{},false); assertEquals((await res.json()).version,"0.4.0");
  assertEquals(res.headers.get("Access-Control-Allow-Origin"),"*");
  assertEquals((await handler(new Request("https://example.invalid",{method:"OPTIONS"}))).status,204);
  assertEquals((await handler(new Request("https://example.invalid",{method:"POST",body:"null"}))).status,400);
});
Deno.test("member settings requires an active session and never reads the schedule table", async () => {
  reset(null);
  assertEquals((await request("member_settings")).status, 401);
  reset(false);
  const response = await request("member_settings");
  assertEquals(response.status, 200);
  assert(!queries.some((query) => query.text.includes("game_schedule")));
});
