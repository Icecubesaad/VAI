// Background removal (Deno, strict TS) — pure-JS so it runs in edge runtime.
// Founder requirement (Sep 2026): renders carry the PERSON ONLY on a fully
// transparent background. Image providers return JPEG (no alpha), so we
// prompt for a flat white studio backdrop and flood-fill it to alpha=0 from
// the borders — interior whites (shirts, highlights) survive because only
// border-connected white is removed.

// npm specifiers — bundled by the Supabase edge runtime.
import { decode as jpegDecode } from "npm:jpeg-js@0.4.4";
import { PNG } from "npm:pngjs@7.0.0";

const SOFT_ALPHA = 90; // 1px boundary feather
const EDGE_ALPHA = 170; // 2nd-ring feather
const MIN_REMOVED_FRACTION = 0.05; // below this the bg wasn't flat — keep original

export function removeWhiteBackground(jpegBytes: Uint8Array): Uint8Array | null {
  try {
    const img = jpegDecode(jpegBytes, { useTArray: true, maxMemoryUsageInMB: 640 });
    const w = img.width as number;
    const h = img.height as number;
    const src = img.data as Uint8Array; // RGBA (jpeg-js alpha=255)
    const px = (x: number, y: number) => (y * w + x) * 4;

    // Adaptive background model: the provider is prompted for a flat studio
    // backdrop, but real output has gradients/vignettes — so we learn the
    // border color cluster (mean + spread) instead of hardcoding white.
    const samples: number[][] = [];
    for (let x = 0; x < w; x += 2) {
      for (const y of [0, h - 1]) samples.push([src[px(x, y)], src[px(x, y) + 1], src[px(x, y) + 2]]);
    }
    for (let y = 0; y < h; y += 2) {
      for (const x of [0, w - 1]) samples.push([src[px(x, y)], src[px(x, y) + 1], src[px(x, y) + 2]]);
    }
    const mu = [0, 0, 0];
    for (const s of samples) for (let c = 0; c < 3; c++) mu[c] += s[c];
    for (let c = 0; c < 3; c++) mu[c] /= samples.length;
    const sigma = [1, 1, 1];
    for (const s of samples) for (let c = 0; c < 3; c++) sigma[c] += (s[c] - mu[c]) ** 2;
    for (let c = 0; c < 3; c++) sigma[c] = Math.max(6, Math.sqrt(sigma[c] / samples.length) * 2.2);
    const isBackground = (i: number) =>
      Math.abs(src[i] - mu[0]) <= sigma[0] &&
      Math.abs(src[i + 1] - mu[1]) <= sigma[1] &&
      Math.abs(src[i + 2] - mu[2]) <= sigma[2];

    // BFS from every border pixel: border-connected white = background.
    const visited = new Uint8Array(w * h);
    const queue: number[] = [];
    for (let x = 0; x < w; x++) {
      for (const y of [0, h - 1]) {
        const idx = y * w + x;
        if (!visited[idx] && isBackground(px(x, y))) {
          visited[idx] = 1;
          queue.push(idx);
        }
      }
    }
    for (let y = 0; y < h; y++) {
      for (const x of [0, w - 1]) {
        const idx = y * w + x;
        if (!visited[idx] && isBackground(px(x, y))) {
          visited[idx] = 1;
          queue.push(idx);
        }
      }
    }
    while (queue.length > 0) {
      const idx = queue.pop()!;
      const x = idx % w;
      const y = (idx - x) / w;
      const neighbors: Array<[number, number]> = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nIdx = ny * w + nx;
        if (!visited[nIdx] && isBackground(px(nx, ny))) {
          visited[nIdx] = 1;
          queue.push(nIdx);
        }
      }
    }

    let removed = 0;
    for (let idx = 0; idx < visited.length; idx++) if (visited[idx]) removed++;
    if (removed / (w * h) < MIN_REMOVED_FRACTION) {
      console.error("[bgremove] background not flat enough — keeping original", {
        removedFraction: Number((removed / (w * h)).toFixed(3)),
      });
      return null; // a half-cutout is worse than no cutout
    }

    const out = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = px(x, y);
        const d = (y * w + x) * 4;
        out.data[d] = src[s];
        out.data[d + 1] = src[s + 1];
        out.data[d + 2] = src[s + 2];
        const bgNear =
          (x > 0 && visited[y * w + x - 1]) ||
          (x < w - 1 && visited[y * w + x + 1]) ||
          (y > 0 && visited[(y - 1) * w + x]) ||
          (y < h - 1 && visited[(y + 1) * w + x]);
        if (visited[y * w + x]) out.data[d + 3] = 0;
        else if (bgNear) {
          out.data[d + 3] = SOFT_ALPHA; // feather the cut edge
        } else {
          out.data[d + 3] = 255;
        }
      }
    }
    return PNG.sync.write(out);
  } catch (e) {
    console.error("[bgremove] failed — keeping original image", { error: (e as Error).message });
    return null; // a render must never fail on polish
  }
}
