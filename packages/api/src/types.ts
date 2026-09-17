/**
 * The shapes the API actually returns.
 *
 * Hand-written rather than generated, and deliberately narrow: these describe
 * what the attendant app reads, not everything the server can say. Anything
 * absent here is absent because no screen needs it yet.
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

/**
 * What `POST /sessions/:id/end` returns.
 *
 * `quote` is optional because the idempotent-replay branch on the server
 * returns the session as it was already stored, with no breakdown — an offline
 * end replayed after the first attempt did go through comes back this way.
 * The fare itself is still on `payableAmount`; only the line-by-line
 * explanation is missing.
 */
export interface EndedSession extends Session {
  quote?: Quote;
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

/**
 * What the checkout sheet hands back, sent verbatim to `POST /payments/:id/verify`.
 *
 * Three opaque strings from Razorpay. The server recomputes the signature
 * with a secret this handset never holds and refuses the capture if it does
 * not match, so nothing here is trusted on its own.
 */
export interface VerifyPayment {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
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
   * The attendant's own vendor, sent with the shift so the handset can show
   * the vendor's share without calling `/revenue`.
   *
   * `commissionPct` is a Prisma `Decimal`, which serialises as a string — not a
   * number. Anything doing arithmetic with it coerces first; `today.tsx` does.
   */
  vendor?: { id: string; orgName: string; commissionPct: string } | null;
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
  /**
   * Present on the `/zones` list this cache is primed from; absent from a
   * `/zones/resolve` answer, whose select does not include it. Resolve only
   * ever returns OPEN zones — it filters to them before running the geometry —
   * so a missing status there means "open by construction", not "unknown".
   */
  status?: string;
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
