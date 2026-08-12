import { PrismaClient } from "@prisma/client";

/**
 * Standard Next.js/Prisma dev-mode singleton: without caching on globalThis,
 * every hot-reload in dev creates a new PrismaClient (and a new connection
 * pool) without releasing the old one, and a dev session eventually exhausts
 * Postgres's max_connections. Production gets one instance per process either way.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
