import { demoEhr } from "@/lib/ehr/adapter";
import { AppError, auth, respondError, transaction } from "@/lib/store";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const patientId = new URL(request.url).searchParams.get("patientId") || "";
    const chart = await transaction(db => {
      const session = auth(db, request);
      if (session.encounterId) {
        auth(db, request, session.encounterId);
        const encounter = db.encounters.find(e => e.id === session.encounterId)!;
        if (encounter.patientId !== patientId) throw new AppError(404, "Demo patient chart not found.");
      }
      return demoEhr.readChart(db, session.owner, patientId);
    });
    return Response.json({ chart }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { const response = respondError(error); response.headers.set("Cache-Control", "no-store"); return response; }
}
