// Corrección de la última frase de José: Claude Sonnet 5.5, respuesta en JSON. Corre en paralelo a la voz.
import { ANTHROPIC_URL, anthropicHeaders, corsHeaders, json, requireJose } from "../_shared/common.ts";

const MODEL = "claude-sonnet-5-5";

const INSTRUCTIONS = `You evaluate one spoken sentence from José, a Spanish-speaking professional from Colombia practicing English in a role-play. His words come from speech recognition: ignore capitalization, punctuation and obvious recognition glitches.

Return ONLY a JSON object with these fields:
- "ok": true if the sentence is grammatically correct and natural enough to be understood as said.
- "better": if not ok, his sentence minimally corrected. If he spoke Spanish or mixed languages, the English way to say it. Otherwise "".
- "natural": a more native-sounding way to say the same thing, only if clearly better; else "".
- "tip": one explanation in neutral Latin American Spanish with "tú" (never "vos"), max 20 words, about the main error or the native phrasing; "" if nothing useful.
- "cefr": your estimate of the CEFR level this sentence shows (A2, B1, B2, C1 or C2).

Example: {"ok":false,"better":"I'm flying to London.","natural":"","tip":"Para planes ya decididos se usa el presente continuo: I'm flying.","cefr":"B1"}`;

Deno.serve(async (req) => {
  const h = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return json({ error: "method" }, 405, h);

  const g = await requireJose(req, h, "corregir", 40);
  if (!g.ok) return g.res;

  let body: { scene?: string; prev?: string; text?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400, h); }
  const text = String(body.text ?? "").trim().slice(0, 1500);
  if (!text) return json({ error: "empty" }, 400, h);

  const user = `Scene: ${String(body.scene ?? "").slice(0, 300)}
The other person just said: "${String(body.prev ?? "").slice(0, 600)}"
José answered: "${text}"`;

  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: [{ type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) {
    return json({ error: "anthropic", status: r.status }, 502, h);
  }
  const data = await r.json();
  const raw = (data.content ?? []).map((b: any) => b.text ?? "").join("");
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  let out: any = null;
  try { out = JSON.parse(raw.slice(start, end + 1)); } catch { /* sin JSON */ }
  if (!out) return json({ error: "bad_model_json" }, 502, h);

  return json({
    ok: out.ok !== false,
    better: String(out.better ?? "").trim(),
    natural: String(out.natural ?? "").trim(),
    tip: String(out.tip ?? "").trim(),
    cefr: String(out.cefr ?? "").trim(),
    usage: data.usage ?? {},
    model: MODEL,
  }, 200, h);
});
