/**
 * Pins what each entry point exports. A barrel is the one file where an addition costs nothing at the keyboard and
 * everything later: a name a consumer can reach is a name this package has to keep working, so growing one of these
 * lists should be a line in a diff someone chose to write.
 *
 * The lists are read out of the source rather than off the module, because half the surface is types, which no longer
 * exist by the time a test could import them.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

function exportedFrom(entry: string): string[] {
  const source = readFileSync(join(__dirname, '..', entry), 'utf8');
  const names: string[] = [];
  const clause = /export\s+(?:type\s+)?\{([^}]*)\}\s+from/g;
  let match = clause.exec(source);
  while (match) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '');
      if (name) names.push(name);
    }
    match = clause.exec(source);
  }
  return names.sort();
}

describe('the core entry point', () => {
  it('exports what a store, a service or a screen writes against, and nothing else', () => {
    expect(exportedFrom('index.ts')).toEqual([
      'ColumnDef', 'DATA_RESULT_KEYS', 'DataResult', 'DataStatus', 'Dep', 'KEY_SEP', 'Loose', 'MaybeId', 'NativeShredSpec',
      'PinnedConnection', 'PrimeState', 'QueryClient', 'QuerySpec', 'QueryStatus', 'RAW_TEXT_RESPONSE_TRANSFORM',
      'RawQuery', 'ReadOptions', 'RowOf', 'RowTable', 'RowTableSchema', 'ShredColumn', 'ShredOp', 'ShredSpec',
      'SqlValue', 'SqliteConnection', 'VersionAtom', 'WindowedBlock', 'bySource', 'byVersion', 'cacheKey',
      'configureDataKernel', 'createBoundedLru', 'createMemoryRowTable', 'createOnceGuard', 'createPushIngest',
      'createSqliteRowTable', 'createTrackedSelector', 'createWindowedList', 'declareMemos', 'definePartitions',
      'defineSqliteStore', 'getIngestTimings', 'groupRowsBy', 'indexRowsBy', 'makeResult', 'mapRows', 'orderedByIds',
      'pairRead', 'pinnedReader', 'readRows', 'reportStoreDegradation', 'rollupIngestTimings', 'runSubscribed',
      'runTracked', 'shallowEqualArray', 'shallowEqualRecord', 'shallowEqualStruct', 'shredColumnDefs',
      'shredColumnNames', 'shredColumnOps', 'shredRow', 'stableKey',
    ]);
  });

  it('keeps every name it exports reachable, so nothing here is a stale re-export', () => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires -- the whole module, by name
    const core = require('../index') as Record<string, unknown>;
    const values = exportedFrom('index.ts').filter((name) => name in core);

    expect(values.length).toBeGreaterThan(0);
    for (const name of values) expect(core[name]).toBeDefined();
  });
});

describe('the nitro entry point', () => {
  it('exports only the on-device wiring', () => {
    expect(exportedFrom('nitro/index.ts')).toEqual(['bindSqliteBackend', 'bindSqliteStore', 'getOpenSqliteConnections', 'openNitroConnection']);
  });
});

describe('the testing entry point', () => {
  it('exports the fixtures a store suite needs, including the internals no shipping code calls', () => {
    expect(exportedFrom('testing/index.ts')).toEqual([
      'SqlJsCapabilities', 'SqlJsConnection', 'createSqlJsConnection', 'createTestVersionAtom', 'createVersionAtom',
      'evalShredElement', 'initSqlJs', 'installTestRuntime', 'itDev', 'resetOnceGuards',
    ]);
  });
});
