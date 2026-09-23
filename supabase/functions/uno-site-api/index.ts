import postgres from "npm:postgres@3.4.7";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL is required");

const sql = postgres(DATABASE_URL, {
  max: 1,
  prepare: true,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: "require",
});

const FUNCTION_NAME = "uno-site-api";
const VERSION = "0.7.0";
const SESSION_DAYS = 30;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function bearerToken(req: Request): string | null {
  const value = req.headers.get("authorization");
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isFourDigitPin(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}$/.test(value);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function login(body: Record<string, unknown>): Promise<Response> {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const pin = body.pin;

  if (!username || !isFourDigitPin(pin)) {
    return json({ error: "Invalid username or PIN" }, 401);
  }

  const sessionToken = generateSessionToken();
  const tokenHash = await sha256Hex(sessionToken);

  const result = await sql.begin(async (tx) => {
    const users = await tx`
      SELECT id, username, display_name, pin_hash, is_admin,
             is_active, failed_attempts, locked_until
      FROM public.site_users
      WHERE lower(username) = lower(${username})
      FOR UPDATE
    `;

    const user = users[0];
    if (!user || !user.is_active) {
      return { ok: false as const };
    }

    const locked = user.locked_until && new Date(user.locked_until).getTime() > Date.now();
    if (locked) return { ok: false as const };

    const pinMatches = await tx`
      SELECT extensions.crypt(${pin}, ${user.pin_hash}) = ${user.pin_hash} AS matches
    `;

    if (!pinMatches[0]?.matches) {
      const nextFailedAttempts = Number(user.failed_attempts ?? 0) + 1;
      if (nextFailedAttempts >= MAX_FAILED_ATTEMPTS) {
        await tx`
          UPDATE public.site_users
          SET failed_attempts = 0,
              locked_until = now() + (${LOCK_MINUTES} * interval '1 minute'),
              updated_at = now()
          WHERE id = ${user.id}
        `;
      } else {
        await tx`
          UPDATE public.site_users
          SET failed_attempts = ${nextFailedAttempts}, updated_at = now()
          WHERE id = ${user.id}
        `;
      }
      return { ok: false as const };
    }

    const sessions = await tx`
      INSERT INTO public.site_sessions (user_id, token_hash, expires_at)
      VALUES (${user.id}, ${tokenHash}, now() + (${SESSION_DAYS} * interval '1 day'))
      RETURNING expires_at
    `;

    await tx`
      UPDATE public.site_users
      SET failed_attempts = 0, locked_until = NULL, updated_at = now()
      WHERE id = ${user.id}
    `;

    return {
      ok: true as const,
      username: user.username,
      display_name: user.display_name,
      is_admin: Boolean(user.is_admin),
      expires_at: sessions[0].expires_at,
    };
  });

  if (!result.ok) return json({ error: "Invalid username or PIN" }, 401);

  return json({
    session_token: sessionToken,
    username: result.username,
    display_name: result.display_name,
    is_admin: result.is_admin,
    expires_at: result.expires_at,
  });
}

async function bootstrap(req: Request): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return json({ error: "Unauthorized" }, 401);
  const tokenHash = await sha256Hex(token);

  const sessions = await sql`
    SELECT s.id AS session_id, u.id AS user_id, u.username, u.display_name,
           u.is_admin, s.expires_at
    FROM public.site_sessions AS s
    JOIN public.site_users AS u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash}
      AND s.expires_at > now()
      AND u.is_active = true
    LIMIT 1
  `;

  const session = sessions[0];
  if (!session) return json({ error: "Unauthorized" }, 401);

  await sql`
    UPDATE public.site_sessions
    SET last_seen_at = now()
    WHERE id = ${session.session_id}
  `;

  const [rules, schedule, bonusHands, settingsRows] = await Promise.all([
    sql`SELECT * FROM public.site_rules`,
    sql`
      SELECT * FROM public.game_schedule
      WHERE is_active = true
      ORDER BY day_sort, sort_order, start_time
    `,
    sql`
      SELECT * FROM public.bonus_hands
      WHERE is_active = true
      ORDER BY sort_order, created_at
      LIMIT 1
    `,
    sql`SELECT * FROM public.site_settings`,
  ]);

  const settings: Record<string, unknown> = {};
  for (const row of settingsRows) {
    const key = row.key ?? row.setting_key ?? row.name;
    if (key !== undefined && key !== null) {
      settings[String(key)] = row.value ?? row.setting_value ?? null;
    }
  }

  return json({
    user: {
      username: session.username,
      display_name: session.display_name,
      is_admin: Boolean(session.is_admin),
    },
    rules,
    game_schedule: schedule,
    bonus_hands: bonusHands,
    settings,
  });
}

