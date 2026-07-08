// One-off asset optimizer: PNG -> WebP.
// Run with: node scripts/encode-images.mjs
import sharp from "sharp";

// The hero cutout is rotated 30° clockwise so the sponge reads upright and the
// forearm drops to the bottom-right corner, matching the comp.
const HAND_ROTATE = 32;

const jobs = [
  // Decorative full-bleed base — near-solid cream, so a single moderate size is plenty.
  { in: "background.png", out: "background.webp", width: 2200, quality: 80 },
  // Hero cutout (has alpha) — rotated, trimmed, two widths for srcset.
  { in: "hand-sponge.png", out: "hand-sponge-1600.webp", width: 1600, quality: 86, rotate: HAND_ROTATE },
  { in: "hand-sponge.png", out: "hand-sponge-800.webp", width: 800, quality: 86, rotate: HAND_ROTATE },
];

for (const j of jobs) {
  let pipe = sharp(j.in);
  const meta = await pipe.metadata();
  if (j.rotate) {
    // Rotate with a transparent canvas (expands), then trim the transparent border.
    pipe = pipe
      .rotate(j.rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .trim();
  }
  const info = await pipe
    .resize({ width: j.width, withoutEnlargement: true })
    .webp({ quality: j.quality, effort: 6 })
    .toFile(j.out);
  console.log(
    `${j.in} (${meta.width}x${meta.height}) -> ${j.out} ` +
      `(${info.width}x${info.height}, ${(info.size / 1024).toFixed(0)} KB)`,
  );
}
