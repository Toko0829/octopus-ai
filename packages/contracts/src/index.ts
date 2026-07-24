import { initContract } from '@ts-rest/core';
import { z } from 'zod';

/**
 * Typed API contract shared by apps/api (implements) and apps/web (calls).
 * Zod schemas are the single source of truth; Fastify validation + the ts-rest
 * client + OpenAPI are all derived from here. See ADR-0004 and tech-stack.md.
 * This is a Phase-0 seed — grows with each endpoint.
 */
const c = initContract();

export const HealthResponse = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  timestamp: z.string().datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const contract = c.router(
  {
    health: {
      method: 'GET',
      path: '/health',
      responses: {
        200: HealthResponse,
      },
      summary: 'Liveness probe',
    },
  },
  {
    pathPrefix: '/api',
  },
);

export type Contract = typeof contract;
