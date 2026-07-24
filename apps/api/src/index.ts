import { buildServer } from './server';

/** Entry point for apps/api. Boots the Fastify server. */
const app = await buildServer();

const port = Number(process.env.API_PORT ?? 3001);
const host = process.env.API_HOST ?? '0.0.0.0';

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
