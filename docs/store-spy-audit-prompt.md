# Task: Full consistency and security audit of Store Spy

You are auditing the Store Spy codebase before its first public deployment.
This is an **audit, not a remediation**. Report findings and stop. Do not fix
anything until I have reviewed and told you what to fix.

## Why now

This codebase has just been through a large structural migration (the B1–B4
control-plane work): identity, sessions, billing and feature gating moved out
of `store_spy.User` into a `control_plane` schema, `store_spy.User` was
dropped, and the app was containerised for deployment. Eleven merges of
structural change is enough for documentation, comments, and dead code paths
to describe a system that no longer exists.

At the same time, the app is about to be reachable from the public internet
and accept real signups, payments, and user-supplied input for the first time.
It has never been audited from that posture.

## Ground rules

- **Report first. Change nothing.** No fixes, no refactors, no "while I was in
  there" cleanups. If you find something you are tempted to fix immediately,
  write it down instead.
- **Rank by exploitability, not by category.** A theoretical issue in an
  unreachable code path ranks below a practical one on the signup route. Say
  plainly when something is theoretical.
- **Verify reachability before you rank.** For every security finding, state
  whether it is reachable from the public internet, from an authenticated
  user, from an admin, or not at all. A dev-only dependency advisory is not
  the same as an unauthenticated route.
- **Distinguish "wrong" from "unlovely".** I want bugs and risks, not style
  preferences. If something is merely inconsistent-but-harmless, put it in a
  separate low-priority list.
- **Cite file and line for everything.** A finding I cannot locate is not a
  finding.
- **If you are unsure whether something is intentional, ask rather than
  assume.** Several apparent oddities in this codebase are deliberate and
  documented (see "Known and intentional" below).

---

# Part 1 — Consistency and contradiction audit

## 1.1 Stale references to the pre-migration world

Search for anything that still describes the old architecture:

- Comments, docstrings, and variable names referring to `store_spy.User`,
  `PlanTier`, `plan-limits`, `resolvePlanSlug`, `verify:b2-step1`,
  `plan-parity`, `ensureControlPlaneAccount`, or the `TRANSITIONAL` markers.
- Documentation in `docs/` that describes behaviour that has since changed.
  Several docs were written mid-migration and may be describing an
  intermediate state as if it were current.
- The historical milestone docs (`docs/milestone-*.md`) are **deliberately
  left as a dated record** — do not flag those as stale, but do check that
  nothing outside them links to them as current guidance.
- README, environment-variable docs, and deployment docs versus what the code
  actually reads and what CI actually does.

## 1.2 The two-subscription-table situation

`store_spy.Subscription` (billing history) and `control_plane.subscriptions`
(entitlement source of truth) both exist. This is intentional, but it is the
highest-risk consistency surface in the codebase.

For every reader and writer of each, determine:

- Which questions are answered from which table, and whether that is coherent.
- Whether any code path writes one without the other where it should write
  both, or reads the wrong one for the question it is asking.
- Whether `checkout.ts`, `subscription-sweep.ts`, and the admin plan-setting
  path agree on which table is authoritative for what.
- Whether analytics queries (`revenue.ts`, `retention.ts`, `usage-cost.ts`,
  `funnel.ts`, `activation.ts`) use the semantic they claim to. Specifically:
  purchased tier (`plan_slug`) versus currently-effective entitlement are
  different questions and a lapsed account reads differently under each.

## 1.3 Purchased versus effective plan

`getPurchasedPlanSlug()` returns what an account bought; `resolveEntitlement()`
answers whether they may currently do a thing. Audit every call site of
`getPurchasedPlanSlug()` and confirm none of them is gating access, granting a
capability, or making a decision that should depend on current entitlement.
Display labels are fine; anything access-adjacent is a bug.

## 1.4 Dead code and orphaned paths

- Code that no longer has a caller (the migration removed several consumers).
- Feature flags, capability checks, or plan fields that are defined but never
  read — `plan-limits.ts` was slimmed but may still carry residue.
- Test helpers, fixtures, or scripts referencing removed tables or functions.
- Migrations directory: confirm the chain is coherent and that nothing in
  `prisma/_migrations-staged/` was left behind.

## 1.5 Schema and code agreement

- `schema.prisma` versus the actual migration chain (there is a known,
  documented ordering drift here — confirm it is still *only* ordering and
  has not grown into anything substantive).
- Every `@@schema` annotation correct after the split.
- Any raw SQL referencing a table by unqualified name, and whether it depends
  on `search_path`. The `search_path` requirement is load-bearing and fragile;
  enumerate every place that depends on it.

---

# Part 2 — Security audit

The app is about to be internet-facing. Audit from the posture of an
unauthenticated attacker, then an authenticated low-privilege user, then a
compromised staff account.

## 2.1 SSRF in the crawler — treat this as the highest-priority area

Store Spy fetches arbitrary user-supplied storefront domains. This is a
server-side request forgery surface by construction, and it is reachable
**unauthenticated** via the anonymous analysis path.

Check specifically whether the fetch layer:

- Resolves and validates the target before connecting, and whether validation
  can be bypassed by DNS rebinding (resolve-then-connect race).
- Blocks private and reserved ranges: `127.0.0.0/8`, `10/8`, `172.16/12`,
  `192.168/16`, `169.254/16` (cloud metadata), `::1`, `fc00::/7`, and IPv4-
  mapped IPv6 forms.
- Follows redirects, and whether each hop in a redirect chain is re-validated
  or only the initial URL.
