import React, { memo } from 'react';
import { Text, View } from 'react-native';
import Svg, { Ellipse, Path } from 'react-native-svg';
import { Button } from './Button';

export type SelfieCheck = {
  key: 'blur' | 'light' | 'face' | 'pose';
  ok: boolean;
  hint: string;
};

export type SelfieGuideProps = {
  /** Live on-device checks; fail = inline reason + Retake (pack §6). */
  checks?: SelfieCheck[];
  /** Machine-readable failure reason for inline display + Retake. */
  failureReason?: string | null;
  onCapture: () => void;
  onRetake?: () => void;
  capturing?: boolean;
  testID?: string;
};

const GOOD = ['Full body, head to shoes', 'Phone at chest height', 'Plain background', 'Daylight or bright room'];
const BAD = ['No mirror clutter behind you', 'No backlight from windows', 'No cropped feet or head'];

/**
 * Mirror-selfie capture overlay: ghost silhouette framing guide + static
 * good/bad hint lists + inline failure reason. Fully static layout
 * (absolute-positioned SVG) so the camera preview never re-lays-out.
 */
export const SelfieGuide = memo(function SelfieGuide({
  checks = [],
  failureReason,
  onCapture,
  onRetake,
  capturing = false,
  testID,
}: SelfieGuideProps): React.JSX.Element {
  const failed = checks.filter((c) => !c.ok);
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel="Selfie guide. Line up your full body inside the silhouette."
      className="flex-1 bg-ink px-xl py-lg"
    >
      {/* ghost silhouette */}
      <View className="flex-1 items-center justify-center" aria-hidden>
        <Svg width={180} height={320} viewBox="0 0 180 320">
          {/* head */}
          <Ellipse cx={90} cy={42} rx={24} ry={28} fill="none" stroke="#FAF8F5" strokeOpacity={0.75} strokeWidth={2.5} strokeDasharray="7 6" />
          {/* body */}
          <Path
            d="M90 74 C64 78 58 100 60 128 L70 200 L66 300 M90 74 C116 78 122 100 120 128 L110 200 L114 300 M60 128 L40 190 M120 128 L140 190"
            fill="none"
            stroke="#FAF8F5"
            strokeOpacity={0.75}
            strokeWidth={2.5}
            strokeDasharray="7 6"
            strokeLinecap="round"
          />
        </Svg>
        <Text className="mt-sm text-center text-[14px] font-medium text-white/80">
          Fit head to shoes inside the outline
        </Text>
      </View>

      {/* live checks */}
      {failed.length > 0 || failureReason ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLabel={failureReason ?? failed.map((f) => f.hint).join('. ')}
          className="mb-sm gap-y-[4px] rounded-lg bg-danger p-md"
        >
          <Text className="text-[14px] font-bold text-white">Not quite — one fix:</Text>
          {failureReason ? <Text className="text-[14px] leading-[20px] text-white">{failureReason}</Text> : null}
          {failed.slice(0, 2).map((f) => (
            <Text key={f.key} className="text-[14px] leading-[20px] text-white">
              • {f.hint}
            </Text>
          ))}
        </View>
      ) : null}

      {/* good / bad hints */}
      <View className="mb-md flex-row gap-x-sm">
        <View className="flex-1 gap-y-[4px] rounded-lg bg-white/10 p-md">
          {GOOD.map((g) => (
            <Text key={g} className="text-[13px] leading-[18px] text-white">
              <Text className="font-bold text-sage">✓ </Text>
              {g}
            </Text>
          ))}
        </View>
        <View className="flex-1 gap-y-[4px] rounded-lg bg-white/10 p-md">
          {BAD.map((b) => (
            <Text key={b} className="text-[13px] leading-[18px] text-white">
              <Text className="font-bold text-danger">✕ </Text>
              {b}
            </Text>
          ))}
        </View>
      </View>

      <Text className="mb-sm text-center text-[12px] leading-[16px] text-white/70">
        Used only for your try-ons. Never public without opt-in.
      </Text>
      <View className="flex-row gap-x-sm">
        {onRetake ? (
          <View className="flex-1">
            <Button title="Retake" variant="secondary" onPress={onRetake} disabled={capturing} />
          </View>
        ) : null}
        <View className="flex-[2]">
          <Button title={capturing ? 'Checking…' : 'Capture'} onPress={onCapture} loading={capturing} />
        </View>
      </View>
    </View>
  );
});
