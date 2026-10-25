import { readFile } from "node:fs/promises";
import { auth, mediaPath, respondError, transaction, AppError } from "@/lib/store";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const mime = await transaction(db => {
      const session = auth(db, request);
      const e = db.encounters.find(v => v.owner === session.owner && v.sources.some(s => s.mediaId === id || s.previewMediaId === id));
      if (!e) throw new AppError(404, "Media not found.");
      const source = e.sources.find(s => s.mediaId === id || s.previewMediaId === id);
      return source?.previewMediaId === id ? "image/jpeg" : source?.mime || "application/octet-stream";
    });
    return new Response(new Uint8Array(await readFile(mediaPath(id))), { headers: { "Content-Type": mime, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return respondError(error); }
}
