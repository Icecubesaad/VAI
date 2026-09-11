import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { buildWatermarkText } from '../lib/watermark';

export type WatermarkProps = {
  code: string;
  /** 'light' for photos, 'dark' for light backgrounds */
  tone?: 'light' | 'dark';
  testID?: string;
};

/** Viral attribution stamp — Premium may move it, never remove it. */
export const Watermark = memo(function Watermark({ code, tone = 'light', testID }: WatermarkProps): React.JSX.Element {
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={buildWatermarkText(code)}
      className={`self-start rounded-pill px-sm py-[4px] ${tone === 'light' ? 'bg-black/55' : 'bg-paperDeep'}`}
    >
      <Text className={`text-[11px] leading-[14px] font-semibold ${tone === 'light' ? 'text-white' : 'text-inkSoft'}`}>
        {buildWatermarkText(code)}
      </Text>
    </View>
  );
});
