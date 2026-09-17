import * as React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { formatDuration, formatMoney, formatPlate, formatTime, type Session } from "@kmcp/api";

import { Banner, Button, Card, Empty, Loading, Pill, Plate } from "../../components/ui";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { theme } from "../../lib/theme";

/**
 * The kerb.
 *
 * What an attendant looks at between vehicles: whether they are on shift, what
 * is parked in front of them, and one button that starts the next session. The
 * running list is ordered oldest first, because the vehicle that has been there
 * longest is the one about to leave — or about to overstay.
 */
export default function Kerb() {
  const router = useRouter();
  const { user, shift, queued, rejected, syncing, sync } = useSession();
  const [sessions, setSessions] = React.useState<Session[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!user?.attendantId) {
      setSessions([]);
      return;
    }
    try {
      const list = await api.sessions.mine(user.attendantId);
      setSessions([...list].sort((a, b) => a.startAt.localeCompare(b.startAt)));
      setError(null);
    } catch {
      // Keep whatever was last known. A list we could not refresh is more
      // useful at a kerb than an error where the list used to be.
      setError("Could not refresh. Showing what was last known.");
      setSessions((current) => current ?? []);
    }
  }, [user?.attendantId]);

  // Refetch on every return to this tab: a session may have been ended on the
  // detail screen, and a stale list here is how a vehicle gets charged twice.
  useFocusEffect(
    React.useCallback(() => {
      void load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    await sync();
    await load();
    setRefreshing(false);
  }

  /**
   * Late by either measure. The server sets `isOverstay` from elapsed time on
   * every list row and separately promotes `status` to OVERSTAY on a schedule;
   * the two agree except in the minutes between the threshold passing and the
   * scheduler running, and either one is reason enough to flag the vehicle.
   */
  const late = (s: Session) => Boolean(s.isOverstay) || s.status === "OVERSTAY";
  const overstaying = (sessions ?? []).filter(late).length;

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colour.text} />
      }
    >
      {!shift ? (
        <Banner
          tone="warning"
          title="You are not on shift"
          body="Open a shift before taking cash — otherwise there is nothing to reconcile it against."
        />
      ) : null}

      {rejected > 0 ? (
        <Banner
          tone="danger"
          title={`${rejected} action${rejected === 1 ? "" : "s"} were refused`}
          body="The server would not accept them. Open the Shift tab to see why."
        />
      ) : null}

      {queued > 0 ? (
        <Banner
          tone="info"
          title={`${queued} waiting to send${syncing ? " — sending now" : ""}`}
          body="Saved on this handset. They will go through when you have signal."
        />
      ) : null}

      {error ? <Banner tone="warning" title={error} /> : null}

      <Button label="Start parking" onPress={() => router.push("/session/start")} />

      <View style={styles.heading}>
        <Text style={styles.headingText}>
          Parked now{sessions ? ` · ${sessions.length}` : ""}
        </Text>
        {overstaying > 0 ? <Pill tone="warning" label={`${overstaying} overstaying`} /> : null}
      </View>

      {sessions === null ? (
        <Loading label="Loading what is parked…" />
      ) : sessions.length === 0 ? (
        <Empty
          title="Nothing parked"
          body="Sessions you start will appear here until they are ended."
        />
      ) : (
        sessions.map((session) => (
          <Card key={session.id} onPress={() => router.push(`/session/${session.code}`)}>
            <View style={styles.cardTop}>
              <Plate value={formatPlate(session.plateNumber)} size="small" />
              {late(session) ? (
                <Pill tone="warning" label="Overstay" />
              ) : (
                <Pill tone="info" label="Running" />
              )}
            </View>
            <View style={styles.cardBottom}>
              <Text style={styles.meta}>
                {formatDuration(session.elapsedMinutes ?? session.durationMinutes)} · from{" "}
                {formatTime(session.startAt)}
              </Text>
              <Text style={styles.meta}>{session.zone?.name ?? ""}</Text>
            </View>
            {session.payableAmount != null ? (
              <Text style={styles.amount}>{formatMoney(session.payableAmount)} due</Text>
            ) : null}
          </Card>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.colour.bg },
  content: { padding: theme.space(2), gap: theme.space(1.5), paddingBottom: theme.space(6) },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: theme.space(1),
  },
  headingText: { ...theme.text.label, color: theme.colour.textMuted },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space(1) },
  cardBottom: { flexDirection: "row", justifyContent: "space-between", gap: theme.space(1) },
  meta: { ...theme.text.small, color: theme.colour.textMuted, flexShrink: 1 },
  amount: { ...theme.text.body, color: theme.colour.text, fontWeight: "700" },
});
