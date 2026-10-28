import { PrismaClient } from '@prisma/client';

/**
 * Process-wide client for modules that previously created their own at import time.
 * Lives outside `events/` so event hot reloads (which clear and re-require that folder)
 * reuse it instead of opening another MongoDB connection pool on every reload.
 */
export const prisma = new PrismaClient();
