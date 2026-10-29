/**
 * The small slice of a PostgreSQL connection that QC's data code needs.
 *
 * The app uses the `postgres` driver against Supabase (see client.ts).
 * Tests use PGlite — real PostgreSQL in memory — through the same shape,
 * so every SQL statement is exercised without a network database.
 */
export interface Database {
  /** Run one parameterised statement ($1, $2 …) and return its rows. */
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]>;

  /**
   * Run a script of several statements with no parameters, as one unit.
   * Used only for migrations — never with user input.
   */
  exec(script: string): Promise<void>;

  /**
   * Runs `fn` as one transaction on one connection: committed when it resolves, rolled back when it
   * throws. Row locks taken inside (`select … for update`) are held until then. Not nested.
   */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
}
