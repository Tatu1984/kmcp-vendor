import * as React from "react";
import { AppState } from "react-native";

/**
 * A clock the screens can read.
 *
 * Every elapsed figure the API sends is an integer worked out when the row was
 * serialised, so a duration rendered from it sits frozen at "43m" until
 * something refetches — and an attendant watching a vehicle approach its
 * overstay threshold is watching a number that stopped moving. This holds the
 * current time as state instead and lets each screen derive its own durations
 * from `startAt`, so one interval keeps a whole list honest rather than one
 * timer per row.
 *
 * What it deliberately does not do is decide whether a vehicle is overstaying.
 * That threshold is zone configuration held on the server, and a handset that
 * guessed at it would flag vehicles the server does not — then disagree with
 * the penalty printed on the receipt. `isOverstay` remains the authority; only
 * the displayed duration comes from here.
 */

/**
 * Fifteen seconds.
 *
 * The finest thing any of these displays renders is a whole minute, so a
 * one-second tick would spend sixty renders to change one glyph. Fifteen bounds
 * how stale a minute label can get to a quarter of the minute it is showing —
 * well inside what an attendant would notice looking between the screen and the
 * car — at four renders a minute.
 */
const TICK_MS = 15_000;

export function useNow(active = true): number {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!active) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      // Catch up before the first tick: a handset that spent ten minutes in a
      // pocket would otherwise show the time it was put away for a quarter of
      // a minute after it comes back out.
      setNow(Date.now());
      timer ??= setInterval(() => setNow(Date.now()), TICK_MS);
    };

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    // Nothing reads a clock on a screen that is off, and a timer firing in a
    // pocket is battery spent for nobody — the same reason `lib/session.tsx`
    // hangs its queue drain off AppState rather than on a timer alone.
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") start();
      else stop();
    });

    // Started outright rather than gated on `AppState.currentState`: this hook
    // runs because a screen is being rendered, and the platform reports
    // "unknown" often enough at mount that checking it would leave the clock
    // stopped until the app was next backgrounded and reopened.
    start();

    return () => {
      subscription.remove();
      stop();
    };
  }, [active]);

  return now;
}

/**
 * Minutes between a server timestamp and a moment on this handset.
 *
 * Floored, because 43m59s is "43m" everywhere else in this app and a duration
 * that rounded up would read as a minute the driver has not used. Clamped at
 * zero, because a handset whose clock is behind the server's would otherwise
 * show a negative duration for a vehicle that has only just arrived. Null when
 * either end of the arithmetic is unusable, so the caller can fall back to the
 * server's own figure rather than render a confident nonsense.
 */
export function elapsedMinutesSince(startAt: string, now: number): number | null {
  const started = Date.parse(startAt);
  if (!Number.isFinite(started) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - started) / 60_000));
}
