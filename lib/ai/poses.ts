/**
 * VAI · Pose Pack prompt pack for reel drops (integrations turf).
 *
 * IRON LAW — pose is LOCKED to the base photo, never AI-invented.
 * Inventing stances/strides mangles limbs. Every per-pose directive below is
 * framing/crop/attitude ONLY and is always appended to the standard
 * face/pose-lock preservation block (`FACE_POSE_DIRECTIVES` in gemini.ts).
 * The `render-tryon` backend MUST enforce the same lock server-side.
 *
 * `base_photos.pose` (text, backend migration pending — NOT this turf)
 * records which reel pose a base was captured for. `selectBaseForPose()`
 * prefers a base captured for the requested pose and otherwise falls back to
 * the newest active base; the lock holds either way because the directives
 * never alter stance, stride, or limb angles.
 *
 * SECRETS: none here. All rendering routes via the `render-tryon` edge fn.
 */

import { FACE_POSE_DIRECTIVES } from './gemini';

export const REEL_POSES = ['front', 'step', 'detail'] as const;
export type ReelPose = (typeof REEL_POSES)[number];

/** Default 7-day pose rotation for a full weekly reel drop. */
export const REEL_WEEK_POSES: readonly ReelPose[] = [
  'front',
  'step',
  'detail',
  'front',
  'step',
  'detail',
  'front',
];

export class UnknownPoseError extends Error {
  readonly code = 'unknown-pose';
  constructor(raw: unknown) {
    super(
      `Unknown reel pose: ${JSON.stringify(raw) ?? String(raw)}. ` +
        `Expected one of: ${REEL_POSES.join(', ')}. Refusing to render (fail-closed).`,
    );
    this.name = 'UnknownPoseError';
  }
}

export class NoBasePhotoError extends Error {
  readonly code = 'no-base-photo';
  constructor() {
    super('No base photo available for this pose. Capture a base photo first.');
    this.name = 'NoBasePhotoError';
  }
}

/** Runtime guard for untrusted pose input (e.g. `base_photos.pose` rows). */
export function isReelPose(value: unknown): value is ReelPose {
  return value === 'front' || value === 'step' || value === 'detail';
}

/** Fail-closed assertion: unknown poses throw, never silently default. */
export function assertReelPose(value: unknown): asserts value is ReelPose {
  if (!isReelPose(value)) throw new UnknownPoseError(value);
}

/** Parse + validate in one step (fail-closed). */
export function parseReelPose(value: unknown): ReelPose {
  assertReelPose(value);
  return value;
}

// ------------------------------------------------------- directives

/**
 * Per-pose framing directives. Framing/crop/attitude ONLY — stance, stride,
 * limb angles, face, and body stay locked to the base photo in every pose.
 * The server may reuse these strings verbatim (contract-pinned).
 */
export const POSE_FRAMING_DIRECTIVES: Record<ReelPose, string> = {
  front:
    'Frame full-body, straight-on, head to shoes, as a fit check: every ' +
    'garment fully inside the frame with clean hems and edges.',
  step:
    'Street-style energy through the attitude of the crop and scene only: ' +
    'same body, same stance, same stride and limb angles, same face as the ' +
    'base photo. Do NOT invent a mid-stride pose or alter any limb.',
  detail:
    'Tighter three-quarter crop highlighting fabric texture, stitching, and ' +
    'accessories; face identity, body shape, stance, and limb angles stay ' +
    'locked to the base photo.',
};

export interface PosePrompt {
  prompt: string;
  tags: string[];
}

/**
 * Build the render prompt for one reel pose: standard face/pose-lock block
 * FIRST, per-pose framing directive APPENDED. Pure + unit-testable.
 * Unknown poses throw (fail-closed) — never silently default.
 */
export function buildPosePrompt(pose: unknown): PosePrompt {
  assertReelPose(pose);
  return {
    prompt: `${FACE_POSE_DIRECTIVES} ${POSE_FRAMING_DIRECTIVES[pose]}`,
    tags: [`pose:${pose}`],
  };
}

// ------------------------------------------------------- multi-base selector

/**
 * Minimal `base_photos` row shape this selector reads. `pose` arrives via
 * the pending backend migration; pre-migration rows simply omit it (treated
 * as untagged) so the selector keeps working across the migration.
 */
export interface BasePhotoLite {
  id: string;
  url: string;
  pose?: string | null;
  is_active: boolean;
  created_at?: string;
}

function createdTime(b: BasePhotoLite): number {
  if (!b.created_at) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(b.created_at);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Pick the base photo for a reel pose:
 * 1. validate the pose (fail-closed),
 * 2. prefer active rows (fall back to all rows when none is active),
 * 3. prefer a base captured for this pose (`pose` column),
 * 4. otherwise the newest base — framing-only directives keep the pose
 *    lock intact, so limbs are never AI-invented.
 * Throws `NoBasePhotoError` when there is no base at all.
 */
export function selectBaseForPose(
  bases: readonly BasePhotoLite[],
  pose: unknown,
): BasePhotoLite {
  assertReelPose(pose);
  if (bases.length === 0) throw new NoBasePhotoError();
  const active = bases.filter((b) => b.is_active);
  const pool: readonly BasePhotoLite[] = active.length > 0 ? active : bases;
  const tagged = pool.find((b) => b.pose === pose);
  if (tagged) return tagged;
  const first = pool[0];
  if (first === undefined) throw new NoBasePhotoError(); // unreachable; fail-closed
  let best: BasePhotoLite = first;
  let bestTime = createdTime(first);
  for (const b of pool) {
    const t = createdTime(b);
    if (t > bestTime) {
      best = b;
      bestTime = t;
    }
  }
  return best;
}
