import { sessionCookie, signIn } from "@/lib/auth";
import { AppError, checkOrigin, respondError } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const body = await request.json();
    if (typeof body.username !== "string" || typeof body.password !== "string" || body.username.length > 100 || body.password.length > 200) throw new AppError(401, "Invalid username or password.");
    const result = await signIn(body.username, body.password, request);
    const response = Response.json({ physician: result.identity }, { headers: { "Cache-Control": "no-store" } });
    response.headers.set("Set-Cookie", sessionCookie(result.token, request));
    return response;
  } catch (error) { const response = respondError(error); response.headers.set("Cache-Control", "no-store"); return response; }
}
