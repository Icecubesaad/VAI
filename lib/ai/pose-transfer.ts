/**
 * VAI · Pinterest pose-transfer prompt pack (integrations turf).
 *
 * Pose-transfer is reference-image + instruction ONLY on the PRIMARY
 * `gemini-3.1-flash-image` model — there is deliberately NO skeleton
 * conditioning anywhere in this pipeline. The pin reference steers stance
 * angles, camera height, and crop energy through words, never a pose rig.
 *
 * IRON LAW (unchanged): pose is LOCKED to the base photo BY DEFAULT
 * (`DEFAULT_POSE_MODE = 'keep'`, see `poses.ts`). `adapt` is an explicit
 * per-render user opt-in: only call `buildPoseTransferPrompt()` after the
 * user picks "adapt" for that render. The backend records the choice as
 * `pose_mode` (see `pose_mode_selected{keep|adapt}` analytics).
 *
 * BACKEND OWNS: resolving the pin `image_url` server-side and passing
 * `pose_mode + reference` into the render pipeline. This module never
 * fetches image URLs — it receives the already-resolved `poseRefImageUrl`
 * string and treats it as an opaque pose cue, never as a garment source
 * (enforced by `validateRenderGarments` in `closet-guard.ts`).
 *
 * Prompt order is contract-pinned:
 *  1. preservation block FIRST (`FACE_POSE_DIRECTIVES` from gemini.ts —
 *     imported, never forked: face identity, body shape, skin tone),
 *  2. stance/framing adaptation directives from the reference (mirror stance
 *     angles, camera height, crop energy — never the reference person's
 *     body, face, or clothes),
 *  3. owned-garment dressing block (closed world: `outfitGarments` only),
 *  4. anti-copy rules (no logos, watermarks, overlaid text, or branding
 *     lifted from the reference image).
 *
 * SECRETS: none here. All rendering routes via the `render-tryon` edge fn.
 */

import { FACE_POSE_DIRECTIVES, RESTYLE_COST_USD } from './gemini';
import type { GarmentRef } from './gemini';

export const POSE_MODES = ['keep', 'adapt'] as const;
export type PoseMode = (typeof POSE_MODES)[number];

/** Pose stays locked to the base photo unless the user explicitly opts into adapt. */
export const DEFAULT_POSE_MODE: PoseMode = 'keep';

/**
 * Adapt-render pre-flight estimate (display only): 1 credit, ~$0.068 — same
 * cost class as a restyle (`RESTYLE_COST_USD`). No new quota bucket: adapt
 * renders decrement the standard render quota. The edge fn returns
 * authoritative `cost_usd` per call — analytics MUST use that, never this.
 */
export const POSE_ADAPT_COST_USD: number = RESTYLE_COST_USD;

export function isPoseMode(value: unknown): value is PoseMode {
  return value === 'keep' || value === 'adapt';
}

export class PoseTransferError extends Error {
  readonly code = 'pose-transfer-invalid';
  constructor(message: string) {
    super(message);
    this.name = 'PoseTransferError';
  }
}

export interface PoseTransferInput {
  /** User's base photo (id or URL label — the pipeline resolves the bytes). */
  basePhoto: string;
  /** Owned-only garment refs (must already pass `validateRenderGarments`). */
  outfitGarments: readonly GarmentRef[];
  /** Server-resolved pin image URL — pose cue ONLY, never a garment source. */
  poseRefImageUrl: string;
  /** Optional user note on the stance to borrow (e.g. "leaning, arms crossed"). Capped at 280 chars. */
  stanceNote?: string;
}

export interface PoseTransferPrompt {
  prompt: string;
  tags: string[];
  poseMode: PoseMode;
}

/**
 * Stance/framing adaptation: borrow stance ANGLES, camera height, and crop
 * energy from the reference. Explicitly NOT borrowed: the reference person's
 * body shape, face/identity, garments, or styling.
 */
const STANCE_ADAPTATION_DIRECTIVES =
  'Adapt the stance to the pose reference image: mirror its stance angles, ' +
  'weight distribution, camera height, and crop energy. Keep the person\'s own ' +
  'body shape, proportions, face identity, and skin tone from the base photo — ' +
  'never adopt the reference person\'s body, face, or clothes.';

const ANTI_COPY_DIRECTIVES =
  'Do not copy, reproduce, or approximate any logo, watermark, overlaid text, ' +
  'caption, brand mark, or graphic from the pose reference image. The output ' +
  'contains no text overlays and no branding beyond what the owned garments ' +
  'themselves carry.';

const MAX_STANCE_NOTE_CHARS = 280;

function cleanStanceNote(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= MAX_STANCE_NOTE_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_STANCE_NOTE_CHARS - 1).trimEnd()}…`;
}

function describeGarment(g: GarmentRef, index: number): string {
  const label = g.category?.trim() || 'garment';
  const id = g.garmentId?.trim();
  return id ? `${index + 1}. ${label} (owned id ${id})` : `${index + 1}. ${label}`;
}

/**
 * Build the adapt-mode render prompt. Pure + unit-testable; the server may
 * reuse the output verbatim. Fail-closed: throws `PoseTransferError` on a
 * missing base photo, an empty garment list, id-less (unowned) garment refs,
 * or a missing pose reference.
 */
export function buildPoseTransferPrompt(input: PoseTransferInput): PoseTransferPrompt {
  const base = input.basePhoto.trim();
  if (!base) throw new PoseTransferError('pose-transfer requires a base photo.');
  const ref = input.poseRefImageUrl.trim();
  if (!ref) {
    throw new PoseTransferError('pose-transfer requires a server-resolved pose reference image URL.');
  }
  if (input.outfitGarments.length === 0) {
    throw new PoseTransferError('pose-transfer requires at least one owned garment ref.');
  }
  const idless = input.outfitGarments.findIndex((g) => !g.garmentId?.trim());
  if (idless !== -1) {
    throw new PoseTransferError(
      `pose-transfer garment_ref[${idless}] has no garmentId — pin images may never contribute garments.`,
    );
  }
  const parts: string[] = [FACE_POSE_DIRECTIVES, STANCE_ADAPTATION_DIRECTIVES];
  const note = input.stanceNote !== undefined ? cleanStanceNote(input.stanceNote) : '';
  if (note) parts.push(`Requested stance nuance: ${note}.`);
  parts.push(
    `Dress the person ONLY in these owned garments (${input.outfitGarments.length}): ` +
      `${input.outfitGarments.map(describeGarment).join('; ')}. ` +
      'Do not add, swap, or restyle garments beyond this list.',
  );
  parts.push(ANTI_COPY_DIRECTIVES);
  return {
    prompt: parts.join(' '),
    tags: ['pose-mode:adapt'],
    poseMode: 'adapt',
  };
}