async function logout(req: Request): Promise<Response> {
  const token = bearerToken(req);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await sql`
      DELETE FROM public.site_sessions
      WHERE token_hash = ${tokenHash}
    `;
  }
  return json({ ok: true });
}

class InputError extends Error {}
function textValue(value: unknown, label: string, max = 200, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) throw new InputError(`Invalid ${label}.`);
  return value.trim();
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new InputError("Choose yes or no.");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > 100000) throw new InputError("Sort values must be whole numbers between -100000 and 100000.");
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new InputError("Invalid record ID.");
  return value;
}
function pinValue(value: unknown): string {
  if (!isFourDigitPin(value)) throw new InputError("Enter a four-digit PIN.");
  return value;
}
function reservationSetting(value: unknown): string {
  if (typeof value !== "string" || value.length > 20 || (value !== "" && !/^(?:\+?[1-9][0-9]{6,14}|[2-9][0-9]{9})$/.test(value))) {
    throw new InputError("Use a valid phone number or leave blank.");
  }
  return value;
}
const scheduleDays: Record<string, number> = { monday: 1, wednesday: 2, thursday: 3 };
function scheduleDay(value: unknown): { name: string; sort: number } {
  const name = textValue(value, "day", 40);
  const sort = scheduleDays[name.toLowerCase()];
  if (!sort) throw new InputError("Day must be Monday, Wednesday, or Thursday.");
  return { name, sort };
}
function scheduleOrder(gameName: string): number {
  return gameName.trim().toLowerCase() === "tournament" ? 1 : 0;
}
const adminActions = new Set(["admin_users", "admin_add_user", "admin_user_active", "admin_reset_pin", "admin_delete_user", "admin_rules", "admin_save_rules", "admin_games", "admin_save_game", "admin_delete_game", "admin_bonus", "admin_save_bonus", "admin_delete_bonus", "admin_settings", "admin_save_settings"]);

async function memberSettings(req: Request): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return json({ error: "Unauthorized" }, 401);
  const tokenHash = await sha256Hex(token);
  const sessions = await sql`
    SELECT s.id
    FROM public.site_sessions AS s
    JOIN public.site_users AS u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash}
      AND s.expires_at > now()
      AND u.is_active = true
    LIMIT 1
  `;
  if (!sessions[0]) return json({ error: "Unauthorized" }, 401);
  const rows = await sql`
    SELECT setting_key, setting_value
    FROM public.site_settings
    WHERE setting_key IN ('reservation_phone_1', 'reservation_phone_2')
  `;
  return json({ settings: Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value])) });
}

