import * as React from "react";
import { AppState, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { formatDuration, formatMoney, formatPlate, formatTime, type Session } from "@kmcp/api";

import { Banner, Button, Card, Empty, Loading, Pill, Plate } from "../../components/ui";
import { api, queue } from "../../lib/api";
import { elapsedMinutesSince, useNow } from "../../lib/elapsed";
import { useSession } from "../../lib/session";
import { theme } from "../../lib/theme";

/**
 * How often the running list is refetched while this tab is in front of somebody.
 *
 * A minute. The only thing on these rows the handset cannot work out for itself
 * is the server's promotion to OVERSTAY — that threshold is zone configuration,
 * not something a handset should guess at — and it moves on a minute boundary at
 * best. The durations tick locally in between, so a faster poll would spend an
 * attendant's data allowance to change nothing on screen. Two requests a minute,
 * and only while this tab is focused and the handset awake.
 */
const REFRESH_MS = 60_000;

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
  // One clock for every row: each row derives its own duration from its own
  // `startAt` against it, so twenty vehicles still cost one timer. Stopped
  // while nothing is parked, because there is then nothing to time.
  const now = useNow(Boolean(sessions?.length));

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

  /**
   * Refetch on every return to this tab — a session may have been ended on the
   * detail screen, and a stale list here is how a vehicle gets charged twice —
   * and then keep refetching while the tab stays in front of somebody.
   *
   * Without the timer an attendant standing with this screen open never sees a
   * vehicle promoted to overstay, because nothing here ever asked again.
   */
  useFocusEffect(
    React.useCallback(() => {
      void load();

      let timer: ReturnType<typeof setInterval> | null = null;

      const tick = () => {
        // Stand down while the queue has work outstanding or is draining. The
        // server's answer is knowingly behind this handset until it empties —
        // it still holds a session whose end is sitting in the queue — and
        // replacing the list with it would put an ended vehicle back on the
        // kerb. The "waiting to send" banner above already explains why the
        // list is not moving, and pull-to-refresh syncs first, which is the
        // ordered way to reconcile the two.
        const state = queue.state();
        if (state.pending > 0 || state.syncing) return;
        void load();
      };

      const start = () => {
        timer ??= setInterval(tick, REFRESH_MS);
      };
      const stop = () => {
        if (timer) clearInterval(timer);
        timer = null;
      };

      // A poll firing in a pocket is mobile data spent on a screen nobody is
      // looking at — the same reason `lib/session.tsx` hangs its queue drain
      // off AppState. Coming back to the app refetches at once rather than
      // waiting out the rest of the minute.
      const subscription = AppState.addEventListener("change", (next) => {
        if (next !== "active") {
          stop();
          return;
        }
        tick();
        start();
      });

      start();

      return () => {
        subscription.remove();
        stop();
      };
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

      {/*
        Said once for the whole list rather than on every row: the durations
        below are counted on this handset, and whether a vehicle is overstaying
        is not — that threshold lives in zone configuration on the server.
      */}
      {sessions && sessions.length > 0 ? (
        <Text style={styles.clockNote}>
          Times count up on this handset. Overstay is the server's call.
        </Text>
      ) : null}

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
              {/*
                Local clock first, the server's integer only as a fallback for a
                timestamp this handset cannot parse: the server's figure was true
                when the row was fetched and stale by the time it is read.
              */}
              <Text style={styles.meta}>
                {formatDuration(
                  elapsedMinutesSince(session.startAt, now) ??
                    session.elapsedMinutes ??
                    session.durationMinutes,
                )}{" "}
                · from {formatTime(session.startAt)}
              </Text>
              {/*
                Bay before zone: on a single-zone shift every row carries the
                same zone name and the bay is the only part that locates the
                vehicle. Sessions from bay-less zones simply show the zone, as
                they did before there were bays to show.
              */}
              <Text style={styles.meta} numberOfLines={1}>
                {[session.slot?.code ? `Bay ${session.slot.code}` : null, session.zone?.name]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
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
  clockNote: { ...theme.text.small, color: theme.colour.textMuted },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space(1) },
  cardBottom: { flexDirection: "row", justifyContent: "space-between", gap: theme.space(1) },
  meta: { ...theme.text.small, color: theme.colour.textMuted, flexShrink: 1 },
  amount: { ...theme.text.body, color: theme.colour.text, fontWeight: "700" },
});
