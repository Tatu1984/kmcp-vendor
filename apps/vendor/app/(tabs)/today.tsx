import * as React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  ApiError,
  formatMoney,
  formatTime,
  slotsWith,
  type Session,
  type SlotSummary,
} from "@kmcp/api";

import { Banner, Button, Card, Field, Pill, Row, Stat } from "../../components/ui";
import { api, queue } from "../../lib/api";
import { useLocation } from "../../lib/location";
import { useSession } from "../../lib/session";
import { theme } from "../../lib/theme";

/**
 * Today: what the shift is worth, and how it closes.
 *
 * This was the Shift tab. It grew the four figures an operator actually asks
 * for rather than becoming a fourth tab, because the layout file's rule holds —
 * a fourth tab competes for a thumb that is holding a phone in the rain, and
 * the Kerb has to stay first.
 *
 * The close is deliberately a count and not a confirmation. The expected figure
 * is shown *after* the attendant has entered what they are holding, never
 * before — pre-filling it would turn counting the money into agreeing with the
 * system, which is the whole thing a reconciliation is meant to test.
 */
export default function TodayScreen() {
  const { user, shift, refreshShift, refreshCache, signOut, queued, rejected, syncing, sync, online, cacheAgeHours } =
    useSession();
  const location = useLocation(false);

  const [cash, setCash] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [closed, setClosed] = React.useState<{ variance: number; matched: boolean } | null>(null);

  const [slots, setSlots] = React.useState<SlotSummary | null>(null);
  const [today, setToday] = React.useState<Session[] | null>(null);

  /**
   * The dashboard figures.
   *
   * Bay counts need a zone, and a zone comes from the open shift — off shift
   * there is nothing to be occupied *of*, so the tiles stand down rather than
   * showing a zero that reads like an empty car park.
   */
  const load = React.useCallback(async () => {
    const zoneId = shift?.zoneId;
    const attendantId = user?.attendantId;

    const [bays, sessions] = await Promise.allSettled([
      zoneId ? api.slots.summary(zoneId) : Promise.resolve(null),
      attendantId ? api.sessions.today(attendantId) : Promise.resolve([]),
    ]);

    // Each tile fails on its own. A dashboard that blanks because one of four
    // figures timed out is worse than a dashboard missing one figure.
    if (bays.status === "fulfilled") setSlots(bays.value);
    if (sessions.status === "fulfilled") setToday(sessions.value);
  }, [shift?.zoneId, user?.attendantId]);

  useFocusEffect(
    React.useCallback(() => {
      void load();
    }, [load]),
  );

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const fix = await location.locate();
      await api.shifts.open(fix ? { location: { lat: fix.lat, lng: fix.lng } } : {});
      await refreshShift();
      // Opening a shift is the last moment this handset is reliably somewhere
      // with signal before it goes somewhere without it.
      await refreshCache();
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not open a shift.");
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!shift) return;
    setBusy(true);
    setError(null);
    try {
      // Rupees on screen, paise on the wire — the only place this app converts.
      const paise = Math.round(Number(cash) * 100);
      const fix = await location.locate();
      const result = await api.shifts.close(
        shift.id,
        paise,
        fix ? { lat: fix.lat, lng: fix.lng } : undefined,
      );

      if (result) {
        const variance = result.varianceAmount ?? 0;
        setClosed({ variance, matched: variance === 0 });
      } else {
        setError("Saved on this handset. The shift will close when you have signal.");
      }
      await refreshShift();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not close the shift.");
    } finally {
      setBusy(false);
    }
  }

  const declared = Number(cash);
  /**
   * Nothing may close while work is still queued.
   *
   * The expected figure is computed by the server from the payments it has
   * seen. Closing with sessions still on the handset would compare a real cash
   * count against an incomplete expectation and raise a variance against a
   * named person for work they did correctly.
   */
  const unsynced = queued > 0;
  const canClose =
    cash.length > 0 && Number.isFinite(declared) && declared >= 0 && !busy && !unsynced;

  // ─────────────────────────────────────────────────────────── the figures
  const free = slots ? slotsWith(slots, "AVAILABLE") : null;
  const capacity = slots?.mappedAgainstCapacity.capacity ?? null;
  const parked = slots?.activeSessions ?? null;
  const collected = shift ? shift.cashExpected + shift.digitalTotal : null;

  /**
   * The vendor's cut of what this attendant collected.
   *
   * Labelled "Vendor share" and not "Your share" on purpose. KMC contracts the
   * vendor, the vendor employs the attendant, and this figure is the vendor's
   * commission on the attendant's takings — not the attendant's pay. What the
   * attendant is owed for the shift is a wage the system does not model at all.
   *
   * Worked out here from the shift's own figures rather than read from
   * `/revenue`, which scopes to the caller's vendor only when the caller holds
   * the VENDOR role — an attendant calling it would be handed city-wide totals.
   * `commissionPct` arrives as a Prisma Decimal, which serialises to a string.
   */
  const commissionPct = shift?.vendor?.commissionPct;
  const pct = commissionPct === undefined || commissionPct === null ? null : Number(commissionPct);
  const share =
    collected !== null && pct !== null && Number.isFinite(pct)
      ? Math.round((collected * pct) / 100)
      : null;

  /** Sessions bucketed by the hour they started, earliest working hour first. */
  const hours = React.useMemo(() => {
    if (!today) return null;
    const buckets = new Map<number, number>();
    for (const s of today) {
      const h = new Date(s.startAt).getHours();
      buckets.set(h, (buckets.get(h) ?? 0) + 1);
    }
    if (buckets.size === 0) return [];
    const first = Math.min(...buckets.keys());
    const last = Math.max(...buckets.keys());
    return Array.from({ length: last - first + 1 }, (_, i) => ({
      hour: first + i,
      count: buckets.get(first + i) ?? 0,
    }));
  }, [today]);

  const peak = hours && hours.length > 0 ? Math.max(...hours.map((h) => h.count)) : 0;

  async function onRefresh() {
    await sync();
    await refreshShift();
    await load();
  }

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={() => void onRefresh()} tintColor={theme.colour.text} />
      }
    >
      {/* ───────────────────────────────────────────────────────── who */}
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.name}>{user?.name ?? "Attendant"}</Text>
          <Text style={styles.role}>{shift?.zone?.name ?? user?.phone ?? ""}</Text>
        </View>
        {shift ? (
          <Pill tone="success" label={`On shift · ${formatTime(shift.startAt)}`} />
        ) : (
          <Pill tone="warning" label="Not on shift" />
        )}
      </View>

      {/* ─────────────────────────────────────────────────────── tiles */}
      <View style={styles.tiles}>
        <Tile
          label="Parked now"
          value={parked === null ? "—" : String(parked)}
          sub={capacity === null ? "open a shift" : `of ${capacity} bays`}
        />
        <Tile
          label="Free slots"
          value={free === null ? "—" : String(free)}
          sub={
            free === null || !capacity
              ? "open a shift"
              : `${Math.round((free / capacity) * 100)}% available`
          }
          tone={free === null ? "default" : free === 0 ? "danger" : free <= 6 ? "warning" : "success"}
        />
        <Tile
          label="Collected"
          value={collected === null ? "—" : formatMoney(collected)}
          sub={
            shift
              ? `cash ${formatMoney(shift.cashExpected)} · digital ${formatMoney(shift.digitalTotal)}`
              : "open a shift"
          }
        />
        <Tile
          label="Vendor share"
          value={share === null ? "—" : formatMoney(share)}
          sub={pct === null ? "rate not published" : `${pct}% to ${shift?.vendor?.orgName ?? "your vendor"}`}
        />
      </View>

      {/* ─────────────────────────────────────────────── sessions by hour */}
      {hours && hours.length > 0 ? (
        <Card>
          <Text style={styles.sectionLabel}>
            SESSIONS BY HOUR · {today?.length ?? 0} TODAY
          </Text>
          <View style={styles.chart} accessibilityLabel={`${today?.length ?? 0} sessions today, busiest hour ${peak}`}>
            {hours.map(({ hour, count }) => (
              <View key={hour} style={styles.bar}>
                {count === peak && peak > 0 ? <Text style={styles.barValue}>{count}</Text> : null}
                <View
                  style={[
                    styles.barFill,
                    {
                      height: Math.max(3, (count / (peak || 1)) * 44),
                      backgroundColor:
                        count === peak ? theme.colour.primaryBright : theme.colour.primary,
                    },
                  ]}
                />
              </View>
            ))}
          </View>
          <View style={styles.axis}>
            <Text style={styles.axisLabel}>{pad(hours[0].hour)}:00</Text>
            <Text style={styles.axisLabel}>{pad(hours[hours.length - 1].hour)}:00</Text>
          </View>
        </Card>
      ) : null}

      {/* ────────────────────────────────────────────────── connection */}
      <Card>
        <View style={styles.head}>
          <Pill tone={online ? "success" : "warning"} label={online ? "Online" : "No signal"} />
          {cacheAgeHours === null ? (
            <Pill tone="danger" label="No offline rates" />
          ) : cacheAgeHours > 24 ? (
            <Pill tone="warning" label={`Rates ${Math.floor(cacheAgeHours)}h old`} />
          ) : (
            <Pill tone="default" label="Rates current" />
          )}
        </View>
        <Button
          label="Refresh offline rates"
          variant="secondary"
          size="medium"
          onPress={() => void refreshCache()}
          disabled={!online}
        />
      </Card>

      {rejected > 0 ? (
        <Card>
          <Banner
            tone="danger"
            title={`${rejected} refused`}
            body="The server would not accept these. They need a supervisor, not another attempt."
          />
          {queue
            .list()
            .filter((item) => item.rejected)
            .map((item) => (
              <View key={item.id} style={styles.rejected}>
                <Text style={styles.rejectedKind}>{item.kind}</Text>
                <Text style={styles.rejectedReason}>{item.lastError ?? "Refused"}</Text>
                <Button
                  label="Discard"
                  variant="secondary"
                  size="medium"
                  onPress={() => void queue.discard(item.id)}
                />
              </View>
            ))}
        </Card>
      ) : null}

      {queued > 0 ? (
        <Card>
          <Banner
            tone="info"
            title={`${queued} waiting to send`}
            body="Saved here until there is signal. Nothing is lost."
          />
          <Button
            label={syncing ? "Sending…" : "Send now"}
            variant="secondary"
            size="medium"
            onPress={() => void sync()}
            busy={syncing}
          />
        </Card>
      ) : null}

      {/* ────────────────────────────────────────────────────── the shift */}
      {closed ? (
        <Card>
          <Banner
            tone={closed.matched ? "success" : "warning"}
            title={closed.matched ? "Shift closed and balanced" : "Shift closed with a variance"}
            body={
              closed.matched
                ? "What you handed in matched what the sessions say you took."
                : `${formatMoney(Math.abs(closed.variance))} ${closed.variance < 0 ? "short" : "over"}. Your supervisor will verify the deposit.`
            }
          />
        </Card>
      ) : !shift ? (
        <Card>
          <Text style={styles.sectionLabel}>NOT ON SHIFT</Text>
          <Text style={styles.body}>
            Open a shift before you start taking cash. Everything you collect is counted against it.
          </Text>
          {error ? <Banner tone="danger" title={error} /> : null}
          <Button label="Open shift" onPress={() => void open()} busy={busy} />
        </Card>
      ) : (
        <Card>
          <Text style={styles.sectionLabel}>CLOSING THE SHIFT</Text>
          <Text style={styles.body}>
            Count the cash you are handing in and enter it. The expected figure is shown once you
            have — that is the point of counting it.
          </Text>

          <View style={styles.stats}>
            <Stat label="Sessions" value={String(shift.sessionsCount)} />
            <Stat label="Digital" value={formatMoney(shift.digitalTotal)} />
          </View>

          <Field
            label="Cash you are handing in (₹)"
            value={cash}
            onChangeText={setCash}
            keyboardType="decimal-pad"
            placeholder="0"
            editable={!busy}
            style={styles.cashInput}
          />

          {cash.length > 0 ? (
            <View style={styles.compare}>
              <Row label="You counted" value={formatMoney(Math.round(declared * 100))} />
              <Row label="Sessions say" value={formatMoney(shift.cashExpected)} />
              <Row
                label="Difference"
                value={formatMoney(Math.round(declared * 100) - shift.cashExpected)}
              />
            </View>
          ) : null}

          {unsynced ? (
            <Banner
              tone="warning"
              title={`${queued} action${queued === 1 ? "" : "s"} have not reached the server`}
              body="The expected figure is worked out from what the server has seen, so closing now would flag a variance you did not cause. Send them first."
            />
          ) : null}

          {error ? <Banner tone="danger" title={error} /> : null}

          <Button
            label="Close shift"
            variant="danger"
            onPress={() => void close()}
            disabled={!canClose}
            busy={busy}
          />
        </Card>
      )}

      <Button label="Sign out" variant="secondary" size="medium" onPress={() => void signOut()} />
    </ScrollView>
  );
}

