import type { ApiClient } from "./client";
import type { OfflineQueue } from "./queue";
import { newEventId } from "./queue";
import type {
  CachedHoliday,
  CachedTariff,
  CachedZone,
  CitizenProfile,
  EndedSession,
  Favourite,
  LoginResponse,
  Media,
  MediaPurpose,
  MyPass,
  MySession,
  MySpendSummary,
  MyVehicle,
  NearbyZone,
  OtpRequested,
  Paise,
  PassPlan,
  Payment,
  PlateLookup,
  Session,
  Shift,
  Slot,
  SlotSummary,
  SlotType,
  UploadTicket,
  WalletBalance,
  WalletEntry,
  WalletTopUp,
  Zone,
} from "./types";

/**
 * Every call the field apps make.
 *
 * The ones that change something go through the queue; the ones that only read
 * go straight out, because stale reads are cheap and a queued read is useless.
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
      login: (email: string, password: string, deviceFingerprint: string) =>
        client.post<LoginResponse>(
          "/auth/login",
          { email, password, deviceFingerprint, platform: "android" },
          { anonymous: true },
        ),

      loginWithPhone: (phone: string, password: string, deviceFingerprint: string) =>
        client.post<LoginResponse>(
          "/auth/login",
          { phone, password, deviceFingerprint, platform: "android" },
          { anonymous: true },
        ),

      me: () => client.get<Record<string, unknown>>("/auth/me"),

      /**
       * Sends a citizen a six-digit code by SMS.
       *
       * The only field the server accepts is the phone number — it normalises
       * to +91 itself, so there is no country code to send and no device to
       * name. Rate limited to five requests in five minutes per install, which
       * is why the screen that calls this shows a countdown rather than a
       * button that can be hammered.
       */
      requestOtp: (phone: string) =>
        client.post<OtpRequested>("/auth/otp/request", { phone }, { anonymous: true }),

      /**
       * Exchanges the code for a token pair, creating the account on the first
       * ever verification.
       *
       * `deviceFingerprint` is deliberately not sent. Passing one makes the
       * server bind this handset to the account, which is the right rule for a
       * depot handset that must not be shared and precisely the wrong one for
       * the public — a citizen replacing a broken phone, or signing in on a
       * borrowed one, is ordinary behaviour and must not need a supervisor.
       */
      verifyOtp: (phone: string, code: string, platform: "ios" | "android") =>
        client.post<LoginResponse>(
          "/auth/otp/verify",
          { phone, code, platform },
          { anonymous: true },
        ),

      logout: (refreshToken: string) =>
        client.post("/auth/logout", { refreshToken }, { anonymous: true }),
    },

    zones: {
      /**
       * Which zone the attendant is standing in.
       *
       * The server answers whenever it can be reached, and its answer is the
       * one that counts. Offline this falls back to the same geometry run
       * against cached boundaries — see `resolveZoneOffline`.
       */
      resolve: (lat: number, lng: number) =>
        client.get<Zone & { alternatives: { id: string; code: string; name: string }[] }>(
          "/zones/resolve",
          { query: { lat, lng } },
        ),

      /**
       * Open car parks around a point, nearest first.
       *
       * The one door in this API that is genuinely public — it carries
       * `@Public()` on the server, so the citizen map draws before anybody has
       * signed in, which is the whole reason a stranger can open this app and
       * find a space. It answers with `NearbyZone`, which is a thinner thing
       * than `Zone`: no boundary, and no status, because the endpoint has
       * already filtered to zones that are open.
       *
       * The default radius is two kilometres, matching the server's own
       * default. Five hundred metres is a reasonable walk; two kilometres is
       * what somebody driving actually wants to see.
       */
      nearby: (lat: number, lng: number, radius = 2000, limit = 20) =>
        client.get<NearbyZone[]>("/zones/nearby", {
          query: { lat, lng, radius, limit },
          anonymous: true,
        }),

      /**
       * One zone in full, boundary included.
       *
       * Guarded by `zone.read`, which a citizen does not hold — see
       * `gaps.ts`. Wired anyway, because the day a public zone view exists
       * this is the call the car park screen already makes.
       */
      byId: (zoneId: string) => client.get<CachedZone>(`/zones/${encodeURIComponent(zoneId)}`),

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
       * and still need folding.
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

      mine: (attendantId: string) =>
        client.get<Session[]>("/sessions", {
          query: { attendantId, status: "ACTIVE", pageSize: 100 },
        }),

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
       * A citizen paying for their own session by UPI.
       *
       * The same route the attendant uses, and the amount is never sent — the
       * server prices the session and charges what it is owed. That is the
       * point: a handset that could name its own figure is a handset that can
       * decide what parking costs.
       *
       * Guarded by `session.read` today, which a citizen does not hold, so
       * this answers 403 until a citizen-scoped payment route exists. See
       * `MISSING.payment`.
       */
      payOwnSession: (sessionId: string, mode: "UPI_INTENT" | "UPI_QR" = "UPI_INTENT") =>
        client.post<Payment>("/payments/collect", {
          sessionId,
          mode,
          idempotencyKey: newEventId(),
        }),
    },

    /**
     * The citizen's own things.
     *
     * Every route under `/me` is scoped by the token and takes no user id —
     * an app that has to name whose sessions it wants is an app one query
     * parameter away from reading somebody else's.
     *
     * Only `profile` works today. The rest are typed against routes that do
     * not exist yet; the tables behind all of them do, and each one is a
     * scoped read over indexes that are already there. `MISSING` in
     * `gaps.ts` names them, and every screen that calls one says on screen
     * that it is waiting rather than showing an empty list as if it were the
     * truth.
     */
    me: {
      /** Real, and the only authenticated call a citizen can make today. */
      profile: () => client.get<CitizenProfile>("/auth/me"),

      /** NOT BUILT — `GET /me/vehicles`. See `MISSING.myVehicles`. */
      vehicles: () => client.get<MyVehicle[]>("/me/vehicles"),

      /** NOT BUILT — `POST /me/vehicles`. See `MISSING.myVehicles`. */
      addVehicle: (plateNumber: string, vehicleType: SlotType) =>
        client.post<MyVehicle>("/me/vehicles", { plateNumber, vehicleType }),

      /** NOT BUILT — `DELETE /me/vehicles/:id`. See `MISSING.myVehicles`. */
      removeVehicle: (vehicleId: string) =>
        client.delete<void>(`/me/vehicles/${encodeURIComponent(vehicleId)}`),

      /**
       * NOT BUILT — `GET /me/sessions`. See `MISSING.mySessions`.
       *
       * Both the History screen and "where is my car" read this. Passing
       * `status: "ACTIVE"` is how the app finds a car an attendant has
       * started a session for; a citizen never starts one themselves.
       */
      sessions: (status?: "ACTIVE" | "COMPLETED") =>
        client.get<MySession[]>("/me/sessions", { query: { status, pageSize: 50 } }),

      /** NOT BUILT — `GET /me/summary`. The two figures at the top of History. */
      summary: (month?: string) =>
        client.get<MySpendSummary>("/me/summary", { query: { month } }),

      /** NOT BUILT — `GET /me/payments`. See `MISSING.myPayments`. */
      payments: () => client.get<Payment[]>("/me/payments", { query: { pageSize: 50 } }),

      /** NOT BUILT — `GET /me/favourites`. The `Favourite` model already exists. */
      favourites: () => client.get<Favourite[]>("/me/favourites"),

      /** NOT BUILT — `POST /me/favourites`. See `MISSING.favourites`. */
      addFavourite: (zoneId: string, label = "SAVED") =>
        client.post<Favourite>("/me/favourites", { zoneId, label }),

      /** NOT BUILT — `DELETE /me/favourites/:zoneId`. */
      removeFavourite: (zoneId: string) =>
        client.delete<void>(`/me/favourites/${encodeURIComponent(zoneId)}`),

      /** NOT BUILT — `GET /me/passes`. The `Pass` model exists and carries a QR. */
      passes: () => client.get<MyPass[]>("/me/passes"),
    },

    /**
     * The wallet. None of this exists on the server in any form.
     *
     * `WALLET` is a value in the `PaymentMode` enum and nothing else — there
     * is no balance column, no ledger table, no top-up and no refund path. The
     * shapes are written down here because the screens had to be built against
     * something, and because the arrangement matters: `balance()` is a derived
     * figure the server computes from `entries()`, never a mutable number this
     * client adds to. A wallet whose balance is stored rather than derived is a
     * wallet whose disputes cannot be answered.
     *
     * Worth knowing before any of it is written: holding citizens' money makes
     * KMC a prepaid instrument issuer under RBI's rules. That is a decision for
     * whoever owns the contract.
     */
    wallet: {
      /** NOT BUILT — `GET /me/wallet`. See `MISSING.wallet`. */
      balance: () => client.get<WalletBalance>("/me/wallet"),

      /** NOT BUILT — `GET /me/wallet/entries`. The ledger, newest first. */
      entries: () =>
        client.get<WalletEntry[]>("/me/wallet/entries", { query: { pageSize: 50 } }),

      /**
       * NOT BUILT — `POST /me/wallet/topups`.
       *
       * Returns an order to pay, not a new balance: the credit is written when
       * the gateway's webhook arrives, so that money is never in the wallet
       * before it is in the account.
       */
      topUp: (amount: Paise) => client.post<WalletTopUp>("/me/wallet/topups", { amount }),

      /**
       * NOT BUILT — `POST /me/wallet/payments`.
       *
       * Debits the wallet for a session the server prices. No amount is sent,
       * for the same reason it is not sent to `/payments/collect`.
       */
      paySession: (sessionId: string) =>
        client.post<Payment>("/me/wallet/payments", {
          sessionId,
          idempotencyKey: newEventId(),
        }),
    },

    passes: {
      /**
       * Season-ticket plans. The route exists but is guarded by `tariff.read`,
       * so a citizen is refused — one more door to open, not one to build.
       */
      plans: () => client.get<PassPlan[]>("/pass-plans", { query: { pageSize: 50 } }),

      /** NOT BUILT — `POST /me/passes`. See `MISSING.passPurchase`. */
      purchase: (planId: string, plateNumber: string) =>
        client.post<MyPass>("/me/passes", { planId, plateNumber }),
    },

    slots: {
      /**
       * Bay counts for a zone. Read-only and cheap, so it is not queued — a
       * stale occupancy figure is useless and a queued one is worse.
       */
      summary: (zoneId: string) =>
        client.get<SlotSummary>(`/slots/summary/${encodeURIComponent(zoneId)}`),

      /**
       * Every bay in a zone, for the grid.
       *
       * Sorted by code because the code is the only spatial information a
       * `Slot` carries — there is no floor, no level and no coordinates on the
       * model — so A01 next to A02 is the closest thing to a plan of the car
       * park that exists.
       *
       * Paged rather than fetched whole: 500 was refused outright by the API,
       * which caps a page at 100. A large car park therefore costs a few
       * requests, and the grid still arrives complete.
       */
      list: (zoneId: string) =>
        fetchAll<Slot>((page, pageSize) =>
          client.get<Slot[]>("/slots", { query: { zoneId, page, pageSize, sort: "code" } }),
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
