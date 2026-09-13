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

React 17 or newer and `@tanstack/query-core` 4 or newer. SQLite comes from `react-native-nitro-sqlite` and is
reached through the `./nitro` entry point; with no native database the kernel runs the same stores over an
in-memory row table, which is what web and tests use.

## Install

```jsonc
// package.json
"@sleeperhq/react-data-kernel": "blitzstudios/react-data-kernel.git#react-data-kernel-v0.6.2-gitpkg"
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
  indexes: [{ name: 'idx_items_group', columns: ['group_id'] }],
  // Where the per-slice ETag is kept, so a refetch can come back 304.
  meta: { table: 'items_meta', keyColumns: ['group_id'], column: 'etag' },
};
```

### 2. Define the slices and the reads

`definePartitions` asks one question — where does one slice's rows live? — and derives the rest from the answer:
presence, what a fetch replaces, where the ETag goes, what a write bumps. `read` then turns a slice of rows into
whatever the screen actually wants.

```ts
import { definePartitions, rowsOf, RowTable, VersionAtom } from '@sleeperhq/react-data-kernel';

export type ItemKey = { groupId: string };
export type ItemVM = { id: string; name: string };

const NO_ITEMS: ItemVM[] = [];
const toVM = (row: ItemRow): ItemVM => ({ id: row.item_id, name: row.name ?? '' });

export type ItemBackend = ReturnType<typeof buildItemBackend>;

export function buildItemBackend(table: RowTable<ItemRow>, version: VersionAtom) {
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
}
```

`select` runs only once the slice holds rows, and only when its version changes. `empty` is what callers get
before that, so it has to be a stable reference.

### 3. Declare the store

```ts
import { defineSqliteStore } from '@sleeperhq/react-data-kernel';

const itemStore = defineSqliteStore<ItemRow, ItemBackend>({
  name: 'item_store',
  schema: itemSchema,
  buildBackend: buildItemBackend,
});

export const getItemBackend = itemStore.getBackend;
export const setItemBackend = itemStore.setBackend;
export const createSqliteItemBackend = itemStore.createSqliteBackend;
```

What comes back already runs on an in-memory row table, so web and tests need nothing further.

### 4. Publish a read, and call it

`pairRead` publishes each read as both halves at once: a hook for components, and an imperative getter for
everything else. A read declares which args it waits on, so the pair stays inert until a caller has them.

```ts
import { pairRead } from '@sleeperhq/react-data-kernel';

export const GroupItems = pairRead(() => getItemBackend().reads.GroupItems);
```

```tsx
function ItemList({ groupId }: { groupId?: string }) {
  const { data: items, isLoading } = GroupItems.useValue({ params: { groupId } });

  if (isLoading) return <Spinner />;
  return <List data={items} renderItem={({ item }) => <Row name={item.name} />} />;
}
```

Calling it with no `groupId` is fine: the read addresses nothing, fetches nothing, and hands back `empty`.

### 5. Wire it up at startup

The host installs two services, and binds SQLite where the platform has it.

```ts
import { configureDataKernel } from '@sleeperhq/react-data-kernel';
import { bindSqliteStore } from '@sleeperhq/react-data-kernel/nitro';

configureDataKernel({
  errors: { captureException, captureMessage },
  query: { client: () => queryClient, useQuery, useQueries },
});

bindSqliteStore('initItemStore', 'items.db', setItemBackend, createSqliteItemBackend);
```

`useQuery` and `useQueries` are passed in rather than imported, so an app keeps its own fetch policy — focus
gating, retries, whatever it already does. Until `configureDataKernel` runs the kernel is inert: reads answer
from rows already stored, and nothing fetches.

## Concepts

Three words, and they nest:

| term | what it is |
| --- | --- |
| **table** | the rows themselves — SQLite on device, a `Map` on web and in tests, behind one `RowTable` interface |
| **partition** | one addressable slice of a table: the unit a fetch replaces, a version tracks, and an ETag belongs to |
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
- **Reactivity per slice, not per store.** Each partition carries a version, and a read subscribes to the
  versions it touches. A write to one slice repaints its readers and nobody else's.
- **A fallback that keeps the app running.** Every store also runs over an in-memory row table. That is the web
  and test path, and it is where a store lands if SQLite fails mid-session, so a database error degrades
  performance instead of breaking reads.
- **Dev-only guards.** Reading off-heap during render without subscribing is correct on first paint and frozen
  after, which is invisible on screen — so in `__DEV__` it warns, naming the partition and the component. Other
  guards catch a backend bound too late, a memo sized too small, and a read fanning out across a list.

## API

Everything below is exported from the package root.

### Declaring a store

| export | what it gives you |
| --- | --- |
| `defineSqliteStore(config)` | the store's spine: the version atom, the slot holding the active backend, the in-memory default, the SQLite builder for startup, and the degrade path back to memory |
| `definePartitions(config)` | from `key.where` and an optional `fetch`: the read constructors, `lifecycle`, `memos`, and the row/version primitives (`where`, `keyOf`, `has`, `versionOf`, `bump`, `clearEtag`) |
| `defineShredColumns<Src, Ctx>()(columns)` | one column table bound to everything derived from it: `names`, `columnDefs`, `row`, and `ops` once every column declares one |

### Rows

| export | what it gives you |
| --- | --- |
| `createSqliteRowTable`, `createMemoryRowTable` | the two `RowTable` backends; same interface, different storage |
| `RowTable` | `init`, three writes (`upsert`, `overwrite`, `shred`), reads (`getOne`, `find`, `findIn`, `has`) and the ETag pair (`getMeta`, `setMeta`) |
| `readRows`, `pinnedReader` | batch reads over a connection, and the opt-out that pins one to a single handle |

The three writes differ in what they delete. `upsert` merges by primary key and removes nothing, which is what a
socket delta wants. `overwrite(where, rows)` makes the slice matching `where` be exactly `rows`. `shred` is that
same replacement from an undecoded response body.

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
| `partitions.read()`, `.readMany()`, `.readGrouped()` | a `{ getValue, useValue }` pair per read: one slice, a variable set of them, or one group of candidates per thing asked about |
| `pairRead(read)` | publishes a read's two halves on a service, gated on the args the read declares |
| `rowsOf(table)` | a query, then a shape: `.rows`, `.map`, `.indexed`, `.grouped`, and `.ordered` for results parallel to the ids asked for — each returning the caller's stable empty |
| `createWindowedList(...)` | windowed list reads: fetch a page, keep the rest off-heap |
| `DataResult<T>`, `makeResult` | the envelope a read hands back, and the builder for a bespoke read the surface can't express |

### Reactivity

| export | what it gives you |
| --- | --- |
| `runTracked`, `runSubscribed` | the tracking scopes an imperative read runs inside |
| `createTrackedSelector` | off-heap-aware reselect, for reads reached from a Redux selector |

### Memoizing derived values

| export | what it gives you |
| --- | --- |
| `partitions.memos({ … })` | every value a store derives onto the heap, declared in one reviewable block and keyed by the partition for you |
| `byVersion` | dropped by every write to its partition; for a value several reads share |
| `bySource` | keyed by the row it was built from, so one row changing doesn't re-derive its neighbours |
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
| `…/nitro` | `openNitroConnection` and `bindSqliteStore`, over `react-native-nitro-sqlite` — the only part that touches native code |
| `…/testing` | a real SQLite engine off-device, an in-process version atom, the host services as spies, and the internals only a test reaches for |
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
