# Google Authentication and Chat Reliability Plan

**Date:** 2026-09-18
**Status:** implemented and validated

This is the working plan and evidence log for the current implementation. It replaces the previous
entry in this repository's established "last implementation" location.

## Reproduction and diagnosis

- The required `chrome-devtools-axi` run could not start because this machine has no system Chrome,
  and the bridge refused a reachable worktree-local Chromium DevTools endpoint. Firstmate authorized
  direct Playwright against that isolated Chromium as the closest faithful substitute; `.tmp/` and
  the reproduction browser are never project dependencies and will be removed before commit.
- Baseline browser path: email/password login returned 200, conversation list/default/persona requests
  returned 200, then the signed-in route rendered blank. The initiating trigger was mounting
  `ChatWindow`; the masking condition was missing behavioral coverage in the last merged change; the
  visible symptom was `ReferenceError: getArchetypeDisplayName is not defined` and an empty page.
- Smallest counterfactual: restore the missing `getArchetypeDisplayName` import, then repeat the real
  path with multiple personas/chats, rapid switching, switching during a stream, and sends in more
  than one chat. Convert each confirmed race and limit boundary into behavioral tests.
- Existing implementation evidence already points to two independent risks to disconfirm in the
  continued reproduction: aborting a stream does not advance its generation token, so late callbacks
  can still mutate the newly selected chat; and the generic 10-request/10-second API limiter currently
  also counts the streaming message route before the chat-specific 20-message/minute limiter.

## Implementation plan

1. **Google authentication and schema**
   - Use Google Identity Services' SPA ID-token callback and send only the credential to the backend.
   - Verify signature, issuer, expiry, and the configured audience with `google-auth-library`; require
     `sub`, an email, and `email_verified === true`; never trust browser-decoded claims.
   - Replace the lossy single `authProvider` field with `authProviders` plus a partial-unique
     `googleSubject`. Passwords are optional only for Google-only users and remain hashed/hidden for
     password users. Add an idempotent migration/backfill and tests for schema/migration guarantees.
   - Resolve identities by Google `sub`. For an existing verified-email collision, auto-link only when
     Google is authoritative for the address (Gmail, or verified Workspace with `hd`); otherwise reject
     deterministically and require the existing password path. This avoids duplicate users and does not
     let a stale third-party email claim take over a local account. Return one canonical user shape from
     register, password login, Google login, and `/me`, reusing the JWT HTTP-only cookie.
   - Render Google's own GIS button on the existing login and registration surfaces with loading,
     accessible failure/unconfigured states, responsive styling, and no secret or credential fallback.

2. **Conversation switching and limits**
   - Give each selected conversation an isolated load/stream generation. Switching invalidates only the
     superseded client stream and prevents every stale token/state/error/done callback from touching the
     active transcript, persona, title, or loading flags.
   - Make sends single-flight at the store boundary so duplicate UI calls cannot emit duplicate requests.
     Keep the selected chat usable after errors and preserve server-returned rate-limit text.
   - Keep the existing numerical limits. Exempt the streaming message route from the generic API bucket
     so the authoritative chat limiter remains 20 generation requests/minute; history/list loads cannot
     consume that allowance. Add middleware integration tests for both boundaries.

3. **Voice control**
   - Extract a shared accessible voice-mode control used by desktop and mobile sidebars. OFF uses an
     explicit "Off / Replies are silent" label, left-positioned switch thumb, muted icon, and
     `role="switch"`; ON uses "On / Replies play aloud", right-positioned thumb, active icon, and the
     same stored preference behavior. Keep the compact header control coherent with explicit On/Off text.
   - Add component/page tests for both visual/state contracts and mobile/desktop renderings.

4. **Configuration, docs, and delivery**
   - Document `GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_ID`, exact Cloud Console web-client setup,
     local and production authorized JavaScript origins, CSP requirements, disabled behavior, migration,
     and the precise client ID/origins the owner must supply. No client secret is needed for this flow.
   - Update API/data/architecture/deployment docs, add focused server/client tests, run all tests and
     production builds, remove `.tmp/`, commit the implementation, then hand the committed branch to
     the no-mistakes pipeline for review, fixes, PR publication, and green CI.

## Outcome and validation

- Google-only, password-only, and dual-provider users now share one canonical session contract.
  Google ID tokens are verified server-side against the configured Web client ID, and the stable
  subject has a partial unique index plus an idempotent backfill migration.
- Conversation loads and streams have independent monotonic generations. A superseded stream cannot
  surface a late token, state, completion, or error in the selected chat; sends are single-flight; and
  a rejected pre-stream request rolls back only its optimistic turn while preserving the exact server
  error. The existing 20-message/minute chat limit is now the only generation limiter.
- Voice controls use a single component across desktop sidebar, mobile drawer, and compact header.
  Both states are communicated by explicit text, icon shape, thumb position/symbol, and accessible
  switch state. Browser screenshots confirmed the desktop On and mobile Off appearances.
- Validation completed with 61 server tests and 183 client tests passing, both production builds
  succeeding, the auth migration succeeding on two consecutive runs against an isolated MongoDB, and
  a direct Playwright substitute (authorized because the required Chrome bridge had no installed
  browser) completing with no page errors.

Deployment still needs one non-secret Google Web OAuth client ID copied into `GOOGLE_CLIENT_ID` and
`VITE_GOOGLE_CLIENT_ID`. Register `http://localhost:5173` and the confirmed production frontend origin
(`https://ai-bestie.vercel.app` in the current deployment docs) as Authorized JavaScript origins. No
client secret or redirect URI is used.
