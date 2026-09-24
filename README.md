# `@sleeperhq/react-data-kernel`

A SQLite-backed data layer for React. Large datasets live in the database instead of on the JS heap, and only
the slice that is on screen is ever materialized in JS.

Underneath, that is all this is: a reactive wrapper around a SQLite database. You declare a table, how a slice of
it is fetched, and what each read hands back. The kernel owns the SQL, the conditional fetch, the caching and the
re-render.

```ts
const { data: items, isLoading } = GroupItems.useValue({ params: { groupId } });
```

That read is subscribed to one slice of one table. It fetches the slice if the database doesn't have it yet,
re-renders when a row in it changes, and re-renders nothing when a row outside it does.

## Why

A reference dataset held in JS costs heap for as long as the process lives — every object, on every launch,
whether or not anything is on screen, plus whatever the garbage collector spends walking it. Held in SQLite, the
resident cost is the slice being looked at.

Doing that one dataset at a time by hand means re-solving the same problems each time: a schema and its
migrations, a conditional fetch, rows back into view models, invalidation, and getting React to re-render the
components that care and no others. That is what this package is.

## Requirements

React 17 or newer and `@tanstack/query-core` 4 or newer. Every store runs on SQLite, and every query is written once:
on device it comes from `react-native-nitro-sqlite` through the `./nitro` entry point, and on the web from sql.js, the
same engine compiled to WebAssembly, through `./sqljs`. Tests use sql.js too, through `./testing`.

## Install

```jsonc
// package.json
"@sleeperhq/react-data-kernel": "blitzstudios/react-data-kernel.git#react-data-kernel-v0.10.3-gitpkg"
```

## Quick start

A store is a table, a key that divides it into fetchable slices, and one or more reads. The store below holds
items belonging to a group, fetched one group at a time.

### 1. Declare the columns

One entry per persisted column. The row type and the `CREATE TABLE` are both generated from this, so adding a
field means adding a column here and nothing else.

```ts
import { defineShredColumns, RowOf, RowTableSchema, ShredColumn } from '@sleeperhq/react-data-kernel';

type RawItem = { id: string; name?: string; rank?: number };
/** Values that belong to the slice rather than to the payload. */
type ItemCtx = { groupId: string };

export const ITEM_COLUMNS = [
  { name: 'group_id', type: 'TEXT', notNull: true, js: (_item: RawItem, ctx: ItemCtx): string => ctx.groupId },
  { name: 'item_id', type: 'TEXT', notNull: true, js: (item: RawItem): string => item.id },
  { name: 'name', type: 'TEXT', js: (item: RawItem) => item.name ?? null },
  { name: 'rank', type: 'INTEGER', js: (item: RawItem) => item.rank ?? null },
] as const satisfies readonly ShredColumn<RawItem, ItemCtx>[];

export type ItemRow = RowOf<typeof ITEM_COLUMNS>;
export const itemShred = defineShredColumns<RawItem, ItemCtx>()(ITEM_COLUMNS);

export const itemSchema: RowTableSchema<ItemRow> = {
  table: 'items',
  columns: itemShred.columnDefs,
  primaryKey: ['group_id', 'item_id'],
  // What a view model is about: the grain every write reports its changes in, and a read subscribes at.
  unit: 'item_id',
  indexes: [{ name: 'idx_items_group', columns: ['group_id'] }],
  // Where the per-slice ETag is kept, so a refetch can come back 304.
  meta: { table: 'items_meta', keyColumns: ['group_id'], column: 'etag' },
};
```

### 2. Declare the store: its slices and its reads

`definePartitions` asks one question — where does one slice's rows live? — and derives the rest from the answer:
presence, what a fetch replaces, where the ETag goes, what a write bumps. `read` then turns a slice of rows into
whatever the screen actually wants. Both live in the store's `build`, which is the store over one row table.

