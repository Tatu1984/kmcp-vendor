import * as React from "react";
import { AppState, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import {
  ApiError,
  formatDuration,
  formatMoney,
  formatPlate,
  formatTime,
  provisionalFare,
  type EndedSession,
  type Paise,
  type ProvisionalQuote,
  type Payment,
  type Session,
} from "@kmcp/api";

import { Banner, Button, Card, Loading, Pill, Plate, Row, Stat } from "../../components/ui";
import { PlateCamera, type Capture } from "../../components/plate-camera";
import { api, cache } from "../../lib/api";
import { elapsedMinutesSince, useNow } from "../../lib/elapsed";
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
 * queues when there is no signal. UPI puts a code on this screen with the fare
 * already inside it, which the driver pays from their own handset — nothing is
 * paid on the attendant's phone, and none of it can queue: the server has to
 * mint the code before anyone can scan it, and a code minted after the driver
 * has gone is worth nothing.
 */
type CollectMode = "CASH" | "UPI";

/**
 * Three seconds.
 *
 * This is the gap between the driver tapping pay and the attendant seeing it,
 * with both of them standing over the screen waiting — anything slower reads
 * as the app not having noticed, and the attendant starts asking for cash on
 * top of a fare that is already settled. It runs only while a code is live and
 * in front of somebody, a minute or two at a time, so the number of requests
 * is bounded by the transaction rather than by how long the app is open.
 */
const QR_POLL_MS = 3_000;

/**
 * The code currently on screen.
 *
 * `outcome` is how it stopped being worth showing: null while it is live and
 * payable, and otherwise one of the two dead ends. Paid is not an outcome here
 * — that becomes a `payment` and a receipt, like every other collection.
 */
type LiveQr = {
  paymentId: string;
  imageUrl: string;
  /** The server's figure, shown verbatim. It is what the code was minted for. */
  amount: Paise;
  expiresAt: string;
  outcome: null | "expired" | "mismatch";
};

export default function SessionScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const { refreshShift } = useSession();
  const location = useLocation(false);

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
  /** The code being shown to a driver, if there is one. */
  const [qr, setQr] = React.useState<LiveQr | null>(null);

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
  /**
   * The clock runs only while the session does.
   *
   * Once the parking has ended its duration is a settled fact, and a figure
   * still ticking on the screen that is about to show a receipt would keep
   * disagreeing with the fare printed on it.
   */
  const now = useNow(running);
  // The server's figure whenever there is one; the provisional estimate only
  // when there is not.
  const owed = session?.payableAmount ?? estimate?.payableAmount ?? null;
  /**
   * UPI needs the server to have priced this session. A session ended offline
   * has a provisional figure and no order behind it, so until the end has
   * synced there is nothing a gateway could charge — cash is the only way.
   */
  const upiPossible = quote !== null;
  /**
   * The code as far as the gateway is concerned: on screen and still payable.
   *
   * Expired and mismatched codes stay in `qr` because the attendant still has
   * to be told about them, but nothing should be polled or closed against one.
   */
  const live = qr && qr.outcome === null ? qr : null;

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

  /**
   * Where every successful collection ends, whoever paid and however.
   *
   * Cash arrives here from the queue's answer; a QR arrives from a poll that
   * found it settled, or from a close that found the driver had got there
   * first. All of them put the same receipt card on screen, and all of them
   * have to move the shift totals.
   */
  const recordPayment = React.useCallback(
    async (collected: Payment) => {
      setQr(null);
      setPayment(collected);
      // The session now carries the payment; refresh so what is on screen is
      // what the server holds.
      try {
        setSession(await api.sessions.get(code));
      } catch {
        // The payment is recorded either way; a stale session card is not
        // worth an error over a receipt.
      }
      await refreshShift();
    },
    [code, refreshShift],
  );

  async function collectCash() {
    if (!session) return;
    setBusy(true);
    setError(null);

    try {
      const result = await api.payments.collectCash(session.id);
      if (result) {
        await recordPayment(result);
      } else {
        // Queued. `recordPayment` refreshes the shift itself, so this branch
        // is the only one left that has to.
        setError("Saved on this handset. The receipt will be issued when you have signal.");
        await refreshShift();
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not record the payment.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Puts a code on screen with the fare already inside it.
   *
   * Nothing is paid on this handset. The driver scans with whichever UPI app
   * they have, pays from their own phone, and this screen finds out by asking
   * — see the poll below. The attendant's job is to hold the phone up and
   * watch it turn into a receipt.
   */
  async function collectUpi() {
    if (!session) return;
    setBusy(true);
    setError(null);

    try {
      const pending = await api.payments.collectUpiQr(session.id);
      if (!pending.qr?.imageUrl) {
        setError("The server accepted the request but sent no code back. Take cash instead.");
        return;
      }
      setQr({
        paymentId: pending.id,
        imageUrl: pending.qr.imageUrl,
        amount: pending.qr.amount,
        expiresAt: pending.qr.expiresAt,
        outcome: null,
      });
    } catch (cause) {
      // Includes SERVICE_UNAVAILABLE when the gateway is not configured on
      // this deployment. The server's message already says cash still works.
      setError(cause instanceof ApiError ? cause.message : "Could not create a UPI code.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Asks, while the code is up, whether it has been paid.
   *
   * There is a `qr_code.credited` webhook and it is the authority, but it
   * arrives at the server rather than here — and on a development machine
   * Razorpay cannot reach it arrives nowhere. Asking is what actually settles
   * this screen, so it is not a fallback.
   *
   * It stops the moment the money lands, the code expires or the attendant
   * leaves, and the interval is cleared on every one of those paths rather
   * than left firing into a screen that has gone. Paused with the app for the
   * reason in `lib/elapsed.ts`: a code nobody is holding up is a code nobody
   * is scanning, and polling for it is mobile data spent on nothing.
   */
  useFocusEffect(
    React.useCallback(() => {
      if (!live) return;

      let timer: ReturnType<typeof setInterval> | null = null;
      let stopped = false;

      const pause = () => {
        if (timer) clearInterval(timer);
        timer = null;
      };
      const stop = () => {
        stopped = true;
        pause();
      };

      const tick = async () => {
        if (stopped) return;

        // Past its close time the gateway will not take it, so the answer can
        // no longer change — and an attendant left holding a dead code up to a
        // driver gets a failure they cannot explain.
        if (Date.now() >= Date.parse(live.expiresAt)) {
          stop();
          setQr({ ...live, outcome: "expired" });
          return;
        }

        try {
          const result = await api.payments.reconcileQr(live.paymentId);
          if (stopped) return;

          if (result.mismatch) {
            stop();
            setQr({ ...live, outcome: "mismatch" });
            return;
          }
          if (result.settled) {
            stop();
            await recordPayment(result);
          }
        } catch {
          // One failed poll is a bad second of signal, not a failed payment.
          // The next tick asks again, which is sooner than an attendant could
          // finish reading a banner about it.
        }
      };

      const start = () => {
        if (!stopped) timer ??= setInterval(() => void tick(), QR_POLL_MS);
      };

      const subscription = AppState.addEventListener("change", (next) => {
        if (next !== "active") {
          pause();
          return;
        }
        // Catch up before resuming the interval: the driver may well have paid
        // while the handset was in a pocket.
        void tick();
        start();
      });

      start();

      return () => {
        subscription.remove();
        stop();
      };
    }, [live, recordPayment]),
  );

  /**
   * The code the teardown has to close, in a ref so the cleanup below sees
   * whichever one is live at unmount rather than the one that was live when
   * the effect first ran.
   */
  const liveQrRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    liveQrRef.current = live?.paymentId ?? null;
  }, [live]);

  /**
   * Walking away from a live code is how one fare gets paid twice: the
   * attendant takes cash, leaves, and the photograph somebody took of the
   * screen is still payable for another ten minutes.
   *
   * Fire and forget, because there is no screen left to report to. If the
   * driver did pay in the meantime the server says so and leaves the capture
   * alone — closing a paid code is refused there, not here.
   */
  React.useEffect(
    () => () => {
      const paymentId = liveQrRef.current;
      liveQrRef.current = null;
      if (paymentId) void api.payments.closeQr(paymentId).catch(() => {});
    },
    [],
  );

  /**
   * The attendant backs out — the driver would rather pay cash, or has given
   * up on the code. The close is the point of this, for the reason above.
   *
   * A close that answers `paid` means the driver got there in the gap between
   * the last poll and this call. That is a collection, and calling it a
   * cancellation would send an attendant to collect a fare twice.
   */
  async function backOutOfUpi() {
    const closing = live;
    setQr(null);
    setMode("CASH");
    if (!closing) return;

    setBusy(true);
    try {
      const result = await api.payments.closeQr(closing.paymentId);
      if (result.paid) await recordPayment(result);
    } catch (cause) {
      // Leave the teardown pointed at it, so leaving the screen tries the
      // close once more rather than abandoning a code that is still payable.
      liveQrRef.current = closing.paymentId;
      setError(
        cause instanceof ApiError
          ? cause.message
          : "The code could not be closed. Check it has not been paid before taking cash.",
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

  /**
   * How long the vehicle has been parked.
   *
   * Counted on this handset from the `startAt` the server recorded, so the
   * figure moves while somebody is looking at it instead of sitting frozen at
   * whatever it was when the screen opened. Once the session has ended the
   * server's `durationMinutes` stands, because that is the figure the fare was
   * priced on. An end that queued has no server duration yet, so the locally
   * recorded `endAt` fills in until it syncs.
   */
  const parkedMinutes = running
    ? (elapsedMinutesSince(session.startAt, now) ?? session.elapsedMinutes ?? null)
    : (session.durationMinutes ??
      (session.endAt ? elapsedMinutesSince(session.startAt, Date.parse(session.endAt)) : null));

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
          <Stat label="Parked for" value={formatDuration(parkedMinutes)} />
          <Stat label="Since" value={formatTime(session.startAt)} />
          {/*
            Shown only when there is one. Zones with no bays recorded, and every
            session started before bays were allocated at all, have nothing to
            put here — and a "Bay —" on all of them would be noise the attendant
            reads past.
          */}
          {session.slot?.code ? <Stat label="Bay" value={session.slot.code} /> : null}
        </View>
        {running ? (
          <Text style={styles.clockNote}>
            Counting up on this handset from the start time the server recorded.
          </Text>
        ) : null}
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
          {qr ? (
            /* --------------------------------- the code, while there is one */
            <Card>
              <Text style={styles.sectionLabel}>UPI</Text>
              {qr.outcome === null ? (
                <>
                  {/*
                    A light panel under it, deliberately: everything else on
                    this screen is dark, and a dark code on a dark ground is
                    one no camera will read.
                  */}
                  <View style={styles.qrPanel}>
                    <Image
                      source={{ uri: qr.imageUrl }}
                      style={styles.qrImage}
                      resizeMode="contain"
                      accessibilityRole="image"
                      accessibilityLabel={`UPI code for ${formatMoney(qr.amount)}`}
                    />
                  </View>
                  {/* The server's figure, not one worked out again here. */}
                  <Text style={styles.qrAmount}>{formatMoney(qr.amount)}</Text>
                  <Text style={styles.qrNote}>
                    Have the driver scan this with any UPI app. The amount is already in the code,
                    so they cannot pay the wrong one. This screen shows the receipt by itself once
                    the money lands — do not take cash as well.
                  </Text>
                </>
              ) : qr.outcome === "expired" ? (
                <>
                  <Banner
                    tone="warning"
                    title="This code has expired"
                    body="Nothing was paid against it and nothing can be now. Show a fresh one, or take cash."
                  />
                  <Button
                    label={`Show a new code for ${formatMoney(qr.amount)}`}
                    onPress={() => void collectUpi()}
                    busy={busy}
                  />
                </>
              ) : (
                <Banner
                  tone="danger"
                  title="The amount paid does not match the fare"
                  body={`The gateway reported something other than the ${formatMoney(qr.amount)} owed, so nothing was captured and there is no receipt. This is not paid — it has to be sorted out with your supervisor before the vehicle is released.`}
                />
              )}
              <Button
                label="Take cash instead"
                variant="secondary"
                size="medium"
                onPress={() => void backOutOfUpi()}
                disabled={busy}
              />
            </Card>
          ) : owed && owed > 0 ? (
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
  // Wraps, because a third figure appeared here once bays were allocated and a
  // long bay code on a narrow handset would otherwise run off the card.
  stats: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.space(4),
    marginTop: theme.space(0.5),
  },
  clockNote: { ...theme.text.small, color: theme.colour.textMuted },
  zone: { ...theme.text.body, color: theme.colour.textMuted },
  sectionLabel: { ...theme.text.label, color: theme.colour.textMuted },
  // White, and otherwise the card every other section uses — the dark border is
  // what gives a white panel an edge against this background. Its padding is
  // white space around the code on top of the quiet zone the gateway draws into
  // the image, which together come to roughly the three clear modules a scanner
  // wants.
  qrPanel: {
    backgroundColor: "#FFFFFF",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colour.border,
    padding: theme.space(2),
    alignItems: "center",
  },
  // Square, and as wide as the card allows. This is held out at arm's length
  // to somebody else's camera in Kolkata sun; a code sized to sit politely in
  // the layout is a code that has to be scanned twice.
  qrImage: { width: "100%", aspectRatio: 1, maxWidth: 320 },
  qrAmount: { ...theme.text.display, color: theme.colour.text, textAlign: "center" },
  qrNote: { ...theme.text.small, color: theme.colour.textMuted },
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
