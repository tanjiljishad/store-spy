import { handlers } from "../../../../lib/auth/auth";

export const runtime = "nodejs"; // Prisma + bcrypt both need Node, not Edge

export const { GET, POST } = handlers;
