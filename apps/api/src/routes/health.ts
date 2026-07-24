import type { FastifyInstance } from 'fastify';
import { HealthResponse } from '@octopus/contracts';

/**
 * Liveness probe. Implements the `health` route from @octopus/contracts.
 * See docs/10-architecture/observability.md (uptime/synthetics run against this path).
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      service: 'octopus-api',
      version: process.env.npm_package_version ?? '0.0.0',
      timestamp: new Date().toISOString(),
    };
  });
}
