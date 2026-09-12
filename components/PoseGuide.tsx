import React, { memo } from 'react';
import { Text, View } from 'react-native';
import Svg, { Ellipse, Path } from 'react-native-svg';
import { hapticFor } from '../lib/haptics';
import { Button } from './Button';
import { PressScale } from './PressScale';

export type PoseGuidePose = 'front' | 'step' | 'detail';

export type PoseCheck = {
  key: 'blur' | 'light' | 'face' | 'pose';
  ok: boolean;
  hint: string;
};

export type PoseGuideProps = {
  /** Active pose. Selector pills render only when `onPoseChange` is passed. */
  pose: PoseGuidePose;
  onPoseChange?: (pose: PoseGuidePose) => void;
  /** Live on-device checks; fail = inline reason + Retake (pack §6). */
  checks?: PoseCheck[];
  /** Machine-readable failure reason for inline display + Retake. */
  failureReason?: string | null;
  onCapture: () => void;
  onRetake?: () => void;
  capturing?: boolean;
  testID?: string;
};

const ORDER: PoseGuidePose[] = ['front', 'step', 'detail'];

const META: Record<PoseGuidePose, { title: string; frame: string; dos: string[]; donts: string[] }> = {
  front: {
    title: 'Front fit-pic',
    frame: 'Fit head to shoes inside the outline',
    dos: ['Full body, head to shoes', 'Phone at chest height', 'Plain background', 'Daylight or bright room'],
    donts: ['No cropped feet or head', 'No backlight from windows', 'No mirror clutter behind you'],
  },
  step: {
    title: 'Mid-step street',
    frame: 'Walk toward the camera, snap mid-stride',
    dos: ['Full body, caught mid-stride', 'Phone at chest height', 'Let arms swing naturally', 'Daylight or bright street'],
    donts: ['No stiff frozen stance', 'No cropped feet', 'No crowds right behind you'],
  },
  detail: {
    title: 'Seated detail',
    frame: 'Sit tall, settle into the outline',
    dos: ['Sit tall, shoulders back', 'Knees together, feet flat', 'Plain background', 'Daylight on the fabric'],
    donts: ['No slouching', 'No backlight from windows', 'No cropped chin'],
  },
};

const STROKE = {
  stroke: '#FAF8F5',
  strokeOpacity: 0.75,
  strokeWidth: 2.5,
  strokeDasharray: '7 6',
  strokeLinecap: 'round' as const,
  fill: 'none',
};

/** Ghost silhouette per pose — dashed SVG, absolute-safe static layout. */
const Ghost = memo(function Ghost({ pose }: { pose: PoseGuidePose }): React.JSX.Element {
  if (pose === 'step') {
    return (
      <Svg width={180} height={320} viewBox="0 0 180 320">
        <Ellipse cx={90} cy={42} rx={24} ry={28} {...STROKE} />
        <Path
          d="M90 74 C64 78 58 100 60 128 L44 198 L18 292 M90 74 C116 78 122 100 120 128 L132 198 L158 290 M60 128 L34 184 M120 128 L146 178"
          {...STROKE}
        />
        {/* ground line */}
        <Path d="M28 306 L152 306" fill="none" stroke="#FAF8F5" strokeOpacity={0.4} strokeWidth={1.5} strokeDasharray="5 5" strokeLinecap="round" />
      </Svg>
    );
  }
  if (pose === 'detail') {
    return (
      <Svg width={180} height={320} viewBox="0 0 180 320">
        {/* head */}
        <Ellipse cx={90} cy={56} rx={22} ry={26} {...STROKE} />
        {/* torso + arms + bent legs */}
        <Path
          d="M90 86 C68 90 64 112 66 150 L66 190 M66 190 L126 190 M126 190 L126 300 M66 190 L114 198 L110 300 M66 150 L46 200 M114 102 L138 160"
          {...STROKE}
        />
        {/* bench hint */}
        <Path d="M40 214 L140 214 M44 214 L44 300 M136 214 L136 300" fill="none" stroke="#FAF8F5" strokeOpacity={0.4} strokeWidth={1.5} strokeDasharray="5 5" strokeLinecap="round" />
      </Svg>
    );
  }
  return (
    <Svg width={180} height={320} viewBox="0 0 180 320">
      <Ellipse cx={90} cy={42} rx={24} ry={28} {...STROKE} />
      <Path
        d="M90 74 C64 78 58 100 60 128 L70 200 L66 300 M90 74 C116 78 122 100 120 128 L110 200 L114 300 M60 128 L40 190 M120 128 L140 190"
        {...STROKE}
      />
    </Svg>
  );
});

