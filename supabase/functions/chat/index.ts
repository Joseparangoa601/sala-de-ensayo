// Turno del personaje: Claude Haiku 5.5 en streaming, reenviado al cliente como SSE.
import { ANTHROPIC_URL, anthropicHeaders, corsHeaders, json, requireJose } from "../_shared/common.ts";

const MODEL = "claude-haiku-5-5";

type Turn = { role: "user" | "assistant"; content: string };

function rules(level: string): string {
  return `You are a role-play partner in a spoken English practice app. The learner is José, a Spanish-speaking sales professional and author from Colombia, CEFR level about ${level}.

HOW YOU SPEAK
- You are a real person in this scene. Never say you are an AI, never mention practice, lessons, corrections or the app.
- Spoken American English: contractions, short sentences, natural listening signals ("Mm-hm", "Right", "Got it") and an occasional filler, sparingly. Use common idioms when they fit.
- 1 to 3 short sentences per turn. Usually end with a question or a prompt that gets José talking. José should talk more than you.
- Pitch your vocabulary slightly above ${level}: clear and natural, not simplified, not showy.
- If José makes a mistake, do not teach. Recast it: echo his idea correctly inside your reply, the way a native speaker would ("Oh, you're flying to London?").
- If José says something in Spanish or gets stuck, stay in English, show you understood, and keep the scene moving simply.
- Your words are read aloud by a voice engine: no emojis, no stage directions, no lists, no markdown, no quotation marks around your whole reply.
- José's words come from speech recognition: ignore punctuation and small transcription glitches.`;
}

Deno.serve(async (req) => {
  const h = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return json({ error: "method" }, 405, h);

  const g = await requireJose(req, h, "chat", 40);
  if (!g.ok) return g.res;

  let body: { persona?: string; history?: Turn[]; level?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400, h); }

  const persona = String(body.persona ?? "").slice(0, 4000);
  const level = /^(A1|A2|B1|B2|C1|C2)$/.test(String(body.level)) ? String(body.level) : "B2";
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((t) => (t.role === "user" || t.role === "assistant") && String(t.content ?? "").trim())
    .slice(-24)
    .map((t) => ({ role: t.role, content: String(t.content).slice(0, 2000) }));

  // La API exige empezar con "user": la escena arranca con una acotación.
  const messages: Turn[] = [{ role: "user", content: "(The scene begins. Speak first, in character.)" }];
  for (const t of history) {
    const last = messages[messages.length - 1];
    if (last.role === t.role) last.content += "\n" + t.content;
    else messages.push({ ...t });
  }
  if (messages[messages.length - 1].role !== "user") {
    messages.push({ role: "user", content: "(José stays silent for a moment.)" });
  }

  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 220,
      stream: true,
      system: [
        { type: "text", text: rules(level) },
        { type: "text", text: "YOUR CHARACTER AND SCENE\n" + persona, cache_control: { type: "ephemeral" } },
      ],
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return json({ error: "anthropic", status: upstream.status, detail: detail.slice(0, 300) }, 502, h);
  }

  // Reenvía solo el texto y el uso, en eventos SSE simples.
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const usage: Record<string, number> = {};
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const reader = upstream.body!.getReader();
      let buf = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = block.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let ev: any;
            try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
              send({ d: ev.delta.text });
            } else if (ev.type === "message_start") {
              Object.assign(usage, ev.message?.usage ?? {});
            } else if (ev.type === "message_delta") {
              Object.assign(usage, ev.usage ?? {});
            } else if (ev.type === "error") {
              send({ error: ev.error?.type ?? "anthropic_stream" });
            }
          }
        }
        send({ done: true, model: MODEL, usage });
      } catch (_e) {
        send({ error: "stream_broken" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { ...h, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
});
