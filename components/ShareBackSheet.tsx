import React, { memo, useEffect, useRef } from 'react';
import { Animated, Linking, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { hapticFor } from '../lib/haptics';
import { Button } from './Button';

export type ShareBackBoard = {
  id: string;
  name: string;
  coverUrl?: string | null;
  pinCount?: number | null;
  secret?: boolean;
};

export type ShareBackSheetProps = {
  visible: boolean;
  boards: ShareBackBoard[];
  selectedBoardId: string | null;
  onSelectBoard: (id: string) => void;
  /** Explicit user tap — the ONLY path that posts (never auto-fires). */
  onConfirm: () => void;
  posting?: boolean;
  /** Set on success — flips the sheet to the posted state. */
  postedUrl?: string | null;
  error?: string | null;
  onClose: () => void;
  testID?: string;
};

/** Explicit-consent confirm label — always names the destination board. */
export function shareConfirmLabel(boardName: string | null): string {
  return boardName ? `Post 1 Pin to ${boardName}?` : 'Choose a board to continue';
}

/**
 * Share-back bottom sheet. Pinterest authenticity rules: every share is a
 * deliberate tap — the sheet names the exact destination board, the confirm
 * is disabled until a board is picked, and success links out to Pinterest.
 * Slide/fade run on the native driver (same pattern as `Sheet`).
 */
export const ShareBackSheet = memo(function ShareBackSheet({
  visible,
  boards,
  selectedBoardId,
  onSelectBoard,
  onConfirm,
  posting = false,
  postedUrl,
  error,
  onClose,
  testID,
}: ShareBackSheetProps): React.JSX.Element {
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      slide.setValue(0);
      Animated.timing(slide, { toValue: 1, duration: 260, useNativeDriver: true }).start();
    }
  }, [visible, slide]);

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [320, 0] });
  const selected = boards.find((b) => b.id === selectedBoardId) ?? null;
  const posted = postedUrl != null && postedUrl.length > 0;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View testID={testID} className="flex-1 justify-end bg-scrim">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss share sheet"
          onPress={onClose}
          className="absolute inset-0"
        />
        <Animated.View
          style={{ transform: [{ translateY }] }}
          className="max-h-[92%] rounded-t-xl bg-paper pb-2xl pt-sm"
          accessible
          accessibilityRole="alert"
          accessibilityLabel="Share back to Pinterest"
        >
          <View className="mx-auto mb-sm h-[5px] w-[40px] rounded-pill bg-line" aria-hidden />
          {posted ? (
            <View className="gap-y-md px-xl pb-md pt-sm" style={{ rowGap: 12 }}>
              <View className="items-center" style={{ rowGap: 8 }}>
                <View className="h-[56px] w-[56px] items-center justify-center rounded-full bg-sageWash" aria-hidden>
                  <Text className="text-[24px] font-bold text-sageDeep">✓</Text>
                </View>
                <Text className="text-center font-display text-[24px] leading-[30px] font-semibold text-ink">
                  Posted{selected ? ` to ${selected.name}` : ''}
                </Text>
                <Text className="text-center text-[15px] leading-[22px] text-inkSoft">
                  Your look is live on Pinterest — it only posted because you tapped post.
                </Text>
              </View>
              <Button
                title="Open in Pinterest"
                onPress={() => {
                  void hapticFor.confirm();
                  if (postedUrl) void Linking.openURL(postedUrl);
                }}
                testID={testID ? `${testID}-open` : 'share-open-pinterest'}
              />
              <Button title="Done" variant="secondary" onPress={onClose} />
            </View>
          ) : (
            <ScrollView contentContainerClassName="gap-y-lg px-xl pb-md" showsVerticalScrollIndicator={false}>
              <View className="gap-y-[4px]">
                <Text className="font-display text-[24px] leading-[30px] font-semibold text-ink">
                  Share back to Pinterest
                </Text>
                <Text className="text-[15px] leading-[22px] text-inkSoft">
                  Pick the board — nothing posts until you tap post.
                </Text>
              </View>

              <View
                accessible
                accessibilityRole="radiogroup"
                accessibilityLabel="Choose a board"
                className="gap-y-sm"
                style={{ rowGap: 8 }}
              >
                {boards.map((b) => {
                  const isSelected = b.id === selectedBoardId;
                  return (
                    <Pressable
                      key={b.id}
                      testID={testID ? `${testID}-board-${b.id}` : `share-board-${b.id}`}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected }}
                      accessibilityLabel={`${b.name}${b.secret ? ', secret board' : ''}${isSelected ? ', selected' : ''}`}
                      onPress={() => {
                        if (!isSelected) {
                          void hapticFor.select();
                          onSelectBoard(b.id);
                        }
                      }}
                      className={`flex-row items-center rounded-lg border-2 bg-card p-sm active:opacity-90 ${
                        isSelected ? 'border-terracotta' : 'border-line'
                      }`}
                      style={{ columnGap: 12 }}
                    >
                      <View className="h-[44px] w-[44px] overflow-hidden rounded-md bg-paperDeep">
                        {b.coverUrl ? (
                          <Image
                            source={{ uri: b.coverUrl }}
                            style={{ width: '100%', height: '100%' }}
                            contentFit="cover"
                            transition={150}
                            accessibilityLabel={`${b.name} cover`}
                          />
                        ) : (
                          <View className="h-full w-full items-center justify-center" aria-hidden>
                            <Text className="text-[16px] font-bold text-muted">◈</Text>
                          </View>
                        )}
                      </View>
                      <View className="flex-1 gap-y-[2px]">
                        <Text className="text-[15px] leading-[22px] font-semibold text-ink" numberOfLines={1}>
                          {b.name}
                        </Text>
                        <Text className="text-[13px] leading-[18px] text-inkSoft">
                          {[b.pinCount != null ? `${b.pinCount} Pins` : null, b.secret ? 'Secret' : null]
                            .filter(Boolean)
                            .join(' · ') || 'Board'}
                        </Text>
                      </View>
                      <View
                        aria-hidden
                        className={`h-[22px] w-[22px] items-center justify-center rounded-full border-2 ${
                          isSelected ? 'border-terracotta bg-terracotta' : 'border-line bg-card'
                        }`}
                      >
                        {isSelected ? <Text className="text-[12px] font-bold text-white">✓</Text> : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>

              {error ? (
                <View
                  accessible
                  accessibilityRole="alert"
                  accessibilityLabel={error}
                  className="rounded-lg bg-dangerWash p-md"
                >
                  <Text className="text-[14px] leading-[20px] font-semibold text-danger">{error}</Text>
                </View>
              ) : null}

              <View className="gap-y-sm" style={{ rowGap: 8 }}>
                <Button
                  title={shareConfirmLabel(selected?.name ?? null)}
                  onPress={() => onConfirm()}
                  loading={posting}
                  disabled={selected == null || posting}
                  testID={testID ? `${testID}-confirm` : 'share-confirm'}
                  accessibilityHint="Posts one pin to the selected board"
                />
                <Text className="text-center text-[13px] leading-[18px] text-inkSoft">
                  Explicit consent: VAI never auto-posts. This shares exactly 1 Pin, only on your tap.
                </Text>
              </View>
            </ScrollView>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
});
