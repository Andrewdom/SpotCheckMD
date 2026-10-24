import { PATIENTS } from "@/lib/domain";
import { transcriptionKeyterms } from "@/lib/transcription/keyterms";
import { assemblyAIStreamingSession } from "@/lib/transcription/streaming";
import { AppError, auth, checkOrigin, checkRevision, respondError, transaction } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const body = await request.json();
    if (typeof body.encounterId !== "string" || body.encounterId.length !== 32) throw new AppError(400, "Choose an encounter before recording.");
    const keyterms = await transaction(db => {
      auth(db, request, body.encounterId);
      const encounter = db.encounters.find(item => item.id === body.encounterId)!;
      checkRevision(encounter, body.revision);
      if (!encounter.consent || !encounter.patientConfirmed || !PATIENTS.some(patient => patient.id === encounter.patientId)) throw new AppError(400, "Confirm the fictional patient and recording consent first.");
      return transcriptionKeyterms(encounter);
    });
    const session = await assemblyAIStreamingSession(keyterms);
    return Response.json(session, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return respondError(error); }
}
