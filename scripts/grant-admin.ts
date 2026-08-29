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

  // B2 2·B: identity is control_plane.users; the admin role lives in
  // store_spy.UserAdminRole (absent row == USER).
  const existing = await prisma.cpUser.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!existing) {
    console.error(`No user with email "${email}"`);
    process.exit(1);
  }
  const currentRole = (await prisma.userAdminRole.findUnique({ where: { userId: existing.id }, select: { role: true } }))?.role ?? "USER";

  const updated = await prisma.$transaction(async (tx) => {
    const newRole = role as (typeof VALID_ROLES)[number];
    if (newRole === "USER") {
      await tx.userAdminRole.deleteMany({ where: { userId: existing.id } });
    } else {
      await tx.userAdminRole.upsert({
        where: { userId: existing.id },
        create: { userId: existing.id, role: newRole },
        update: { role: newRole },
      });
    }
    await recordAdminAction(tx, {
      actorId: "system:bootstrap",
      actorEmail: "system:bootstrap",
      action: "user.role.update",
      targetType: "User",
      targetId: existing.id,
      metadata: { fromRole: currentRole, toRole: role, via: "scripts/grant-admin.ts" },
    });
    return { id: existing.id, email: existing.email, role: newRole };
  });

  console.log(JSON.stringify(updated, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