```ts
import { definePartitions, defineSqliteStore, rowsOf } from '@sleeperhq/react-data-kernel';

export type ItemKey = { groupId: string };
export type ItemVM = { id: string; name: string };

const NO_ITEMS: ItemVM[] = [];
const toVM = (row: ItemRow): ItemVM => ({ id: row.item_id, name: row.name ?? '' });

export const itemStore = defineSqliteStore({
  name: 'item_store',
  schema: itemSchema,
  build: (table, version) => {
    table.init();
    const rows = rowsOf(table);

    const items = definePartitions<ItemRow, ItemKey>({
      name: 'items',
      table,
      version,
      key: {
        fields: ['groupId'],
        where: ({ groupId }) => ({ group_id: groupId }),
      },
      fetch: {
        query: ({ groupId }, etag) => ({
          queryFn: async () => {
            const response = await fetch(`/groups/${groupId}/items`, { headers: etag ? { 'If-None-Match': etag } : {} });
            return { data: await response.text(), etag: response.headers.get('etag') ?? undefined };
          },
        }),
        parse: ({ groupId }, rawJson) => (JSON.parse(rawJson) as RawItem[]).map((item) => itemShred.row(item, { groupId })),
      },
    });

    return {
      reads: {
        GroupItems: items.read<ItemKey, ItemVM[]>()({
          select: (_args, key) => rows.where(items.where(key), { orderBy: 'rank' }).map(toVM, NO_ITEMS),
          empty: NO_ITEMS,
        }),
      },
      lifecycle: items.lifecycle,
    };
  },
});
```

`select` runs only once the slice holds rows, and again only when something it read has changed. `empty` is what
callers get before that, so it has to be a stable reference.

Until it is bound, a store runs over a connection that answers nothing, so each read gives back its `empty`. Startup
binds it (step 4). On device, a SQLite failure mid-session reopens the database, deleting it first when the file is
what failed, and after two failed reopens moves the store to an in-memory database: the same SQLite, with the store's
tables in the connection's temp schema. `build` runs again each time the store moves, so it holds nothing outside what
it returns — and `itemStore.reads` always reaches whichever connection is running, so callers hold the store rather
than anything taken off it.

#### Priming is by partition, not by what a read selects

Reading a cold partition fetches it, automatically, and that is meant to be unremarkable — it is most of why the
layer exists. Worth knowing once, though: the fetch is scoped to the **partition**, never to what the read selects.

```ts
ItemsByIds: items.read<ItemIdsKey, ItemVM[]>()({
  varyBy: ['ids'],
  select: (args, key) => rows.byIds(items.where(key), args.ids),
  empty: NO_ITEMS,
}),
```

That read asks for a handful of ids. If `items` partitions by league and a league holds thirty thousand rows, the
first such read fetches thirty thousand rows. The gap can be three orders of magnitude and it is invisible at the
call site, which sees only `useItemsByIds({ league, ids })`.

This is a property of the store's **fetch granularity**, not of the read, and no setting on the read improves it.
Where it bites, the fixes are:

- at the call site — if the payload that named those ids already carries what you render, render from that and do
  not read the store at all;
- in the store — a narrower partition key, where the API offers one.

`prime: false` exists but is not that fix. It means *never fetch on this read's behalf*, and it is for a read that
guesses across candidate partitions, or a selector over rows something else is responsible for fetching. A read
using it is `empty` until whoever owns the fetch has run.

Nothing here has to be declared. An ingest landing more than a few thousand rows files one `info` report per
partition per session, which is how an over-large partition makes itself known — including one that was a
reasonable size when the read was written and grew since.

### 3. Publish a read, and call it

`pairRead` publishes each read as both halves at once: a hook for components, and an imperative getter for
everything else. A read declares which args it waits on, so the pair stays inert until a caller has them.

```ts
import { pairRead } from '@sleeperhq/react-data-kernel';

export const GroupItems = pairRead(() => itemStore.reads.GroupItems);
```

```tsx
function ItemList({ groupId }: { groupId?: string }) {
  const { data: items, isLoading } = GroupItems.useValue({ params: { groupId } });

  if (isLoading) return <Spinner />;
  return <List data={items} renderItem={({ item }) => <Row name={item.name} />} />;
}
```

