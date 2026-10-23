// Ambient declaration for the optional better-sqlite3 fallback driver.
// Loaded dynamically only when the node:sqlite built-in is unavailable.
declare module "better-sqlite3" {
  interface BetterSqlite3Database {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
    close(): void;
  }
  const Database: new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => BetterSqlite3Database;
  export default Database;
}
