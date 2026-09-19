import type { ApiClient } from "./client";
import type { OfflineQueue } from "./queue";
import { newEventId } from "./queue";
import type {
  CachedHoliday,
  CachedTariff,
  CachedZone,
  EndedSession,
  LoginResponse,
  Media,
  MediaPurpose,
  Payment,
  PlateLookup,
  Session,
  Shift,
  Slot,
  SlotStatus,
  SlotSummary,
  SlotType,
  UploadTicket,
  VerifyPayment,
  Zone,
} from "./types";

/**
 * Every call the attendant app makes.
 *
 * The ones that change something go through the queue; the ones that only read
 * go straight out, because stale reads are cheap and a queued read is useless.
 *
 * Nothing here is wired for a screen that does not exist. This package was
 * once shared with the citizen app and carried its half-built routes; that app
 * now lives in its own repository with its own copy, and the residue was
 * removed rather than left as a second source of drift.
 */

/**
 * The largest page the API will answer.
 *
 * `PaginationSchema` caps `pageSize` at 100 and returns 400 above it — not a
 * clamped list, a refusal. Three call sites here asked for 200 and 500 and got
 * a validation error every time, which is why the offline zone cache was
 * quietly never priming.
 */
const MAX_PAGE_SIZE = 100;

/**
 * Walks a paginated endpoint to the end.
 *
 * The client returns `data` and drops `meta`, so there is no `total` to stop
 * on; a short page is the signal that there are no more. `limit` is a guard
 * against a runaway loop rather than a real expectation — nothing here should
 * approach it.
 */
async function fetchAll<T>(
  fetchPage: (page: number, pageSize: number) => Promise<T[]>,
  limit = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; rows.length < limit; page++) {
    const batch = await fetchPage(page, MAX_PAGE_SIZE);
    rows.push(...batch);
    if (batch.length < MAX_PAGE_SIZE) break;
  }
  return rows.length > limit ? rows.slice(0, limit) : rows;
}

