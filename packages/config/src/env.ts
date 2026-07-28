import { z } from 'zod';

/**
 * Environment schema — the single validated definition of what Octopus needs to boot.
 * See docs/30-modules/infra-devops.md (env schema validation) and .env.example.
 * Rule: SUPABASE_SERVICE_ROLE_KEY is SERVER-ONLY and must never reach the client.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Web (public, browser-safe). Publishable key only, never a secret key.
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),

  // API (server-only). Supabase new key format: sb_publishable_... and sb_secret_...
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  SUPABASE_JWT_ISSUER: z.string().url().optional(),

  // Services.
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_HOST: z.string().default('0.0.0.0'),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  API_URL: z.string().url().default('http://localhost:3001'),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validate and return the server environment. Throws (loudly) on invalid config so a
 * misconfigured service fails fast at boot instead of behaving mysteriously later.
 */
export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = JSON.stringify(parsed.error.flatten().fieldErrors, null, 2);
    // eslint-disable-next-line no-console
    console.error('[config] Invalid environment configuration:\n' + issues);
    throw new Error('Invalid environment configuration');
  }
  return parsed.data;
}
