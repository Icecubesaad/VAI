import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { tokenColors } from '@/theme';
import { INSPIRATION_RACK } from '@/lib/inspiration';

/**
 * Inspiration strip — horizontal Pinterest-stand-in rack on Home.
 *
 * Static catalog art (lib/inspiration.ts) until the AI intake lands: user
 * scrapes → vision tagging → taste_context. Tapping a card sets today's
 * occasion toward that vibe's first tag (same re-plan path as the
 * "What's today?" toggle) — so the strip already DOES something instead of
 * decorating. Failed photos degrade to a labeled tile, never blank.
 */
export const InspirationStrip = memo(function InspirationStrip({
  onPick,
}: {
  /** Vibe tag to plan toward (first tag of the tapped look). */
  onPick: (tag: string) => void;
}): React.JSX.Element {
  return (
    <View testID="home-inspiration">
      <Text style={styles.kicker}>Inspiration for you</Text>
      <View style={styles.row}>
        {INSPIRATION_RACK.slice(0, 6).map((item) => (
          <Pressable
            key={item.id}
            onPress={() => onPick(item.tags[0] ?? item.label)}
            testID={`inspo-${item.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Plan toward ${item.label}`}
            style={styles.card}
          >
            <Image
              source={{ uri: item.uri }}
              style={styles.photo}
              contentFit="cover"
              transition={200}
              accessibilityLabel={`${item.label} inspiration photo`}
            />
            <View style={styles.labelWrap} pointerEvents="none">
              <Text style={styles.label} numberOfLines={1}>
                {item.label}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  kicker: {
    color: tokenColors.ink,
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'Poppins_600SemiBold',
    marginTop: 18,
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  card: {
    width: '31.5%',
    aspectRatio: 3 / 4,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: tokenColors.oxbloodWash,
  },
  photo: { width: '100%', height: '100%' },
  labelWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 8,
    paddingVertical: 7,
    backgroundColor: 'rgba(23,17,38,0.55)',
  },
  label: {
    color: '#FFFFFF',
    fontSize: 11.5,
    fontWeight: '700',
    fontFamily: 'Poppins_600SemiBold',
  },
});
