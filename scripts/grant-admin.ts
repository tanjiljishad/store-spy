/**
 * The ONLY way to mint the first SUPER_ADMIN (or grant any other admin
 * role, for that matter) — SUPER_ADMIN cannot be granted through any HTTP
 * route (see PATCH /api/admin/users/[id]/role's invariant 4). Follows
 * scripts/set-user-plan.ts's pattern: DEV/TEST-ONLY tooling, requires
 * direct DATABASE_URL access, not reachable from any route or UI.
 *
 * Usage: npx tsx scripts/grant-admin.ts user@example.com SUPER_ADMIN --confirm
 *
 * Refuses to run without --confirm — granting SUPER_ADMIN is irreversible
 * enough (the recipient can then grant/revoke every other role) that a
 * bare typo'd invocation should never silently succeed.
 */
import { prisma } from "../src/lib/db/prisma";
import { recordAdminAction } from "../src/lib/admin/audit";

const VALID_ROLES = [
  "USER",
  "ANALYST",
  "CONTENT_ADMIN",
  "SUPPORT_ADMIN",
  "BILLING_ADMIN",
  "OPS_ADMIN",
  "MARKETING_ADMIN",
  "MANAGER",
  "SUPER_ADMIN",
] as const;

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--confirm");
  const [email, role] = args.filter((a) => a !== "--confirm");

  if (!email || !role) {
    console.error("Usage: npx tsx scripts/grant-admin.ts <email> <role> --confirm");
    console.error(`Valid roles: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }
  if (!VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
    console.error(`Invalid role "${role}". Must be one of: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }
  if (!confirmed) {
    console.error("Refusing to run without --confirm. This grants a real admin role — re-run with --confirm to proceed.");
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, role: true } });
  if (!existing) {
    console.error(`No user with email "${email}"`);
    process.exit(1);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: existing.id },
      data: { role: role as (typeof VALID_ROLES)[number] },
      select: { id: true, email: true, role: true },
    });
    await recordAdminAction(tx, {
      actorId: "system:bootstrap",
      actorEmail: "system:bootstrap",
      action: "user.role.update",
      targetType: "User",
      targetId: user.id,
      metadata: { fromRole: existing.role, toRole: role, via: "scripts/grant-admin.ts" },
    });
    return user;
  });

  console.log(JSON.stringify(updated, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
