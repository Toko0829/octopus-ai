import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const monorepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@octopus/config', '@octopus/contracts'],
  // Pin file-tracing to the monorepo root (silences the multi-lockfile warning).
  outputFileTracingRoot: monorepoRoot,
};

export default nextConfig;
