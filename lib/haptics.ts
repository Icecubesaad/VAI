import * as Haptics from 'expo-haptics';

/**
 * Haptic helper — every trigger is fire-and-forget and swallows errors
 * (haptics must never crash or block a press handler, incl. Android
 * devices with no haptic motor and Expo Go).
 */
export type HapticKind = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' | 'selection';

export async function haptic(kind: HapticKind = 'light'): Promise<void> {
  try {
    switch (kind) {
      case 'light':
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        break;
      case 'medium':
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        break;
      case 'heavy':
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        break;
      case 'success':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        break;
      case 'warning':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        break;
      case 'error':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        break;
      case 'selection':
        await Haptics.selectionAsync();
        break;
    }
  } catch {
    // Intentionally silent — haptics are decorative.
  }
}

/** Conventional triggers per surface (keeps feel consistent app-wide). */
export const hapticFor = {
  /** Primary CTAs, Generate, trial start, purchase confirm */
  confirm: () => haptic('medium'),
  /** Plan-card select, toggles, chips */
  select: () => haptic('selection'),
  /** Paywall appears, quota exhausted, destructive actions */
  blocked: () => haptic('warning'),
  /** Render ready, item saved, trial started */
  done: () => haptic('success'),
} as const;
