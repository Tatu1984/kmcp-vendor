/**
 * The shapes the API actually returns.
 *
 * Hand-written rather than generated, and deliberately narrow: these describe
 * what the field apps read, not everything the server can say. Anything absent
 * here is absent because no screen needs it yet.
 *
 * Every amount is integer paise. There is no floating point in the money path
 * anywhere in this platform, and adding one here would be the place it starts.
 */

export type Paise = number;

export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  meta: { requestId: string; page?: number; pageSize?: number; total?: number };
  error?: { code: string; message: string; details?: { field: string; issue: string }[] };
}

export type SlotType =
  | "TWO_WHEELER"
  | "THREE_WHEELER"
  | "CAR"
  | "EV"
  | "COMMERCIAL"
  | "BUS"
  | "TRUCK"
  | "VIP"
  | "GOVERNMENT"
  | "ACCESSIBLE";

export type SessionStatus = "ACTIVE" | "COMPLETED" | "CANCELLED" | "OVERSTAY" | "DISPUTED";

export type PaymentMode =
  | "CASH"
  | "UPI_QR"
  | "UPI_INTENT"
  | "CARD"
  | "NETBANKING"
  | "WALLET"
  | "PASS"
  | "CORPORATE";

export interface Principal {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  role: string;
  vendorId?: string | null;
  attendantId?: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  tokenType: "Bearer";
}

export interface LoginResponse {
  status: "authenticated" | "two_factor_required";
  challengeId?: string;
  tokens?: TokenPair;
  user?: Principal;
}

export interface Zone {
  id: string;
  code: string;
  name: string;
  centerLat: number;
  centerLng: number;
  capacity: number;
  occupied: number;
  available: number;
  occupancyPct: number;
  availability: "AVAILABLE" | "LIMITED" | "FULL";
  allowedVehicleTypeIds: SlotType[];
  openTime: string;
  closeTime: string;
  status: string;
  distanceMetres?: number;
}

export interface Session {
  id: string;
  code: string;
  zoneId: string;
  slotId?: string | null;
  plateNumber: string;
  status: SessionStatus;
  startAt: string;
  endAt?: string | null;
  durationMinutes?: number | null;
  payableAmount?: Paise | null;
  grossAmount?: Paise | null;
  taxAmount: Paise;
  penaltyAmount: Paise;
  evidenceStartMediaId?: string | null;
  zone?: { id: string; code: string; name: string } | null;
  vehicleType?: { code: SlotType; label: string } | null;
  elapsedMinutes?: number | null;
  isOverstay?: boolean;
  /** True when the server recognised this as a replay of an event already recorded. */
  replayed?: boolean;
}

export interface QuoteLine {
  label: string;
  code: string;
  amount: Paise;
}

export interface Quote {
  tariffName: string;
  durationMinutes: number;
  chargeableMinutes: number;
  gracePeriodMin: number;
  lines: QuoteLine[];
  grossAmount: Paise;
  discountAmount: Paise;
  penaltyAmount: Paise;
  taxAmount: Paise;
  taxPercent: number;
  payableAmount: Paise;
  cappedByDailyLimit: boolean;
  waivedByPass: boolean;
}

export interface EndedSession extends Session {
  quote: Quote;
}

export interface PlateLookup {
  plateNumber: string;
  known: boolean;
  vehicle: {
    id: string;
    plateNumber: string;
    makeModel?: string | null;
    colour?: string | null;
    isBlacklisted: boolean;
    vehicleType: { code: SlotType; label: string };
  } | null;
  active: Session | null;
  recent: {
    id: string;
    code: string;
    startAt: string;
    endAt?: string | null;
    payableAmount?: Paise | null;
    zone: { name: string };
  }[];
}

export interface Payment {
  id: string;
  sessionId?: string | null;
  mode: PaymentMode;
  amount: Paise;
  status: "PENDING" | "CAPTURED" | "FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED";
  paidAt?: string | null;
  receipt?: { id: string; number: string; issuedAt: string } | null;
  replayed?: boolean;
  /** Present for gateway modes, so a checkout sheet can be opened. */
  gatewayKeyId?: string;
  gatewayOrder?: { id: string; amount: number; currency: string };
}

