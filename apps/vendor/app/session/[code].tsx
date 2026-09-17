import * as React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ApiError,
  formatDuration,
  formatMoney,
  formatPlate,
  formatTime,
  provisionalFare,
  type EndedSession,
  type ProvisionalQuote,
  type Payment,
  type Session,
} from "@kmcp/api";

import { Banner, Button, Card, Loading, Pill, Plate, Row, Stat } from "../../components/ui";
import { PlateCamera, type Capture } from "../../components/plate-camera";
import { api, cache } from "../../lib/api";
import { useRazorpayCheckout } from "../../lib/checkout";
import { useLocation } from "../../lib/location";
import { useSession } from "../../lib/session";
import { theme } from "../../lib/theme";

/**
 * One session, from running to paid.
 *
 * The screen moves through three states and never goes back: running, ended and
 * awaiting payment, then paid with a receipt number. Each is a separate act by
 * the attendant, because ending the parking and taking the money are separate
 * things that can fail independently — a car can leave before the cash is
 * counted, and the fare must survive that.
 *
 * Two ways to take the money. Cash is recorded here and captured at once, and
 * queues when there is no signal. UPI goes through the gateway and cannot
 * queue: the server has to mint an order before the driver can scan anything,
 * and an order minted after the driver has gone is worth nothing.
 */
type CollectMode = "CASH" | "UPI";

