import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { Badge } from './Badge';
import { buildWatermarkText } from '../lib/watermark';

export type ShareCardProps = {
  /** DNA teaser line from quiz-score, e.g. "Soft tailoring, warm neutrals…" */
  teaser: string;
  labels: string[];
  colorSeason: string;
  /** Renders the `Made with VAI · vai.style/r/<code>` attribution line. */
  watermark?: boolean;
  /** Referral code for the watermark URL; generic stamp when omitted. */
  referralCode?: string | null;
  testID?: string;
};

/**
 * Frontend alias-shape for style-DNA sharing (CONTRACT-frontend name).
 * Lightweight quiz-teaser card: teaser + label chips + color season +
 * attribution line. The full exportable 4:5 view-shot card stays `ShareDNA`;
 * pass `referralCode` here and the watermark URL matches it exactly.
 */
export const ShareCard = memo(function ShareCard({
  teaser,
  labels,
  colorSeason,
  watermark = false,
  referralCode,
  testID,
}: ShareCardProps): React.JSX.Element {
  return (
    <View
      testID={testID ?? 'share-card'}
      accessible
      accessibilityLabel={`Style DNA: ${teaser}. Labels: ${labels.join(', ')}. Season ${colorSeason}`}
      className="gap-y-md rounded-xl border border-lineOnCard bg-card p-lg shadow-card"
    >
      <Text className="text-[13px] font-semibold text-terracotta">
        Your style DNA
      </Text>
      <Text className="font-display text-[22px] leading-[28px] font-semibold text-ink">
        {teaser}
      </Text>
      <View className="flex-row flex-wrap gap-[8px]" aria-hidden={labels.length === 0}>
        {labels.slice(0, 5).map((l) => (
          <Badge key={l} label={l} tone="neutral" />
        ))}
      </View>
      <Text className="text-[15px] leading-[22px] text-inkSoft">
        Suits a <Text className="font-bold text-ink">{colorSeason}</Text> palette
      </Text>
      {watermark ? (
        <Text className="border-t border-line pt-md text-[13px] leading-[18px] font-semibold text-inkSoft">
          {referralCode ? buildWatermarkText(referralCode) : 'Made with VAI · vai.style'}
        </Text>
      ) : null}
    </View>
  );
});
