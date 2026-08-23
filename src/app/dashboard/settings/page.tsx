import { prisma } from "@/lib/db/prisma";
import { requireUser } from "@/lib/auth/session";
import { AccountSettingsActions } from "@/components/dashboard/AccountSettingsActions";

/** Milestone 12 §4.1: makes the GDPR export/delete endpoints actually reachable, and shows the current marketing-consent status set at signup. */
export default async function SettingsPage() {
  const actor = await requireUser();
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: actor.id },
    select: { email: true, marketingConsent: true },
  });

  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight">Settings</h1>

      <section className="mt-6 rounded-lg border border-line bg-surface p-5">
        <h2 className="mb-1 font-mono text-[13px] font-semibold text-paper">Email preferences</h2>
        <p className="font-mono text-[12.5px] text-muted-dim">
          Marketing email: <span className="text-paper">{user.marketingConsent ? "Subscribed" : "Not subscribed"}</span>.{" "}
          {user.marketingConsent
            ? "You can unsubscribe anytime from the link in any marketing email."
            : "You can opt in from the signup form, or a future marketing email will offer an opt-in link."}
        </p>
      </section>

      <div className="mt-6">
        <AccountSettingsActions email={user.email} />
      </div>
    </div>
  );
}
