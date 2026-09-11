# `@sleeperhq-private/react-data-kernel`

The kernel behind Sleeper's off-heap accessor stores (`schedule`, `player`, `player_stats`), which live in the
app. It exists so large reference datasets stay **off the JS heap** — in SQLite on mobile — and only the
on-screen slice is ever materialized in JS.

If you're here to **add or edit a store**, read this first. For the "why", the concepts, and the API feature code
calls, see [`docs/data-layer-proposal.md`](https://github.com/blitzstudios/sleeperbot/blob/master/clients/docs/data-layer-proposal.md);
for one store traced end to end in real code, see
[`docs/data-layer-example-schedule.md`](https://github.com/blitzstudios/sleeperbot/blob/master/clients/docs/data-layer-example-schedule.md),
which walks the store this doc points you at as the template.

## Installing and wiring it up

```jsonc
// package.json
"@sleeperhq-private/react-data-kernel": "blitzstudios/react-data-kernel.git#react-data-kernel-v0.5.8-gitpkg"
```

Three entry points:

| entry | holds | imported by |
| --- | --- | --- |
| `@sleeperhq-private/react-data-kernel` | everything a store, a service or a screen writes against | stores, services, screens |
| `…/nitro` | `openNitroConnection` and `bindSqliteStore`, over `react-native-nitro-sqlite` | the app's startup, on device |
| `…/testing` | a real SQLite engine off-device, a test version atom, the host services as spies, and the kernel internals only a test reaches for | a store's own tests |

The core entry runs anywhere React does; only `./nitro` touches native code. Each subpath is declared twice — in
`exports`, and as a stub `package.json` beside `lib/` — because the app's TypeScript and Metro still resolve the
way Node did before `exports` existed.

**The host installs two services before it binds any backend**, and until it does the kernel stays inert — a
store reads the rows it already holds, and nothing fetches:

```ts
configureDataKernel({
  errors: { captureException, captureMessage },  // where a degradation report goes
  query: { client: () => queryClient, useQuery, useQueries },  // the React Query runtime an ingest mounts on
});
```

`useQuery` and `useQueries` are hooks, so an app passes its own focus-gated drop-ins and keeps that policy.

**`lib/` is committed.** The workspace that consumes this installs with `enableScripts: false`, so a gitpkg
install never runs `prepare`; a change to `src/` is not published until `yarn build` runs and the output is
committed and tagged.

---

## Three words, kept apart

They nest, and mixing them up is the fastest way to misread any file here:

- a **table** (`RowTable`) is the rows themselves — SQLite on mobile, a `Map` on web and in tests;
- a **partition** is one addressable slice of a table: the unit a fetch replaces, a version tracks, and an ETag
  belongs to. A store has as many as its callers ask for — `player` has one per sport, `player_stats` thousands;
- a **store** is the feature module wrapping both, declared by `defineSqliteStore` and exported from `store.ts`.

`definePartitions` is the middle layer: one table, divided into partitions, that a backend reads and
fetches through.

---

## Two kinds of store

They differ enough in size that picking the wrong one is the most expensive mistake available here:

| kind                                | what it does                                                                                                                             | example                             | you write                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Normal store**                    | Fetch a dataset, keep it off-heap, read a **bounded slice** and select it into a VM in JS.                                               | `schedule` (the small template) | a schema, VM types, mappers, a backend that composes the kernel.                                           |
| **Native-compute store** (advanced) | Everything above **plus** a whole-collection compute (rank/score ~9k rows) done _inside SQLite_ so the collection never crosses into JS. | `player_stats` **only**       | all of the above **plus** a bespoke SQL compute engine (`ranking/native_ranker.ts`, `ranking/score_sql.ts`). |

**Copy `schedule`, not `player_stats`.** `player_stats` is by far the largest backend, and its extra weight is a
second layer of ranking SQL serving one hard problem: rank a 9k-player list without pulling 9k objects across the
bridge.

The native-compute tier is for a read that reduces a whole collection — rank, sum, top-N over _everything_. If
your read is "give me this team's games" / "this roster's scores" — a bounded slice — you never touch it.

---

## What the kernel gives you (the reusable half)

Everything in this folder is shared and already tested. You compose these; you don't reimplement them.

A note on reach: `index.ts` exports what a store, a service or a screen writes against. The pieces `definePartitions`
and `defineSqliteStore` are themselves built out of — the spine, the read surface, the fetch ingest, the SQL batch and
migration helpers — are described below but deliberately absent from it. Wanting one of them by name usually means a
store is reaching past its entry point; import it from its own module only if you are working on the kernel itself.

- **`defineSqliteStore`** — a store's whole spine in one descriptor: the version atom, the one slot holding the
  active backend, the in-memory default for web and tests, the SQLite builder startup binds, and the degrade
  path back to that default when a statement fails mid-session.
- **`createRowTable` (`createSqliteRowTable` / `createMemoryRowTable`)** — the off-heap row engine from a
  schema: `find` / `findIn` (indexed slice reads), `has`, `getMeta` / `setMeta` (ETags), and three writes.
  SQLite on mobile, in-memory on web/test — same interface.

  **The three writes.** `upsert(rows)` merges by primary key and removes nothing, chunked off-thread — what a
  socket delta wants. `overwrite(where, rows)` makes the slice matching `where` be exactly `rows`, deleting first
  in one transaction. `shred(where, rawJson, parse)` is that same replacement from an undecoded body, shredded in
  C++ so the payload never becomes a JS object graph. Only `overwrite` and `shred` name a slice, because only they
  delete; and in DEV every row they write is checked against the filter it was written under.

  **Changing a schema.** Edit the schema and ship it; there is no migration to write. `init` stamps a fingerprint
  of everything it builds — columns, primary key, indexes, the ETag side-table, the shred spec — into
  `PRAGMA user_version`, and a database whose stamp doesn't match is migrated on the spot. There are two ways that
  can go, and which one you get is worth knowing before you edit:

  - **A widening**, where the declaration only *added* columns. The table is kept and each new column arrives by
    `ALTER TABLE ADD COLUMN`, so not one row is lost. This is the case worth having: a schema whose columns are
    generated from a catalog — the scoring keys a sport publishes — gains a column every time the catalog does, and
    dropping a user's whole table to add one costs them a refetch for nothing. The added columns are `NULL` in every
    row that predates them, so the ETags go even though the rows stay: keeping one would answer the fetch that fills
    them with a 304.
  - **A rebuild**, for everything else — a changed key, a changed index, a renamed ETag table, a shred op that now
    fills a column it already had from a different path. Each of those restates rows already on disk, and no
    `ALTER TABLE` can restate them, so the table is dropped and refilled from the next fetch. A half-migrated table
    fails silently instead (a stale primary key turns ingest's `INSERT OR REPLACE` back into `INSERT`).

  Telling those apart takes two stamps, because a fingerprint that no longer matches can't say *what* moved:
  `PRAGMA user_version` holds the whole declaration's, and `PRAGMA application_id` holds the same hash with the
  columns left out — the table's, and the shred spec's `columns`/`ops` with them, since a spec is index-aligned with
  the table and a generated column arrives together with the op that fills it. Structure stamp equal and columns only
  added ⇒ widen; anything else ⇒ rebuild. A database built before the second stamp existed reads it as `0`, so its
  next schema change is one last rebuild, and every widening after that is free. The stamps are also what make an
  index edit take effect at all: `CREATE INDEX IF NOT EXISTS` is a no-op against an index of the same name over
  different columns, and `PRAGMA table_info` doesn't report indexes. Two fields on the schema go with them:

  - `pushFed: true` — for a store fed by socket as well as fetch. A rebuild there loses whatever arrived by push
    since the last fetch, so one files a sampled `info` notice naming the table. It does **not** throw, in `__DEV__`
    or anywhere else: `init` stamps the schema last, so refusing the rebuild would leave the stale stamp on disk and
    bind the in-memory backend on every launch after — permanently slower than the heap it replaced, over a change
    someone shipped on purpose. Catch the edit where the edit happens, by pinning the store's column set in a test.
  - `rebuildVersion` — bump to force a rebuild for something the stamps can't see, and it is part of the structure
    stamp, so bumping it is never mistaken for a widening. Two things need it. One is a row builder written in JS with
    no spec beside it (`schedule`): a change there leaves rows stale rather than malformed, and the stored ETag will
    304 the correction away. The other is repointing a shred op on a column that already exists *in the same release
    that adds a column* — alone that rebuilds (a plan with nothing to add is a rebuild), but alongside an addition it
    reads as a widening and the old values under the repointed column stay. Bumping this drops the ETags with the
    rows, which makes the next fetch a real one.

  **The shred spec is part of the fingerprint, which is why `NativeShredSpec` holds a `specs` map keyed by
  variant.** The fingerprint has to hash every spec a store can shred through, so the specs have to be
  enumerable. If your spec varies — `player_stats` shreds different
  scoring columns per sport — enumerate the variants and give `variant(scope)` the job of picking one. Naming a
  variant that isn't in the map falls back to the JS parse path rather than shredding through `undefined`.
- **`definePartitions`** — **how your rows are divided into fetchable units, and the thing you actually write.**
  It asks one question — *where does one partition's rows live?* — and derives the rest of the plumbing from the
  answer:

  ```ts
  const schedule = definePartitions<ScheduleSqlRow, ScheduleKey>({
    name: 'schedule',
    table,
    version,
    key: {
      fields: ['sport', 'season', 'seasonType'],
      where: ({ sport, season, seasonType }) => ({ sport, season, season_type: seasonType }),
    },
    fetch: {
      query: (key, etag) => getScheduleRawQuery(key, etag),
      parse: (key, rawJson) => buildScheduleRows(key.sport, key.season, key.seasonType, JSON.parse(rawJson)),
    },
  });
  ```

  `key.where` is a `WHERE` over your table — the same shape `table.find` takes — and it locates the partition for
  every operation the kernel runs on your behalf: reading and writing its ETag (`table.getMeta`/`setMeta`),
  testing whether it holds rows yet (`table.has`), replacing its rows on ingest, and bumping its version on a
  write.

  `key.fields` names the key's fields in the order they are spelled into the version and query keys, and that
  ordering is the only place a partition is ever positional. Everything you write — every `fetch` callback, every
  read's `select` — is handed the **key**, your own type.

  Use `key.of` + `key.id` instead of `fields` when your partition is a **record** too big to be a key, which is
  what `player_stats` has: a `StatPartition` addresses its rows by the string `partitionKey` hashes it to, and
  the fetch needs the record back to build a URL from. `of` says how a read's args reach the record, `id` says
  what it hashes to, and declaring them hands the record⇄key table to this module. Every path that names a
  partition files it away on the way through, so the entry backing anything on screen stays warm, and your
  `fetch` callbacks are handed the record itself. The interning is this module's. `of` may answer `null` for args
  that address no partition — a locator a screen is still filling in — and such a read is off, primes nothing, and
  returns its `empty`, the same as a field that has not arrived.

  `fetch` is the store's real fetch behaviour and nothing else: the request, and how a body becomes rows.
  Everything mechanical around it belongs here — trying the native shred, falling back to a JS parse and
  reporting the degradation when it can't run, holding the ETag, recording when rows landed, bumping. Two
  optional members cover the cases that vary: `canShredNatively` for a body the native pass can't iterate, and
  `holdWrites` for a store that also takes socket writes. Leave `fetch` off entirely for a push-fed store.
  `onChanged` sits beside it, for a store holding a derived rollup that a partition's new rows invalidate.

  Back you get the read surface (`read`, `readMany`, `readGrouped`), the row-filter primitives your hydration and
  writes need (`where`, `keyOf`, `has`, `versionOf`, `bump`, `clearEtag`), and a ready-made **`lifecycle`**
  group — `usePrime`, `usePrimeMany`, `usePrimeAndVersion`, `has`, `getVersion`, `getFetchedAt`, `fetch`,
  `refetch`, `invalidate`, `forget`. Every member takes the same **args** a read does, in the `(args, options?)`
  call shape a backend publishes, so both `player` and `player_stats` publish the group unchanged
  (`lifecycle: players.lifecycle`) rather than restating it. `usePrime` and `usePrimeAndVersion` take those args
  loosely, so a screen calls them with what it has, exactly as it calls a read: a field that has not arrived leaves
  the key unaddressable, and `key.of` answers `null` for args that name no partition, so neither primes anything.
- **`createFetchIngest`** — the fetch engine `definePartitions` composes: React Query orchestrates a raw-text fetch
  (ETag-conditional), `ingestRaw` shreds it into the row table, the version bumps. Gives you `usePrime` /
  `usePrimeMany` (reactive, one partition or a variable set) and `ensure` (imperative self-heal). Generic over
  your key, with `toParts` the one place it is spelled positionally. You should not need to call this directly.
- **`createPushIngest`** — the same job for rows that arrive by socket rather than by fetch. Pushes come in far
  faster than they need to be persisted, one item at a time rather than one partition, and they can land on a
  partition a fetch is midway through deleting and rewriting — so this buffers per partition, dedupes by
  `idOf`, writes in bounded chunks off the render path, requeues a failed chunk without overwriting anything
  newer, and lets a partition be **held** for the length of a fetch. Give it `idOf`, `toRows`, `bump` and
  `onWrite`; you get `queue` and `hold`. The `hold` is what `definePartitions`'s
  `fetch.holdWrites` wants. Only `player_stats` is push-fed today.
- **`rowsOf(table)`** (`row_shaping.ts`) — a hydration's whole read side: ask it for rows, then say what shape you
  want them in. `rows.where(filter, opts)` and `rows.in(filter, column, values)` are the two queries, `.given(rows)`
  wraps rows you already hold, and each hands back something with `.rows`, `.map(fn, empty)`, `.indexed(column)`,
  `.grouped(column)` and — for `.in` — `.ordered(mapper, empty)`. Every shape returns the caller's **stable empty**
  when nothing survives. `ordered` is for an index-parallel result: SQL `IN` does not preserve argument order and
  `findIn` chunks on top of that, so a caller treating rows as parallel to the ids it asked for needs them reordered
  — which is why it hangs off `.in` alone and cannot be reached from a query that has no ids.
- **`partitionLabel(parts)`** (`args_key.ts`) — a partition's parts joined on `:` for a log line or a telemetry
  field. Never a key: `:` occurs inside a part (`clubsoccer:epl`), which is why keys don't use it. Keys themselves
  are not the caller's to build — a read's is the engine's, and a memo's comes from the partition it is bound to.
- **`chunkList` / `getOrCreate`** (`collections.ts`) — bounded batches, and the `Map` entry that may not exist
  yet.
- **`createVersionAtom`** — per-partition integer reactivity (a module-level `useSyncExternalStore`). `bump`
  on write; `useVersion` to subscribe; `useSelect` to subscribe + read a value with a bail-out; `get` for
  imperative reads.
- **`createReadSurface`** — **the read engine, reached through `definePartitions`'s `read` / `readMany`.** A read is
  one identical five-part shape — locate the partition, prime it, subscribe its version, select a bounded
  subset, wrap in an envelope. You declare it once as a `read<Args, Value>()({ partition, varyBy, select, empty })`
  descriptor — two calls, the first naming what the read takes and returns and the second taking the read, which is
  what leaves TypeScript free to infer `varyBy` from the list itself — and
  the engine generates both halves: `read.getValue` (imperative, self-priming, reference-stable) and
  `read.useValue` (reactive `DataResult<T>`; named `useValue` so React Compiler treats it as a normal hook,
  not React's `use()` API). Your
  only job is `select(args, key)` — the SQL subset → VM — everything mechanical is the engine, including skipping
  `select` entirely while the partition is still empty. A store's read surface becomes a small table of
  `read` descriptors.

  `partition` **defaults to the store's `key.fields`, or to `key.of` for a record partition**, so a read
  declares no partition at all — which is most reads in `schedule` and every read in `player` and `player_stats`.
  Give it explicitly only for an address one read computes differently from its siblings. `readMany` always names
  its own `partitions`, since the set is the read's. `varyBy` is everything else `select` reads — named as args
  fields (`varyBy: ['playerId']`) or computed — and it is both the read's cache key and its gate: the read is off
  while any of those values is absent.

  Prefer the field names, which is the form that carries its own guarantee: `select` is handed those fields and
  nothing else, each non-null, so a cast at the call is unnecessary and reaching an arg the read never declared —
  the mistake that would serve one caller's value to the next — does not compile. A computed `varyBy` names no
  fields to narrow to, so such a read is handed the whole args and answers for them itself;
  `sleeper/no_undeclared_select_arg` is what holds it to the same rule.

  Three variations cover the rest of the stores: `readMany({ partitions, … })` for a read spanning a variable set
  of partitions (it observes the same fetches through `usePrimeMany`, so it reports loading like any other read);
  `readGrouped({ groups, … })` when the caller is asking about several things at once and each has its own
  candidate partitions — `select` gets the groups back in the order it named them, so a read never flattens a list
  and then re-slices it by index; and, for a push-fed table, leaving `fetch` off, so its reads report `success`
  over an empty value. The kernel takes the fetch half as one value: the priming hooks and the refetch that goes
  with them are supplied together or not at all.
- **`partitions.memos`** — every memo a store holds, in one block, and the only way it builds one:

  ```ts
  const memos = schedule.memos({
    summaryMap: byVersion<ScheduleSummaryMap>()({ max: 2048 }),
    playerRow: bySource<PlayerRowVM>()({ max: 4096, by: ['playerId'] }),
  });

  memos.summaryMap.for(key).read(() => deriveSummaryMap(rows.where(where(key)).rows));
  memos.playerRow.for(key).put(playerId, row.data_json, () => toVM(row));
  ```

  The block is reached off the store's partitions, which is what makes `.for(key)` possible: the memo takes both
  the partition's key and its current version from there, so **no store builds a memo key or looks up a version**.
  What a store still names is `max`, which bounds what it derives onto the heap, and `by`, which is what the key
  holds beyond the partition — one argument to `.for(…)`'s methods per name, in order, each either a scalar or a
  structured value the kernel interns. So the block stays a complete, reviewable account of the store's heap, which
  is the point: the judgment below is made by reading the keys. Each memo carries a dev-time watch that reports
  itself too small for the keys it keeps being asked for again, and reports itself if it has never once answered
  from its entry.
- **`byVersion`** — a memo dropped by every write to its partition, with optional content-stable reference reuse: on
  a bump that didn't change an entry, hand back the _same reference_ so downstream shallow-equal bails.
  `read(…parts, compute)` is the whole memo in one call; `peek`/`set` are its batched half, for a caller that
  gathers its misses and computes them in one round-trip.

  Reach for it when **several reads** derive the same value from a partition's rows, or when **one read consults it
  per item**. Both mean the key is not the read's key, which is the whole test: the read surface already memoizes
  `select` per `(partition + varyBy, version)`, so a memo one read owns, keyed as that read is keyed, is the same
  cache twice at two sizes — the pair performs as whichever is smaller. Reach for `getCacheMax` instead.
- **`bySource`** — the other of the two, and the one a hydration reaches for. A version
  alone skips the **SQL round-trip** for a read no write invalidated, but it misses for every entry in a partition
  the moment anything in it changes. A source — the `data_json` the value was built from — survives that miss and
  hands back the same reference, which is what keeps one socket flush rewriting one player's row from repainting
  every reader of every other row in the partition. This carries both in one entry: `peek(…parts)` answers
  with no query at all, and `put(…parts, source, build)` rebuilds only when the source really moved.
  **If a read's value feeds a downstream identity comparison — and every `isEqual` on a read descriptor is one —
  hydrate it through this.** All three of `player_stats`' hydrations do.

  Two rules when you add one. Name the filter that produced the entry in `by` as well as the entity, or two
  reads holding different rows for the same entity re-hydrate each other on every call. And leave
  whole-collection reads out of it: one of those evicts the bounded reads' entries and costs more than the
  repaints it saves.

  The name a report points at is the one the block gave it. This is the cache where too small is
  worth catching at runtime, since a rebuilt value is a new reference and so a repaint no `isEqual` can bail
  out of — a cost that lands spread across React's render phase, where a profile has nothing to point at. A
  versioned cache that is too small costs a recompute instead, pooled under one function, so it is left to
  the profile and carries no name.
- **`offHeapStatus`** — the loading-status rule (`loading` while a cold fetch is in flight, else `success`).
  The engine calls this for you; bespoke batch reads call it directly.
- **`shallowEqualValue`, `shallowEqualRecord`, `shallowEqualArray`, `shallowEqualStruct`** — the `isEqual` family. A
  read that names none gets `shallowEqualValue`, which is one level the way a store would have written it by hand: a
  list by its elements, a record by its values, anything else by identity — so a hydration rebuilding a list or a map
  out of unchanged parts bails its readers out without being asked to. Name one only where a level is not enough,
  which in practice means `shallowEqualStruct` for a struct: it takes a check per field for the fields holding a
  record or a list and compares the rest with `Object.is`, so a scalar field added later is covered without touching
  the call. `shallowEqualRecord` and `shallowEqualArray` are the two it composes, for a memo handing one over.

**Declare reads through the engine; no store here hand-writes one.** If you ever need to, two rules apply:
every imperative getter must call `version.get(parts)` on **every** call, cache hit included, or its reads
become invisible to both the tracking scope and the DEV guard below; and if the hook reads during render while
subscribing itself, wrap the read in **`runSubscribed(() => …)`** so the guard knows the subscription exists.
`createReadSurface` and `useSelect`/`useSelectMany` already do both for you.

**The guard:** in `__DEV__`, a read that happens during render with nothing subscribing it logs a warning
naming the partition and the component (`reactivity/tracking.ts` + `reactivity/render_phase.ts`). That failure is invisible on
screen — the value is correct on first paint and then frozen — so it is checked at the single choke point every
read passes through. Reads outside render (callbacks, reducers, socket handlers) are deliberately unsubscribed
and stay silent.

---

## The recipe for a normal store (copy `schedule`)

A store is ~9 small files grouped by the direction data travels, and all three existing stores have the same
layout. Mirror `schedule`:

```
<store>/
  types.ts        schema.ts        the spine both directions import
  write/          raw_query.ts  ingest.ts
  read/           view_models.ts  hydration.ts
  backend.ts      store.ts  index.ts
```

1. **`types.ts`** — the store's *inputs*: the payload it ingests and the param-key types (`XKey`). Nothing a
   caller receives goes here. The `Backend` interface is derived in `backend.ts` from the read set (see step 6).
2. **`schema.ts`** — one `ShredColumn` table, and the `RowTableSchema` (columns, indexes, meta) generated from
   it. The row type is `RowOf<typeof COLUMNS>`, so declaring a column is the only step to adding a field.
3. **`write/raw_query.ts`** — the React Query descriptor for the fetch (URL, ETag param).
4. **`write/ingest.ts`** — payload → rows: `build<Name>Rows(raw)` and, if the payload is big enough to be
   worth shredding in C++, the `NativeShredSpec` whose ops must match the columns' `js` builders.
5. **`read/view_models.ts`** — everything a caller can be handed and the code that builds it: the VM types,
   the row→VM mappers, the empty sentinels, and any pure derivation over a bounded set of VMs. No store
   access, so it stays trivially testable. Back-compat shapes for pre-store callers go at the bottom, marked
   as such.
6. **`read/hydration.ts`** — the getters that query a slice of rows and map it to VMs, built with the
   partition's own `where` and `versionOf` so neither is restated. Everything a `select` calls lives here,
   which is what keeps each read in step 7 to one line.
7. **`backend.ts`** — compose the kernel: `table.init()`, one `definePartitions({ key, fetch })`, then a
   `reads` table of one descriptor per read, each declared with that partition's own `<partition>.read(...)`
   (each gives a `{ getValue, useValue }` pair). A read is declared ONCE here: `export type XBackend =
   ReturnType<typeof buildXBackend>` infers the interface, and the `reads` table itself is the public read
   surface. This is the only "logic" file, and in `schedule` it is still small.
8. **`store.ts` + `index.ts`** — `defineSqliteStore(...)` and the imperative `XStore` handle (for
   `mapStateToProps` / non-React callers). The `<name>_service` facade publishes each read with `pairRead`,
   which hands back the `use`/`get` pair from one declaration — see **the facade** below.

A store with more to say adds to these folders rather than to the root: `player_stats` puts its socket writer
in `write/live_ingest.ts` and its SQL-filtered reads in `read/filtered_reads.ts`, and keeps its ranking
subsystem in `ranking/`. That store is also the one exception to "every column is declared in `schema.ts`": its
`s_*`/`d_*` columns are generated per sport from the scoring keyspace, so they are declared in
`ranking/score_sql.ts` and merged into the schema — `schema.ts` says so at the top.

### What the backend returns: `{ reads, push?, lifecycle? }`

Three groups, and which one a new function belongs in is decided by who calls it, not by what it does:

| group | holds | who has one |
| --- | --- | --- |
| `reads` | one `read`/`readMany` descriptor per read. Required — a store with nothing to read is not a store. | all three |
| `push` | a caller handing rows **in** | `player_stats` |
| `lifecycle` | partition-level operations that neither read rows nor write them: priming, freshness, invalidation | all three |

**A fetch-fed store's ingest belongs to the partition's `fetch`, and the only way rows arrive is a fetch the read
surface already triggers — the common case.** You add `push` when rows arrive from
somewhere the kernel doesn't own (a socket). `lifecycle` is where a caller outside the read path primes, checks
freshness or invalidates a partition; `schedule` needs only `forget` there, while `player` and `player_stats` also
prime. `player_stats` is the store to read when you want all three groups in one file, being the only one that is
both push-fed *and* fetch-fed.

A group with no members is left off rather than declared empty, so a backend's shape tells you what kind of store
it is at a glance. `StoreBackendShape` requires `reads`, and the app's own `stores/tests/backend_shape.test.ts`
fails on a fourth group name, which keeps the grouping exhaustive enough to rely on when reading an unfamiliar
store.

### The facade

The service facade publishes reads; it does not re-implement them. `pairRead` takes the read and returns both
halves, with params typed as `Loose<Args>` so a caller may pass what it has:

```ts
const Reads = {
  TeamSchedule: pairRead(() => getScheduleStoreBackend().reads.TeamSchedule),
};

export const Hooks = { useTeamSchedule: Reads.TeamSchedule.useValue };
export const Get = { getTeamSchedule: Reads.TeamSchedule.getValue };
```

The read supplies its own gate. `read({ … })` publishes `requires` — its partition's fields plus its `varyBy`
fields — and the pair holds the read inert until a caller has every one of them, so the facade restates nothing the
store already declared. A field counts as in hand unless it is `undefined`, `null` or `''`; `[]`, `0` and `false`
are answers, and what a read does with an empty list is its `varyBy`'s business. A read naming its partitions with a
function, where there are no fields to read them off, declares `requires` itself — `player_stats`' `LocatedRow`
takes a stat key it parses into candidate partitions, and requires that key.

A facade read's params are the store read's own args, so a service names no vocabulary of its own and translates
nothing: `pairRead` takes the read and nothing else. `pairRead` throws on a read that publishes no `requires`, since
it has been asked to gate on nothing.

Both halves resolve the backend per call, so the SQLite bind at startup is picked up by callers that ran before
it. Publishing only one half is what pushes a Redux selector into a loop of point reads, so a guard test in the app
(`stores/tests/read_pairing.test.ts`) fails on a read that ships without its twin.

The wiring itself (step 6) is one descriptor — `defineSqliteStore` folds the version atom, the swappable
backend registry, the in-memory web/test default, and the SQLite bind builder:

```ts
const myStore = defineSqliteStore<MyRow, MyBackend>({
  name: 'my_store',
  schema: mySchema,
  buildBackend: buildMyBackend, // (rowTable, version, caps) => backend
});
export const getMyBackend = myStore.getBackend;
export const setMyBackend = myStore.setBackend;
export const createSqliteMyBackend = myStore.createSqliteBackend;
```

…and mobile binds it in one line (`init_my_store.ts`):

```ts
export const initMyStore = () => bindSqliteStore('initMyStore', 'my.db', setMyBackend, createSqliteMyBackend);
```

Caching, reactivity and fetch orchestration are the kernel's; a store does not write its own.

Two optional fields, and nothing else: `nativeShredSpec` for a native (simdjson) ingest shred, and
`sqliteCapabilities` for an accelerator that needs the live connection. Every store falls back to the same
backend over an in-memory row table, so the two platforms can only differ in where the rows live. The fallback is
built on first read, so a platform that binds SQLite first never constructs one at all.

---

## Taking rows from a socket (copy `player_stats/write/live_ingest.ts`)

Rows that arrive over the socket rather than from a fetch. `player_stats` takes both, which is the shape to copy:
a fetch fills a partition, and live frames keep it current.

1. **A `push` group.** `push.ingestStats(stats)` is how frames get in, beside the `lifecycle` group the fetch
   half needs.
2. **A buffered flush behind that write** (see below).
3. **A decision about frames for partitions nothing has fetched.** `player_stats` creates the partitions a stat
   names rather than dropping it, because live scoring is the only source for a game no screen asked the API
   for. Make this choice explicitly: it decides whether a score can appear at all.

A store fed *only* by a socket leaves `definePartitions`'s `fetch` off, so its reads report `success` over
an empty value, and sets `pushFed: true` on the schema so a rebuild of a table no fetch can refill says so out
loud. No store is push-only today.

### The buffered flush

A bulk completion carries thousands of rows at once, and writing them inline froze JS for ~2s. So `ingest` never
writes: it stages rows and returns, and a scheduled task does the work. Five properties carry that, and each one
is load-bearing:

- **Stage into a `Map` keyed by row identity.** Two frames for the same stat inside one flush window collapse to
  the last, which is what makes a burst cost one write per *row* rather than one per *frame*.
- **Flush on a macrotask, chunked, yielding between chunks.** `setTimeout(0)` gets it off the current frame;
  `upsert` in chunks of 250 with a yield between them keeps a long flush from becoming the same block in a
  different place. Reactivity lands a frame after the write resolves, which is the deliberate trade.
- **Bump every touched partition once, inside `notifyManager.batch`.** The flush collects the distinct partitions
  it wrote and bumps them together, so a thousand rows across four partitions is four bumps in one React commit.
- **On failure, requeue only what no newer write replaced** (`if (!pending.has(key))`) and retry after a delay.
  The guard is what keeps a retry from putting a superseded score back over a fresher one, which is the one
  failure in here that reaches the screen as wrong data rather than as jank.
- **Clear the partition's ETag on every socket write** (`onSocketWrite`). The ETag describes the last body the
  *fetch* ingested, not the socket's writes over it, and the rows outlive the process — so the next launch would
  304 and keep a game frozen where the socket left it. Costs nothing while the game is live, since a body the
  socket is tracking is changing and would not have matched anyway.

---

## Map of the files here

**What earns a place in this package:** the kernel is the store-authoring vocabulary — the pieces you compose to
write a store. Being generic is not the bar, and neither is having more than one caller: a mechanism belongs here
when a *store author* reaches for it. So `read/windowed_list.ts` lives here with a single
consumer today, because "windowed list read" is one of the read shapes you choose between when writing a store;
whereas `native_ranker.ts`'s compute-table LRU is just as generic and stays inside `player_stats`, because no
store author picks it — it's how that one store's ranked scan happens to work. A per-store mechanism moves here
when a second *store* needs it, which is also the point at which its shape has been checked against more than
one caller.

Reusable kernel (you use, never fork):

The root holds what a store declares itself with, plus the primitives every folder below needs. The folders
follow the trip a row takes: it lands in a `table/`, gets there through `write/`, comes back out through
`read/`, and the component that asked hears about it through `reactivity/`.

| file                                             | role                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `define_sqlite_store.ts`                         | the SQLite-or-memory descriptor a store declares itself with, and the spine it builds: version atom, backend slot, degrade path |
| `define_partitions.ts`                    | one table's partitions: their keys, their fetch, and the lifecycle over them |
| `store_result.ts`                                | the `DataResult` envelope, and the `offHeapStatus` rule that fills one     |
| `prime_state.ts`                                 | what a read knows about the fetch behind its partition — the contract between the two, so neither imports the other |
| `key.ts`                                         | how a key's parts are joined, on a separator no part can contain; imports nothing, so anything may have it |
| `args_key.ts`                                    | what a read's key is derived from: a value by its content, a partition, a vary list |
| `caches.ts`                                      | bounded LRU, the two memos and the block that binds them to a store's partitions, and the `isEqual` family |
| `collections.ts`                                 | `chunkList` and `getOrCreate`                                             |
| `runtime.ts`                                     | the host's two services — where a report goes, and the query runtime an ingest mounts on — and the inert defaults until one is installed |

| `table/` — where rows live                       |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `types.ts`                                       | the schema types and the `RowTable` contract both backends implement      |
| `sqlite.ts`, `memory.ts`                         | the two backends behind that contract; `query.ts` holds the `where`/order semantics they must answer identically |
| `schema.ts`                                      | what `init` builds, and the two stamps that decide between widening it and rebuilding it |
| `presence.ts`                              | whether a row filter holds rows, cached — a read asks far more often than it changes |
| `connection.ts`                                  | batch/read helpers over the native binding; routes reads to the reader handle (`pinnedReader` opts out, for `TEMP`-table readers) |

| `write/` — how rows get in                       |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `fetch_ingest.ts`                                | write-through fetch → shred → bump                                       |
| `push_ingest.ts`                                 | the push counterpart: buffer → dedupe → chunked write → bump, with per-partition holds for an in-flight fetch |
| `shred_columns.ts`                               | co-located shred column table (each column's `sql` + its `js` twin), and `defineShredColumns`, which binds it to everything derived from it — `names`, `columnDefs`, `row`, and, once every column declares an `op`, `namedOps` and `ops` |
| `shred_spec.ts`                                  | the native shred op language + its JS reference interpreter              |

| `read/` — how rows come out                      |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `surface.ts`                                     | the read engine — `read({ … })` → `{ getValue, useValue }`               |
| `partition_fields.ts`                            | the field specs a read names its partition and its vary key with          |
| `row_shaping.ts`                                 | `rowsOf`: a query, then rows → list / ordered list / record / groups, each with the stable empty |
| `facade.ts`                                      | what a service is written against: `pairRead`, so it exposes the hook and the imperative read together, plus the types its methods are spelled in (`ReadOptions`, `MaybeId`, `Loose`) |
| `windowed_list.ts`                               | windowed list reads (fetch a page, keep the rest off-heap), and the per-row `useWindowedDetail` that indexes back into one |

| `reactivity/` — how a write reaches a component  |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `version_atom.ts`                                | per-partition reactivity                                                 |
| `tracked_selector.ts`, `tracking.ts`             | off-heap-aware reselect, for reads reached from Redux selectors; also the DEV guard that catches an unsubscribed render read (`render_phase.ts` is its phase probe) |

| `diagnostics/` — how the layer reports on itself |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `telemetry.ts`                                   | reports silent perf degradation (a native fallback that stayed correct)  |
| `ingest_timing.ts`                               | per-ingest timings, rolled up for the dev overlay — the `./diagnostics` entry, which no shipping screen reads |
| `once_guard.ts`                                  | warn-once guards that a test can reset                                   |

| `nitro/` — the device                            |                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `nitro_connection.ts`                            | the `SqliteConnection` over `react-native-nitro-sqlite`: pragmas, param coercion, the native shred sentinel, and the binds that degrade rather than throw |

Two more entries ship beside the core one. `./diagnostics` holds what a developer surface dumps —
`getIngestTimings` and `rollupIngestTimings` — kept out of the core entry because a shipping screen has no
business reading them. `./testing` is what a store's tests are written against: `sqljs_connection.ts` (a real
SQLite engine for parity tests), `version_atom.ts` (in-process version atom with working `subscribe`),
`runtime.ts` (the host services as spies), `memos.ts` (a store's `memos` for a suite that builds one module
rather than a whole backend), and `dev_mode.ts` (the wrappers pinning a case to one build). It also re-exports the
handful of internals that only a test reaches for — a real `createVersionAtom` to bump by hand, `evalShredElement`
to check a native shred against, and `resetOnceGuards` — which is why those are absent from the core entry.

Bespoke per store (the domain half you write, in the app): `schedule` is the small template, `player` is the same shape over
a much larger payload (a native shred, and a `lifecycle` group), and `player_stats` is by far the largest — a
fetch ingest, a buffered socket ingest, its backend **plus** the
native-compute tier (`ranking/native_ranker.ts`, `ranking/score_sql.ts`), which is advanced, opt-in, and
used by that one store.
