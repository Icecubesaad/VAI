import React, { forwardRef, memo } from 'react';
import { Text, View } from 'react-native';
import ViewShot, { captureRef, type ViewShotRef } from 'react-native-view-shot';
import { buildReferralUrl, buildWatermarkText } from '../lib/watermark';

export type ShareDNAProps = {
  name?: string;
  styleLabels: string[];
  colorSeason?: string | null;
  palette?: string[];
  /** Referral code stamped as vai.style/r/<code> */
  referralCode: string;
  testID?: string;
};

/**
 * Style DNA share card — fixed 4:5 geometry (1080×1350 export).
 * Rendered on paper with serif display type, exported via view-shot.
 *
 * Export:
 * ```tsx
 * const ref = useRef<ViewShotRef>(null);
 * <ShareDNA ref={ref} styleLabels={…} referralCode={…} />
 * const uri = await captureShareDNA(ref); // jpg tmpfile → Share.share()
 * ```
 */
export const ShareDNA = memo(
  forwardRef<ViewShotRef, ShareDNAProps>(function ShareDNA(
    { name, styleLabels, colorSeason, palette = [], referralCode, testID },
    ref,
  ): React.JSX.Element {
    return (
      <ViewShot
        ref={ref}
        options={{ format: 'jpg', quality: 0.95, result: 'tmpfile' }}
        style={{ width: '100%', aspectRatio: 1080 / 1350 }}
      >
        <View
          testID={testID}
          accessible
          accessibilityLabel={`Style DNA card for ${name ?? 'you'}: ${styleLabels.join(', ')}`}
          className="flex-1 justify-between bg-paper p-[48px]"
        >
          <View className="gap-y-[12px]">
            {/* Eyebrow in sentence case — no tracked ALL-CAPS (a template tell). */}
            <Text className="text-[22px] font-semibold text-terracottaDeep">
              My style DNA
            </Text>
            <Text className="font-display text-[64px] leading-[68px] text-ink" numberOfLines={2}>
              {name ?? 'Styled by VAI'}
            </Text>
          </View>

          <View className="gap-y-[20px]">
            <View className="flex-row flex-wrap gap-[10px]">
              {styleLabels.slice(0, 5).map((l) => (
                <View key={l} className="rounded-full border border-line bg-card px-[18px] py-[10px]">
                  <Text className="text-[24px] font-semibold text-ink">{l}</Text>
                </View>
              ))}
            </View>
            {colorSeason ? (
              <Text className="text-[26px] text-inkSoft">
                Season · <Text className="font-bold text-ink">{colorSeason}</Text>
              </Text>
            ) : null}
            {palette.length > 0 ? (
              <View className="flex-row gap-[10px]" aria-hidden>
                {palette.slice(0, 6).map((hex) => (
                  <View
                    key={hex}
                    style={{ backgroundColor: hex }}
                    className="h-[44px] w-[44px] rounded-full border border-line"
                  />
                ))}
              </View>
            ) : null}
          </View>

          <View className="gap-y-[8px] border-t border-line pt-[20px]">
            <Text className="text-[22px] font-semibold text-inkSoft">{buildWatermarkText(referralCode)}</Text>
            <Text className="text-[20px] text-muted">Find your DNA · {buildReferralUrl(referralCode).replace('https://', '')}</Text>
          </View>
        </View>
      </ViewShot>
    );
  }),
);

export async function captureShareDNA(ref: React.RefObject<ViewShotRef | null>): Promise<string> {
  const node = ref.current;
  if (!node) throw new Error('ShareDNA ref not attached');
  // Prefer the instance method; fall back to captureRef for older versions.
  const maybeCapture = node as unknown as { capture?: () => Promise<string> };
  if (typeof maybeCapture.capture === 'function') return maybeCapture.capture();
  return captureRef(node, { format: 'jpg', quality: 0.95, result: 'tmpfile' });
}
