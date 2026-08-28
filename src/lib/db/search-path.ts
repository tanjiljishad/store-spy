/**
 * DATABASE_URL / search_path guard.
 *
 * Since the control-plane split (migration 20260828120000) the application's
 * tables live in the `store_spy` Postgres schema, not `public`. Prisma's typed
 * queries are schema-qualified and unaffected, but RAW SQL ($queryRaw /
 * $executeRaw — including every integration test's `TRUNCATE "..."`) resolves
 * bare identifiers through `search_path`, which must therefore put `store_spy`
 * ahead of `public`.
 *
 * The footgun this guards against: adding `?schema=public` (or any `?schema=`)
 * back onto DATABASE_URL. Prisma then pins `search_path` to that one schema and
 * ignores the `options` parameter entirely — every raw SQL statement breaks,
 * and it breaks at the first query at runtime, not at boot. Seven code
 * comments do not survive muscle memory; this does.
 *
 * Wired into src/instrumentation.ts (server start — refuses to boot) and
 * vitest.integration.setup.ts (the integration preflight).
 */

/** search_path must start with this; `public` must also be present (for _prisma_migrations and advisory locks). */
export const REQUIRED_FIRST_SCHEMA = "store_spy";

function tryParse(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/**
 * The `?schema=` footgun. Always wrong post-split, regardless of how
 * search_path is otherwise set. Returns a problem string, or null if clean.
 */
export function schemaParamProblem(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null; // absence is a different, louder failure — let Prisma report it
  const u = tryParse(rawUrl);
  if (!u) return null;
  if (u.searchParams.has("schema")) {
    return (
      `DATABASE_URL carries \`?schema=${u.searchParams.get("schema")}\`. Remove it. ` +
      `It pins Postgres search_path to that one schema and makes Prisma ignore the ` +
      `\`options\` parameter, so every raw SQL query resolves against the wrong schema. ` +
      `Use \`?options=-c search_path=store_spy,public\` instead (see docs/environment-variables.md).`
    );
  }
  return null;
}

function parseSearchPathList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * Strict check for controlled environments (the integration preflight): the
 * URL must itself carry `options=-c search_path=store_spy,public` (or
 * equivalent). Returns a list of problems; empty means fine.
 *
 * Not used at app startup — production may legitimately set search_path via
 * `ALTER ROLE` / `ALTER DATABASE` / a pooler config rather than the URL, and
 * liveSearchPathProblem() is the authoritative check there.
 */
export function explicitSearchPathProblems(rawUrl: string | undefined): string[] {
  if (!rawUrl) return ["DATABASE_URL is unset"];
  const u = tryParse(rawUrl);
  if (!u) return [`DATABASE_URL is not a valid URL: ${rawUrl}`];

  const schemaProblem = schemaParamProblem(rawUrl);
  if (schemaProblem) return [schemaProblem];

  const options = u.searchParams.get("options");
  const match = options?.match(/search_path\s*=\s*([^&\s]+)/i);
  if (!match) {
    return [
      `DATABASE_URL has no \`options=-c search_path=...\`. Post-split it must set ` +
        `\`?options=-c search_path=store_spy,public\`.`,
    ];
  }
  const list = parseSearchPathList(match[1]);
  const problems: string[] = [];
  if (list[0] !== REQUIRED_FIRST_SCHEMA) {
    problems.push(`search_path in DATABASE_URL is [${list.join(", ")}] — "${REQUIRED_FIRST_SCHEMA}" must be first.`);
  }
  if (!list.includes("public")) {
    problems.push(`search_path in DATABASE_URL is [${list.join(", ")}] — "public" must also be present.`);
  }
  return problems;
}

/**
 * The authoritative runtime check: ask Postgres what search_path the live
 * connection actually has and confirm `store_spy` resolves before `public`.
 * Catches a misconfiguration no matter how it arose (URL, ALTER ROLE, pooler).
 * Returns a problem string, or null if fine. Throws only on a real connection
 * error — the caller decides whether that should block startup.
 */
export async function liveSearchPathProblem(
  client: { $queryRawUnsafe: (query: string) => Promise<unknown> },
): Promise<string | null> {
  const rows = (await client.$queryRawUnsafe("SHOW search_path")) as Array<{ search_path: string }>;
  const raw = rows[0]?.search_path ?? "";
  const list = parseSearchPathList(raw);
  const storeSpyIdx = list.indexOf(REQUIRED_FIRST_SCHEMA);
  const publicIdx = list.indexOf("public");

  if (storeSpyIdx === -1) {
    return `live search_path is [${raw}] — "${REQUIRED_FIRST_SCHEMA}" is absent. Bare identifiers in raw SQL will resolve to the wrong schema or error.`;
  }
  if (publicIdx !== -1 && publicIdx < storeSpyIdx) {
    return `live search_path is [${raw}] — "public" precedes "${REQUIRED_FIRST_SCHEMA}"; bare table names will resolve to public.`;
  }
  return null;
}
