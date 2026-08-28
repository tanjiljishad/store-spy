# Task: Rebrand Store Spy and extract shared identity into the control plane

You are working in the Store Spy application repo. Two separate pieces of work
are described below. **Do them in order, on separate branches, and do not start
Task B until Task A is merged.** Task A is a pure refactor with no behaviour
change; Task B changes how authentication works. Mixing them makes the diff
impossible to review.

## Company context you need

- **Bellwether Intelligence** is the parent company. It is not going away.
- **Store Spy** is one product under it. A second product, **Find Suppliers**,
  is coming later.
- The codebase was originally built as "Bellwether" and uses that name
  everywhere — for the company, the product, the database, and the UI, with no
  distinction between those meanings. That conflation is the problem.
- Nothing is deployed. There are no users, no production data, no live
  integrations. **This is the cheapest possible moment to do all of this** —
  say so if you find yourself hesitating over a migration or a breaking change.

---

# TASK A — Disambiguate the naming

## A1. Inventory first. Change nothing yet.

Search the entire repo — code, config, migrations, templates, tests, docs,
seed data, CI files, IaC, package manifests, and asset filenames — for every
case-insensitive occurrence of `bellwether` (also check `bw`, `BW_`, and any
abbreviated forms you find).

Produce a report grouped into these categories, and **stop and show it to me
before making any changes**:

| Category | Examples | Rename risk |
|---|---|---|
| User-facing strings | Page titles, nav, emails, meta tags, error copy | None |
| Code identifiers | Classes, functions, modules, variables | Low |
| File and directory names | `bellwether/`, `bellwether-client.ts` | Low |
| Package identity | `package.json` name, `pyproject.toml`, lockfiles | Medium |
| Environment variables | `BELLWETHER_API_KEY` | Medium |
| Database objects | Table names, columns, enum values, indexes | **High** |
| Applied migrations | Existing migration files | **Do not edit** |
| Auth artifacts | Cookie names, session keys, JWT issuer/audience | Medium |
| External registrations | OAuth redirect URIs, webhook URLs, DNS, repo name | **Needs my action** |

For each item also mark your judgement of **which meaning it carries**:

- `PRODUCT` — refers to this specific application → rename to Store Spy
- `COMPANY` — refers to the parent org → keep as Bellwether
- `AMBIGUOUS` — you cannot tell from context → **ask me, do not guess**

The ambiguous list is the important output. Do not resolve it yourself.

## A2. Canonical names

Once I approve the inventory, apply these forms consistently. Do not invent
variants:

| Context | Store Spy | Parent company |
|---|---|---|
| Display / UI text | `Store Spy` | `Bellwether Intelligence` |
| URL slug, product key | `store-spy` | `bellwether` |
| Code identifier (camel) | `storeSpy` | `bellwether` |
| Code identifier (snake) | `store_spy` | `bellwether` |
| Env var prefix | `STORE_SPY_` | `BELLWETHER_` |
| Package name | `@bellwether/store-spy` | — |
| DB schema | `store_spy` | `control_plane` |

Copyright notices, the legal entity name, billing descriptors, and privacy or
terms documents stay as Bellwether Intelligence. Product names in page titles,
navigation, onboarding, and transactional email become Store Spy.

Page title format: `Store Spy — <page>`, with `Bellwether Intelligence` used
only in the footer and legal pages.

## A3. Execution rules by category

- **User-facing strings**: if there is an i18n or constants file, route
  everything through it rather than hardcoding. If there isn't, create one —
  a second product is coming and hardcoded brand strings will hurt twice.
- **Database objects**: never edit an applied migration. Add a new migration
  that renames tables, columns, and enum values, and make sure it is
  reversible. If renaming a column would require a table rewrite on a large
  table, say so rather than doing it silently — though with no production data
  this should be cheap.
- **Environment variables**: rename them and update `.env.example`, Docker
  Compose, CI config, and any deployment manifests **in the same commit**. A
  renamed variable with a stale deploy config is a silent production failure.
- **Auth artifacts**: rename cookie and session names freely — there are no
  live sessions to invalidate.
- **External registrations**: do not attempt to change these. List them for me
  with the exact current value and the value it should become.

## A4. Verification

- The app builds and all tests pass.
- `grep -ri bellwether` returns only intentional `COMPANY` matches — show me
  that output.