export interface Shift {
  id: string;
  attendantId: string;
  zoneId?: string | null;
  startAt: string;
  endAt?: string | null;
  sessionsCount: number;
  cashExpected: Paise;
  cashDeposited?: Paise | null;
  digitalTotal: Paise;
  varianceAmount?: Paise | null;
  status: "OPEN" | "CLOSED" | "VERIFIED" | "VARIANCE_FLAGGED";
  zone?: { id: string; code: string; name: string } | null;
  /**
   * The attendant's own vendor. `commissionPct` is optional because the server
   * does not send it yet — the Today screen hides the share tile rather than
   * inventing a percentage. See notes in today.tsx.
   */
  vendor?: { id: string; orgName: string; commissionPct?: number } | null;
  alreadyOpen?: boolean;
  variance?: { amount: Paise; short: boolean; over: boolean; matched: boolean };
}

/**
 * Bay counts for one zone, as `GET /slots/summary/:zoneId` returns them.
 *
 * Deliberately not pre-reduced to "free": the server groups by status and the
 * handset decides what to show, because AVAILABLE, RESERVED and OUT_OF_SERVICE
 * are three different answers to "can I park here" and flattening them on the
 * wire would throw away the distinction the schema went to the trouble of
 * keeping.
 *
 * `mapped` is not `capacity`. A zone can be priced for forty vehicles while
 * only twelve bays have been painted and recorded, so a free count derived
 * from bays is a floor, not the whole story.
 */
export interface SlotSummary {
  zone: { id: string; code: string; name: string; capacity: number };
  total: number;
  mappedAgainstCapacity: { mapped: number; capacity: number };
  activeSessions: number;
  byStatus: { status: SlotStatus; count: number }[];
  byType: { type: SlotType; count: number }[];
}

export type SlotStatus = "AVAILABLE" | "OCCUPIED" | "RESERVED" | "OUT_OF_SERVICE";

/** Count for one bay status, or 0 when the server did not mention it. */
export function slotsWith(summary: SlotSummary | null, status: SlotStatus): number {
  return summary?.byStatus.find((s) => s.status === status)?.count ?? 0;
}

/**
 * A tariff held on the handset so a fare can be quoted without signal.
 *
 * Published tariff versions are immutable — the server forks a new draft rather
 * than editing one in place — so a cached copy is either current or plainly
 * stale, never subtly wrong. `fetchedAt` is what tells the attendant which.
 */
export interface CachedTariffRule {
  type: string;
  label: string;
  dayType: "ALL" | "WEEKDAY" | "WEEKEND" | "HOLIDAY";
  timeFrom?: string | null;
  timeTo?: string | null;
  multiplier?: number | string | null;
  flatAmount?: Paise | null;
  priority: number;
  isActive: boolean;
}

export interface CachedTariff {
  id: string;
  name: string;
  zoneId?: string | null;
  vehicleType: SlotType;
  baseAmount: Paise;
  baseMinutes: number;
  incrementAmount: Paise;
  incrementMinutes: number;
  dailyCapAmount?: Paise | null;
  gracePeriodMin: number;
  overstayPenalty?: Paise | null;
  taxPercent: number | string;
  rules: CachedTariffRule[];
  /** When this copy was taken. Shown whenever a provisional fare is quoted. */
  fetchedAt: string;
}

export interface CachedHoliday {
  date: string;
  name: string;
  zoneIds: string[];
}

