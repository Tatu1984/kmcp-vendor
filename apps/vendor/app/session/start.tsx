import * as React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  ApiError,
  formatPlate,
  normalisePlate,
  resolveZone,
  type CachedZone,
  type Slot,
  type SlotType,
} from "@kmcp/api";

import { Banner, Button, Card, Field, Loading, Pill } from "../../components/ui";
import { PlateCamera, type Capture } from "../../components/plate-camera";
import { api, cache } from "../../lib/api";
import { useLocation } from "../../lib/location";
import { useSession } from "../../lib/session";
import { theme } from "../../lib/theme";

const VEHICLE_LABELS: Record<SlotType, string> = {
  TWO_WHEELER: "Two-wheeler",
  THREE_WHEELER: "Auto",
  CAR: "Car",
  EV: "Electric",
  COMMERCIAL: "Commercial",
  BUS: "Bus",
  TRUCK: "Truck",
  VIP: "VIP",
  GOVERNMENT: "Government",
  ACCESSIBLE: "Accessible",
};

/**
 * The zone's bays, or the reason there are none to offer.
 *
 * Three states rather than a list and a loading flag, because "still looking",
 * "the list could not be fetched" and "the list came back empty" lead to three
 * different sentences on screen and only one of them may hold the start button.
 * `null` means no zone has resolved yet, so nothing has been asked for.
 */
type BayList =
  | { status: "loading" }
  | { status: "unavailable"; because: string }
  | { status: "ready"; bays: Slot[] };

/**
 * Bays in the order they are painted.
 *
 * The server sorts `code` as a byte comparison, which runs A1, A10, A2 — a grid
 * in that order is unreadable beside a kerb where the numbers go up. The code is
 * the only spatial information a bay carries, so this is the whole of the layout.
 */
const byCode = (a: Slot, b: Slot) => a.code.localeCompare(b.code, "en", { numeric: true });

/**
 * Starting a session.
 *
 * Five things in one screen because a driver is waiting: where you are, what
 * the plate says, what kind of vehicle it is, which bay it goes in, and a
 * photograph. The zone is resolved from GPS rather than chosen, so an attendant
 * cannot accidentally book a car into the zone next door where the tariff is
 * different. The bay is the opposite — picked, not assigned, because the person
 * standing on the kerb can see which space the vehicle actually fits in and the
 * server cannot.
 *
 * Nothing here computes a price. The server prices it, refuses it, or accepts
 * it — this screen only reports what was observed.
 */
