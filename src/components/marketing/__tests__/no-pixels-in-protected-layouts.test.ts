import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Milestone 12 §4.2 Step 2: "Add a test asserting no pixel component is
 * importable from the dashboard or admin layouts." A STATIC claim, not a
 * runtime one — CookieConsentBanner.tsx polices itself at runtime with a
 * pathname check, but the pixel layer is scoped structurally instead:
 * MarketingPixels.tsx (and every pixel component under
 * src/components/marketing/pixels/) is imported ONLY from individual
 * public page files (`/`, `/terms`, `/privacy`), never from the root
 * layout, DashboardLayout, or AdminLayout, or anything THEY import. This
 * test proves that by walking the REAL import graph, not by asserting the
 * page files look right by inspection.
 *
 * The scanner is a lightweight regex-based import extractor, not the
 * TypeScript compiler API — this codebase's imports are all single-line,
 * standard ES module syntax (confirmed by reading, not assumed), so a
 * full ts.Program is unneeded weight for what's fundamentally a
 * regression guard. Its own correctness is verified directly below (the
 * "sanity check" test) rather than trusted blindly: it must find a REAL
 * pixel import starting from the homepage, or a bug in the scanner itself
 * could make every other assertion in this file pass for the wrong
 * reason (finding nothing because it's broken, not because there's
 * nothing there).
 */

const SRC_ROOT = path.resolve(__dirname, "../../../");

// Matches `import ... from "spec"`, `import type ... from "spec"`,
// `export ... from "spec"`, and a bare `import "spec"` (side-effect
// import) — the import styles this codebase's own source actually uses.
// Does NOT match dynamic `import("spec")` calls (no whitespace between
// `import` and `(`) — a known, scoped limitation; none of the files this
// test walks use dynamic imports (confirmed by reading their source).
const IMPORT_RE = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;

function resolveImportPath(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith(".")) return path.resolve(path.dirname(fromFile), specifier);
  if (specifier.startsWith("@/")) return path.resolve(SRC_ROOT, specifier.slice(2));
  return null; // external package (react, next/navigation, etc.) — nothing under src/ to recurse into
}

function findRealFile(basePath: string): string | null {
  const candidates = [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts"), path.join(basePath, "index.tsx")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function collectImportGraph(entryFile: string): Set<string> {
  const visited = new Set<string>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const resolved = findRealFile(current);
    if (!resolved || visited.has(resolved)) continue;
    visited.add(resolved);
    const content = fs.readFileSync(resolved, "utf8");
    for (const match of content.matchAll(IMPORT_RE)) {
      const next = resolveImportPath(resolved, match[1]);
      if (next) queue.push(next);
    }
  }
  return visited;
}

function pixelFilesIn(graph: Set<string>): string[] {
  return [...graph].filter((f) => f.includes(`${path.sep}marketing${path.sep}pixels${path.sep}`) || path.basename(f).startsWith("MarketingPixels"));
}

describe("no pixel component is importable from the dashboard or admin layouts", () => {
  it("DashboardLayout's full import graph contains no marketing pixel module", () => {
    const graph = collectImportGraph(path.join(SRC_ROOT, "app/dashboard/layout.tsx"));
    expect(pixelFilesIn(graph)).toEqual([]);
  });

  it("AdminLayout's full import graph contains no marketing pixel module", () => {
    const graph = collectImportGraph(path.join(SRC_ROOT, "app/admin/layout.tsx"));
    expect(pixelFilesIn(graph)).toEqual([]);
  });

  it("the root layout's own import graph contains no marketing pixel module either — it wraps dashboard/admin too", () => {
    const graph = collectImportGraph(path.join(SRC_ROOT, "app/layout.tsx"));
    expect(pixelFilesIn(graph)).toEqual([]);
  });

  it("sanity check: the scanner genuinely finds a pixel import when one exists — the real public homepage does import MarketingPixels", () => {
    const graph = collectImportGraph(path.join(SRC_ROOT, "app/page.tsx"));
    expect(pixelFilesIn(graph).length).toBeGreaterThan(0);
  });
});
