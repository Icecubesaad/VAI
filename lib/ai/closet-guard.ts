/**
 * VAI · closet guard: fail-closed garment-ownership validator (integrations turf).
 *
 * Every `garment_ref` in a render request must resolve to a user-owned,
 * ACTIVE closet garment. Anything else fails closed — the pipeline refuses
 * to render rather than dressing the user in a stranger's clothes.
 *
 * PIN LAW: pin images may NEVER contribute garments. A pin reference travels
 * through the pipeline ONLY with a role ∈ {pose, style} (`PinReference`):
 *  - `pose`  — stance/framing cue for adapt-mode renders (pose-transfer.ts),
 *  - `style` — taste cue for the planner prompt block (taste-seeds.ts).
 * Enforcement is twofold: (1) `validateRenderGarments` rejects any
 * `garment_ref` without a `garmentId` (raw/unowned image URLs — including
 * pins — cannot enter as garments), and (2) the optional
 * `opts.pinImageUrls` overlap check rejects a `garment_ref.imageUrl` that
 * matches a known pin URL. BACKEND OWNS passing the pin URL list through.
 *
 * Pure + unit-testable. No secrets, no network.
 */

import type { GarmentRef } from './gemini';

/** The only roles a pin image may take in the render pipeline. Never a garment. */
export const PIN_REFERENCE_ROLES = ['pose', 'style'] as const;
export type PinReferenceRole = (typeof PIN_REFERENCE_ROLES)[number];

export interface PinReference {
  imageUrl: string;
  role: PinReferenceRole;
}

export interface OwnedClosetEntry {
  id: string;
  isActive: boolean;
}

/** Active-owned index: entry list (inactive ids fail distinctly) or a prebuilt id set. */
export type ClosetIndex = readonly OwnedClosetEntry[] | ReadonlySet<string>;

export type ValidateRenderGarmentsResult = { ok: true } | { ok: false; reason: string };

export class PinReferenceRoleError extends Error {
  readonly code = 'bad-pin-role';
  constructor(raw: unknown) {
    super(
      `Bad pin reference role: ${JSON.stringify(raw) ?? String(raw)}. ` +
        `Expected one of: ${PIN_REFERENCE_ROLES.join(', ')}. Pin images may only be pose/style references — refusing (fail-closed).`,
    );
    this.name = 'PinReferenceRoleError';
  }
}

export class ClosetGuardError extends Error {
  readonly code = 'closet-guard';
  constructor(reason: string) {
    super(reason);
    this.name = 'ClosetGuardError';
  }
}

/** Runtime guard for untrusted reference-role input (e.g. edge-fn payloads). */
export function isPinReferenceRole(value: unknown): value is PinReferenceRole {
  return value === 'pose' || value === 'style';
}

/** Fail-closed assertion: bad roles throw, never silently coerce. */
export function assertPinReferenceRole(value: unknown): asserts value is PinReferenceRole {
  if (!isPinReferenceRole(value)) throw new PinReferenceRoleError(value);
}

/**
 * Fail-closed ownership check for a render's garment refs. Returns
 * `{ok:true}` or `{ok:false, reason}` — never throws, so the pipeline can
 * surface `reason` in UI/telemetry. Use `assertRenderGarments` for the
 * throwing variant.
 */
export function validateRenderGarments(
  refs: readonly GarmentRef[],
  closet: ClosetIndex,
  opts?: { pinImageUrls?: readonly string[] },
): ValidateRenderGarmentsResult {
  if (refs.length === 0) {
    return { ok: false, reason: 'Render requires at least one garment_ref from the owned closet.' };
  }
  const active = new Set<string>();
  const inactive = new Set<string>();
  if (typeof (closet as ReadonlySet<string>).has === 'function') {
    for (const id of closet as ReadonlySet<string>) {
      const trimmed = id.trim();
      if (trimmed) active.add(trimmed);
    }
  } else {
    for (const entry of closet as readonly OwnedClosetEntry[]) {
      const trimmed = entry.id.trim();
      if (!trimmed) continue;
      if (entry.isActive) active.add(trimmed);
      else inactive.add(trimmed);
    }
  }
  const pinUrls = new Set<string>();
  for (const url of opts?.pinImageUrls ?? []) {
    const trimmed = url.trim();
    if (trimmed) pinUrls.add(trimmed);
  }
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i] as GarmentRef;
    const imageUrl = ref.imageUrl.trim();
    if (imageUrl && pinUrls.has(imageUrl)) {
      return {
        ok: false,
        reason: `garment_ref[${i}] reuses a pin image URL — pin images may only travel as pose/style references, never as garments.`,
      };
    }
    const id = ref.garmentId?.trim() ?? '';
    if (!id) {
      return {
        ok: false,
        reason: `garment_ref[${i}] has no garmentId — raw/unowned images (including pins) may never contribute garments.`,
      };
    }
    if (!active.has(id)) {
      if (inactive.has(id)) {
        return {
          ok: false,
          reason: `garment_ref[${i}] (${id}) is in the closet but not active — reactivate it before rendering.`,
        };
      }
      return {
        ok: false,
        reason: `garment_ref[${i}] (${id}) is not in the user's owned closet — refusing to render (fail-closed).`,
      };
    }
  }
  return { ok: true };
}

/** Throwing variant for pipeline code that prefers exceptions. */
export function assertRenderGarments(
  refs: readonly GarmentRef[],
  closet: ClosetIndex,
  opts?: { pinImageUrls?: readonly string[] },
): void {
  const result = validateRenderGarments(refs, closet, opts);
  if (!result.ok) throw new ClosetGuardError(result.reason);
}
