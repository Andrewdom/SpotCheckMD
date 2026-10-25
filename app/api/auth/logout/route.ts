import { expiredSessionCookie, revokeSession, SESSION_COOKIE } from "@/lib/auth";
import { checkOrigin, respondError } from "@/lib/store";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const token = request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    await revokeSession(token);
    const response = Response.json({ signedOut: true }, { headers: { "Cache-Control": "no-store" } });
    response.headers.set("Set-Cookie", expiredSessionCookie(request));
    return response;
  } catch (error) { return respondError(error); }
}