/**
 * 3-pose capture guide for the reel loop (front fit-pic / mid-step street /
 * seated detail): per-pose ghost silhouette + dos/donts, matching the
 * SelfieGuide language (same good/bad panel layout, same failure alert,
 * same consent line) so capture feels like one flow, not two.
 */
export const PoseGuide = memo(function PoseGuide({
  pose,
  onPoseChange,
  checks = [],
  failureReason,
  onCapture,
  onRetake,
  capturing = false,
  testID,
}: PoseGuideProps): React.JSX.Element {
  const meta = META[pose];
  const failed = checks.filter((c) => !c.ok);
  const stepLabel = `Pose ${ORDER.indexOf(pose) + 1} of ${ORDER.length}`;
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`Pose guide, ${meta.title}. ${meta.frame}`}
      className="flex-1 bg-ink px-xl py-lg"
    >
      <Text className="text-center text-[12px] font-bold uppercase text-white/70" style={{ letterSpacing: 1.2 }}>
        {stepLabel} · {meta.title}
      </Text>

      {/* pose selector */}
      {onPoseChange ? (
        <View className="mt-sm flex-row" style={{ columnGap: 8 }} accessible accessibilityLabel="Choose a pose">
          {ORDER.map((p) => {
            const selected = p === pose;
            return (
              <PressScale
                key={p}
                testID={testID ? `${testID}-${p}-cta` : `pose-guide-${p}-cta`}
                accessibilityRole="button"
                accessibilityLabel={`${META[p].title}${selected ? ', selected' : ''}`}
                accessibilityState={{ selected }}
                hitSlop={8}
                onPress={() => {
                  if (!selected) {
                    void hapticFor.select();
                    onPoseChange(p);
                  }
                }}
                className={`flex-1 items-center rounded-pill py-sm active:opacity-80 ${selected ? 'bg-terracotta' : 'bg-white/10'}`}
              >
                <Text className={`text-[13px] leading-[18px] font-bold ${selected ? 'text-white' : 'text-white/70'}`}>
                  {META[p].title}
                </Text>
              </PressScale>
            );
          })}
        </View>
      ) : null}

      {/* ghost silhouette */}
      <View className="flex-1 items-center justify-center" aria-hidden>
        <Ghost pose={pose} />
        <Text className="mt-sm text-center text-[14px] font-medium text-white/80">{meta.frame}</Text>
      </View>

      {/* live checks */}
      {failed.length > 0 || failureReason ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLabel={failureReason ?? failed.map((f) => f.hint).join('. ')}
          className="mb-sm rounded-lg bg-danger p-md"
          style={{ rowGap: 4 }}
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

      {/* dos / donts */}
      <View className="mb-md flex-row" style={{ columnGap: 8 }}>
        <View className="flex-1 rounded-lg bg-white/10 p-md" style={{ rowGap: 4 }}>
          {meta.dos.map((g) => (
            <Text key={g} className="text-[13px] leading-[18px] text-white">
              <Text className="font-bold text-sage">✓ </Text>
              {g}
            </Text>
          ))}
        </View>
        <View className="flex-1 rounded-lg bg-white/10 p-md" style={{ rowGap: 4 }}>
          {meta.donts.map((b) => (
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
      <View className="flex-row" style={{ columnGap: 8 }}>
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
