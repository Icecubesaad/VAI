import React, { memo, useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import { hapticFor } from '../lib/haptics';
import { PressScale } from './PressScale';
import { Icon } from './icons';
import { useReducedMotion } from '../lib/motion';
import { reelFullProps } from '../lib/perf';
import { ReelSkeleton } from './ReelSkeleton';

/**
 * One pager cell in the looks reel. The pager parent owns sizing /
 * virtualization; this component is `flex-1` full-bleed inside its slot.
 *
 * Design: editorial product-detail treatment (founder reference §reel) —
 * the look IS the screen; a left rail shows the owned pieces in the look
 * (the reference's size circles, remapped); the piece name is the display
 * type; one frosted CTA pill with a round icon inside, remix as its
 * sidekick circle. Plum-black stage, white glass, violet only for "on".
 */
export type ReelCard = {
  id: string;
  outfitId: string;
  renderId: string;
  imageUrl: string;
  pose: 'front' | 'step' | 'detail';
  garmentIds: string[];
  whyLine: string;
  trendTag?: string;
  costUsd: number;
  createdAt: string;
};

export type ReelCardProps = {
  card: ReelCard;
  onTry?: () => void;
  onSave?: () => void;
  onRegenerate?: () => void;
  saved: boolean;
  /** Owned-garment thumbs keyed by garment id (matches `card.garmentIds`). */
  garmentThumbs?: Record<string, string>;
  /** Real piece names keyed by garment id (closet categories), for the title. */
  garmentNames?: Record<string, string>;
  /** Pager position — drives the dots on the visible card. */
  index?: number;
  count?: number;
  /** Whether THIS card is the pager's visible page (rail + dots render on it only). */
  active?: boolean;
  /** Failed-render retry (free). */
  error?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  /** Shows the pager shimmer in place. */
  loading?: boolean;
  testID?: string;
};

/** Mandatory microcopy on every reel cell (store compliance, pack §6/§9). */
export const REEL_DISCLOSURE = 'AI styled · may differ from fit';

const STAGE = '#171126';

export const ReelCard = memo(function ReelCard({
  card,
  onTry,
  onSave,
  onRegenerate,
  saved,
  garmentThumbs,
  garmentNames,
  index = 0,
  count = 0,
  active = false,
  error = null,
  onRetry,
  retrying = false,
  loading = false,
  testID,
}: ReelCardProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const lastTap = useRef(0);
  const burstScale = useRef(new Animated.Value(0)).current;
  const burstOpacity = useRef(new Animated.Value(0)).current;
  const [burstOn, setBurstOn] = useState(false);
  const reduceMotion = useReducedMotion();

  const fireBurst = useCallback(() => {
    if (reduceMotion) return;
    setBurstOn(true);
    burstScale.setValue(0.4);
    burstOpacity.setValue(1);
    Animated.parallel([
      Animated.spring(burstScale, { toValue: 1.1, friction: 6, tension: 120, useNativeDriver: true }),
      Animated.sequence([
        Animated.delay(350),
        Animated.timing(burstOpacity, { toValue: 0, duration: 300, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      ]),
    ]).start(({ finished }) => {
      if (finished) setBurstOn(false);
    });
  }, [burstOpacity, burstScale, reduceMotion]);

  const handleSave = useCallback(() => {
    void hapticFor.done();
    onSave?.();
  }, [onSave]);

  const handleImagePress = useCallback(() => {
    const now = Date.now();
    if (now - lastTap.current < 350) {
      lastTap.current = 0;
      handleSave();
      fireBurst();
    } else {
      lastTap.current = now;
    }
  }, [fireBurst, handleSave]);

  const pieceNames = card.garmentIds
    .map((id) => garmentNames?.[id])
    .filter(Boolean)
    .slice(0, 3);
  // The look's name: trend tag when the stylist gave one, else the pieces.
  const title = card.trendTag?.trim() || pieceNames.join(' · ');
  const railPieces = card.garmentIds
    .map((id) => ({ id, thumb: garmentThumbs?.[id], name: garmentNames?.[id] }))
    .filter((p) => typeof p.thumb === 'string' && p.thumb.length > 0)
    .slice(0, 4);

  if (loading) {
    return <ReelSkeleton testID={testID} />;
  }

  if (error) {
    const retry = onRetry ?? onRegenerate;
    return (
      <View
        testID={testID ?? 'reel-error'}
        accessible
        accessibilityRole="alert"
        accessibilityLabel={`Look failed to load. ${error}`}
        style={[styles.root, styles.center]}
      >
        <View style={styles.errorGlyph} aria-hidden>
          <Text style={{ color: '#FFFFFF', fontSize: 24 }}>!</Text>
        </View>
        <Text style={styles.errorTitle}>Couldn&apos;t create this look</Text>
        <Text style={styles.errorBody}>{error}</Text>
        {retry ? (
          <View style={{ marginTop: 16, width: '100%' }}>
            <PressScale
              testID="reel-retry"
              accessibilityRole="button"
              accessibilityLabel="Retry this look, free of charge"
              accessibilityState={{ disabled: retrying, busy: retrying }}
              disabled={retrying}
              hitSlop={12}
              onPress={() => {
                void hapticFor.select();
                retry();
              }}
              style={[styles.ctaPill, retrying ? { opacity: 0.5 } : null]}
            >
              <View style={styles.ctaIconCircle} aria-hidden>
                <Icon name="refresh" color={STAGE} size={17} strokeWidth={2} />
              </View>
              <Text style={styles.ctaText}>{retrying ? 'Retrying…' : 'Retry (free)'}</Text>
              {retrying ? (
                <View style={StyleSheet.absoluteFill} pointerEvents="none">
                  <ActivityIndicator color={STAGE} />
                </View>
              ) : null}
            </PressScale>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View
      testID={testID ?? 'reel-card'}
      accessible
      accessibilityLabel={`AI styled look. ${title}. ${card.whyLine}`}
      style={styles.root}
    >
      {/* cover — the whole cell is the look; double-tap saves */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Look photo"
        accessibilityHint="Double-tap to save this look"
        onPress={handleImagePress}
        style={StyleSheet.absoluteFill}
      >
        {card.imageUrl ? (
          <Image
            source={{ uri: card.imageUrl }}
            style={{ width: '100%', height: '100%' }}
            {...reelFullProps(card.id)}
            transition={reduceMotion ? 0 : 200}
            accessibilityLabel="AI styled outfit photo"
          />
        ) : (
          // Pending render: dark stage + honest note (never a fake image).
          <View style={[styles.center, { backgroundColor: STAGE }]} testID="reel-pending">
            <ActivityIndicator color="#FFFFFF" />
            <Text style={styles.pendingText}>Styling this look…</Text>
          </View>
        )}
      </Pressable>

      {/* legibility scrims — soft fades (never hard bands over the photo) */}
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(15,10,28,0.55)', 'rgba(15,10,28,0.25)', 'rgba(15,10,28,0)']}
        locations={[0, 0.55, 1]}
        style={[styles.scrim, { top: 0, height: 150 }]}
        aria-hidden
      />
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(15,10,28,0)', 'rgba(15,10,28,0.5)', 'rgba(15,10,28,0.72)']}
        locations={[0, 0.4, 1]}
        style={[styles.scrim, { bottom: 0, height: 340 }]}
        aria-hidden
      />

      {/* save — glass heart, top-right (the reference's one floating circle) */}
      {onSave ? (
        <PressScale
          testID="reel-save"
          accessibilityRole="button"
          accessibilityLabel={saved ? 'Remove from saved looks' : 'Save this look'}
          accessibilityState={{ selected: saved }}
          hitSlop={10}
          onPress={() => {
            if (!saved) void hapticFor.done();
            else void hapticFor.select();
            onSave();
          }}
          style={[styles.glassCircle, styles.saveCircle]}
        >
          <Icon name={saved ? 'heartSolid' : 'heart'} color={saved ? '#FF7A9E' : '#FFFFFF'} size={22} />
        </PressScale>
      ) : null}

      {/* heart burst on double-tap save */}
      {burstOn ? (
        <Animated.View
          pointerEvents="none"
          aria-hidden
          style={[
            styles.center,
            StyleSheet.absoluteFill,
            { opacity: burstOpacity, transform: [{ scale: burstScale }] },
          ]}
        >
          <View style={styles.burstCircle}>
            <Text style={{ fontSize: 44, color: '#FF7A9E' }}>♥</Text>
          </View>
        </Animated.View>
      ) : null}

      {/* left rail: the owned pieces in this look — the reference's size
          circles, remapped. Tapping a piece opens the changing room. */}
      {active && railPieces.length > 0 && onTry ? (
        <View
          pointerEvents="box-none"
          style={[styles.rail, { bottom: insets.bottom + 208 }]}
          accessibilityLabel={'In this look: ' + railPieces.map((p) => p.name ?? 'piece').join(', ')}
        >
          <Text style={styles.railCaption} accessible={false}>
            In this look
          </Text>
          {railPieces.map((p) => (
            <PressScale
              key={p.id}
              scaleTo={0.9}
              onPress={() => {
                void hapticFor.select();
                onTry();
              }}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={'Open ' + (p.name ?? 'this piece') + ' in the changing room'}
              style={styles.railCircle}
            >
              <Image source={{ uri: p.thumb }} style={styles.railThumb} contentFit="cover" transition={150} />
            </PressScale>
          ))}
        </View>
      ) : null}

      {/* bottom: dots → look name → why-line → CTA row (pill + remix circle) */}
      <View
        pointerEvents="box-none"
        style={[styles.bottom, { paddingBottom: insets.bottom + 82 }]}
      >
        {active && count > 1 ? (
          <View style={styles.dots} aria-hidden>
            {Array.from({ length: count }, (_, i) => (
              <View
                key={i}
                style={[styles.dot, { backgroundColor: i === index ? '#FFFFFF' : 'rgba(255,255,255,0.35)' }]}
              />
            ))}
          </View>
        ) : null}
        {!!title && (
          <Text
            testID="reel-outfit-title"
            style={styles.title}
            numberOfLines={2}
          >
            {title}
          </Text>
        )}
        {!!card.whyLine && (
          <Text style={styles.why} numberOfLines={2}>
            {card.whyLine}
          </Text>
        )}
        <Text testID="reel-disclosure" style={styles.disclosure}>
          {REEL_DISCLOSURE}
        </Text>
        <View style={styles.ctaRow} pointerEvents="box-none">
          {onTry ? (
            <PressScale
              testID="reel-try"
              accessibilityRole="button"
              accessibilityLabel="Try this look on your photo"
              hitSlop={10}
              onPress={() => {
                void hapticFor.confirm();
                onTry();
              }}
              style={[styles.ctaPill, { flex: 1 }]}
            >
              <View style={styles.ctaIconCircle} aria-hidden>
                <Icon name="closet" color={STAGE} size={16} strokeWidth={2} />
              </View>
              <Text style={styles.ctaText}>Try it on</Text>
            </PressScale>
          ) : null}
          {onRegenerate ? (
            <PressScale
              testID="reel-regenerate"
              accessibilityRole="button"
              accessibilityLabel="Generate a new variation of this look"
              hitSlop={10}
              onPress={() => {
                void hapticFor.select();
                onRegenerate();
              }}
              style={styles.glassCircle}
            >
              <Icon name="refresh" color="#FFFFFF" size={20} />
            </PressScale>
          ) : null}
        </View>
      </View>
    </View>
  );
});

const GLASS = 'rgba(255,255,255,0.16)';
const GLASS_BORDER = 'rgba(255,255,255,0.22)';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: STAGE },
  center: { alignItems: 'center', justifyContent: 'center', gap: 10 },
  scrim: { position: 'absolute', left: 0, right: 0 },
  pendingText: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '600', marginTop: 4 },

  glassCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: GLASS,
    borderWidth: 1,
    borderColor: GLASS_BORDER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveCircle: { position: 'absolute', top: 64, right: 16 },

  burstCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(255,255,255,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  rail: { position: 'absolute', left: 16, gap: 9 },
  railCaption: {
    color: 'rgba(255,255,255,0.66)',
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Poppins_600SemiBold',
    marginBottom: 2,
    marginLeft: 2,
  },
  railCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: GLASS,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.34)',
    overflow: 'hidden',
  },
  railThumb: { width: '100%', height: '100%' },

  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingHorizontal: 20 },
  dots: { flexDirection: 'row', columnGap: 5, marginBottom: 14 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  title: {
    color: '#FFFFFF',
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '700',
    fontFamily: 'PlayfairDisplay_700Bold',
    letterSpacing: -0.2,
    textAlign: 'center',
    textShadowColor: 'rgba(15,10,28,0.4)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 8,
  },
  // Stylist's why-line on the dark stage — italic serif, softly lit.
  why: {
    color: 'rgba(255,255,255,0.88)',
    fontSize: 15,
    lineHeight: 21,
    fontFamily: 'PlayfairDisplay_700Bold_Italic',
    textAlign: 'center',
    marginTop: 8,
  },
  disclosure: { color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 6 },

  ctaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'stretch',
    marginTop: 16,
  },
  ctaPill: {
    height: 56,
    borderRadius: 28,
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 7,
    gap: 10,
  },
  ctaIconCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(23,17,38,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: {
    color: STAGE,
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'Poppins_600SemiBold',
    marginRight: 10,
  },

  errorGlyph: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: GLASS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '600',
    fontFamily: 'Poppins_600SemiBold',
    textAlign: 'center',
  },
  errorBody: { color: 'rgba(255,255,255,0.7)', fontSize: 15, lineHeight: 22, textAlign: 'center', paddingHorizontal: 32 },
});
