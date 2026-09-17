import * as React from "react";
import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { primeCache } from "@kmcp/api";
import type { LoginResponse, Principal, Shift } from "@kmcp/api";

import {
  api,
  cache,
  getDeviceId,
  initialise,
  isConfigured,
  loadTokens,
  onSignedOut,
  queue,
  saveTokens,
} from "./api";

/**
 * Who is signed in, what shift they are on, and what has not reached the server.
 *
 * All three are needed almost everywhere — a session cannot be started without
 * an attendant, cash cannot be collected without a shift to collect it against,
 * and nothing may be closed while work is still queued — so they are resolved
 * once here rather than fetched per screen.
 */

/**
 * How a sign-in attempt ended when the server did not refuse it.
 *
 * Two outcomes rather than one because the server has two: an account with an
 * authenticator enrolled is answered with a challenge and no tokens, and the
 * screen has to ask for the code before anybody is signed in. A refusal —
 * wrong password, unbound handset — is thrown, not returned, so the ordinary
 * error path stays the ordinary error path.
 */
export type SignInResult =
  | { status: "ok" }
  | { status: "two_factor_required"; challengeId: string };

interface SessionState {
  ready: boolean;
  configured: boolean;
  user: Principal | null;
  shift: Shift | null;
  queued: number;
  rejected: number;
  syncing: boolean;
  /** True while the handset believes it can reach the network at all. */
  online: boolean;
  /** How stale the cached zones and rate cards are, in hours. */
  cacheAgeHours: number | null;
  /**
   * What the last cache priming could not fetch, as `primeCache` names it.
   *
   * Empty after a complete priming. Kept here because a partly primed cache
   * is indistinguishable from a full one by age alone, and the attendant
   * needs to know before the signal goes, not after.
   */
  cacheFailures: string[];
  signIn: (phone: string, password: string) => Promise<SignInResult>;
  verifyTwoFactor: (challengeId: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshShift: () => Promise<void>;
  sync: () => Promise<void>;
  refreshCache: () => Promise<void>;
}

const SessionContext = React.createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = React.useState(false);
  const [user, setUser] = React.useState<Principal | null>(null);
  const [shift, setShift] = React.useState<Shift | null>(null);
  const [online, setOnline] = React.useState(true);
  const [cacheAgeHours, setCacheAgeHours] = React.useState<number | null>(null);
  const [cacheFailures, setCacheFailures] = React.useState<string[]>([]);
  const [queueState, setQueueState] = React.useState({ pending: 0, rejected: 0, syncing: false });

  const refreshShift = React.useCallback(async () => {
    try {
      setShift(await api.shifts.current());
    } catch {
      // A shift we cannot fetch is not a shift that does not exist. Leave what
      // we last knew rather than telling an attendant their shift has gone.
    }
  }, []);

  const refreshCache = React.useCallback(async () => {
    try {
      const primed = await primeCache(api, cache);
      setCacheFailures(primed.failed);
    } catch {
      // Priming is best-effort. Failing it leaves the previous copy in place,
      // which is exactly what it is for — but say so, rather than let the
      // previous copy pass for a fresh one.
      setCacheFailures(["zones", "holidays"]);
    }
    setCacheAgeHours(cache.ageHours());
  }, []);

  const loadUser = React.useCallback(async () => {
    const me = (await api.auth.me()) as unknown as Principal;
    setUser(me);
    await refreshShift();
    await refreshCache();
  }, [refreshShift, refreshCache]);

  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      await initialise();
      onSignedOut(() => {
        setUser(null);
        setShift(null);
      });

      const unsubscribe = queue.subscribe((state) => {
        if (!cancelled) setQueueState(state);
      });

      setCacheAgeHours(cache.ageHours());

      const tokens = await loadTokens();
      if (tokens && isConfigured()) {
        try {
          await loadUser();
        } catch {
          // An expired session on a cold start is ordinary. Show the login
          // screen rather than an error.
        }
      }
      if (!cancelled) setReady(true);
      return unsubscribe;
    })();

    return () => {
      cancelled = true;
    };
  }, [loadUser]);

  /**
   * Drain the queue on the events that actually mean something changed —
   * signal returning, or the attendant opening the app — rather than on a timer
   * that fires uselessly all day and misses the moment a kerb finds a bar of
   * signal. The slow timer stays as a backstop for a handset left face-up on a
   * dashboard with work outstanding.
   */
  React.useEffect(() => {
    if (!user) return;

    const unsubscribeNet = NetInfo.addEventListener((state) => {
      const reachable = Boolean(state.isConnected && state.isInternetReachable !== false);
      setOnline(reachable);
      if (reachable && queue.state().pending > 0) void queue.sync();
    });

    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active" && queue.state().pending > 0) void queue.sync();
    });

    const timer = setInterval(() => {
      if (queue.state().pending > 0) void queue.sync();
    }, 120_000);

    return () => {
      unsubscribeNet();
      subscription.remove();
      clearInterval(timer);
    };
  }, [user]);

  /**
   * Turns a login response into a signed-in handset.
   *
   * Shared by the password step and the authenticator step because the server
   * answers both with the same shape. A response that claims to have signed
   * us in but carries no tokens is treated as a failure rather than let
   * through: `loadUser` would then call `/auth/me` unauthenticated and the
   * attendant would see a 401 that nothing on screen explains.
   */
  const settle = React.useCallback(
    async (result: LoginResponse): Promise<SignInResult> => {
      if (result.status === "two_factor_required") {
        if (!result.challengeId) {
          throw new Error("The server asked for an authenticator code but sent no challenge.");
        }
        return { status: "two_factor_required", challengeId: result.challengeId };
      }
      if (!result.tokens) throw new Error("The server accepted the sign-in but sent no session.");
      await saveTokens(result.tokens);
      await loadUser();
      return { status: "ok" };
    },
    [loadUser],
  );

  const signIn = React.useCallback(
    (phone: string, password: string) =>
      api.auth.loginWithPhone(phone, password, getDeviceId()).then(settle),
    [settle],
  );

  const verifyTwoFactor = React.useCallback(
    async (challengeId: string, code: string) => {
      const result = await settle(await api.auth.verifyTwoFactor(challengeId, code));
      // The verify route never answers with another challenge; if it ever
      // did, looping the attendant back to the code field would be wrong and
      // saying so is better than pretending they are signed in.
      if (result.status !== "ok") {
        throw new Error("The server asked for a second code. Try signing in again.");
      }
    },
    [settle],
  );

  const signOut = React.useCallback(async () => {
    const tokens = await loadTokens();
    if (tokens?.refreshToken) await api.auth.logout(tokens.refreshToken).catch(() => undefined);
    await saveTokens(null);
    setUser(null);
    setShift(null);
    // The cache is deliberately kept: it holds no personal data, only zones and
    // rate cards, and the next attendant on this handset can start work with it.
  }, []);

  const value: SessionState = {
    ready,
    configured: isConfigured(),
    user,
    shift,
    queued: queueState.pending,
    rejected: queueState.rejected,
    syncing: queueState.syncing,
    online,
    cacheAgeHours,
    cacheFailures,
    signIn,
    verifyTwoFactor,
    signOut,
    refreshShift,
    refreshCache,
    sync: async () => {
      await queue.sync();
      await refreshShift();
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = React.useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside SessionProvider");
  return context;
}