export default function StartSession() {
  const router = useRouter();
  const { shift, refreshShift } = useSession();
  const location = useLocation();

  const [zone, setZone] = React.useState<CachedZone | null>(null);
  const [zoneOffline, setZoneOffline] = React.useState(false);
  /**
   * Why there is no zone on screen. Two different failures wear it: standing
   * outside every zone, and the server refusing to say — a 403, a closed
   * route, a validation error. They get different titles because the first is
   * fixed by walking and the second is not.
   */
  const [zoneError, setZoneError] = React.useState<{ title: string; body: string } | null>(null);
  const [plate, setPlate] = React.useState("");
  const [vehicleType, setVehicleType] = React.useState<SlotType>("CAR");
  const [bayList, setBayList] = React.useState<BayList | null>(null);
  const [slotId, setSlotId] = React.useState<string | null>(null);
  const [capture, setCapture] = React.useState<Capture | null>(null);
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  /**
   * Which bay fetch is the current one.
   *
   * The zone re-resolves on every new GPS fix, and a slow reply for the zone
   * the attendant has walked out of must not land on top of the one they are
   * standing in — they would be offered bays from the wrong kerb, and the
   * server accepts whatever bay it is sent.
   */
  const bayRequest = React.useRef(0);

  const loadBays = React.useCallback(async (zoneId: string, resolvedOffline: boolean) => {
    const ticket = (bayRequest.current += 1);
    const settle = (next: BayList) => {
      if (bayRequest.current === ticket) setBayList(next);
    };

    if (resolvedOffline) {
      // The zone itself came from the cache, so the server could not be reached
      // seconds ago. Bays are deliberately not cached — occupancy changes by
      // the minute and a stale bay map would hand out a space somebody is
      // parked in — and spending twenty seconds of request timeout to discover
      // there is still no signal is time the driver waits for nothing.
      settle({
        status: "unavailable",
        because:
          "There is no signal, and bays are not held on this handset — a stale bay map would send a vehicle into a space that is taken.",
      });
      return;
    }

    settle({ status: "loading" });
    try {
      // Every bay, not only the free ones. The vehicle chips above can change
      // after this lands, and telling "no bays recorded for a car" apart from
      // "every car bay is taken" means counting the taken ones.
      const found = await api.slots.list(zoneId);
      settle({ status: "ready", bays: [...found].sort(byCode) });
    } catch (cause) {
      settle({
        status: "unavailable",
        because:
          cause instanceof ApiError ? cause.message : "The bays in this zone could not be listed.",
      });
    }
  }, []);

  // Resolve the zone as soon as there is a fix. The attendant should find the
  // answer already on screen when they look up from the number plate.
  React.useEffect(() => {
    if (location.status !== "ready") return;
    let cancelled = false;

    void (async () => {
      try {
        // Asks the server, and falls back to the same geometry against cached
        // boundaries only when it cannot be reached. Either way the server
        // re-checks this when the session syncs.
        const resolved = await resolveZone(api, cache, location.fix.lat, location.fix.lng);
        if (cancelled) return;

        if (!resolved) {
          setZoneError({
            title: "Not in a parking zone",
            body: "You are not inside any zone you are assigned to. Move to the kerb you are working.",
          });
          // Bumped rather than merely cleared, so a bay fetch still in flight
          // for the zone we have just left cannot repopulate the picker.
          bayRequest.current += 1;
          setBayList(null);
          return;
        }

        setZone(resolved.zone);
        setZoneOffline(resolved.offline);
        setZoneError(null);
        void loadBays(resolved.zone.id, resolved.offline);

        const allowed = resolved.zone.allowedVehicleTypeIds ?? [];
        // Default to the commonest permitted type rather than to CAR, which a
        // two-wheeler-only lane would refuse.
        if (allowed.length > 0 && !allowed.includes("CAR")) setVehicleType(allowed[0]);
      } catch (cause) {
        if (cancelled) return;
        // The server answered and said no. Its words are the honest ones —
        // "outside every zone assigned to you", "not permitted" — and none of
        // them is "no signal", so the cache is not consulted.
        setZone(null);
        setZoneOffline(false);
        setZoneError({
          title: "The server could not place you",
          body: cause instanceof ApiError ? cause.message : "Could not work out which zone you are in.",
        });
        bayRequest.current += 1;
        setBayList(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [location.status, location.status === "ready" ? location.fix.lat : 0, location.status === "ready" ? location.fix.lng : 0, loadBays]);

  const normalised = normalisePlate(plate);
  const plateLooksRight = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(normalised);
  const allowedTypes = zone?.allowedVehicleTypeIds?.length
    ? zone.allowedVehicleTypeIds
    : (Object.keys(VEHICLE_LABELS) as SlotType[]);

  const bays = bayList?.status === "ready" ? bayList.bays : null;

  /**
   * The bays of the type on screen, and of those the ones actually free.
   *
   * Filtered on the handset rather than asked of the server, because the
   * vehicle chips change after the fetch has landed and a refetch per chip tap
   * is a request the attendant waits on to see a list already in hand.
   *
   * AVAILABLE is not decoration here. The server takes `slotId` on trust and
   * flips that bay to OCCUPIED without checking it was free, so offering a bay
   * that already holds a vehicle would overwrite its record — and then release
   * the bay the moment the *other* session ended, with a car still in it.
   */
  const baysOfType = React.useMemo(
    () => (bays ?? []).filter((bay) => bay.type === vehicleType),
    [bays, vehicleType],
  );
  const freeBays = React.useMemo(
    () => baysOfType.filter((bay) => bay.status === "AVAILABLE"),
    [baysOfType],
  );

  /**
   * Drops a bay the current vehicle type cannot use.
   *
   * The type can be corrected after a bay has been picked, and a two-wheeler
   * bay left selected under CAR would be sent as `slotId` and accepted — the
   * server does not check the bay against the vehicle. Also covers a bay that
   * stopped being free between the fetch and the tap.
   */
  React.useEffect(() => {
    setSlotId((current) => (current && freeBays.some((bay) => bay.id === current) ? current : null));
  }, [freeBays]);

  /**
   * A zone is on screen but its bays are not settled yet.
   *
   * `null` and "loading" are folded together deliberately: both mean the answer
   * is not in, and keeping them apart left a gap in which an unfetched list
   * would have been reported as "no bays recorded here" — a sentence that would
   * have been a lie and would have let the start through without a bay.
   */
  const baysPending = Boolean(zone) && (bayList === null || bayList.status === "loading");

  /**
   * A bay is required only when there is one to require.
   *
   * Many zones have fewer bays mapped than their priced capacity, and some have
   * none at all — the server reports bays and active sessions as separate counts
   * for exactly that reason. A zone with no free bay of this type still has to
   * be workable, so the requirement follows the list rather than the product's
   * wish for one.
   */
  const bayRequired = freeBays.length > 0;
  const canStart =
    Boolean(zone) &&
    plateLooksRight &&
    !busy &&
    !baysPending &&
    (!bayRequired || slotId !== null);

  async function start() {
    if (!zone) return;
    setBusy(true);
    setError(null);

    try {
      // The photograph is uploaded first so the session carries its evidence id
      // from the moment it exists. If the upload fails the session still starts
      // — a car parked with no picture is a gap in the record, but a car parked
      // with no session is lost revenue and an argument at the exit.
      let evidenceMediaId: string | undefined;
      if (capture) {
        try {
          const media = await api.media.upload(capture.uri, "SESSION_EVIDENCE_START");
          evidenceMediaId = media.id;
        } catch {
          setError("The photograph could not be uploaded. Starting without it.");
        }
      }

      const session = await api.sessions.start({
        zoneId: zone.id,
        plateNumber: normalised,
        vehicleType,
        location: location.status === "ready" ? { lat: location.fix.lat, lng: location.fix.lng } : undefined,
        evidenceMediaId,
        // Absent rather than null when no bay was allocated: the start schema
        // takes an optional string, and a zone with no bays recorded must send
        // nothing at all rather than a field the server has to interpret.
        slotId: slotId ?? undefined,
      });

      await refreshShift();

      if (session) {
        router.replace(`/session/${session.code}`);
      } else {
        // Queued: there is no session code yet because the server has not seen
        // it. Say so plainly rather than inventing one.
        router.replace("/(tabs)");
      }
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Could not start the session. Try again.",
      );
      setBusy(false);
    }
  }

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {!shift ? (
        <Banner
          tone="warning"
          title="You are not on shift"
          body="You can still start a session, but the cash will not be reconciled against a shift."
        />
      ) : null}

      {/* --------------------------------------------------------- where */}
      {location.status === "locating" || (location.status === "ready" && !zone && !zoneError) ? (
        <Loading label="Finding which zone you are in…" />
      ) : location.status === "denied" ? (
        <Banner
          tone="danger"
          title="Location is switched off"
          body="A session can only be started inside the zone it is for, so the handset has to know where it is."
        />
      ) : zoneError ? (
        <Banner tone="danger" title={zoneError.title} body={zoneError.body} />
      ) : zone ? (
        <Card>
          <Text style={styles.zoneLabel}>YOU ARE IN</Text>
          <Text style={styles.zoneName}>{zone.name}</Text>
          <View style={styles.zoneMeta}>
            {zone.available !== undefined ? (
              <Pill
                tone={
                  zone.availability === "FULL"
                    ? "danger"
                    : zone.availability === "LIMITED"
                      ? "warning"
                      : "success"
                }
                label={`${zone.available} of ${zone.capacity} free`}
              />
            ) : (
              <Pill tone="default" label={`${zone.capacity} bays`} />
            )}
            <Text style={styles.zoneHours}>
              Open {zone.openTime}–{zone.closeTime}
            </Text>
          </View>
          {zoneOffline ? (
            <Text style={styles.zoneOffline}>
              Worked out on this handset — there is no signal. The server checks it again when this
              session syncs.
            </Text>
          ) : null}
        </Card>
      ) : null}

      {(location.status === "denied" || location.status === "failed" || zoneError) && (
        <Button label="Try again" variant="secondary" onPress={() => void location.locate()} />
      )}

      {/* --------------------------------------------------------- plate */}
      <Field
        label="Number plate"
        value={plate}
        onChangeText={setPlate}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="WB 02 AB 1234"
        maxLength={14}
        editable={!busy}
        style={styles.plateInput}
        hint={plateLooksRight ? formatPlate(normalised) : "As written on the vehicle"}
        error={plate.length > 3 && !plateLooksRight ? "That does not look like a plate yet" : undefined}
      />

      {/* -------------------------------------------------- vehicle type */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>VEHICLE</Text>
        <View style={styles.chips}>
          {allowedTypes.map((type) => {
            const selected = type === vehicleType;
            return (
              <Pressable
                key={type}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                onPress={() => setVehicleType(type)}
                disabled={busy}
                style={({ pressed }) => [
                  styles.chip,
                  selected && styles.chipSelected,
                  pressed && styles.chipPressed,
                ]}
              >
                <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>
                  {VEHICLE_LABELS[type] ?? type}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* ------------------------------------------------------------- bay */}
      {zone ? (
        <View style={styles.section}>
          <View style={styles.bayHead}>
            <Text style={styles.sectionLabel}>BAY</Text>
            {baysOfType.length > 0 ? (
              <Text style={styles.bayCount}>
                {freeBays.length} free of {baysOfType.length}
              </Text>
            ) : null}
          </View>

          {baysPending ? (
            <Text style={styles.bayNote}>Finding which bays are free…</Text>
          ) : bayList?.status === "unavailable" ? (
            <>
              <Banner
                tone="warning"
                title="No bay list for this zone"
                body={`${bayList.because} Start the session without one — the vehicle is booked to the zone, which is what the server checks anyway.`}
              />
              {/*
                Asks the network even when the zone itself came from the cache:
                the signal may have returned in the seconds since, and this is
                the only way back to a bay list short of walking out of the zone
                and back in.
              */}
              <Button
                label="Look for bays again"
                variant="secondary"
                size="medium"
                onPress={() => void loadBays(zone.id, false)}
                disabled={busy}
              />
            </>
          ) : bays && bays.length === 0 ? (
            <Banner
              tone="info"
              title="This zone has no numbered bays"
              body="Its capacity is priced and enforced without them — many kerbs have never been surveyed and painted. Start the session; the vehicle is booked to the zone rather than to a bay."
            />
          ) : baysOfType.length === 0 ? (
            <Banner
              tone="info"
              title={`No ${VEHICLE_LABELS[vehicleType] ?? vehicleType} bay is recorded here`}
              body="The bays mapped in this zone are for other vehicle types. Start the session; the vehicle is booked to the zone rather than to a bay."
            />
          ) : freeBays.length === 0 ? (
            <Banner
              tone="warning"
              title={`Every ${VEHICLE_LABELS[vehicleType] ?? vehicleType} bay here is taken`}
              body={`All ${baysOfType.length} are occupied, reserved or out of service. You can still start the session — what the server refuses on is the zone being full, not its bay map.`}
            />
          ) : (
            <>
              <View style={styles.bayGrid}>
                {freeBays.map((bay) => (
                  <BayCell
                    key={bay.id}
                    bay={bay}
                    selected={bay.id === slotId}
                    disabled={busy}
                    onPress={() => setSlotId(bay.id)}
                  />
                ))}
              </View>
              {freeBays.some((bay) => bay.isReserved) ? (
                <Text style={styles.bayNote}>
                  A bay marked RESERVED is empty now but set aside in the zone's records. Nothing
                  refuses it — look at the kerb before putting a casual vehicle in one.
                </Text>
              ) : null}
            </>
          )}
        </View>
      ) : null}

      {/* ---------------------------------------------------- photograph */}
      <Button
        label={capture ? "Photograph taken — retake" : "Photograph the plate"}
        variant={capture ? "success" : "secondary"}
        size="medium"
        onPress={() => setCameraOpen(true)}
        disabled={busy}
      />

      {error ? <Banner tone="warning" title={error} /> : null}

      {/*
        Why the button is not ready, said out loud. A start button that is
        simply grey teaches an attendant to tap it twice and then restart the
        app; the requirement to pick a bay is a product decision, so it is
        worth a sentence.
      */}
      {baysPending ? (
        <Text style={styles.requirement}>Checking which bays are free before this can start.</Text>
      ) : bayRequired && !slotId ? (
        <Text style={styles.requirement}>Pick a bay above before starting.</Text>
      ) : null}

      <View style={styles.actions}>
        <Button label="Start parking" onPress={() => void start()} disabled={!canStart} busy={busy} />
        <Button
          label="Cancel"
          variant="secondary"
          size="medium"
          onPress={() => router.back()}
          disabled={busy}
        />
      </View>

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

/**
 * One free bay, as a button.
 *
 * The code is the whole label because the code is what is painted on the
 * ground — the id is a cuid nobody can read off a kerb — and it is what the
 * attendant will say to the driver. Sized like every other target in this app:
 * tapped in a hurry, outdoors, sometimes through gloves.
 */
function BayCell({
  bay,
  selected,
  disabled,
  onPress,
}: {
  bay: Slot;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`Bay ${bay.code}${bay.isReserved ? ", marked reserved" : ""}`}
      accessibilityState={{ selected, disabled: Boolean(disabled) }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.bay,
        selected && styles.baySelected,
        pressed && !disabled && styles.chipPressed,
      ]}
    >
      <Text
        style={[styles.bayCode, selected && styles.bayCodeSelected]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {bay.code}
      </Text>
      {bay.isReserved ? (
        <Text style={[styles.bayFlag, selected && styles.bayFlagSelected]}>RESERVED</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.colour.bg },
  content: { padding: theme.space(2), gap: theme.space(1.5), paddingBottom: theme.space(6) },
  zoneLabel: { ...theme.text.label, color: theme.colour.textMuted },
  zoneName: { ...theme.text.title, color: theme.colour.text },
  zoneMeta: { flexDirection: "row", alignItems: "center", gap: theme.space(1), flexWrap: "wrap" },
  zoneHours: { ...theme.text.small, color: theme.colour.textMuted },
  zoneOffline: { ...theme.text.small, color: theme.colour.warning },
  plateInput: { fontSize: 30, fontWeight: "700", letterSpacing: 2, minHeight: 72 },
  section: { gap: theme.space(1) },
  sectionLabel: { ...theme.text.label, color: theme.colour.textMuted },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(1) },
  chip: {
    minHeight: theme.minTouch,
    paddingHorizontal: theme.space(2),
    justifyContent: "center",
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colour.border,
    backgroundColor: theme.colour.surface,
  },
  chipSelected: { backgroundColor: theme.colour.primary, borderColor: theme.colour.primary },
  chipPressed: { opacity: 0.8 },
  chipLabel: { ...theme.text.body, color: theme.colour.textMuted },
  chipLabelSelected: { color: theme.colour.primaryText, fontWeight: "700" },

  bayHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  bayCount: { ...theme.text.small, color: theme.colour.textMuted },
  bayNote: { ...theme.text.small, color: theme.colour.textMuted },
  bayGrid: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(1) },
  bay: {
    // Four across, not the six the citizen app uses for its read-only grid: a
    // sixth of the width is legible on a phone held at reading distance and not
    // through gloves in Kolkata sun. Four cells and the three gaps between them
    // fit one row on the narrowest handset, so the last one never wraps alone.
    flexBasis: "22.5%",
    flexGrow: 0,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colour.border,
    backgroundColor: theme.colour.surface,
  },
  baySelected: { backgroundColor: theme.colour.primary, borderColor: theme.colour.primary },
  bayCode: { fontSize: 19, fontWeight: "700", color: theme.colour.text },
  bayCodeSelected: { color: theme.colour.primaryText },
  bayFlag: { ...theme.text.small, fontSize: 10, letterSpacing: 0.4, color: theme.colour.warning },
  bayFlagSelected: { color: theme.colour.primaryText },
  requirement: { ...theme.text.small, color: theme.colour.warning },

  actions: { gap: theme.space(1), marginTop: theme.space(1) },
});
