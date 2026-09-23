# uno-club-site

Independent Uno Club informational website, **v0.5.0**, using plain HTML, CSS, and JavaScript with no dependencies or build step. GitHub contains only the public site shell. Protected data and authentication live in Supabase behind the `uno-site-api` Edge Function. No other Uno Club repository or app is used.

## Preview and hosting

Run `python3 -m http.server 8000` here and visit `http://localhost:8000`. For GitHub Pages, publish the repository root from your chosen branch in Settings → Pages. Relative asset paths support `/uno-club-site/`; `.nojekyll` keeps deployment static. This initial implementation does not deploy anything.

Set **`EDGE_FUNCTION_URL` at the top of `app.js`** to your HTTPS project URL ending in `/functions/v1/uno-site-api`. The project URL is configured. The custom session contract needs no browser Supabase key or SDK. Never add secret/service-role keys, database passwords, PINs, PIN hashes, reservation numbers, or protected content to this repository.

## API response contract

The frontend consumes the tested login and bootstrap response shapes. The downloaded Edge Function source is maintained in `supabase/functions/uno-site-api/index.ts`. Requests are JSON `POST` bodies containing `action`. Authenticated calls send `Authorization: Bearer <session_token>`; tokens never go in URLs.

| Action | Additional request fields | Successful JSON response |
| --- | --- | --- |
| `login` | `username`: string, `pin`: four-digit string | Top-level `session_token`, `username`, `display_name`, `is_admin`, `expires_at` |
| `bootstrap` | None | `user`, `rules`, `game_schedule`, `bonus_hands`, `settings` |
| `member_settings` | None | `settings` (authenticated reservation contacts for the permanent member schedule) |
| `logout` | None | `{}` after revoking the session (existing contract) |

Login reads the top-level profile and stores only `session_token`, under the unchanged `uno-club-site-session` localStorage key. Restoring a session calls `bootstrap` to validate it. Rules and Bonus Hands use `bootstrap`; the permanent member-facing Games Schedule calls authenticated `member_settings` only and never reads `game_schedule`.

Bootstrap fields:

- `user`: `username`, `display_name`, and boolean `is_admin`.
- `rules`: an array; the page displays the first row's `body` when present.
- `game_schedule`: an array retained for API compatibility and Admin CRUD. It is not used by the member-facing Games Schedule.
- `bonus_hands`: active entries sorted by `sort_order`, displaying `hand_name`, `payout_text`, and `description`. IDs and timestamps are not rendered.
- `settings`: optional `reservation_phone_1` and `reservation_phone_2`. The permanent member schedule uses these authenticated values as hidden recipients. Ten-digit US values and international values are accepted and normalized to SMS URI format in memory. Empty numbers leave reservation unavailable.

The permanent member schedule is Monday (Hold Em 7:00 PM, Omaha 7:00 PM), Wednesday (Omaha 7:00 PM, Tournament 7:30 PM), and Thursday (Hold Em 7:00 PM, Omaha 7:00 PM). Each game has one `Reserve Seat` button addressed to both configured contacts. The member schedule does not depend on `game_schedule`.

No protected examples or fallback data belong in the shell.

SMS links open the device composer; they do not send a message or confirm a reservation. The body is exactly:

> I would like to reserve a seat for the &lt;game specified&gt; game on &lt;day specified&gt;.

The URI uses the iOS body separator on iPhone/iPad and the standard query separator elsewhere. Verify composition on a real iPhone after connecting the backend.

Use HTTP `401` for invalid credentials or expired/revoked sessions, `403` for denied access, and `429` for throttling. All successful responses, including logout, must contain JSON. Protected content is fetched only after successful login or server validation of a stored session, and rendered as text rather than HTML.

## Backend security requirements

