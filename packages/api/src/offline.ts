import type { Api } from "./endpoints";
import type { OfflineCache } from "./cache";
import { ApiError } from "./client";
import { estimateFare, type ProvisionalQuote } from "./fare";
import { gapOf } from "./gaps";
import { distanceMetres, withinZone } from "./geo";
import type { CachedZone, SlotType } from "./types";

/**
 * Working without signal.
 *
 * Three jobs, and one rule shared by all of them: the server's answer is used
 * whenever the server can be reached, and the cached answer is a clearly
 * labelled substitute when it cannot. Nothing here ever overrides a reply that
 * actually arrived.
 */

/**
 * Fills the cache with everything needed to work through an outage.
 *
 * `failed` names each piece that could not be fetched — "zones", "holidays",
 * or "tariff:<zone code>:<vehicle type>" — so the caller can say which. A
 * cache that is three rate cards short looks identical to a full one from the
 * outside; the attendant finds out at a kerb with no signal, which is the one
 * place they cannot do anything about it.
 */
export async function primeCache(
  api: Api,
  cache: OfflineCache,
  vehicleTypes: SlotType[] = ["CAR", "TWO_WHEELER", "THREE_WHEELER"],
): Promise<{ zones: number; tariffs: number; failed: string[] }> {
  await cache.load();
  const failed: string[] = [];

  let zones: CachedZone[] = [];
  try {
    zones = await api.zones.assigned();
    await cache.putZones(zones);
  } catch {
    failed.push("zones");
    zones = cache.get().zones;
  }

  try {
    await cache.putHolidays(await api.tariffs.holidays());
  } catch {
    // The calendar is the least damaging thing to miss — a holiday rate not
    // applied is a small under-charge, and `estimateFare` says so out loud.
    failed.push("holidays");
  }

  // One rate card per open zone and the vehicle types actually seen at a kerb.
  // Fetched sequentially rather than in parallel: this runs while an attendant
  // is standing still with signal, and hammering the API from a hundred
  // handsets at shift change is a worse problem than taking a few seconds.
  let tariffs = 0;
  for (const zone of zones.filter((z) => z.status === "OPEN")) {
    for (const vehicleType of vehicleTypes) {
      if (zone.allowedVehicleTypeIds?.length && !zone.allowedVehicleTypeIds.includes(vehicleType)) {
        continue;
      }
      try {
        const tariff = await api.tariffs.applicable(zone.id, vehicleType);
        await cache.putTariff(zone.id, vehicleType, {
          ...tariff,
          fetchedAt: new Date().toISOString(),
        });
        tariffs += 1;
      } catch {
        failed.push(`tariff:${zone.code}:${vehicleType}`);
      }
    }
  }

  await cache.markPrimed();
  return { zones: zones.length, tariffs, failed };
}

export interface ResolvedZone {
  zone: CachedZone;
  /** True when this came from the cache rather than from the server. */
  offline: boolean;
  alternatives: { id: string; code: string; name: string }[];
}

/**
 * Which zone the handset is standing in, asking the server first.
 *
 * The cache answers only when the server could not be reached — a dead
 * connection, a timeout, or a server that fell over before answering. A
 * server that answered and refused is a different thing entirely: a 403 means
 * this handset may not ask, a 404 means the route is not there, a 422 means
 * "you are outside every zone", and every one of those is rethrown so the
 * screen shows the real reason. Dressing a refusal up as "no signal" and
 * answering from the cache would have the handset overriding a reply that
 * actually arrived, which is the one thing this module promises never to do.
 *
 * The offline path runs the server's own geometry against cached boundaries
 * and, like the server, takes the nearest centre when more than one zone
 * matches. It is no more permissive than the server would be, so a session it
 * allows is one the server will accept when it syncs — the alternative,
 * guessing generously, would queue work destined to be rejected after the
 * cash was taken. What it cannot match is the server's zone scope: the cache
 * holds the zones this attendant was assigned when it was primed, and an
 * assignment that changed since is only known once there is signal again.
 */
export async function resolveZone(
  api: Api,
  cache: OfflineCache,
  lat: number,
  lng: number,
): Promise<ResolvedZone | null> {
  try {
    const live = await api.zones.resolve(lat, lng);
    return {
      zone: live as unknown as CachedZone,
      offline: false,
      alternatives: live.alternatives ?? [],
    };
  } catch (error) {
    if (gapOf(error) !== null) throw error;
    const unreachable = !(error instanceof ApiError) || error.isRetryable;
    if (!unreachable) throw error;
    // Fall through: the server was never reached, so the cache is the best
    // answer there is.
  }

  const point = { lat, lng };
  const { zones, geofenceToleranceM } = await cache.load();
  const matches = zones
    .filter((z) => z.status === "OPEN")
    .filter((z) =>
      withinZone(point, z.boundary, { lat: z.centerLat, lng: z.centerLng }, geofenceToleranceM),
    )
    .map((zone) => ({
      zone,
      distance: distanceMetres(point, { lat: zone.centerLat, lng: zone.centerLng }),
    }))
    .sort((a, b) => a.distance - b.distance)
    .map((m) => m.zone);

  const nearest = matches[0];
  if (!nearest) return null;
  return {
    zone: nearest,
    offline: true,
    alternatives: matches.slice(1, 4).map((z) => ({ id: z.id, code: z.code, name: z.name })),
  };
}

/**
 * What to charge when the server could not price it.
 *
 * Returns null when there is no cached rate card for this zone and vehicle —
 * in which case the attendant genuinely cannot quote a figure, and the app must
 * say so rather than invent one.
 */
export async function provisionalFare(
  cache: OfflineCache,
  input: {
    zoneId: string;
    vehicleType: SlotType;
    startAt: Date;
    endAt: Date;
    overstayAfterMinutes?: number;
  },
): Promise<ProvisionalQuote | null> {
  const contents = await cache.load();
  const tariff = cache.tariff(input.zoneId, input.vehicleType);
  if (!tariff) return null;

  return estimateFare({
    tariff,
    startAt: input.startAt,
    endAt: input.endAt,
    zoneId: input.zoneId,
    holidays: contents.holidays,
    overstayAfterMinutes: input.overstayAfterMinutes,
  });
}
