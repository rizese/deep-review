# Deep Review

A local tool for reading pull requests: an agent slices the PR into the
changes that matter, and a call-graph walker lets you follow each slice
through the code that calls it and the code it calls.

Project vocabulary lives in [CONTEXT.md](./CONTEXT.md).

## Quick start

```sh
pnpm install
pnpm build      # the client app the server serves, and the pr-review CLI
```

Authenticate to GitHub once. Nothing here shells out to `gh`, so the login on
its own is not enough — hand the token it holds to the command that needs it:

```sh
gh auth login
export GITHUB_TOKEN=$(gh auth token)
```

Then hand a PR to the slice explorer — the tool's primary interface, stacking
slices vertically and each slice's call graph horizontally:

```sh
export OPENAI_API_KEY=...   # or ANTHROPIC_API_KEY / GROK_API_KEY, see below
pnpm --filter @deep-review/review cli https://github.com/vercel/swr/pull/2950
```

This slices the PR with an agent, walks a call graph from each slice's target function, serves the page from a local navigation server and opens it. It will automatically open the page with the slicing progress for you to monitor.

To have the server listen to new PRs as they get assigned to you, run the following once: 

```sh
pr-review watch --repo spara-ai/spara-app
```

That both adds the repo to `~/.deep-review/watch.json` and turns watching on, installing a launchd agent that survives logout and reboot. 

### Adding PRs to the server

One long-lived local server holds every PR you add. The first invocation
starts it, later ones add their PRs to it, and each PR keeps its own URL until
the server is stopped. The server listens on port 7331 when it is free (set
`DEEP_REVIEW_PORT` to prefer another), so the index stays at one address
across restarts and a bookmark to it keeps working.

Every page sits in the same frame: a bar along the top with the Deep Review
wordmark, which leads back to the index from anywhere, a pill with the number
of PRs the server holds and a `+` that adds one by URL, and a light / system
/ dark switch. The theme is remembered by the browser. A PR builds in the background — its URL opens at once
and turns into the explorer when it is ready.

```sh
# One PR by URL; starts the server if it isn't already up.
pnpm --filter @deep-review/review cli https://github.com/vercel/swr/pull/2950

# Several at once as bare numbers, with the repo named separately
# (or set DEEP_REVIEW_REPO=vercel/swr and drop --repo).
pnpm --filter @deep-review/review cli 2950 2951 2952 --repo vercel/swr

# Reuse a saved slicing run instead of paying for the agent again.
pnpm --filter @deep-review/review cli 2950 --repo vercel/swr --slices slices.json

# Stay attached until the PRs you added have finished building.
pnpm --filter @deep-review/review cli 2950 --repo vercel/swr --wait

# What the server holds, and how to stop it.
pnpm --filter @deep-review/review cli status
pnpm --filter @deep-review/review cli stop
```

After `pnpm build`, the same CLI is on your path as `pr-review`, so those read
`pr-review 2950 --repo vercel/swr`. `--help` lists every flag, including
`--max-graphs <n>` to cap the slow call-graph analysis. Every run's slice JSON
is kept under `~/.deep-review/slices/` for `--slices` to reuse.

Environment: a model key is required unless `--slices` is given —
`OPENAI_API_KEY` for the default model (`gpt-5.6-sol`), `ANTHROPIC_API_KEY` for
`claude-*` models, `GROK_API_KEY` for `grok-*`; `GITHUB_TOKEN` (or `GH_TOKEN`)
for private repos, and required outright by `watch`, whose `assignee:@me` query
has no meaning without a token to resolve it against; `LINEAR_API_KEY` is
optional and enables linked-ticket context. A `.env` in the package or repo
root is picked up automatically, so `GITHUB_TOKEN=$(gh auth token)` can live
there instead of being passed per invocation.

## The desktop app

