import { useCallback, useRef } from 'react';
import { Dimensions, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts } from '@/theme';
import { REEL_QA_ITEMS } from '@/lib/reel-qa';

const { height: SCREEN_H } = Dimensions.get('window');

/**
 * Interim QA reel (founder directive): scrollable AI editorial images —
 * magazine cover + destination poses. Data is the QA seed in lib/reel-qa.ts;
 * the server pipeline (quota + provider chain) replaces this before GA.
 */
export default function ReelScreen() {
  const insets = useSafeAreaInsets();
  const viewConfigRef = useRef({ viewAreaCoveragePercentThreshold: 60 });

  const onIndexChanged = useCallback(() => {}, []);

  return (
    <View style={styles.screen} testID="reel-screen">
      <FlatList
        data={REEL_QA_ITEMS}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable style={styles.cell}>
            <Image source={{ uri: item.uri }} style={styles.image} contentFit="cover" recyclingKey={item.id} />
            <LinearGradient
              colors={['transparent', 'rgba(20,12,24,0.9)']}
              style={[styles.shade, { paddingBottom: insets.bottom + 96 }]}
            >
              <Text style={[styles.label, { fontFamily: fonts.display }]}>{item.label}</Text>
              <Text style={styles.disclosure}>AI generated · QA preview</Text>
            </LinearGradient>
          </Pressable>
        )}
        getItemLayout={(_, index) => ({ length: SCREEN_H, offset: SCREEN_H * index, index })}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        viewabilityConfig={viewConfigRef.current}
        onViewableItemsChanged={onIndexChanged}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#171126' },
  cell: { height: SCREEN_H, width: '100%' },
  image: { height: '100%', width: '100%' },
  shade: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingTop: 60,
    paddingHorizontal: 20,
  },
  label: { fontSize: 28, lineHeight: 34, fontWeight: '700', color: '#FFFFFF' },
  disclosure: { marginTop: 6, fontSize: 12, letterSpacing: 0.4, color: 'rgba(255,255,255,0.72)' },
});
