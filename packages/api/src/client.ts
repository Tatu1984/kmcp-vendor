import type { ApiEnvelope, TokenPair } from "./types";

/**
 * The HTTP client both field apps use.
 *
 * Written for a handset on a bad connection at a kerb, which is a different
 * problem from a browser on an office desk: requests time out often, tokens
 * expire mid-shift, and the same call may be made several times because the
 * first attempt appeared to fail when it had not.
 */

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: { field: string; issue: string }[],
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when re-authenticating would plausibly fix it. */
  get isAuthError(): boolean {
    return this.status === 401 || this.code === "TOKEN_REUSED";
  }

  /**
   * True when the request never reached the server, so it is safe to queue and
   * retry. A refusal on its merits — a closed zone, a duplicate plate — is not
   * retryable, and queueing it would mean an attendant's handset silently
   * trying to do something the server has already said no to.
   */
  get isRetryable(): boolean {
    return this.code === "NETWORK_ERROR" || this.code === "TIMEOUT" || this.status >= 500;
  }

  /** Field-keyed messages, ready to put beside an input. */
  fieldErrors(): Record<string, string> {
    return Object.fromEntries((this.details ?? []).map((d) => [d.field, d.issue]));
  }
}

export interface ClientConfig {
  baseUrl: string;
  /**
   * A stable per-handset id. Attendant accounts are bound to one.
   *
   * A getter rather than a value because it is read from the secure store
   * asynchronously at startup, after this client is constructed.
   */
  getDeviceId: () => string;
  getTokens: () => TokenPair | null;
  setTokens: (tokens: TokenPair | null) => void;
  /** Called when the session is gone for good, so the app can show the login screen. */
  onSignedOut?: () => void;
  timeoutMs?: number;
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  anonymous?: boolean;
  timeoutMs?: number;
}

export class ApiClient {
  private refreshInFlight: Promise<TokenPair | null> | null = null;

  constructor(private readonly config: ClientConfig) {}

  private url(path: string, query?: RequestOptions["query"]): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * Exchanges the refresh token for a new pair.
   *
   * Refresh tokens are single-use — presenting one twice revokes the whole
   * family server-side. A handset firing several requests at once as signal
   * returns would otherwise refresh in parallel and sign itself out.
   */
  private async refresh(): Promise<TokenPair | null> {
    const current = this.config.getTokens();
    if (!current?.refreshToken) return null;

    this.refreshInFlight ??= (async () => {
      try {
        const response = await fetch(this.url("/auth/refresh"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: current.refreshToken }),
        });
        if (!response.ok) {
          this.config.setTokens(null);
          this.config.onSignedOut?.();
          return null;
        }
        const payload = (await response.json()) as ApiEnvelope<TokenPair>;
        this.config.setTokens(payload.data);
        return payload.data;
      } catch {
        // A failed refresh on a dead connection is not proof the session is
        // gone. Keep the tokens; the next attempt may succeed.
        return null;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  async request<T>(path: string, options: RequestOptions = {}, retrying = false): Promise<T> {
    const { body, query, anonymous, timeoutMs, headers, ...rest } = options;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.config.timeoutMs ?? 20_000);

    const requestHeaders = new Headers(headers as HeadersInit);
    requestHeaders.set("accept", "application/json");
    if (body !== undefined) requestHeaders.set("content-type", "application/json");
    requestHeaders.set("x-device-id", this.config.getDeviceId());

    const tokens = anonymous ? null : this.config.getTokens();
    if (tokens?.accessToken) requestHeaders.set("authorization", `Bearer ${tokens.accessToken}`);

    let response: Response;
    try {
      response = await fetch(this.url(path, query), {
        ...rest,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new ApiError(
        aborted ? "TIMEOUT" : "NETWORK_ERROR",
        aborted
          ? "That took too long. It may still have gone through — it will be retried."
          : "No connection. This will be sent when you are back online.",
        0,
      );
    }
    clearTimeout(timer);

    // One transparent refresh, then give up: a second 401 means the session is
    // genuinely gone rather than merely expired.
    if (response.status === 401 && !anonymous && !retrying) {
      const refreshed = await this.refresh();
      if (refreshed) return this.request<T>(path, options, true);
    }

    const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;

    if (!response.ok || !payload?.success) {
      const error = new ApiError(
        payload?.error?.code ?? "INTERNAL_ERROR",
        payload?.error?.message ?? "Something went wrong. Please try again.",
        response.status,
        payload?.error?.details,
        payload?.meta?.requestId,
      );

      // A handset a supervisor has released is signed out, not merely refused.
      // `/auth/me` skips the device check, so the tokens still "work" for the
      // one call the app makes at startup and fail for every call after it —
      // which leaves an attendant looking signed in on a phone that can do
      // nothing. Treating this like a revoked session sends them to the login
      // screen, where the reason is explained. Anonymous requests are exempt:
      // a login refused for this reason has no session to end, and the login
      // screen shows that refusal itself.
      if (error.code === "DEVICE_NOT_BOUND" && !anonymous) {
        this.config.setTokens(null);
        this.config.onSignedOut?.();
      }

      throw error;
    }

    return payload.data;
  }

  get<T>(path: string, options: RequestOptions = {}) {
    return this.request<T>(path, { ...options, method: "GET" });
  }
  post<T>(path: string, body?: unknown, options: RequestOptions = {}) {
    return this.request<T>(path, { ...options, method: "POST", body });
  }
  patch<T>(path: string, body?: unknown, options: RequestOptions = {}) {
    return this.request<T>(path, { ...options, method: "PATCH", body });
  }
  delete<T>(path: string, body?: unknown, options: RequestOptions = {}) {
    return this.request<T>(path, { ...options, method: "DELETE", body });
  }
}
