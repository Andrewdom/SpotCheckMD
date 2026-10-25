import postgres, { type Sql } from "postgres";

const globalDatabase = globalThis as unknown as { spotcheckSql?: Sql };

export function databaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required for physician authentication.");
  return value;
}

export function sql() {
  if (!globalDatabase.spotcheckSql) {
    globalDatabase.spotcheckSql = postgres(databaseUrl(), {
      max: Number(process.env.DATABASE_POOL_SIZE || 8),
      connect_timeout: 10,
      idle_timeout: 20,
      prepare: false,
      onnotice: () => {},
    });
  }
  return globalDatabase.spotcheckSql;
}

export async function closeDatabase() {
  await globalDatabase.spotcheckSql?.end({ timeout: 5 });
  globalDatabase.spotcheckSql = undefined;
}
