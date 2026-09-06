import { ApiError } from "./client";

/**
 * What the server cannot do yet, written down where the code can see it.
 *
 * The citizen app was designed against a backend that is only partly built.
 * Two different kinds of hole exist and they need different words on screen,
 * because they are different promises to the person holding the phone:
 *
 *  - NOT_BUILT — the route does not exist. Nothing will ever come back from it
 *    until somebody writes it.
 *  - NOT_PERMITTED — the route exists and works, but a citizen's token is
 *    refused by it. The `CITIZEN` role currently holds *zero* permissions, so
 *    every endpoint carrying `@RequirePermissions(...)` answers 403. This is
 *    the larger of the two problems and the less obvious one, because the
 *    endpoint looks finished from the outside.
 *
 * Neither is treated as an error the citizen caused, and neither is allowed to
 * become a zero. A screen that cannot get its figures says which door is shut.
 */

export type Gap = "NOT_BUILT" | "NOT_PERMITTED";

/**
 * Classifies a failure, or returns null when it was an ordinary one.
 *
 * A timeout, a dead connection or a 500 is *not* a gap — those are transient
 * and deserve "try again", not "this is not built". Only a definite refusal
 * from a server that answered counts.
 */
export function gapOf(error: unknown): Gap | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404 || error.code === "NOT_FOUND") return "NOT_BUILT";
  if (error.status === 403 || error.code === "FORBIDDEN") return "NOT_PERMITTED";
  return null;
}

/**
 * The endpoints the citizen app needs and cannot have today.
 *
 * Kept as data rather than as prose in a README so that the screens can name
 * the exact route they are waiting on. When one of these ships, its entry is
 * deleted and the screen that quoted it starts working with no other change.
 */
export interface MissingEndpoint {
  /** Method and path, as it will be once it exists. */
  route: string;
  gap: Gap;
  /** One line, in the words a citizen could be shown. */
  because: string;
}

export const MISSING: Record<string, MissingEndpoint> = {
  slotSummary: {
    route: "GET /slots/summary/:zoneId",
    gap: "NOT_PERMITTED",
    because:
      "Bay counts exist on the server but are behind the zone.read permission, which a citizen account does not hold. This needs a public availability view.",
  },
  slotList: {
    route: "GET /slots?zoneId=",
    gap: "NOT_PERMITTED",
    because:
      "Individual bays exist and are listed for staff, but the same permission shuts a citizen out of them.",
  },
  zoneDetail: {
    route: "GET /zones/:id",
    gap: "NOT_PERMITTED",
    because:
      "Only /zones/nearby is public. Everything else about a zone — its boundary included — is behind zone.read.",
  },
  tariff: {
    route: "GET /tariffs/applicable",
    gap: "NOT_PERMITTED",
    because:
      "The rate card is guarded by session.read so kerb devices can quote a fare. Citizens hold no permissions at all, so they cannot see what they will be charged.",
  },
  plateLookup: {
    route: "GET /sessions/plate/:plateNumber",
    gap: "NOT_PERMITTED",
    because:
      "The lookup that finds a parked car is guarded by session.read. A citizen-scoped version, returning only their own vehicles, is what this screen needs.",
  },
  mySessions: {
    route: "GET /me/sessions",
    gap: "NOT_BUILT",
    because:
      "No citizen-scoped read of their own parking exists. Every table behind it does — sessions, payments, receipts — but there is no route into them.",
  },
  myPayments: {
    route: "GET /me/payments",
    gap: "NOT_BUILT",
    because:
      "Payment.paidByUserId already attributes a payment to a citizen. Nothing exposes it to the citizen it belongs to.",
  },
  myVehicles: {
    route: "GET /me/vehicles, POST /me/vehicles",
    gap: "NOT_BUILT",
    because:
      "Vehicle.ownerUserId links a plate to its owner and is indexed, but a citizen has no way to register one. Vehicles are only created implicitly when an attendant starts a session.",
  },
  favourites: {
    route: "GET /me/favourites, POST /me/favourites",
    gap: "NOT_BUILT",
    because:
      "The Favourite model exists with a unique key on (userId, zoneId) and has never been written to — there is no controller for it anywhere.",
  },
  wallet: {
    route: "GET /me/wallet, GET /me/wallet/entries, POST /me/wallet/topups",
    gap: "NOT_BUILT",
    because:
      "There is no wallet in any form. WALLET is a value in the PaymentMode enum and nothing else — no balance, no ledger table, no top-up, no refund path.",
  },
  passPurchase: {
    route: "POST /me/passes",
    gap: "NOT_BUILT",
    because:
      "Pass plans are admin CRUD and the Pass model already carries a QR code and validity dates, but nothing lets a citizen buy one.",
  },
  payment: {
    route: "POST /payments/collect",
    gap: "NOT_PERMITTED",
    because:
      "Collecting a payment is guarded by session.read because attendants collect at the kerb. A citizen paying for their own session is refused by the same guard.",
  },
};