- No string in the UI reads "Bellwether" where it should read "Store Spy".
- Migrations run cleanly forward and backward on an empty database.

Commit as a single reviewable change titled `refactor: disambiguate Bellwether
company name from Store Spy product name`. **No behaviour changes in this
branch** — if you find a bug, note it separately rather than fixing it here.

---

# TASK B — Extract identity into the control plane

Start only after Task A is merged.

Store Spy currently owns its own users, auth, and (probably) its own notion of
plans and subscriptions. A second product is coming, and a customer who buys
both must be one account, not two. The shared layer needs to exist before
Find Suppliers is built, and it is far cheaper to do now with zero rows than
later with paying customers.

## B1. Create the control plane schema

New schema `control_plane`, in the same Postgres instance for now:

```
accounts        id, billing_email, provider_customer_id, created_at
users           id, account_id FK, email, password_hash, account_role, created_at
products        id, slug, name
subscriptions   id, account_id FK, product_id FK, status, period_end, provider_ref
entitlements    id, subscription_id FK, feature_key, quota, used
staff           id, email, password_hash, is_superadmin, created_at
staff_roles     id, staff_id FK, product_id FK, role
audit_log       id, actor_type, actor_id, action, target, metadata, created_at
```

Four rules these encode. Follow them even if a shortcut looks tempting:

1. **`staff` and `users` are separate tables and must never be merged.** No
   `is_admin` flag on `users`. Employees and customers have different
   lifecycles, different auth requirements, and different blast radius.
2. **`accounts` own subscriptions, not `users`.** Store Spy creates a
   one-user account per signup today; team seats later then need no rewrite.
3. **`is_superadmin` is a column on `staff`, not a row in `staff_roles`**, so
   it cannot be granted through the ordinary role-assignment path.
4. **`staff_roles` is scoped per product**, so a marketing hire can be given
   Find Suppliers access without Store Spy customer data.

Seed `products` with `store-spy`. Add `find-suppliers` as a row now — it costs
nothing and makes the multi-product assumption concrete.

## B2. Migrate Store Spy's auth

- Move Store Spy's user records into `control_plane.users`, creating one
  `accounts` row per user.
- Store Spy's own schema keeps only its domain data, joined by `user_id` or
  `account_id`. It must not retain its own users table.
- Session issuance and validation move to the control plane.

## B3. Entitlements service

Expose a single internal endpoint, something like:

```
GET /internal/entitlements?account_id=<id>&feature_key=<key>
→ { allowed: bool, quota: int|null, used: int, reason: string }
```

**Store Spy must call this and nothing else.** It must never query
`subscriptions` directly, never read the payment provider's API, and never
infer access from a plan name string. Every feature gate and every quota check
goes through this endpoint.

Replace every existing plan or tier check in Store Spy with an entitlements
call. List the ones you find and what feature key you mapped each to — I want
to review that mapping, since those keys become the vocabulary for pricing.

## B4. Deployment readiness

While you are in here:

- Dockerfile and `docker-compose.yml` running Store Spy, the control plane,
  Postgres, and Redis.
- Builds happen in CI and produce an image; the server pulls and restarts. Do
  not add a build step that runs on the production host.
- A `/health` endpoint that checks database connectivity.
- `.env.example` complete and accurate, with no real secrets committed.
- Confirm no secrets, keys, or salts are in version control. Flag anything you
  find rather than quietly rotating it.

---

## Ground rules for both tasks

- Work incrementally and show me the diff at each checkpoint. Do not present
  one giant commit at the end.
- Do not refactor unrelated code, restructure directories beyond what the
  rename requires, or upgrade dependencies. If you spot something worth
  changing, add it to a list at the end instead.
- If a decision depends on business intent rather than code — which feature
  keys exist, what the free tier caps, whether a reference means company or
  product — **ask me. Do not choose a plausible default.**
- If something in these instructions contradicts what you find in the
  codebase, stop and tell me. The codebase is the source of truth about what
  exists; I am the source of truth about what it should become.

## When you finish each task

1. Summary of what changed, grouped by category.
2. Anything you deliberately did not change, and why.
3. External actions I need to take myself (DNS, OAuth redirect URIs, repo
   rename, provider dashboards) with exact current and target values.
4. Anything you found that worries you but was out of scope.
