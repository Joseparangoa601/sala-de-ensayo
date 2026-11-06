// Entrega un token de Azure Speech de 10 minutos. La clave nunca sale del servidor.
import { corsHeaders, json, requireJose } from "../_shared/common.ts";

Deno.serve(async (req) => {
  const h = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });

  const g = await requireJose(req, h, "token", 20);
  if (!g.ok) return g.res;

  const region = Deno.env.get("AZURE_SPEECH_REGION") ?? "eastus";
  const key = Deno.env.get("AZURE_SPEECH_KEY");
  if (!key) return json({ error: "azure_key_missing" }, 500, h);

  const r = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": key, "Content-Length": "0" },
  });
  if (!r.ok) {
    // 401/403: clave errada. 429: cupo o concurrencia de F0.
    return json({ error: "azure_token", status: r.status }, 502, h);
  }
  const token = await r.text();
  // Azure dice 10 min; el cliente renueva a los 8.
  return json({ token, region, ttlSeconds: 480 }, 200, h);
});
