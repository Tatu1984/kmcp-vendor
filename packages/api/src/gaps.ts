import { ApiError } from "./client";

/**
 * Telling a shut door from a dead line.
 *
 * Two kinds of failure reach a handset and they deserve different words,
 * because they are different promises to the person holding it:
 *
 *  - NOT_BUILT — the server answered 404. The route is not there, and nothing
 *    will come back from it until somebody writes it.
 *  - NOT_PERMITTED — the server answered 403. The route exists and works, but
 *    this token is refused by it.
 *
 * Both are definite: a server was reached and said no. That is the property
 * the offline code cares about — a definite refusal must never be dressed up
 * as "no signal" and answered from the cache, because the cache would then be
 * quietly overriding a reply that actually arrived.
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
