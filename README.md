# KMCP mobile

Two applications, one repository:

- **`apps/vendor`** — what a parking attendant uses at the kerb. Starts and ends
  parking sessions, photographs the plate, takes cash, and runs a shift.
- **`apps/citizen`** — the public app. Find a government car park, see what is
  free bay by bay, find the car an attendant has started a session for, and pay
  for it.

They share **`packages/api`**: the API client, the types the server actually
returns, and the offline queue. That package is the reason this is one
repository rather than two — the alternative is maintaining the same client
twice and letting the copies drift.

## The rule that shapes everything here

**Nothing on a device decides anything that matters.** Fares, geo-fences, tariff
selection, what a session costs and whether it may start at all are the server's
decisions. A handset reports what it observed — a typed plate, a photograph, a
GPS fix — and asks. That is what lets a tariff change take effect everywhere
without an app release, and what stops a modified build from parking for free.

## Working on it

```
npm install
npm run vendor      # Expo dev server for the attendant app
npm run citizen     # Expo dev server for the citizen app
npm run typecheck
```

The apps read `EXPO_PUBLIC_API_URL`. Without it they run against nothing and say
so, rather than appearing to work.

The citizen app also reads `EXPO_PUBLIC_GOOGLE_MAPS_KEY`, and only on Android:
Google Maps draws a blank grey rectangle without one rather than failing, so the
map screen checks for a key up front and falls back to a plain list that says
why. iOS uses Apple Maps and needs nothing. The key is never committed — see
`apps/citizen/.env.example`.

## What the citizen app is still waiting for

Most of the citizen screens are built against endpoints the server does not
offer yet, and they say so on themselves rather than showing a zero. Two
different holes exist and they are not the same problem:

- **Not built.** `/me/sessions`, `/me/payments`, `/me/vehicles`, `/me/favourites`
  and the whole wallet. The tables behind all of them already exist.
- **Not permitted.** `slots/summary/:zoneId`, `slots`, `zones/:id`,
  `tariffs/applicable`, `sessions/plate/:plateNumber` and `payments/collect` all
  work — but the `CITIZEN` role holds no permissions at all, so every one of them
  answers 403. `zones/nearby` is the single public route on the API, which is why
  the map works and nothing else does.

`packages/api/src/gaps.ts` is the list, in code, with the reason for each. When
one of them ships, its entry goes and the screen quoting it starts working.