export default function SessionScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const { refreshShift } = useSession();
  const location = useLocation(false);
  const checkout = useRazorpayCheckout();

  const [session, setSession] = React.useState<Session | EndedSession | null>(null);
  const [payment, setPayment] = React.useState<Payment | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [capture, setCapture] = React.useState<Capture | null>(null);
  const [mode, setMode] = React.useState<CollectMode>("CASH");
  /** What to charge when the server could not price it. Never overrides a real quote. */
  const [estimate, setEstimate] = React.useState<ProvisionalQuote | null>(null);

  React.useEffect(() => {
    if (!code) return;
    let cancelled = false;

    void (async () => {
      try {
        const found = await api.sessions.get(code);
        if (!cancelled) setSession(found);
      } catch (cause) {
        if (!cancelled) {
          setLoadError(
            cause instanceof ApiError ? cause.message : "Could not load this session.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  // `quote` is absent on an idempotent replay of an end, not only on a fresh
  // `Session`, so both "no key" and "key with nothing in it" mean no breakdown.
  const quote = session && "quote" in session ? (session.quote ?? null) : null;
  const running = session?.status === "ACTIVE" || session?.status === "OVERSTAY";
  // The server's figure whenever there is one; the provisional estimate only
  // when there is not.
  const owed = session?.payableAmount ?? estimate?.payableAmount ?? null;
  /**
   * UPI needs the server to have priced this session. A session ended offline
   * has a provisional figure and no order behind it, so until the end has
   * synced there is nothing a gateway could charge — cash is the only way.
   */
  const upiPossible = quote !== null;

  async function end() {
    if (!session) return;
    setBusy(true);
    setError(null);

    try {
      let evidenceMediaId: string | undefined;
      if (capture) {
        try {
          const media = await api.media.upload(capture.uri, "SESSION_EVIDENCE_END");
          evidenceMediaId = media.id;
        } catch {
          setError("The photograph could not be uploaded. Ending without it.");
        }
      }

      const fix = await location.locate();
      const ended = await api.sessions.end(session.code, {
        location: fix ? { lat: fix.lat, lng: fix.lng } : undefined,
        evidenceMediaId,
      });

      if (ended) {
        setSession(ended);
      } else {
        // Queued. The server has not priced it, so quote from the cached rate
        // card instead — an attendant with a driver in front of them needs a
        // number, and the server's re-price on sync is still what stands.
        const endedAt = new Date();
        setSession({ ...session, status: "COMPLETED", endAt: endedAt.toISOString() });

        const quoted = await provisionalFare(cache, {
          zoneId: session.zoneId,
          vehicleType: session.vehicleType?.code ?? "CAR",
          startAt: new Date(session.startAt),
          endAt: endedAt,
        });

        if (quoted) {
          setEstimate(quoted);
        } else {
          setError(
            "Saved on this handset, but there is no rate card cached for this zone, so the fare cannot be worked out here.",
          );
        }
      }
      await refreshShift();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not end the session.");
    } finally {
      setBusy(false);
    }
  }

  async function collectCash() {
    if (!session) return;
    setBusy(true);
    setError(null);

    try {
      const result = await api.payments.collectCash(session.id);
      if (result) {
        setPayment(result);
      } else {
        setError("Saved on this handset. The receipt will be issued when you have signal.");
      }
      await refreshShift();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not record the payment.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Order, sheet, verify — three round trips, and only the last one moves
   * money. A cancelled or dismissed sheet leaves the session exactly as it
   * was, unpaid and without a banner: the driver changing their mind is not
   * an error, and the attendant's next move is to offer cash.
   */
  async function collectUpi() {
    if (!session) return;
    setBusy(true);
    setError(null);

    let pending: Payment;
    try {
      pending = await api.payments.collectDigital(session.id, "UPI_INTENT");
    } catch (cause) {
      // Includes SERVICE_UNAVAILABLE when the gateway is not configured on
      // this deployment. The server's message already says cash still works.
      setError(cause instanceof ApiError ? cause.message : "Could not start a UPI payment.");
      setBusy(false);
      return;
    }

    if (!pending.gatewayKeyId || !pending.gatewayOrder) {
      setError("The server accepted the request but sent nothing to pay against. Take cash instead.");
      setBusy(false);
      return;
    }

    const result = await checkout.open({
      gatewayKeyId: pending.gatewayKeyId,
      gatewayOrder: pending.gatewayOrder,
      description: `Parking ${session.code} · ${formatPlate(session.plateNumber)}`,
    });

    if (result.status === "cancelled") {
      setBusy(false);
      return;
    }
    if (result.status === "error") {
      setError(result.message);
      setBusy(false);
      return;
    }

    try {
      const captured = await api.payments.verify(pending.id, {
        razorpayOrderId: result.razorpayOrderId,
        razorpayPaymentId: result.razorpayPaymentId,
        razorpaySignature: result.razorpaySignature,
      });
      setPayment(captured);
      // The session now carries the payment; refresh so what is on screen is
      // what the server holds, not what was on screen before the sheet opened.
      try {
        setSession(await api.sessions.get(session.code));
      } catch {
        // The payment is captured either way; a stale session card is not
        // worth an error over a receipt.
      }
      await refreshShift();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "The payment went through but could not be confirmed here. It will be confirmed by the gateway; do not collect cash.",
      );
    } finally {
      setBusy(false);
    }
  }

  function collect() {
    if (mode === "UPI") void collectUpi();
    else void collectCash();
  }

  if (loadError) {
    return (
      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        <Banner tone="danger" title="Session not found" body={loadError} />
        <Button label="Back to the kerb" variant="secondary" onPress={() => router.replace("/(tabs)")} />
      </ScrollView>
    );
  }

  if (!session) return <Loading label="Loading session…" />;

  const collectLabel =
    owed === null
      ? ""
      : mode === "UPI"
        ? `Collect ${formatMoney(owed)} by UPI`
        : `Collect ${formatMoney(owed)} cash${estimate && !quote ? " (provisional)" : ""}`;

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <Card>
        <View style={styles.head}>
          <Plate value={formatPlate(session.plateNumber)} />
          {running ? (
            <Pill tone={session.isOverstay ? "warning" : "info"} label={session.isOverstay ? "Overstay" : "Running"} />
          ) : (
            <Pill tone="success" label="Ended" />
          )}
        </View>
        <Text style={styles.code}>{session.code}</Text>
        <View style={styles.stats}>
          <Stat
            label="Parked for"
            value={formatDuration(session.elapsedMinutes ?? session.durationMinutes)}
          />
          <Stat label="Since" value={formatTime(session.startAt)} />
        </View>
        {session.zone?.name ? <Text style={styles.zone}>{session.zone.name}</Text> : null}
      </Card>

      {error ? <Banner tone="warning" title={error} /> : null}

      {/* ------------------------------------------------- the fare, once known */}
      {quote ? (
        <Card>
          <Text style={styles.sectionLabel}>WHAT IS OWED</Text>
          {quote.lines.map((line, i) => (
            <Row key={`${line.code}-${i}`} label={line.label} value={formatMoney(line.amount)} />
          ))}
          {quote.discountAmount > 0 ? (
            <Row label="Discount" value={`− ${formatMoney(quote.discountAmount)}`} />
          ) : null}
          {quote.penaltyAmount > 0 ? (
            <Row label="Overstay penalty" value={formatMoney(quote.penaltyAmount)} />
          ) : null}
          {quote.taxAmount > 0 ? (
            <Row label={`Tax (${quote.taxPercent}%)`} value={formatMoney(quote.taxAmount)} />
          ) : null}
          <View style={styles.total}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatMoney(quote.payableAmount)}</Text>
          </View>
          {quote.waivedByPass ? <Pill tone="success" label="Covered by a pass" /> : null}
          {quote.cappedByDailyLimit ? <Pill tone="info" label="Daily cap applied" /> : null}
          <Text style={styles.tariff}>
            {quote.tariffName} · {formatDuration(quote.chargeableMinutes)} chargeable of{" "}
            {formatDuration(quote.durationMinutes)}
          </Text>
        </Card>
      ) : null}

      {/* ------------------------- the provisional fare, when there is no signal */}
      {!quote && estimate ? (
        <Card>
          <Banner
            tone="warning"
            title="Provisional — worked out on this handset"
            body={`Rate card cached ${formatTime(estimate.tariffFetchedAt)}. The server prices this properly when it syncs, and any difference shows on your shift.`}
          />
          {estimate.lines.map((line, i) => (
            <Row key={`${line.code}-${i}`} label={line.label} value={formatMoney(line.amount)} />
          ))}
          {estimate.taxAmount > 0 ? (
            <Row label={`Tax (${estimate.taxPercent}%)`} value={formatMoney(estimate.taxAmount)} />
          ) : null}
          <View style={styles.total}>
            <Text style={styles.totalLabel}>To collect</Text>
            <Text style={styles.totalValue}>{formatMoney(estimate.payableAmount)}</Text>
          </View>
          {estimate.assumptions.map((line) => (
            <Text key={line} style={styles.assumption}>
              • {line}
            </Text>
          ))}
        </Card>
      ) : null}

      {/* ------------------------------------------------------------ receipt */}
      {payment ? (
        <Card>
          <Banner
            tone="success"
            title={`${formatMoney(payment.amount)} collected${payment.mode === "CASH" ? "" : " by UPI"}`}
            body={
              payment.receipt
                ? `Receipt ${payment.receipt.number}`
                : "The receipt number will follow when this reaches the server."
            }
          />
          <Button label="Done" onPress={() => router.replace("/(tabs)")} />
        </Card>
      ) : running ? (
        <View style={styles.actions}>
          <Button
            label={capture ? "Photograph taken — retake" : "Photograph on exit"}
            variant={capture ? "success" : "secondary"}
            size="medium"
            onPress={() => setCameraOpen(true)}
            disabled={busy}
          />
          <Button label="End parking" onPress={() => void end()} busy={busy} />
        </View>
      ) : (
        <View style={styles.actions}>
          {owed && owed > 0 ? (
            <>
              {/* ------------------------------------------- how to take it */}
              <View style={styles.modes} accessibilityRole="radiogroup">
                <ModeChip
                  label="Cash"
                  selected={mode === "CASH"}
                  onPress={() => setMode("CASH")}
                  disabled={busy}
                />
                <ModeChip
                  label="UPI"
                  selected={mode === "UPI"}
                  onPress={() => setMode("UPI")}
                  disabled={busy || !upiPossible}
                />
              </View>
              {!upiPossible ? (
                <Text style={styles.modeNote}>
                  UPI needs the server to have priced this session. Until this end has synced, cash
                  is the only way to collect.
                </Text>
              ) : null}
              <Button label={collectLabel} variant="success" onPress={collect} busy={busy} />
            </>
          ) : (
            <Banner
              tone="info"
              title="Nothing to collect"
              body="This session has no fare outstanding."
            />
          )}
          <Button
            label="Back to the kerb"
            variant="secondary"
            size="medium"
            onPress={() => router.replace("/(tabs)")}
            disabled={busy}
          />
        </View>
      )}

      <PlateCamera
        visible={cameraOpen}
        onCancel={() => setCameraOpen(false)}
        onCapture={(shot) => {
          setCapture(shot);
          setCameraOpen(false);
        }}
      />

      {checkout.modal}
    </ScrollView>
  );
}

/** One of the two ways to take the money. Same shape as the vehicle chips on Start. */
function ModeChip({
  label,
  selected,
  onPress,
  disabled,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: Boolean(disabled) }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && !disabled && styles.chipPressed,
        disabled && !selected && styles.chipDisabled,
      ]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.colour.bg },
  content: { padding: theme.space(2), gap: theme.space(1.5), paddingBottom: theme.space(6) },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space(1) },
  code: { ...theme.text.small, color: theme.colour.textMuted, letterSpacing: 1 },
  stats: { flexDirection: "row", gap: theme.space(4), marginTop: theme.space(0.5) },
  zone: { ...theme.text.body, color: theme.colour.textMuted },
  sectionLabel: { ...theme.text.label, color: theme.colour.textMuted },
  total: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: theme.space(1.5),
  },
  totalLabel: { ...theme.text.title, color: theme.colour.text },
  totalValue: { ...theme.text.display, color: theme.colour.text },
  tariff: { ...theme.text.small, color: theme.colour.textMuted },
  assumption: { ...theme.text.small, color: theme.colour.warning },
  actions: { gap: theme.space(1) },
  modes: { flexDirection: "row", gap: theme.space(1) },
  modeNote: { ...theme.text.small, color: theme.colour.textMuted },
  chip: {
    flex: 1,
    minHeight: theme.minTouch,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colour.border,
    backgroundColor: theme.colour.surface,
  },
  chipSelected: { backgroundColor: theme.colour.primary, borderColor: theme.colour.primary },
  chipPressed: { opacity: 0.8 },
  chipDisabled: { opacity: 0.4 },
  chipLabel: { ...theme.text.body, color: theme.colour.textMuted },
  chipLabelSelected: { color: theme.colour.primaryText, fontWeight: "700" },
});
