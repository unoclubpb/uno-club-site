# uno-club-site

Independent Uno Club informational website, **v0.2.0**, using plain HTML, CSS, and JavaScript with no dependencies or build step. GitHub contains only the public site shell. Protected data and authentication live in Supabase behind the `uno-site-api` Edge Function. No other Uno Club repository or app is used.

## Preview and hosting

Run `python3 -m http.server 8000` here and visit `http://localhost:8000`. For GitHub Pages, publish the repository root from your chosen branch in Settings → Pages. Relative asset paths support `/uno-club-site/`; `.nojekyll` keeps deployment static. This initial implementation does not deploy anything.

Set **`EDGE_FUNCTION_URL` at the top of `app.js`** to your HTTPS project URL ending in `/functions/v1/uno-site-api`. It is intentionally empty until the project URL is supplied. The custom session contract needs no browser Supabase key or SDK. Never add secret/service-role keys, database passwords, PINs, PIN hashes, reservation numbers, or protected content to this repository.

## Expected API contract

This is a proposed contract for the backend to implement, not a deployed backend. Adjust the frontend adapter if the actual backend uses another contract. Requests are JSON `POST` bodies containing `action`. Authenticated calls send `Authorization: Bearer <session_token>`; tokens never go in URLs.

| Action | Additional request fields | Successful JSON response |
| --- | --- | --- |
| `login` | `username`: string, `pin`: four-digit string | `session_token`: nonempty string, `user`: user object |
| `session` | None | `user`: user object |
| `rules` | None | `sections`: array of `{title: string, body: string}` |
| `schedule` | None | `games`: array of game objects |
| `bonus` | None | `sections`: array of `{title: string, body: string}` |
| `logout` | None | `{}` after revoking the session |

A user object contains `username: string` and `is_admin: boolean`. A game contains `name: string`, `day: string`, and optional `time: string`, `details: string`, `reservation_phone: string | null`. The backend supplies display-ready game/day text and a single international-format number beginning with `+`, or omits the number when unavailable. No protected examples or fallback data belong in the shell.

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

Admin includes placeholders for Users, Rules, Games Schedule, Bonus Hands, Reservation Numbers, and Change My PIN. No admin mutations are implemented.

Before production, verify login failures/success, session expiry, logout, ordinary/admin users, empty/populated content, network failures, and SMS composition on iPhone. Live authentication requires the function URL and backend and cannot yet be verified.
