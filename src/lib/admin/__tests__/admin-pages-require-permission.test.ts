import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Security review fix 1: admin/promos/page.tsx and admin/users/page.tsx
 * called no permission check at all — AdminLayout only proves "holds some
 * admin permission" (see its own doc comment), never the specific one a
 * given page's data requires. Fixing the two known instances isn't enough
 * on its own: this makes the whole CLASS of bug structurally impossible to
 * reintroduce by walking the real page.tsx files under src/app/admin/
 * (not an allowlist that has to be kept in sync by hand), so a NEW admin
 * page added later and forgotten still fails here. Same approach as
 * no-pixels-in-protected-layouts.test.ts: a lightweight regex check on
 * each file's own source, not a claim about its transitive imports —
 * every existing admin page calls requirePermission() directly (see
 * admin/analytics/page.tsx), and that's the pattern this enforces.
 */

const ADMIN_APP_ROOT = path.resolve(__dirname, "../../../app/admin");
const REQUIRE_PERMISSION_CALL_RE = /\brequirePermission\s*\(/;

function findPageFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findPageFiles(full));
    else if (entry.isFile() && entry.name === "page.tsx") found.push(full);
  }
  return found;
}

function sourceCallsRequirePermission(source: string): boolean {
  return REQUIRE_PERMISSION_CALL_RE.test(source);
}

function pagesMissingRequirePermission(files: string[]): string[] {
  return files
    .filter((f) => !sourceCallsRequirePermission(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(ADMIN_APP_ROOT, f));
}

describe("every admin page.tsx calls requirePermission()", () => {
  const pageFiles = findPageFiles(ADMIN_APP_ROOT);

  it("sanity check: the walker actually found admin pages to check (proves this isn't vacuously passing)", () => {
    expect(pageFiles.length).toBeGreaterThan(0);
  });

  it("no admin page.tsx is missing a requirePermission() call", () => {
    expect(pagesMissingRequirePermission(pageFiles)).toEqual([]);
  });

  it("negative control: the checker correctly flags source that never calls requirePermission() — proves the regex isn't vacuously true", () => {
    const pageWithNoPermissionCheck = `
      import { prisma } from "@/lib/db/prisma";
      import { listPromos } from "@/lib/admin/promos-service";

      export default async function AdminPromosPage() {
        const page = await listPromos(prisma);
        return <div>{page.items.length}</div>;
      }
    `;
    expect(sourceCallsRequirePermission(pageWithNoPermissionCheck)).toBe(false);
  });

  it("negative control (import-only): merely importing requirePermission without calling it must not satisfy the check", () => {
    const importOnly = `import { requirePermission } from "@/lib/admin/guard";\n\nexport default async function P() { return null; }`;
    expect(sourceCallsRequirePermission(importOnly)).toBe(false);
  });
});