- Validate sessions on every protected request, enforce expiry/revocation, and authorize every future admin action on the server. Hiding the Admin button is not access control.
- Custom opaque sessions require the function gateway to pass requests to the custom authentication handler (`verify_jwt = false`). The handler must authenticate every action except login and CORS preflight. The default JWT check does not validate custom opaque sessions. See [Supabase function authentication](https://supabase.com/docs/guides/functions/auth).
- Handle CORS `OPTIONS` and allow the production site origin and explicit development origins, `POST`, `Content-Type`, and `Authorization`. See [Supabase CORS documentation](https://supabase.com/docs/guides/functions/cors).
- Keep secure salted PIN hashing and verification on the backend, with rate limiting and lockout/backoff. Never log PINs or tokens. Protect tables using permissions and RLS; do not allow unauthenticated direct access to member data.
- Return `Cache-Control: no-store` on authentication and protected responses. The frontend also requests `cache: "no-store"` and uses no service worker.
- Only the returned session token goes in localStorage. User details and protected content stay in memory; logout clears the page and token immediately and requests server revocation. PIN inputs are cleared after attempts. If storage is unavailable, sessions persist only in memory.
- Robots metadata and `robots.txt` discourage indexing but are not access controls. Static assets remain public.

## Maintenance and verification

`index.html` defines the screens, `styles.css` provides mobile-first styling with iPhone safe-area spacing, and `app.js` handles API requests and rendering. The header reserves room for a logo. Update the footer and README together when changing the version.

Admin includes separate screens for Users, Rules, Games Schedule, Bonus Hands, Reservation Numbers, and Change My PIN. Users can be added, disabled, reactivated, and have their PIN reset; permanent deletion is not available. Administrators cannot disable themselves or bypass current-PIN verification on their own account. Every management request authenticates the active custom session and checks the current database admin flag. User lists explicitly omit PIN hashes. New PINs are hashed with pgcrypto bcrypt (cost 10). Disabling a user or resetting their PIN revokes their sessions. Changing your own PIN preserves the current session and revokes other sessions; incorrect current-PIN attempts use the existing lockout counters.

Rules save to row 1 and open the refreshed member Rules page. Admin Games Schedule editing exposes only Day, Game Name, Start Time, and Active; the backend derives Monday/Wednesday/Thursday ordering and places Tournament after regular games. Bonus hands support create/edit/delete (with confirmation), numeric ordering, and active flags. Reservation numbers accept 10-digit US or international format. Member content is fetched anew on navigation, so edits require no new login. Every authenticated member can reach Change My PIN from the main menu.

The existing case-insensitive unique index `site_users_username_unique` on `lower(username)` protects concurrent user creation. No schema changes are required. Authentication uses the existing 30-day custom sessions and failed-login lockout. Keep `[functions.uno-site-api] verify_jwt = false` in `supabase/config.toml`.

New API actions: `member_settings`, `admin_users`, `admin_add_user`, `admin_user_active`, `admin_reset_pin`, `admin_rules`, `admin_save_rules`, `admin_games`, `admin_save_game`, `admin_delete_game`, `admin_bonus`, `admin_save_bonus`, `admin_delete_bonus`, `admin_settings`, `admin_save_settings`, and authenticated `change_pin`. Mutations return `{ "ok": true }`; validation errors return 400, missing records 404, and duplicates 409. Admin reads return their named arrays/objects. PIN fields are only sent in HTTPS request bodies and never persisted by the browser.

Backend checks: `deno check supabase/functions/uno-site-api/index.ts` and `deno test --allow-read tests/admin_api_test.ts`. These offline handler tests cover every management action's 401/403 gates, validation, PIN hashing, session revocation, and safe responses. No real club records are changed by tests.

Deploy only this function with `supabase functions deploy uno-site-api --project-ref xnfudstmpejjmmwpqqgz --use-api`. GitHub Pages serves the static shell from `main`; no backend credentials belong in any tracked file.

Run `python3 tests/check_site.py` on macOS (Python 3 and the system JavaScriptCore framework). This retains the original shell checks and adds synthetic response-shape regression tests for login, bootstrap, session restoration, rules, bonus hands, reservation settings, and logout. It uses a minimal DOM and mocked API; it makes no network calls and includes no real credentials or protected club data.

The user has tested the real API shapes. Automated checks do not replace live browser authentication, populated schedule verification, or SMS composition testing on iPhone.