- Restricts schemes to http/https (no `file:`, `gopher:`, `ftp:`, `data:`).
- Enforces timeouts, response size caps, and content-type expectations.
- Leaks internal response bodies, headers, or error text back to the caller —
  a blind SSRF that echoes an error message is not blind.

State clearly whether an unauthenticated user can currently cause the server
to make a request to an arbitrary host, and what they can observe about the
result.

## 2.2 The internal entitlements endpoint

`/api/internal/entitlements` is gated by `CONTROL_PLANE_INTERNAL_SECRET`.
Determine:

- Whether it is reachable from the public internet at all once deployed, or
  only from inside the compose network. If it is publicly routable, that is a
  finding regardless of the shared secret.
- Whether the secret comparison is constant-time and fail-closed.
- Whether the response leaks information useful for enumeration (does a
  request for a nonexistent `account_id` behave differently from a valid one?).
- Whether any other route under `/api/internal/` exists and shares or lacks
  this protection.

## 2.3 Authentication and session handling

- Password hashing algorithm and parameters.
- The 60-second session revalidation window: confirm the revocation floor
  (`sessions_valid_after`) cannot be bypassed, and that the privileged-role
  always-reread branch actually fires for every privileged path.
- JWT: signing algorithm, secret handling, whether any claim is trusted
  without revalidation, and whether a stale pre-migration token shape can
  confuse current logic.
- OAuth account linking: can an attacker link their OAuth identity to an
  existing account by email without proving control of that email?
- Email verification: can an unverified account do things it should not?
- Password reset flow, if present: token entropy, expiry, single-use,
  and whether the response differs for existing versus nonexistent emails.
- CSRF protection on state-changing routes, especially those outside the
  Auth.js-managed set.

## 2.4 Authorisation

- Every API route and server action: enumerate what authentication and
  authorisation each requires, and flag any that check authentication but not
  ownership. Specifically, can user A read or modify user B's watchlist,
  analyses, exports, or account?
- Admin routes: confirm every one checks the admin role, and that the check
  cannot be satisfied by a stale JWT claim.
- `AdminPermissionGrant` and `UserAdminRole`: whether privilege can be
  escalated through any normal user-facing path.
- IDOR on any route taking an id, domain, or slug from the request.
- The GDPR export and account-delete paths: confirm they are scoped to the
  requesting account and cannot be pointed at another.

## 2.5 Rate limiting and abuse

There is no Redis; rate limiting is in-process. Assess:

- What resets on restart or deploy, and whether that is exploitable.
- The anonymous analysis limiter is IP-keyed — determine how client IP is
  derived. If it trusts `X-Forwarded-For` without knowing the proxy topology,
  it is trivially bypassable. State what it currently does and what the
  correct behaviour is behind Caddy/nginx on a single VPS.
- Signup: is account creation rate-limited independently of Turnstile?
- Turnstile fails open when unconfigured. Confirm whether that is the current
  deployed state and what an attacker gets from it.
- Any expensive unauthenticated operation (crawl, analysis, email send) and
  whether it can be used for amplification or to burn our data budget.

## 2.6 Injection and data handling

- Every `$queryRaw` / `$executeRaw`: confirm parameterisation, and flag any
  string interpolation of user input. Note that some of these were recently
  rewritten during the analytics repoint.
- Any dynamic ORDER BY, LIMIT, or column name derived from user input.
- Output encoding in any place raw HTML is rendered.
- File upload or import paths, if any.
- Email: header injection via user-controlled name or address fields.

## 2.7 Secrets, logging, and error handling

- Confirm no secret is logged, including in error paths and in the crawler's
  failure logging.
- Whether stack traces or database errors reach the client in production.
- Whether `/api/health` leaks anything beyond liveness.
- Any secret with a weak or defaulted value, and anything that silently
  proceeds when a required secret is unset (fail-open patterns).

## 2.8 Container and deployment posture

- Does the container run as a non-root user?
- Is anything unnecessary present in the runtime image (source maps, `.git`,
  test files, dev tooling)?
- Are database and internal service ports exposed to the host or only within
  the compose network?
- Does the deploy script or compose file put secrets on a command line or in
  a layer?
- CI: is `GITHUB_TOKEN` or the GHCR credential scoped correctly, and could a
  pull request from a fork obtain it?

## 2.9 Dependencies

Re-run `npm audit` and report current state. For anything found, state whether
it is reachable in the production image (`--omit=dev`, `output: standalone`)
or dev-only.

---

## Known and intentional — do not flag as bugs

Confirm each is still true, but these are deliberate decisions, not findings:

- Two subscription tables (`store_spy.Subscription` for billing history,
  `control_plane.subscriptions` for entitlements).
- FREE accounts hold two subscription rows (`subf_` perpetual ACTIVE for
  analysis, `subt_` TRIALING for monitoring).
- No Redis; rate limiting is in-process by design at this scale.
- `prisma migrate diff` reports ordering drift between `schema.prisma` and the
  replayed chain — documented, and `migrate dev` must not be used to reconcile.
- `docs/milestone-*.md` are a historical record and intentionally stale.
- The `DATABASE_URL` must use `search_path`, never `?schema=`.

If any of these turns out to *not* be true any more, that itself is a finding.

---

## Output format

Produce a single report with:

1. **Critical / High / Medium / Low**, ranked by exploitability, each with:
   file:line, what it is, who can reach it, what they get, and a one-line
   suggested fix. Do not implement the fix.
2. **Consistency findings**, separately — contradictions, stale docs, dead
   code — since these are correctness and maintenance issues rather than
   security ones.
3. **Questions**, for anything where you could not tell whether the current
   behaviour is intentional.
4. **What you checked and found clean**, briefly. I want to know the coverage,
   not just the hits.

Stop after the report.