Calling it with no `groupId` is fine: the read addresses nothing, fetches nothing, and hands back `empty`.

### 4. Wire it up at startup

The host installs two services, and binds each store to its platform's SQLite.

```ts
import { configureDataKernel } from '@sleeperhq/react-data-kernel';
import { AppState } from 'react-native';
import { bindSqliteStore, retrySqliteStores } from '@sleeperhq/react-data-kernel/nitro';

configureDataKernel({
  errors: { captureException, captureMessage },
  query: { client: () => queryClient, useQuery, useQueries },
  gate: { useReadGate },
});

bindSqliteStore('initItemStore', 'items.db', itemStore);

// A store whose database would not open — a launch in the background before the device's first unlock, say — tries
// again when the app comes back.
AppState.addEventListener('change', (state) => state === 'active' && retrySqliteStores());
```

On the web, the app loads sql.js and binds each store to a database of its own, held in memory for the page:

```ts
import initSqlJs from 'sql.js';
import { bindSqlJsStore } from '@sleeperhq/react-data-kernel/sqljs';

initSqlJs({ locateFile: (file) => `/static/${file}` }).then((SQL) => bindSqlJsStore('items', SQL, itemStore));
```

`useQuery` and `useQueries` are passed in rather than imported, so an app keeps its own fetch policy — focus
gating, retries, whatever it already does. Until `configureDataKernel` runs the kernel is inert: reads answer
from rows already stored, and nothing fetches.

A database that will not open or migrate is retried once from empty, since it is only a cache. A store that still
cannot bind, or that left its file mid-session, runs on its in-memory database until `retrySqliteStores` moves it
back, at most three times a session. `bindSqliteStore(…, { inMemory: true })` skips the file altogether, which is
what a kill switch wants, and `{ shredInJs: true }` ingests through the JS row builders instead of the native shred,
for a switch over that native code.

`useReadGate` is the same idea for the read side. It answers one question — is this read still taking writes? —
and the kernel never learns why the answer changed, so an app decides whether a blurred screen, a hidden subtree
or a backgrounded app counts:

```ts
const useReadGate = () => {
  const controller = useFocusController();
  return useMemo(() => ({ isLive: () => controller.isFocused, onChange: controller.onFocusChange }), [controller]);
};
```

While a gate is dead its reads drop their subscription and hold the value they last had, then catch up in one
render when it goes live again. They do not blank, and the gate never reaches the render — a read that
re-rendered on gate changes would wake every screen in the stack on each navigation, which is the cost this
avoids. Configure no gate and every read stays live.

## Concepts

Three words, and they nest:

| term | what it is |
| --- | --- |
| **table** | the rows themselves, in SQLite: the device's own, and sql.js on web and in tests, behind one `RowTable` interface |
| **partition** | one addressable slice of a table: what a fetch replaces and an ETag belongs to |
| **unit** | what a view model is about — an item, a player — declared on the schema. Every write reports the units it changed, and a read of named units depends on those alone. One unit may span several rows |
| **store** | the module wrapping both, declared with `defineSqliteStore` |

A store has as many partitions as its callers ask for — one per group, or thousands, one per entity.

## What you get without writing it

- **Conditional fetch.** Each slice keeps its own ETag, so a refetch that hasn't changed costs a 304 and no
  write. Fetches are orchestrated through the host's React Query, deduped and shared between readers.
- **JSON that never becomes objects.** A response body can be shredded from text straight into columns in C++,
  so a large payload is never a JS object graph. Declaring a `NativeShredSpec` is optional; without one the same
  columns are filled by their JS builders.
- **Schema migration with no migration to write.** `init` fingerprints the schema it built. A database whose
  fingerprint no longer matches is migrated on the spot — widened by `ALTER TABLE ADD COLUMN` when the change
  only added columns, rebuilt from the next fetch otherwise.
- **Writes that say what they changed.** Every write compares what it was handed with what the table holds,
  rewrites only the units that differ, and reports them. A refetch that brings back what the table already holds
  changes nothing and wakes nobody; a live poll where four players moved wakes the readers of those four.