async function management(req: Request, body: Record<string, unknown>): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return json({ error: "Unauthorized" }, 401);
  const hash = await sha256Hex(token);
  // Authorization and mutation share a transaction. Lock the actor so disabling
  // that user cannot race an already-authorized management write.
  return await sql.begin(async (tx) => {
    const sessions = await tx`
      SELECT s.id AS session_id, u.id AS user_id, u.is_admin
      FROM public.site_sessions s JOIN public.site_users u ON u.id = s.user_id
      WHERE s.token_hash = ${hash} AND s.expires_at > now() AND u.is_active = true
      FOR UPDATE OF u
    `;
    const actor = sessions[0];
    if (!actor) return json({ error: "Unauthorized" }, 401);
    const action = body.action;
    if (action !== "change_pin" && actor.is_admin !== true) return json({ error: "Forbidden" }, 403);
    if (action === "admin_users") {
      const users = await tx`SELECT id, username, display_name, is_admin, is_active, created_at FROM public.site_users ORDER BY CASE WHEN id = ${actor.user_id} THEN 0 ELSE 1 END, lower(display_name), lower(username)`;
      return json({ users, current_user_id: actor.user_id });
    }
    if (action === "admin_add_user") {
      const username = textValue(body.username, "username", 100);
      const displayName = textValue(body.display_name, "display name", 200);
      const pin = pinValue(body.pin);
      const admin = flag(body.is_admin);
      // Existing unique index site_users_username_unique on lower(username)
      // also enforces uniqueness for concurrent requests.
      const existing = await tx`SELECT id FROM public.site_users WHERE lower(username) = lower(${username})`;
      if (existing.length) return json({ error: "That username is already in use." }, 409);
      await tx`INSERT INTO public.site_users (username, display_name, pin_hash, is_admin, is_active)
        VALUES (${username}, ${displayName}, extensions.crypt(${pin}, extensions.gen_salt('bf', 10)), ${admin}, true)`;
    } else if (action === "admin_user_active" || action === "admin_reset_pin" || action === "admin_delete_user") {
      const id = uuid(body.id);
      if (id === actor.user_id) throw new InputError(action === "admin_reset_pin" ? "Use Change My PIN for your own account." : "You cannot change or delete your own account.");
      const targets = await tx`SELECT id FROM public.site_users WHERE id = ${id} FOR UPDATE`;
      if (!targets.length) return json({ error: "User not found." }, 404);
      if (action === "admin_delete_user") {
        await tx`DELETE FROM public.site_sessions WHERE user_id = ${id}`;
        await tx`DELETE FROM public.site_users WHERE id = ${id}`;
      } else if (action === "admin_user_active") {
        const active = flag(body.is_active);
        await tx`UPDATE public.site_users SET is_active = ${active}, updated_at = now() WHERE id = ${id}`;
        if (!active) await tx`DELETE FROM public.site_sessions WHERE user_id = ${id}`;
      } else {
        const pin = pinValue(body.pin);
        await tx`UPDATE public.site_users SET pin_hash = extensions.crypt(${pin}, extensions.gen_salt('bf', 10)), failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = ${id}`;
        await tx`DELETE FROM public.site_sessions WHERE user_id = ${id}`;
      }
    } else if (action === "change_pin") {
      const current = pinValue(body.current_pin);
      const next = pinValue(body.new_pin);
      if (next !== body.confirm_pin) throw new InputError("New PINs do not match.");
      const rows = await tx`SELECT failed_attempts, locked_until, extensions.crypt(${current}, pin_hash) = pin_hash AS matches FROM public.site_users WHERE id = ${actor.user_id}`;
      const row = rows[0];
      if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) return json({ error: "Too many attempts. Please wait before trying again." }, 429);
      if (!row.matches) {
        const attempts = Number(row.failed_attempts ?? 0) + 1;
        await tx`UPDATE public.site_users SET failed_attempts = ${attempts >= MAX_FAILED_ATTEMPTS ? 0 : attempts},
          locked_until = CASE WHEN ${attempts} >= ${MAX_FAILED_ATTEMPTS} THEN now() + (${LOCK_MINUTES} * interval '1 minute') ELSE locked_until END,
          updated_at = now() WHERE id = ${actor.user_id}`;
        return json({ error: "Current PIN was not recognized." }, 400);
      }
      await tx`UPDATE public.site_users SET pin_hash = extensions.crypt(${next}, extensions.gen_salt('bf', 10)), failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = ${actor.user_id}`;
      await tx`DELETE FROM public.site_sessions WHERE user_id = ${actor.user_id} AND id <> ${actor.session_id}`;
    } else if (action === "admin_rules") {
      return json({ rules: await tx`SELECT id, body FROM public.site_rules WHERE id = 1` });
    } else if (action === "admin_save_rules") {
      const bodyText = textValue(body.body, "rules", 100000, true);
      await tx`INSERT INTO public.site_rules (id, body) VALUES (1, ${bodyText}) ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`;
    } else if (action === "admin_games") {
      return json({ game_schedule: await tx`SELECT id, day_name, day_sort, game_name, start_time, sort_order, is_active FROM public.game_schedule ORDER BY day_sort, CASE WHEN lower(game_name) = 'tournament' THEN 1 ELSE 0 END, start_time, lower(game_name)` });
    } else if (action === "admin_bonus") {
      const rows = await tx`SELECT description FROM public.bonus_hands ORDER BY sort_order, created_at LIMIT 1`;
      return json({ bonus_text: typeof rows[0]?.description === "string" ? rows[0].description : "" });
    } else if (action === "admin_save_game") {
      const day = scheduleDay(body.day_name);
      const name = textValue(body.game_name, "game name", 200);
      const sort = scheduleOrder(name), active = flag(body.is_active);
      const time = body.start_time === "" || body.start_time === null ? null : textValue(body.start_time, "start time", 8);
      if (time !== null && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(time)) throw new InputError("Invalid start time.");
      if (body.id == null) {
        await tx`INSERT INTO public.game_schedule (day_name, day_sort, game_name, start_time, sort_order, is_active) VALUES (${day.name}, ${day.sort}, ${name}, ${time}, ${sort}, ${active})`;
      } else {
        const id = uuid(body.id);
        const rows = await tx`UPDATE public.game_schedule SET day_name=${day.name}, day_sort=${day.sort}, game_name=${name}, start_time=${time}, sort_order=${sort}, is_active=${active}, updated_at=now() WHERE id=${id} RETURNING id`;
        if (!rows.length) return json({ error: "Game not found. Refresh and try again." }, 404);
      }
    } else if (action === "admin_save_bonus") {
      const bodyText = textValue(body.body, "Bonus Hands Info", 100000, true);
      const rows = await tx`SELECT id FROM public.bonus_hands ORDER BY sort_order, created_at LIMIT 1 FOR UPDATE`;
      if (rows.length) {
        await tx`UPDATE public.bonus_hands SET description=${bodyText}, is_active=true, updated_at=now() WHERE id=${rows[0].id}`;
      } else {
        await tx`INSERT INTO public.bonus_hands (hand_name, payout_text, description, sort_order, is_active) VALUES ('Bonus Hands Info', NULL, ${bodyText}, 0, true)`;
      }
    } else if (action === "admin_delete_game" || action === "admin_delete_bonus") {
      const id = uuid(body.id);
      if (action === "admin_delete_game") await tx`DELETE FROM public.game_schedule WHERE id = ${id}`;
      else await tx`DELETE FROM public.bonus_hands WHERE id = ${id}`;
    } else if (action === "admin_settings") {
      const rows = await tx`SELECT setting_key, setting_value FROM public.site_settings WHERE setting_key IN ('reservation_phone_1', 'reservation_phone_2')`;
      return json({ settings: Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value])) });
    } else if (action === "admin_save_settings") {
      for (const key of ["reservation_phone_1", "reservation_phone_2"]) {
        const phone = reservationSetting(body[key]);
        await tx`INSERT INTO public.site_settings (setting_key, setting_value) VALUES (${key}, ${phone}) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = now()`;
      }
    } else return json({ error: "Unknown action" }, 400);
    return json({ ok: true });
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid request." }, 400);
    const action = body.action;

    if (action === "health") {
      return json({ ok: true, service: FUNCTION_NAME, version: VERSION });
    }
    if (action === "login") return await login(body);
    if (action === "bootstrap") return await bootstrap(req);
    if (action === "member_settings") return await memberSettings(req);
    if (action === "logout") return await logout(req);

    if (adminActions.has(action) || action === "change_pin") return await management(req, body);
    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, 400);
    if (error instanceof SyntaxError) return json({ error: "Invalid JSON." }, 400);
    if ((error as { code?: string })?.code === "23505") return json({ error: "That record already exists." }, 409);
    // Database errors can contain parameter values. Never log them.
    console.error("uno-site-api request failed");
    return json({ error: "Internal server error" }, 500);
  }
});
