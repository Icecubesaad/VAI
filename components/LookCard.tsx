import React, { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { PressScale } from './PressScale';
import { Icon } from './icons';
import { tokenColors } from '@/theme';

/**
 * LookCard — one cell of the home grid (inspo: uniform white cards,
 * near-sharp media, piece list under the photo). An AI picture of the user
 * wearing a closet combo when a render exists, otherwise a quiet collage of
 * the owned pieces with a small render affordance. "Today" chip for the
 * planner hero.
 */
export type LookCardProps = {
  /** Finished try-on of the user in this combo (null → collage placeholder). */
  uri: string | null;
  /** Owned-garment cutouts backing the placeholder collage (max 2 shown). */
  fallbackUris: string[];
  label: string;
  /** Media height ratio (width 1 → height). Rendered 3/4, collage ~1/1. */
  aspect: number;
  isToday?: boolean;
  saved?: boolean;
  onSave?: () => void;
  onPress: () => void;
  testID?: string;
};

export const LookCard = memo(function LookCard({
  uri,
  fallbackUris,
  label,
  aspect,
  isToday = false,
  saved = false,
  onSave,
  onPress,
  testID,
}: LookCardProps): React.JSX.Element {
  return (
    // The heart is a SIBLING overlay, never a child of the card pressable —
    // nested <button>s are invalid HTML and React-web throws in dev.
    <View style={styles.wrap}>
      <PressScale
        scaleTo={0.97}
        onPress={onPress}
        style={styles.card}
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={
          (uri ? 'Your look wearing ' : 'Render ') + label + (isToday ? ", today's outfit" : '')
        }
      >
        <View style={[styles.media, { aspectRatio: aspect }]}>
          {uri ? (
            <Image
              source={{ uri }}
              style={styles.fill}
              contentFit="cover"
              transition={200}
              accessibilityLabel="AI try-on photo of you in this outfit"
            />
          ) : (
            <View style={[styles.fill, styles.collage]} testID="look-collage">
              {fallbackUris[0] ? (
                <Image
                  source={{ uri: fallbackUris[0] }}
                  style={styles.collageMain}
                  contentFit="contain"
                  transition={150}
                />
              ) : null}
              {fallbackUris[1] ? (
                <View style={styles.collageSecond}>
                  <Image
                    source={{ uri: fallbackUris[1] }}
                    style={styles.fill}
                    contentFit="contain"
                    transition={150}
                  />
                </View>
              ) : null}
              <View style={styles.renderChip}>
                <Text style={styles.renderChipText}>Render</Text>
              </View>
            </View>
          )}

          {isToday ? (
            <View style={styles.todayChip}>
              <Text style={styles.todayChipText}>Today</Text>
            </View>
          ) : null}
        </View>
        {/* inspo caption zone: white, piece names + try affordance */}
        <View style={styles.captionZone}>
          <Text style={styles.caption} numberOfLines={2}>
            {label}
          </Text>
        </View>
      </PressScale>
      {onSave ? (
        <PressScale
          scaleTo={0.88}
          hitSlop={8}
          onPress={onSave}
          style={styles.heart}
          testID={testID ? `${testID}-save` : 'look-save'}
          accessibilityRole="button"
          accessibilityLabel={saved ? 'Remove from saved looks' : 'Save this look'}
          accessibilityState={{ selected: saved }}
        >
          <Icon
            name={saved ? 'heartSolid' : 'heart'}
            color={saved ? '#E34D78' : 'rgba(42,35,64,0.72)'}
            size={17}
            strokeWidth={2}
          />
        </PressScale>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  card: {
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(33,28,51,0.05)',
    shadowColor: '#3A2030',
    shadowOpacity: 0.1,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  media: {
    width: '100%',
    backgroundColor: tokenColors.well,
  },
  fill: { width: '100%', height: '100%' },
  collage: { alignItems: 'center', justifyContent: 'center' },
  collageMain: { width: '76%', height: '76%' },
  collageSecond: {
    position: 'absolute',
    right: 8,
    bottom: 12,
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: 'rgba(42,35,64,0.08)',
    overflow: 'hidden',
  },
  renderChip: {
    position: 'absolute',
    right: 8,
    top: 8,
    borderRadius: 999,
    backgroundColor: tokenColors.terracottaDeep,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  renderChipText: {
    color: '#FFFFFF',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700',
    fontFamily: 'Poppins_600SemiBold',
  },
  // White caption zone below the media — the inspo's piece-list block.
  captionZone: { paddingHorizontal: 12, paddingTop: 9, paddingBottom: 11 },
  caption: {
    color: tokenColors.ink,
    fontSize: 12.5,
    lineHeight: 17,
    fontWeight: '600',
    fontFamily: 'Poppins_600SemiBold',
  },
  todayChip: {
    position: 'absolute',
    top: 8,
    left: 8,
    borderRadius: 999,
    backgroundColor: tokenColors.terracottaDeep,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  todayChipText: {
    color: '#FFFFFF',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700',
    fontFamily: 'Poppins_600SemiBold',
  },
  heart: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.94)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#3A2030',
    shadowOpacity: 0.16,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
});
