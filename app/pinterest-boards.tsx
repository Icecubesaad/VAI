import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/theme';
import { Button, EmptyState, ErrorView } from '@/components';
import { api, apiErrorCopy, type PinterestBoard } from '@/lib/api';
import { track } from '@/lib/analytics';
import { useSession } from '@/store/session';
import { usePaywall } from '@/store/paywall';
import { useTaste } from '@/store/taste';

/** `store/paywall` Tier ('free'|'trial'|'premium') → analytics SubTier ('free'|'premium'). */
function toAnalyticsTier(tier: string): 'free' | 'premium' {
  return tier === 'free' ? 'free' : 'premium';
}

/**
 * Board picker (sheet-screen): multi-select with pin counts, Sync button →
 * progress → done counts. Entries: settings profile row + the
 * post-first-tryon upsell card. Selection is local (defaults to all);
 * the store keeps the board list + pose-ref cache.
 */
export default function PinterestBoards() {
  const router = useRouter();
  const { colors } = useTheme();
  const cached = useTaste((s) => s.boards);

  const [boards, setBoards] = useState<PinterestBoard[]>(cached);
  const [selected, setSelected] = useState<Record<string, true>>(() => {
    const init: Record<string, true> = {};
    for (const b of cached) init[b.boardId] = true;
    return init;
  });
  const [loading, setLoading] = useState(cached.length === 0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [done, setDone] = useState<{ boards: number; pins: number } | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const fresh = await api.pinterestBoards();
        if (!mountedRef.current) return;
        setBoards(fresh);
        useTaste.getState().setBoards(fresh);
        // New boards default to selected; keep existing choices.
        setSelected((prev) => {
          const next: Record<string, true> = {};
          for (const b of fresh) {
            if (prev[b.boardId] || !(b.boardId in prev)) next[b.boardId] = true;
          }
          return next;
        });
      } catch (e) {
        if (!mountedRef.current) return;
        setLoadError(apiErrorCopy(e).message);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();
  }, []);

  useEffect(load, [load]);

  const toggle = useCallback((id: string) => {
    setDone(null);
    setSelected((s) => {
      const next = { ...s };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  }, []);

  const selectedIds = boards.filter((b) => selected[b.boardId]).map((b) => b.boardId);

  const sync = useCallback(() => {
    if (syncing || loading) return;
    setSyncError(null);
    setDone(null);
    if (selectedIds.length === 0) {
      setSyncError('Select at least one board — VAI learns your taste from the boards you pick.');
      return;
    }
    setSyncing(true);
    void (async () => {
      try {
        const res = await api.pinterestSync({ boardIds: selectedIds });
        if (!mountedRef.current) return;
        if (res.boards.length > 0) {
          setBoards(res.boards);
          useTaste.getState().setBoards(res.boards);
        }
        useTaste.getState().setPoseRefs(res.posePins);
        setDone({ boards: res.boardsSynced, pins: res.pinsImported });
        const uid = useSession.getState().userId;
        if (uid) {
          track('boards_synced', {
            user_id: uid,
            tier: toAnalyticsTier(usePaywall.getState().tier),
            count: res.boardsSynced,
          });
        }
      } catch (e) {
        if (!mountedRef.current) return;
        setSyncError(apiErrorCopy(e).message);
      } finally {
        if (mountedRef.current) setSyncing(false);
      }
    })();
  }, [loading, selectedIds, syncing]);

  const renderRow = useCallback(
    ({ item }: { item: PinterestBoard }) => {
      const on = selected[item.boardId] === true;
      return (
        <Pressable
          style={[styles.row, { borderColor: colors.border }, on && { borderColor: colors.primary }]}
          onPress={() => toggle(item.boardId)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: on }}
          testID={`board-${item.boardId}`}
        >
          <View
            style={[
              styles.box,
              { borderColor: colors.border },
              on && { backgroundColor: colors.primary, borderColor: colors.primary },
            ]}
          >
            {on && <Text style={[styles.tick, { color: colors.onPrimary }]}>✓</Text>}
          </View>
          <View style={styles.rowText}>
            <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={[styles.meta, { color: colors.muted }]} testID={`board-meta-${item.boardId}`}>
              {item.pinCount} pins · {item.privacy === 'secret' ? 'Secret' : 'Public'}
            </Text>
          </View>
        </Pressable>
      );
    },
    [colors, selected, toggle],
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]} testID="pinterest-boards">
      <View style={styles.head}>
        <Text style={[styles.title, { color: colors.text }]}>Choose boards</Text>
        <Text style={[styles.sub, { color: colors.muted }]}>
          VAI learns your taste from the boards you pick — {selectedIds.length} of {boards.length} selected.
        </Text>
      </View>

      {loading ? (
        <View style={styles.state} testID="boards-loading">
          <ActivityIndicator size="large" />
          <Text style={[styles.sub, { color: colors.muted }]}>Loading your boards…</Text>
        </View>
      ) : loadError && boards.length === 0 ? (
        <View style={styles.state} testID="boards-error">
          <ErrorView message={loadError} onRetry={load} />
        </View>
      ) : boards.length === 0 ? (
        <View style={styles.state} testID="boards-empty">
          <EmptyState
            title="No boards found"
            body="We couldn't see any Pinterest boards. Reconnect (trial-sandbox accounts only show test boards) or try again."
            actionTitle="Reconnect Pinterest"
            onAction={() => router.replace('/pinterest-connect')}
          />
        </View>
      ) : (
        <FlatList
          data={boards}
          keyExtractor={(b) => b.boardId}
          renderItem={renderRow}
          contentContainerStyle={styles.list}
          testID="boards-list"
        />
      )}

      {!!syncError && (
        <Text style={[styles.syncError, { color: colors.danger }]} testID="boards-sync-error">
          {syncError}
        </Text>
      )}
      {!!done && (
        <Text style={[styles.doneLine, { color: colors.text }]} testID="boards-done">
          Synced {done.boards} board{done.boards === 1 ? '' : 's'} · {done.pins} pins — your
          taste is up to date.
        </Text>
      )}

      <View style={styles.foot}>
        {done ? (
          <Button title="Done" onPress={() => router.back()} testID="boards-done-button" />
        ) : (
          <Button
            title={syncing ? 'Syncing…' : `Sync ${selectedIds.length} board${selectedIds.length === 1 ? '' : 's'}`}
            onPress={sync}
            loading={syncing}
            disabled={loading || boards.length === 0}
            testID="boards-sync"
          />
        )}
        {syncing && (
          <Text style={[styles.progress, { color: colors.muted }]} testID="boards-progress">
            Reading pins and pose marks — usually under a minute.
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 64 },
  head: { paddingHorizontal: 24, gap: 4 },
  title: { fontSize: 26, fontWeight: '700' },
  sub: { fontSize: 14, lineHeight: 20 },
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  list: { padding: 16, gap: 10 },
  row: { flexDirection: 'row', gap: 12, borderWidth: 1.5, borderRadius: 14, padding: 14, alignItems: 'center' },
  box: { width: 24, height: 24, borderRadius: 7, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  tick: { fontSize: 15, fontWeight: '700' },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: '700' },
  meta: { fontSize: 13 },
  syncError: { fontSize: 13, paddingHorizontal: 24, marginTop: 8 },
  doneLine: { fontSize: 14, fontWeight: '600', paddingHorizontal: 24, marginTop: 8 },
  foot: { padding: 24, gap: 8 },
  progress: { fontSize: 13, textAlign: 'center' },
});
