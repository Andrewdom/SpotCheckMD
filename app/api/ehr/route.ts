import { demoEhr } from "@/lib/ehr/adapter";
import { auth, respondError, transaction } from "@/lib/store";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const patientId = new URL(request.url).searchParams.get("patientId") || "";
    const chart = await transaction(db => {
      const session = auth(db, request);
      return demoEhr.readChart(db, session.owner, patientId);
    });
    return Response.json({ chart }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { const response = respondError(error); response.headers.set("Cache-Control", "no-store"); return response; }
}
