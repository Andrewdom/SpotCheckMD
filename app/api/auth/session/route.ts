import { identityForToken, SESSION_COOKIE } from "@/lib/auth";
import { AppError, respondError } from "@/lib/store";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const token = request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    const physician = await identityForToken(token);
    if (!physician) throw new AppError(401, "Your physician session is missing or expired. Sign in again.");
    return Response.json({ physician }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return respondError(error); }
}