`packages/desktop` is Deep Review as a Mac app: the same server, watcher and
pages, in one window with a tray icon, notifications when a PR is ready, and
a Settings page that keeps your tokens and model keys in the keychain (via
Electron's `safeStorage`) instead of the environment. It takes over from the
CLI's daemon and the launchd watcher when it starts, and the `pr-review` CLI
keeps working against it.

```sh
pnpm app          # run it in development, with hot reload for the pages
pnpm app:build    # build packages/desktop/dist/*.dmg (unsigned)
```

Merges to `main` build an unsigned arm64 release through
`.github/workflows/release.yml`.

## Structure

- `packages/pr` — one PR's raw material: URL parsing, GitHub metadata, linked Linear tickets, base/head worktrees, and unified-diff parsing. Depended on by the two analysis packages below.
- `packages/call-graph` — analyze how a function's callers/callees change across a GitHub PR, using the TypeScript language service's call hierarchy (and Pyright for Python). Also renders the explorer pages.
- `packages/slicer` — break a PR's diff into prioritized slices with an agent.
- `packages/review` — the two together: slices on the vertical axis, call graphs on the horizontal. The `pr-review` CLI, the local server and its API, the watcher.
- `packages/desktop` — the Mac app (electron-vite): `src/main.ts` runs the server and the watcher, `src/preload.ts` is the typed bridge for settings, and `src/renderer` is the React client app (CSS modules) that renders the index, the building placeholder and the explorer from the server's JSON.



## Scripts

Run from the repo root:


| Command          | What it does                           |
| ---------------- | -------------------------------------- |
| `pnpm build`     | Build the client app (which the server serves) and the CLI |
| `pnpm typecheck` | Type-check every package               |
| `pnpm test`      | Run all tests (Vitest)                 |
| `pnpm e2e`       | Compare the pages against their visual baselines (Playwright, Chromium) |
| `pnpm e2e:update` | Re-take the baselines after a deliberate visual change |




## Watching your assigned PRs

`pr-review watch` turns the whole thing around: instead of asking for a
review, a review is waiting when a PR is assigned to you. It follows the PRs
you open, too, so the index has two tabs: **For review**, the PRs waiting on
you, and **My PRs**, the ones you authored. A **Hide approved PRs** box on
the index hides, on either tab, every PR that already carries an approval;
the watcher refreshes approvals on each check, so a PR approved after its
page was built disappears from the filtered list on its own. Both the tab and
the box are remembered by the browser.

```sh
pr-review watch          # on; survives logout, reboot and a closed lid
pr-review status         # what is being watched, and what the server holds
pr-review watch --off    # off
```

It checks GitHub every five minutes (`--interval <seconds>`) for the PRs
waiting on your review, and hands each new one to the same long-lived server
every other invocation uses — starting it if it is not up, so there is never
a server to start yourself. New PRs simply appear on the server's index,
built and ready.

What it looks for is the business of one file, `~/.deep-review/watch.json`
(under `$DEEP_REVIEW_HOME`, beside the rest of the state): a GitHub search
per tab of the index, exactly the query github.com/pulls runs.

```json
{
  "searches": {
    "review": [
      "is:open is:pr archived:false draft:false assignee:@me",
      "is:open is:pr archived:false draft:false review-requested:@me"
    ],
    "authored": ["is:open is:pr archived:false author:@me"]
  }
}
```

A list per tab because GitHub cannot OR two qualifiers in one query: being
assigned and having your review requested are different things, and both are
PRs waiting on you, so both are asked for and the answers merged. A PR two
searches both find is handed over once.

There used to be a list of repos here instead, each queried separately, and
that list was the source of truth for what you were reviewing. It made a poor
one: a PR waiting on you in a repo nobody had named was invisible, and naming
repos is work GitHub already does. An old file is still read — its repos
become repo-scoped searches, so an upgrade watches what it watched yesterday
— and saving from the app rewrites it in the new shape.

What the repo list was protecting against is still real. A search bound to
nobody and nowhere returns every PR the token can see, and one night that
quietly handed six PRs from a personal repo to the server. So every search
must name a person, an owner or a repo — `assignee:@me`, `user:acme`,
`repo:acme/widgets` — and one that names none is skipped with a note in the
log rather than asked. Narrowing is the search's job: add `user:acme` to
watch one org, `repo:acme/widgets` to watch one repo. `pr-review watch --repo
<owner>/<repo>` is sugar for the latter. The file is read on every check, so
changing it needs no reinstall. `DEEP_REVIEW_REPO` still names the repo a bare
PR number refers to; it plays no part in what is searched for.

In the desktop app, Settings shows each search with the number of PRs it
finds right now, so a search can be judged before it is saved and starts
building what it matches.

"Waiting on your review" is narrower than "open and yours to worry about": a
draft is not ready to be read, so drafts are excluded. Approved PRs are not —
GitHub's `review:approved` means approved by *anyone*, so filtering on it
would hide a PR one colleague has approved while your review is still
requested. They come through marked approved instead, for the index's box to
hide.

A PR in both lists — one you opened and assigned to yourself — is yours, and
appears once, under My PRs.

The check asks for the *current* set of such PRs rather than for events,
which is what makes a laptop the right place to run it: a webhook delivered to
a sleeping machine is lost, but one poll after the lid opens sees everything
that happened overnight. Missing a check costs nothing by construction.

A PR is handed over once, when it first appears in either list — not every
time it changes, because `updated_at` moves on every comment and a rebuild
means a paid slicing run. What GitHub says about a PR already handed over —
its approval, above all — is passed along on every check without a rebuild. Anything that drops out of the list is forgotten, so
approving a PR and having it reassigned, or unassigning and reassigning, is
the deliberate way to ask for it again.

A build that fails says what kind of failure it was, and that decides what
happens next. A network failure is retried on a backoff (one minute, two,
five, fifteen, thirty, then hourly) for a day. A failure in our own pipeline
gets one more try, since the model is not deterministic, then parks until
the PR's head moves. A setup problem (no token, a bad key) or a problem with
the PR itself (a diff too large to slice) parks at once, with the reason on
the card. Every failed card has a retry button, and a restart retries the
network and setup failures, since a restart is when those get fixed.

Once a PR is merged or closed, its page leaves the server's index on the next  
check, so the index shows only what can still be acted on. Leaving the list is  
not what triggers this — approval, unassignment and turning back into a draft  
all do that, and none of them finish a PR — so every PR handed over is asked  
about directly until GitHub says it is closed.