# KMCP attendant app

What a parking attendant uses at the kerb. Starts and ends parking sessions,
photographs the plate, takes cash, and runs a shift.

> **On the name.** The repository is `kmcp-vendor` and the workspace is
> `@kmcp/vendor`, but the person holding this handset is an **attendant** — the
> kerbside staff a vendor employs. KMC contracts the vendor; the vendor employs
> the attendant; the vendor's own dashboard is a web screen in the KMCP portal
> at `/vendor`, not this app. The naming is inherited and worth knowing before
> somebody files a vendor-company feature request against this repo.

## The rule that shapes everything here

**Nothing on a device decides anything that matters.** Fares, geo-fences, tariff
selection, what a session costs and whether it may start at all are the server's
decisions. A handset reports what it observed — a typed plate, a photograph, a
GPS fix — and asks. That is what lets a tariff change take effect everywhere
without an app release, and what stops a modified build from parking for free.

## Working on it

```
npm install
npm start           # Expo dev server
npm run typecheck
```

The app reads `EXPO_PUBLIC_API_URL`. Without it, it runs against nothing and
says so, rather than appearing to work. See `apps/vendor/.env.example`.

## Layout

```
apps/vendor      the app itself
packages/api     the API client, the types the server actually returns,
                 and the offline queue
```

A workspace with one app in it looks like overkill until you notice the second
directory. `packages/api` is shared with the citizen app, which lives in its own
repository — see below.

## The shared client, and the drift it invites

`packages/api` was the reason the two apps were one repository. Splitting them
does not remove that dependency; it moves it from a problem the tooling solved
into one people have to.

**The copies must stay identical.** Nothing here should be edited to suit this
app alone: an endpoint the citizen app needs, a type the server returns, a
change to the offline queue — all of it belongs to both. Two divergent copies of
an API client is exactly the failure the monorepo existed to prevent, and it
arrives quietly, one small local fix at a time.

Three ways to hold the line, in increasing order of effort and safety:

1. **Copy deliberately.** When `packages/api` changes in either repository, copy
   the whole directory across and commit it with the same message. Cheap, works
   today, relies on discipline.
2. **`git subtree`.** Keep `packages/api` in a third repository and pull it into
   both. Real history, no publishing step, a command to remember.
3. **Publish it.** `@kmcp/api` to a private registry, versioned. The right answer
   once either app is in the stores and a bad client cannot simply be
   re-deployed.

Until one of those is chosen, treat any diff in `packages/api` between this
repository and the citizen one as a bug.

## Where it points

`EXPO_PUBLIC_API_URL` is the deployed API — `https://kmcp-backend.vercel.app/api/v1`
for the demonstration environment. The app holds no camera credentials, no
tariff table and no fare arithmetic of its own; it asks.
