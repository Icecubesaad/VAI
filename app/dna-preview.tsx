import { ScrollView, StyleSheet, Text } from 'react-native';
import { DnaFilmstrip } from '@/components';
import { dnaGalleryFor } from '@/lib/dna-gallery';

/**
 * TEMPORARY dev-only visual check for the DNA filmstrip — NOT a product
 * route. Renders the real gallery cast (bundled lookbook shots) exactly as
 * the quiz result screen does. Delete before merging.
 */
export default function DnaPreviewScreen() {
  const looks = dnaGalleryFor(['Streetwear', 'Minimal', 'Old Money'], false);
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      testID="dna-preview"
    >
      <Text style={styles.kicker}>The verdict is in</Text>
      <Text style={styles.title}>This is your style</Text>
      <DnaFilmstrip looks={looks} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#141114' },
  content: { padding: 24, paddingTop: 64 },
  kicker: { fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1 },
  title: { fontSize: 30, fontWeight: '800', marginTop: 10 },
});
