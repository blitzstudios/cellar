/** The `where` and ordering predicates the two kinds of row table share: SQL on SQLite, the same rules in JS. */

import { RowShape, RowTableSchema, SqlValue } from './types';

/** Builds a row filter's `WHERE` clause and its binds; an absent value becomes `IS NULL`, the spelling SQL matches on. */
export function whereClause(where: Partial<RowShape>): { sql: string; params: SqlValue[] } {
  const keys = Object.keys(where);
  if (!keys.length) return { sql: '', params: [] };
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  for (const key of keys) {
    const value = where[key];
    if (value == null) {
      clauses.push(`${key} IS NULL`);
    } else {
      clauses.push(`${key} = ?`);
      params.push(value);
    }
  }
  return { sql: ` WHERE ${clauses.join(' AND ')}`, params };
}

/** The in-memory table's half of {@link whereClause}: whether one row satisfies `where`. */
export function matchesWhere<Row extends RowShape>(row: Row, where: Partial<Row>): boolean {
  for (const key of Object.keys(where)) {
    const wanted = where[key as keyof Row];
    const actual = row[key as keyof Row];
    if (wanted == null ? actual != null : actual !== wanted) return false;
  }
  return true;
}

/** Dev-only: the declared unit has to be one of the table's columns, since every write groups its rows by it. */
export function assertUnitColumn<Row extends RowShape>(schema: RowTableSchema<Row>): void {
  if (!(schema.unit in schema.columns)) {
    throw new Error(`row_table: \`${schema.table}\` declares unit \`${String(schema.unit)}\`, which is not one of its columns.`);
  }
}

/**
 * Dev-only: every row written under a filter must satisfy it. A row that doesn't lands outside the slice its own
 * write just cleared, where the next write to that slice cannot reach it and no `find` for it expects it.
 */
export function assertRowsMatchWhere<Row extends RowShape>(table: string, where: Partial<Row>, rows: readonly Row[]): void {
  for (const row of rows) {
    if (!matchesWhere(row, where)) {
      const wrong = Object.keys(where)
        .filter((column) => !matchesWhere(row, { [column]: where[column as keyof Row] } as Partial<Row>))
        .map((column) => `\`${column}\` is ${JSON.stringify(row[column as keyof Row])}, not ${JSON.stringify(where[column as keyof Row])}`);
      throw new Error(`row_table: a row written into \`${table}\` does not match the filter it replaced — ${wrong.join(', ')}.`);
    }
  }
}

/**
 * The ordering behind `FindOpts.orderBy`, run in JS by both kinds of table so an ordered `find` comes back in one sequence
 * whichever one served it. A column holding numbers sorts numerically, and everything else compares as a string.
 */
export function comparator<Row extends RowShape>(orderBy: keyof Row & string): (left: Row, right: Row) => number {
  return (left, right) => {
    const leftValue = left[orderBy];
    const rightValue = right[orderBy];
    if (typeof leftValue === 'number' || typeof rightValue === 'number') {
      return (typeof leftValue === 'number' ? leftValue : 0) - (typeof rightValue === 'number' ? rightValue : 0);
    }
    const leftText = String(leftValue ?? '');
    const rightText = String(rightValue ?? '');
    if (leftText === rightText) return 0;
    return leftText < rightText ? -1 : 1;
  };
}