- **Reactivity per unit, found by reading.** A read subscribes to exactly what it read, discovered by running it: a
  read of named units through a projection or a unit memo depends on those units, and a read over the whole slice
  depends on the slice. Nothing is declared, and a read that takes rows straight off the table falls back to its
  whole slice, so precision is never bought with correctness.
- **Stable references for free.** Rows come back from SQLite as fresh objects, so a read rebuilding view models
  would repaint every subscriber. Declare the shape with `project` and the kernel keeps each unit's view model until
  that unit changes, handing back the same reference until then.
- **One query engine.** Every environment runs SQLite — the device's, sql.js on the web, sql.js in tests — so a store
  writes each query once, in SQL, and a test runs the SQL a device runs. A store whose database file keeps failing
  moves to an in-memory database on the same engine, so a disk error costs persistence, not speed.
- **Dev-only guards.** Reading off-heap during render without subscribing is correct on first paint and frozen
  after, which is invisible on screen — so in `__DEV__` it warns, naming the partition and the component. Other
  guards catch a store bound too late, a memo sized too small, and a read fanning out across a list.

## API

Everything below is exported from the package root.

### Declaring a store

| export | what it gives you |
| --- | --- |
| `defineSqliteStore(config)` | the store: `reads`, `push` and `lifecycle` on whichever connection is running, `capabilities` for what the store builds from that connection (a ranker running its own SQL, say), `bindSqlite` to run it on a connection, and `testing.over(conn)` for a test's own surface and the table to seed it through |
| `definePartitions(config)` | from `key.where` and an optional `fetch`: the read constructors, `lifecycle`, `memos`, and the row/version primitives (`where`, `keyOf`, `has`, `versionOf`, `bump`, `clearEtag`) |
| `defineShredColumns<Src, Ctx>()(columns)` | one column table bound to everything derived from it: `names`, `columnDefs`, `row`, and `ops` once every column declares one |

### Rows

| export | what it gives you |
| --- | --- |
| `createSqliteRowTable` | the `RowTable` over any SQLite connection; `{ temporary: true }` builds it in the connection's temp schema |
| `RowTable` | `init`, three writes (`upsert`, `overwrite`, `shred`) that each return the units they changed, reads (`getOne`, `find`, `findIn`, `has`, `unitsWhere`) and the ETag pair (`getMeta`, `setMeta`) |
| `ChangeSet`, `ALL_UNITS`, `NO_CHANGES` | what a write reports: the units it changed, every unit when it cannot say, or none |
| `readRows`, `pinnedReader` | batch reads over a connection, and the opt-out that pins one to a single handle |

The three writes differ in what they delete. `upsert` merges by primary key and removes nothing, which is what a
socket delta wants. `overwrite(where, rows)` makes the slice matching `where` be exactly `rows`. `shred` is that
same replacement from an undecoded response body.

On SQLite each write lands its rows in a staging table and one transaction compares them with the table, every
column and null-safe, then rewrites only the units that differ. A slice that holds nothing yet skips the stage:
with nothing to compare against, its rows go straight in and every unit counts as new.

### Getting rows in

| export | what it gives you |
| --- | --- |
| a partition's `fetch` | `query` and `parse`, plus `canShredNatively` and `holdWrites`; leave it off for a store fed only by pushes |
| `createPushIngest(config)` | rows arriving by socket: buffered per partition, deduped, written in bounded chunks off the render path, with per-partition holds for an in-flight fetch |
| `NativeShredSpec`, `ShredOp` | the native shred language, for filling columns without decoding in JS |
| `RAW_TEXT_RESPONSE_TRANSFORM` | keeps a client from `JSON.parse`-ing a body the kernel wants as text |

### Reading