/** One dashboard figure. Only the tile that needs acting on carries colour. */
function Tile({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label.toUpperCase()}</Text>
      <Text style={[styles.tileValue, tone !== "default" && { color: theme.colour[tone] }]}>
        {value}
      </Text>
      <Text style={styles.tileSub}>{sub}</Text>
    </View>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.colour.bg },
  content: { padding: theme.space(2), gap: theme.space(1.5), paddingBottom: theme.space(6) },

  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space(1) },
  headText: { flexShrink: 1 },
  name: { ...theme.text.title, color: theme.colour.text },
  role: { ...theme.text.small, color: theme.colour.textMuted },

  tiles: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(1.25) },
  tile: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: theme.colour.surface,
    borderWidth: 1,
    borderColor: theme.colour.border,
    borderRadius: theme.radius.lg,
    padding: theme.space(1.75),
    gap: 2,
  },
  tileLabel: { ...theme.text.label, color: theme.colour.textMuted, fontSize: 12 },
  tileValue: { fontSize: 29, fontWeight: "700", color: theme.colour.text, letterSpacing: -0.5 },
  tileSub: { ...theme.text.small, color: theme.colour.textMuted, fontSize: 12.5 },

  sectionLabel: { ...theme.text.label, color: theme.colour.textMuted },
  body: { ...theme.text.body, color: theme.colour.textMuted },

  chart: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 56 },
  bar: { flex: 1, justifyContent: "flex-end", alignItems: "center" },
  barValue: { fontSize: 11, fontWeight: "700", color: theme.colour.primaryBright, marginBottom: 2 },
  barFill: { width: "100%", borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  axis: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: theme.colour.border,
    paddingTop: theme.space(0.5),
  },
  axisLabel: { ...theme.text.small, color: theme.colour.textMuted, fontSize: 11 },

  stats: { flexDirection: "row", gap: theme.space(4) },
  cashInput: { fontSize: 30, fontWeight: "700", minHeight: 72 },
  compare: { marginTop: theme.space(0.5) },
  rejected: { gap: theme.space(0.5), paddingVertical: theme.space(1) },
  rejectedKind: { ...theme.text.body, color: theme.colour.text, fontWeight: "700" },
  rejectedReason: { ...theme.text.small, color: theme.colour.textMuted },
});