/** A zone with enough of itself to run the geo-fence on the handset. */
export interface CachedZone {
  id: string;
  code: string;
  name: string;
  centerLat: number;
  centerLng: number;
  boundary?: { type: "Polygon"; coordinates: [number, number][][] } | null;
  capacity: number;
  allowedVehicleTypeIds: SlotType[];
  openTime: string;
  closeTime: string;
  status: string;
  /**
   * Live occupancy, present only when this came from the server.
   *
   * Deliberately absent from a cached copy: how full a kerb is changes minute
   * by minute, and a stale figure shown as current would send an attendant to
   * a full zone. Offline, the honest answer is that we do not know.
   */
  occupied?: number;
  available?: number;
  occupancyPct?: number;
  availability?: "AVAILABLE" | "LIMITED" | "FULL";
}

/**
 * What a photograph is for. These are the server's enum values verbatim — a
 * near-miss like "SESSION_START" is refused, so it is a type rather than a
 * string a caller has to remember.
 */
export type MediaPurpose =
  | "SESSION_EVIDENCE_START"
  | "SESSION_EVIDENCE_END"
  | "INCIDENT_PHOTO"
  | "KYC_DOCUMENT"
  | "AGREEMENT"
  | "RECEIPT"
  | "REPORT_EXPORT"
  | "PROFILE";

export interface UploadTicket {
  uploadUrl: string;
  key: string;
  bucket: string;
  expiresInSeconds: number;
  method: "PUT";
  headers: Record<string, string>;
}

export interface Media {
  id: string;
  key: string;
  mimeType: string;
  sizeBytes: number;
  purpose: string;
  createdAt: string;
}

/* ────────────────────────────────────────────────────────── citizen app
 *
 * Everything below this line was added for `apps/citizen`. It is separated
 * because a good half of it describes endpoints the server does not have yet:
 * the shapes are written down now so the screens can be built and typed
 * against them, and so that whoever builds the backend has something precise
 * to build against rather than a screenshot.
 *
 * `packages/api/src/gaps.ts` says which is which, and every screen that reads
 * one of the absent endpoints says so on the screen rather than showing a zero.
 */

/** The server's own verdict on whether a zone has room. Never recomputed here. */
export type Availability = "AVAILABLE" | "LIMITED" | "FULL";

/**
 * One zone as `GET /zones/nearby` returns it.
 *
 * A separate type from `Zone` rather than a reuse, because the two genuinely
 * differ and pretending otherwise would put optional fields on `Zone` that the
 * vendor app relies on being present. Two absences matter to the citizen map:
 *
 *  - There is no `boundary`. The nearby projection does not select it, so the
 *    map cannot draw a real lot footprint from this call alone — see the note
 *    in `components/park-map.tsx` about what it draws instead.
 *  - There is no `status`. The endpoint already filters to OPEN zones, so
 *    everything that comes back is open by construction.
 *
 * `occupied` here is derived from live sessions, not from bay records, so it
 * can disagree with the bay summary. That is not a bug in either: a car park
 * can be running more sessions than it has painted bays.
 */
export interface NearbyZone {
  id: string;
  code: string;
  name: string;
  centerLat: number;
  centerLng: number;
  capacity: number;
  openTime: string;
  closeTime: string;
  allowedVehicleTypeIds: SlotType[];
  ward: { name: string } | null;
  street: { name: string } | null;
  occupied: number;
  available: number;
  occupancyPct: number;
  availability: Availability;
  /** Great-circle metres from the point that was searched. */
  distanceMetres: number;
}

/**
 * One bay, as `GET /slots` returns it.
 *
 * Sparse on purpose — the Prisma model really does hold nothing else. There is
 * no floor, no level, no coordinates, so a bay grid can only be a grid: the
 * codes carry whatever spatial meaning exists, which is why they are sorted
 * and shown verbatim rather than laid out.
 */
export interface Slot {
  id: string;
  zoneId: string;
  code: string;
  type: SlotType;
  status: SlotStatus;
  isReserved: boolean;
  zone: { id: string; code: string; name: string };
}

/** What `POST /auth/otp/request` answers with. */
export interface OtpRequested {
  sent: boolean;
  expiresInSeconds: number;
  /**
   * The code itself, returned only when the server is not in production.
   *
   * It exists so a demo build can be signed into without an SMS gateway. The
   * app shows it plainly labelled as such — quietly filling the field in would
   * make a test build indistinguishable from a broken one.
   */
  devCode?: string;
}

