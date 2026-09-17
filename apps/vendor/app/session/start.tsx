import * as React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  ApiError,
  formatPlate,
  normalisePlate,
  resolveZone,
  type CachedZone,
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
 * Starting a session.
 *
 * Four things in one screen because a driver is waiting: where you are, what
 * the plate says, what kind of vehicle it is, and a photograph. The zone is
 * resolved from GPS rather than chosen, so an attendant cannot accidentally
 * book a car into the zone next door where the tariff is different.
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
  const [capture, setCapture] = React.useState<Capture | null>(null);
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

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
          return;
        }

        setZone(resolved.zone);
        setZoneOffline(resolved.offline);
        setZoneError(null);

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
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [location.status, location.status === "ready" ? location.fix.lat : 0, location.status === "ready" ? location.fix.lng : 0]);

  const normalised = normalisePlate(plate);
  const plateLooksRight = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(normalised);
  const allowedTypes = zone?.allowedVehicleTypeIds?.length
    ? zone.allowedVehicleTypeIds
    : (Object.keys(VEHICLE_LABELS) as SlotType[]);

  const canStart = Boolean(zone) && plateLooksRight && !busy;

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

      {/* ---------------------------------------------------- photograph */}
      <Button
        label={capture ? "Photograph taken — retake" : "Photograph the plate"}
        variant={capture ? "success" : "secondary"}
        size="medium"
        onPress={() => setCameraOpen(true)}
        disabled={busy}
      />

      {error ? <Banner tone="warning" title={error} /> : null}

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
  actions: { gap: theme.space(1), marginTop: theme.space(1) },
});
