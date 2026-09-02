#!/usr/bin/env node
/**
 * Engravings for the landing: masters in, two web encodes out.
 *
 * Masters are black-ink-on-white engravings, generated (see
 * docs/20-design/design-system.md, "How a reference enters this system") and
 * kept in `tools/art/engravings/src/<name>.(png|jpg|webp)`, which is gitignored
 * on the same principle as the Blender masters: a binary in git can only ever
 * be a stale copy of something reproducible, and the prompt and this script are
 * the reproducible part.
 *
 * For each master this writes, into `apps/web/public/engravings/`:
 *
 *   <name>-paper-1x.webp / -2x.webp   ink on white, for the paper panel
 *                                       (placed with mix-blend-mode: multiply)
 *   <name>-ink-1x.webp   / -2x.webp   inverted and tinted teal on black, for the
 *                                       water (placed with mix-blend-mode: screen)
 *
 * Both start from the same levelled greyscale, so the two encodes are the same
 * drawing on two surfaces rather than two drawings. The tint is baked here and
 * not done in CSS, because a CSS filter chain that reliably lands on one hue
 * does not exist, and this hue carries meaning: teal is the agent.
 *
 * Usage:  node tools/art/engrave.mjs            all masters
 *         node tools/art/engrave.mjs entry-tell  one
 *
 * `sharp` is resolved from the workspace: Next already depends on it, so this
 * adds no dependency.
 */

import { createRequire } from 'node:module';
import { readdirSync, mkdirSync, existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const sharp = require(
  require.resolve('sharp', { paths: [resolve(process.cwd(), 'node_modules/.pnpm/node_modules')] }),
);

const SRC = resolve('tools/art/engravings/src');
const OUT = resolve('apps/web/public/engravings');

/** --teal-300 from globals.css, the accent used as light. */
const TEAL = { r: 0x5f, g: 0xe3, b: 0xd4 };

/** Widths of the 1x encode by orientation; 2x is double. Landscape masters are
    3:2 and land in a column at most ~560px wide. Portrait is kept for a future
    master; the hero tried one and the owner rejected it. */
const WIDTH_1X = { landscape: 1100, portrait: 1024 };

const only = process.argv[2];

if (!existsSync(SRC)) {
  console.error(`No masters at ${SRC}. Put the generated engravings there first.`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const masters = readdirSync(SRC)
  .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
  .filter((f) => !only || basename(f, extname(f)) === only);

if (masters.length === 0) {
  console.error(only ? `No master named ${only}` : 'No masters found.');
  process.exit(1);
}

for (const file of masters) {
  const name = basename(file, extname(file));
  const input = sharp(join(SRC, file));
  const meta = await input.metadata();
  const orientation = meta.height > meta.width ? 'portrait' : 'landscape';
  const w1 = WIDTH_1X[orientation];

  // One levelled greyscale for both encodes. `normalise` stretches the plate's
  // tonal range to full black and white, which is what makes a generated
  // engraving with a slightly grey paper and slightly soft ink behave like a
  // print; `linear` then pushes the midtones so hatching stays crisp at 1x.
  const grey = await input.clone().greyscale().normalise().linear(1.15, -12).toBuffer();

  for (const scale of [1, 2]) {
    const width = w1 * scale;

    // Paper: the ink as it is.
    await sharp(grey)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82, effort: 6 })
      .toFile(join(OUT, `${name}-paper-${scale}x.webp`));

    // Ink: invert, so the lines are light and the paper is black, then tint. The
    // tint multiplies the light lines toward teal and leaves the black black,
    // which is exactly what `screen` onto the water needs: black contributes
    // nothing, the lines contribute teal light.
    //
    // Two passes, deliberately. sharp runs its operations in a fixed internal
    // order whatever order they are called in, and `tint` sits before `negate`
    // in that order: one chained call tinted the black-on-white plate and then
    // inverted the result, which is the complement of teal. The first encode
    // shipped coral lines on a page where coral means "a person does this".
    const inverted = await sharp(grey).negate().toBuffer();
    await sharp(inverted)
      .tint(TEAL)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82, effort: 6 })
      .toFile(join(OUT, `${name}-ink-${scale}x.webp`));
  }

  console.log(`${name}: ${orientation}, ${meta.width}x${meta.height} → 4 encodes`);
}
