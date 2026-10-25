export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { sql } = await import("@/lib/database");
    const migration = await sql()<[{ current: boolean }]>`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '001_physician_auth_postgres') AS current`;
    if (!migration[0]?.current) throw new Error("Database migrations are not current.");
    return Response.json(
      { status: "ok", service: "spotcheckmd-web", database: "available" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable", service: "spotcheckmd-web", database: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
