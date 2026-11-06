// Utilidades compartidas: CORS, autenticación (solo el correo de José) y límite de peticiones.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ORIGINS.includes(origin) ? origin : (ORIGINS[0] ?? "");
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}

export function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

// Límite simple por instancia: suficiente para una app de una sola persona.
const hits = new Map<string, number[]>();
function rateLimited(key: string, perMinute: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > perMinute;
}

export type Guard =
  | { ok: true; email: string; userId: string }
  | { ok: false; res: Response };

export async function requireJose(
  req: Request,
  headers: Record<string, string>,
  bucket: string,
  perMinute = 40,
): Promise<Guard> {
  const origin = req.headers.get("origin") ?? "";
  if (ORIGINS.length && origin && !ORIGINS.includes(origin)) {
    return { ok: false, res: json({ error: "origin_not_allowed" }, 403, headers) };
  }
  const auth = req.headers.get("authorization") ?? "";
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } },
  );
  const { data, error } = await sb.auth.getUser();
  const allowed = (Deno.env.get("ALLOWED_EMAIL") ?? "").trim().toLowerCase();
  const email = data?.user?.email?.toLowerCase() ?? "";
  if (error || !data?.user || !allowed || email !== allowed) {
    return { ok: false, res: json({ error: "unauthorized" }, 401, headers) };
  }
  if (rateLimited(bucket + ":" + email, perMinute)) {
    return { ok: false, res: json({ error: "rate_limited" }, 429, headers) };
  }
  return { ok: true, email, userId: data.user.id };
}

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export function anthropicHeaders(): Record<string, string> {
  return {
    "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}