/** `GET /auth/me` for a citizen. Wider than `Principal`, and the real shape. */
export interface CitizenProfile {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  status: string;
  permissions: string[];
  vendorId: string | null;
  attendantId: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

/**
 * A vehicle a citizen has told us is theirs.
 *
 * The plate is the join between a citizen and a parking session: a citizen
 * never starts one, an attendant does, so "your car" is found by matching a
 * registered plate against active sessions.
 */
export interface MyVehicle {
  id: string;
  plateNumber: string;
  makeModel?: string | null;
  colour?: string | null;
  vehicleType: { code: SlotType; label: string };
  isBlacklisted: boolean;
}

/** One of the citizen's own parking sessions, with what they paid for it. */
export interface MySession {
  id: string;
  code: string;
  plateNumber: string;
  status: SessionStatus;
  startAt: string;
  endAt: string | null;
  durationMinutes: number | null;
  payableAmount: Paise | null;
  refundedAmount: Paise;
  zone: { id: string; code: string; name: string };
  payment: { id: string; mode: PaymentMode; status: string } | null;
  receipt: { id: string; number: string; issuedAt: string } | null;
}

/** The figures at the top of the History screen, totalled by the server. */
export interface MySpendSummary {
  /** "2026-09" — the month these totals cover. */
  month: string;
  totalPaid: Paise;
  totalRefunded: Paise;
  sessions: number;
}

/** A saved car park. The `Favourite` model exists; nothing writes to it yet. */
export interface Favourite {
  id: string;
  zoneId: string;
  /** "HOME", "OFFICE", or whatever the citizen typed. */
  label: string;
  zone: { id: string; code: string; name: string };
}

/**
 * A wallet balance.
 *
 * Deliberately not a mutable number the client adds to and subtracts from. The
 * server derives it from the ledger every time it is asked, which is the only
 * arrangement under which a balance disputed three months later can be
 * answered — the same reasoning the shift reconciliation already uses.
 */
export interface WalletBalance {
  balance: Paise;
  currency: "INR";
  /** When the ledger last moved. Not when this response was computed. */
  updatedAt: string | null;
}

export type WalletEntryKind =
  | "TOPUP"
  | "SESSION_DEBIT"
  | "REFUND"
  | "REVERSAL"
  | "ADJUSTMENT";

/**
 * One row of the ledger.
 *
 * `amount` is signed — credits positive, debits negative — so that a client
 * never has to know which kinds add and which subtract, and a new kind added
 * server-side cannot silently be totalled the wrong way here.
 */
export interface WalletEntry {
  id: string;
  kind: WalletEntryKind;
  amount: Paise;
  balanceAfter: Paise;
  /** Already written for a person to read: "Park Street North", "Added by UPI". */
  description: string;
  sessionId: string | null;
  zone: { id: string; name: string } | null;
  createdAt: string;
}

/**
 * A top-up waiting to be paid.
 *
 * The money is not in the wallet when this returns. The credit is written when
 * the gateway's webhook arrives, which is why this carries an order to pay and
 * not a new balance.
 */
export interface WalletTopUp {
  id: string;
  amount: Paise;
  status: "PENDING" | "CAPTURED" | "FAILED";
  gatewayKeyId: string;
  gatewayOrder: { id: string; amount: number; currency: string };
}

/** A season-ticket plan a citizen could buy. */
export interface PassPlan {
  id: string;
  name: string;
  description: string | null;
  amount: Paise;
  validDays: number;
  vehicleType: SlotType;
  zoneId: string | null;
}

/** A pass the citizen holds, once purchase exists. */
export interface MyPass {
  id: string;
  planName: string;
  plateNumber: string;
  status: "PENDING_PAYMENT" | "ACTIVE" | "EXPIRED" | "CANCELLED";
  validFrom: string;
  validTo: string;
  qrCode: string | null;
}
