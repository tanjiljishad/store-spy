/**
 * Next.js server-start hook (node_modules/next/dist/docs/.../instrumentation.md):
 * `register()` runs once when a server instance boots, before it serves any
 * request, in every runtime.
 *
 * We use it for one thing: refuse to start if the database connection's
 * `search_path` is wrong. Since the control-plane split the app's tables live
 * in the `store_spy` schema and all raw SQL depends on `search_path` having it
 * ahead of `public` — see src/lib/db/search-path.ts. A wrong `search_path`
 * (usually: someone put `?schema=public` back on DATABASE_URL) otherwise only
 * surfaces on the first raw query, deep into serving traffic. Better to fail
 * the boot.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { schemaParamProblem, liveSearchPathProblem } = await import("./lib/db/search-path");

  // 1. String-level: the `?schema=` footgun. No database needed — always fatal.
  const urlProblem = schemaParamProblem(process.env.DATABASE_URL);
  if (urlProblem) {
    throw new Error(`[startup] Refusing to start — ${urlProblem}`);
  }

  // 2. Runtime-level: what search_path did the connection actually get?
  //    A connection failure here is NOT a config bug (transient infra, a
  //    build-time invocation with no DB) — log and continue. A search_path
  //    mismatch IS — refuse to start.
  const { prisma } = await import("./lib/db/prisma");
  let liveProblem: string | null = null;
  try {
    liveProblem = await liveSearchPathProblem(prisma);
  } catch (e) {
    console.warn(
      `[startup] Could not verify database search_path (DB unreachable at boot?): ${
        e instanceof Error ? e.message : String(e)
      }. The URL string check passed; the first raw query will surface any real problem.`,
    );
    return;
  }
  if (liveProblem) {
    throw new Error(
      `[startup] Refusing to start — ${liveProblem} Expected search_path with "store_spy" first, then "public". ` +
        `Check DATABASE_URL (it must NOT contain \`?schema=\`; use \`?options=-c search_path=store_spy,public\`).`,
    );
  }
}