| export | what it gives you |
| --- | --- |
| `partitions.read()`, `.readMany()`, `.readGrouped()` | a `{ getValue, useValue }` pair per read: one slice, a variable set of them, or one group of candidates per thing asked about. A `varyBy` value that is an object or an array keys by its content, and its identity is remembered per reference so a caller holding one across a list serializes it once — which is why `__DEV__` freezes it: a key remembered for a reference is only sound while the content holds still |
| `partitions.project()` | a view-model shape built one unit at a time: `.one`, `.byIds`, `.mapByIds`, `.where`, `.all`. You supply the unit's-rows-to-view-model function; a write rebuilds only the units it changed and hands back the previous reference for the rest. `.one`, `.byIds` and `.mapByIds` depend on the units they name alone; `.where` and `.all` on the slice, since which units match can move. Reads of the same shape share one projection, so a unit is built once however many ask |
| `pairRead(read)` | publishes a read's two halves on a service, gated on the args the read declares. They return the same value but do not fetch alike: `useValue` refetches on React Query's staleness, `getValue` fetches a partition that has never been fetched and otherwise leaves it |
| `rowsOf(table)` | a query, then a shape: `.rows`, `.map`, `.indexed`, `.grouped`, and `.ordered` for results parallel to the ids asked for — each returning the caller's stable empty |
| `createWindowedList(...)` | windowed list reads: fetch a page, keep the rest off-heap |
| `DataResult<T>`, `makeResult` | the envelope a read hands back, and the builder for a bespoke read the surface can't express |

### Reactivity

| export | what it gives you |
| --- | --- |
| `runTracked`, `runSubscribed` | the tracking scopes an imperative read runs inside |
| `createTrackedSelector` | off-heap-aware reselect, for reads reached from a Redux selector |
| `useTrackedValue` | the hook every reactive read goes through: runs a derivation, subscribes to exactly what it read, and honours the read gate — for a derivation over several stores, or over Redux as well |

### Memoizing derived values

| export | what it gives you |
| --- | --- |
| `partitions.memos({ … })` | every value a store derives onto the heap, declared in one reviewable block and keyed by the partition for you |
| `byVersion` | dropped by every write that changed its partition; for a value derived from the whole slice |
| `byUnit` | one entry per unit, kept until that unit changes; for a value built from one unit's rows. `readMany` answers what it holds and builds every miss in one call, so a read of a roster costs one query for the units that changed |
| `shallowEqualValue`, `shallowEqualRecord`, `shallowEqualArray`, `shallowEqualStruct` | the `isEqual` family a read compares its value with |

### Host services and diagnostics

| export | what it gives you |
| --- | --- |
| `configureDataKernel(services)` | where an error report goes, and the React Query runtime an ingest mounts on |
| `reportStoreDegradation`, `createOnceGuard` | how the kernel reports a silent slowdown, and warn-once guards a test can reset |

## Entry points

| entry | holds |
| --- | --- |
| `@sleeperhq/react-data-kernel` | everything above: what a store, a service or a screen writes against |
| `…/nitro` | `openNitroConnection`, `bindSqliteStore` and `retrySqliteStores`, over `react-native-nitro-sqlite` — the only part that touches native code |
| `…/sqljs` | `bindSqlJsStore` and `openSqlJsConnection`, over a sql.js module the app loads — what the web runs on |
| `…/testing` | sql.js off-device (`createTestRowTable`, `createSqlJsConnection`), an in-process version atom, the host services as spies, and the internals only a test reaches for |
| `…/diagnostics` | `getIngestTimings` and `rollupIngestTimings`, for a developer surface; no shipping screen reads these |

The core entry runs anywhere React does. Each subpath is declared twice — in `exports`, and as a stub
`package.json` beside `lib/` — because TypeScript and Metro still resolve the way Node did before `exports`
existed.

**`lib/` is committed.** Consumers install with `enableScripts: false`, so a gitpkg install never runs `prepare`;
a change to `src/` is not published until `yarn build` runs and the output is committed and tagged.

## Internals

[`docs/internals.md`](docs/internals.md) is the long form: every export in detail, the rules each one imposes,
the two schema fingerprints and how they decide between widening and rebuilding, what the push buffer does and
why each property of it is load-bearing, and a map of every file in `src/`. Read it when you need to know why a
piece behaves the way it does, or when you are changing the kernel itself.