export function createApi(client: ApiClient, queue: OfflineQueue) {
  return {
    auth: {
      loginWithPhone: (phone: string, password: string, deviceFingerprint: string) =>
        client.post<LoginResponse>(
          "/auth/login",
          { phone, password, deviceFingerprint, platform: "android" },
          { anonymous: true },
        ),

      /**
       * Completes a sign-in that `loginWithPhone` answered with
       * `two_factor_required`.
       *
       * Anonymous like the login itself: there is no token yet, the challenge
       * id is what ties this to the password that was just accepted. The
       * device fingerprint is not resent — the server kept it with the
       * challenge, so the binding it makes is to the handset that entered the
       * password, not to whichever one enters the code.
       */
      verifyTwoFactor: (challengeId: string, code: string) =>
        client.post<LoginResponse>(
          "/auth/two-factor/verify",
          { challengeId, code },
          { anonymous: true },
        ),

      me: () => client.get<Record<string, unknown>>("/auth/me"),

      logout: (refreshToken: string) =>
        client.post("/auth/logout", { refreshToken }, { anonymous: true }),
    },

    zones: {
      /**
       * Which zone the attendant is standing in.
       *
       * The server answers whenever it can be reached, and its answer is the
       * one that counts. Offline this falls back to the same geometry run
       * against cached boundaries — see `resolveZone` in `offline.ts`.
       */
      resolve: (lat: number, lng: number) =>
        client.get<Zone & { alternatives: { id: string; code: string; name: string }[] }>(
          "/zones/resolve",
          { query: { lat, lng } },
        ),

      /**
       * Every zone this attendant may work, with boundaries, for the cache.
       *
       * Paged. This asked for 200 in one request and the API refused it with a
       * 400 every time, so the offline cache was never actually primed — the
       * failure was invisible because `primeCache` treats a failed fetch as
       * "nothing to cache" rather than an error worth showing.
       */
      assigned: () =>
        fetchAll<CachedZone>((page, pageSize) =>
          client.get<CachedZone[]>("/zones", { query: { page, pageSize } }),
        ),
    },

    tariffs: {
      /** The rate card for a zone and vehicle type, cached for offline quoting. */
      applicable: (zoneId: string, vehicleType: SlotType) =>
        client.get<CachedTariff>("/tariffs/applicable", { query: { zoneId, vehicleType } }),

      holidays: () => client.get<CachedHoliday[]>("/holidays"),
    },

    sessions: {
      lookup: (plateNumber: string) =>
        client.get<PlateLookup>(`/sessions/plate/${encodeURIComponent(plateNumber)}`),

      /** One session by its human-quotable code, or its id. */
      get: (idOrCode: string) => client.get<Session>(`/sessions/${encodeURIComponent(idOrCode)}`),

      /**
       * Everything this attendant started since midnight, ended or not.
       *
       * The Today screen buckets these by hour. Asking the server for the day
       * and folding it here costs one request; asking per hour would cost ten
       * and still need folding. No status filter, so OVERSTAY rows are in the
       * count like any other.
       */
      today: (attendantId: string) => {
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        return fetchAll<Session>((page, pageSize) =>
          client.get<Session[]>("/sessions", {
            query: { attendantId, from: midnight.toISOString(), page, pageSize },
          }),
        );
      },

      /**
       * What this attendant has parked right now.
       *
       * Two requests, not one. A session that runs past the overstay threshold
       * is promoted from ACTIVE to OVERSTAY on the server, and the list route's
       * `status` filter takes exactly one value — so asking for ACTIVE alone
       * silently dropped every overstaying vehicle, which is precisely the set
       * the Kerb screen's overstay count exists to show. Asking with no filter
       * would return the day's completed sessions first and push a car parked
       * this morning off the page. A page of each live status keeps the server
       * doing the filtering and the list complete.
       */
      mine: async (attendantId: string) => {
        const [active, overstay] = await Promise.all([
          client.get<Session[]>("/sessions", {
            query: { attendantId, status: "ACTIVE", pageSize: MAX_PAGE_SIZE },
          }),
          client.get<Session[]>("/sessions", {
            query: { attendantId, status: "OVERSTAY", pageSize: MAX_PAGE_SIZE },
          }),
        ]);
        return [...active, ...overstay];
      },

      /**
       * Starts a session. Queued when offline — the clientEventId is what makes
       * a replay return the original session rather than a second charge.
       */
      start: (input: {
        zoneId: string;
        plateNumber: string;
        vehicleType: SlotType;
        location?: { lat: number; lng: number };
        evidenceMediaId?: string;
        slotId?: string;
      }) => {
        const id = newEventId();
        return queue.submit<Session>({
          id,
          kind: "session.start",
          path: "/sessions/start",
          body: { ...input, clientEventId: id, source: "ATTENDANT_APP", startedAt: new Date().toISOString() },
        });
      },

      end: (idOrCode: string, input: { location?: { lat: number; lng: number }; evidenceMediaId?: string } = {}) => {
        const id = newEventId();
        return queue.submit<EndedSession>({
          id,
          kind: "session.end",
          path: `/sessions/${idOrCode}/end`,
          body: { ...input, clientEventId: id, endedAt: new Date().toISOString() },
        });
      },
    },

    payments: {
      /** Cash captures immediately; the receipt comes back with it. */
      collectCash: (sessionId: string) => {
        const id = newEventId();
        return queue.submit<Payment>({
          id,
          kind: "payment.collect",
          path: "/payments/collect",
          body: { sessionId, mode: "CASH", idempotencyKey: id },
        });
      },

      collectDigital: (sessionId: string, mode: "UPI_QR" | "UPI_INTENT" | "CARD") => {
        const id = newEventId();
        // Not queued: a gateway order is worthless once the payer has walked
        // away, so this either happens now or does not happen.
        return client.post<Payment>("/payments/collect", {
          sessionId,
          mode,
          idempotencyKey: id,
        });
      },

      /**
       * Hands the gateway's signed result back so the server can capture it.
       *
       * The signature is computed with a secret this handset has never held,
       * which is what stops a forged "paid" from capturing anything. The
       * webhook remains the authority; this exists so the attendant sees a
       * receipt while the driver is still standing there rather than after
       * the webhook lands.
       */
      verify: (paymentId: string, input: VerifyPayment) =>
        client.post<Payment>(`/payments/${encodeURIComponent(paymentId)}/verify`, input),
    },

    slots: {
      /**
       * Bay counts for a zone. Read-only and cheap, so it is not queued — a
       * stale occupancy figure is useless and a queued one is worse.
       */
      summary: (zoneId: string) =>
        client.get<SlotSummary>(`/slots/summary/${encodeURIComponent(zoneId)}`),

      /**
       * The bays themselves, so an attendant can put a vehicle in a named one.
       *
       * Paged, for the reason at the top of this file: `pageSize` above 100 is
       * refused with a 400 rather than clamped. `sort` is sent rather than left
       * to the server's default, because paging a list whose order is only
       * implicit is how a bay comes back twice, or not at all.
       *
       * `status` and `type` are the server's own filters, offered because a
       * caller that wants only the free bays should not pay for the occupied
       * ones. The bay picker passes neither on purpose: it has to tell "no bays
       * recorded for a car" apart from "every car bay is taken", and that needs
       * the taken ones counted.
       */
      list: (zoneId: string, filter: { status?: SlotStatus; type?: SlotType } = {}) =>
        fetchAll<Slot>((page, pageSize) =>
          client.get<Slot[]>("/slots", {
            query: {
              zoneId,
              status: filter.status,
              type: filter.type,
              page,
              pageSize,
              sort: "code",
            },
          }),
        ),
    },

    shifts: {
      current: () => client.get<Shift | null>("/shifts/current"),

      open: (input: { zoneId?: string; location?: { lat: number; lng: number } } = {}) =>
        client.post<Shift>("/shifts/open", input),

      close: (id: string, cashDeposited: number, location?: { lat: number; lng: number }) => {
        const eventId = newEventId();
        return queue.submit<Shift>({
          id: eventId,
          kind: "shift.close",
          path: `/shifts/${id}/close`,
          body: { cashDeposited, location },
        });
      },
    },

    media: {
      /**
       * Uploads a photograph straight to storage.
       *
       * The bytes never pass through the API, which is what makes this survivable
       * on a bad connection — a 4 MB photograph fighting a function timeout is
       * how evidence gets lost.
       */
      upload: async (uri: string, purpose: MediaPurpose, mimeType = "image/jpeg") => {
        // Read the file before asking for a ticket, so the size sent is the
        // size that will actually be uploaded. The server rejects a zero, and a
        // caller guessing at the length of a photograph it has not opened is
        // exactly how that zero gets sent.
        const file = await fetch(uri);
        const blob = await file.blob();
        const sizeBytes = blob.size;
        if (!sizeBytes) throw new Error("The photograph is empty.");

        const ticket = await client.post<UploadTicket>("/media/uploads", {
          purpose,
          mimeType,
          sizeBytes,
        });

        const put = await fetch(ticket.uploadUrl, {
          method: ticket.method,
          headers: ticket.headers,
          body: blob,
        });
        if (!put.ok) throw new Error(`Storage rejected the photograph (${put.status}).`);

        return client.post<Media>("/media/uploads/confirm", {
          key: ticket.key,
          purpose,
          mimeType,
          sizeBytes,
          capturedAt: new Date().toISOString(),
        });
      },
    },
  };
}

export type Api = ReturnType<typeof createApi>;
