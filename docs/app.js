/* Sala de Ensayo · F1 voz a voz
   Micrófono → VAD local (Silero) → Azure STT (solo mientras José habla) → /chat (Haiku, streaming)
   → Azure TTS por frase → cola de audio. Interrupción si José habla encima. /corregir en paralelo. */
(() => {
"use strict";
const CFG = window.SALA_CONFIG;
const SDK = window.SpeechSDK;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("sala:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("sala:" + k, JSON.stringify(v)); } catch {} },
};
const now = () => performance.now();

/* ---------------- estado ---------------- */
const S = {
  session: null,
  scene: null,
  history: [],            // {role, content}
  state: "idle",          // idle | listening | hearing | thinking | speaking | paused
  level: store.get("level", "B2"),
  rate: store.get("rate", 0),          // % de velocidad SSML
  voices: store.get("voices", {}),     // sceneId → voz elegida
  bargeIn: store.get("bargeIn", true),
  gen: 0,                 // generación del turno: invalida audio y streams viejos
  chatCtl: null,
  turnMetrics: null,
  metrics: store.get("metrics", []),   // últimas latencias (ms)
  usage: { haikuIn: 0, haikuOut: 0, haikuCacheRead: 0, sonnetIn: 0, sonnetOut: 0, turns: 0, sttSeconds: 0, ttsChars: 0 },
  availableVoices: null,
};
let sb = null;

/* ---------------- UI helpers ---------------- */
function show(id) {
  for (const el of document.querySelectorAll(".screen")) el.hidden = el.id !== id;
}
function setState(st, caption) {
  S.state = st;
  const orb = $("#orb");
  orb.dataset.state = st;
  const label = { idle: "Toca para empezar", listening: "Escuchando", hearing: "Te escucho…", thinking: "Pensando", speaking: "Hablando", paused: "En pausa" }[st] || st;
  $("#stateLabel").textContent = label;
  if (caption !== undefined) $("#live").textContent = caption;
  $("#pauseBtn").textContent = st === "paused" ? "Continuar" : "Pausa";
}
function notice(msg, kind = "warn") {
  const n = $("#notice");
  n.textContent = msg || "";
  n.dataset.kind = kind;
  n.hidden = !msg;
}
function addBubble(role, text) {
  const el = document.createElement("div");
  el.className = "msg " + (role === "user" ? "me" : "char");
  el.innerHTML = `<span class="lbl">${role === "user" ? "Tú" : esc(S.scene.name)}</span><div class="bubble"></div>`;
  el.querySelector(".bubble").textContent = text;
  $("#log").appendChild(el);
  scrollLog();
  return el;
}
function scrollLog() { requestAnimationFrame(() => { const m = $("#logWrap"); m.scrollTop = m.scrollHeight; }); }
function proofHTML(c) {
  if (!c) return "";
  if (c.ok && !c.natural) return `<div class="proof good"><span class="ok">✓ Correcto</span></div>`;
  let h = `<div class="proof ${c.ok ? "good" : ""}">`;
  if (c.ok) h += `<span class="ok">✓ Correcto</span>`;
  if (!c.ok && c.better) h += `<div class="row"><b>Dijiste</b><span class="del">${esc(c.original)}</span></div><div class="row"><b>Correcto</b><span class="ins">${esc(c.better)}</span></div>`;
  if (c.natural) h += `<div class="row"><b>Nativo</b><span class="alt">${esc(c.natural)}</span></div>`;
  if (c.tip) h += `<div class="tip">${esc(c.tip)}</div>`;
  return h + `</div>`;
}

/* ---------------- Supabase ---------------- */
function configured() {
  return CFG && CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes("REEMPLAZAR") && CFG.SUPABASE_ANON_KEY && !CFG.SUPABASE_ANON_KEY.includes("REEMPLAZAR");
}
async function fnFetch(name, body, signal) {
  const { data } = await sb.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw { code: "no_session" };
  const r = await fetch(`${CFG.SUPABASE_URL}/functions/v1/${name}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + token, apikey: CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  return r;
}

/* ---------------- Azure: token, STT y TTS ---------------- */
const AZ = { token: null, region: "eastus", exp: 0, synth: null, speechCfg: null };
async function azureToken(force = false) {
  if (!force && AZ.token && Date.now() < AZ.exp) return AZ.token;
  const r = await fnFetch("token-azure");
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw { code: "azure_token", status: j.status || r.status };
  }
  const j = await r.json();
  AZ.token = j.token; AZ.region = j.region; AZ.exp = Date.now() + (j.ttlSeconds || 480) * 1000;
  if (AZ.synth) AZ.synth.authorizationToken = AZ.token;
  if (AZ.speechCfg) AZ.speechCfg.authorizationToken = AZ.token;
  return AZ.token;
}
setInterval(() => { if (S.session && AZ.token && Date.now() > AZ.exp - 60_000) azureToken(true).catch(() => {}); }, 30_000);

function makeSynth() {
  const cfg = SDK.SpeechConfig.fromAuthorizationToken(AZ.token, AZ.region);
  cfg.speechSynthesisOutputFormat = SDK.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;
  AZ.speechCfg = cfg;
  AZ.synth = new SDK.SpeechSynthesizer(cfg, null); // null: devuelve el audio, no lo reproduce
  try { SDK.Connection.fromSynthesizer(AZ.synth).openConnection(); } catch {}
}
function voiceFor(scene) { return S.voices[scene.id] || scene.voice; }
function ssml(text, voice) {
  const rate = S.rate ? `${S.rate > 0 ? "+" : ""}${S.rate}%` : "0%";
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}"><prosody rate="${rate}">${escXml(text)}</prosody></voice></speak>`;
}
function azureSynth(text, voice) {
  return new Promise((resolve, reject) => {
    AZ.synth.speakSsmlAsync(ssml(text, voice), (res) => {
      if (res.reason === SDK.ResultReason.SynthesizingAudioCompleted) { S.usage.ttsChars += text.length; resolve(res.audioData); }
      else {
        let detail = "";
        try { detail = SDK.CancellationDetails.fromResult(res).errorDetails; } catch {}
        reject({ code: "tts", detail });
      }
    }, (err) => reject({ code: "tts", detail: String(err) }));
  });
}

/* ---------------- audio de salida: un solo AudioContext ---------------- */
let ctx = null;
const player = { queue: [], playing: null, gen: 0, onIdle: null };
function unlockAudio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  const b = ctx.createBuffer(1, 1, 22050); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
  try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record"; } catch {}
}
// Encola una frase: arranca la síntesis ya y reproduce en orden.
function speakSentence(text, gen) {
  const voice = voiceFor(S.scene);
  const item = { text, gen, ready: null };
  item.ready = azureSynth(text, voice)
    .then((ab) => ctx.decodeAudioData(ab.slice(0)))
    .catch((e) => { logDebug("TTS Azure falló → voz del sistema: " + (e.detail || e.code)); return { fallback: true }; });
  player.queue.push(item);
  if (!player.playing) playNext();
}
async function playNext() {
  const item = player.queue.shift();
  if (!item) { player.playing = null; if (player.onIdle) player.onIdle(); return; }
  player.playing = item;
  const buf = await item.ready;
  if (item.gen !== S.gen) { player.playing = null; return playNext(); }
  if (S.turnMetrics && !S.turnMetrics.firstAudio) { S.turnMetrics.firstAudio = now(); finishMetrics(); }
  if (S.state !== "speaking") setState("speaking");
  if (buf && buf.fallback) {
    await systemSpeak(item.text, item);
  } else {
    await new Promise((res) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination);
      item.src = src; src.onended = res; src.start(0);
    });
  }
  playNext();
}
function systemSpeak(text, item) {
  return new Promise((res) => {
    if (!("speechSynthesis" in window)) return res();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US"; u.onend = res; u.onerror = res;
    item.utter = true;
    speechSynthesis.speak(u);
  });
}
function stopSpeaking() {
  S.gen++;
  for (const it of player.queue) it.gen = -1;
  player.queue = [];
  if (player.playing) {
    try { player.playing.src && player.playing.src.stop(0); } catch {}
    if (player.playing.utter && "speechSynthesis" in window) speechSynthesis.cancel();
  }
  if (S.chatCtl) { try { S.chatCtl.abort(); } catch {} S.chatCtl = null; }
}

/* ---------------- micrófono + VAD + STT ---------------- */
let micStream = null, vadNode = null;
const ring = [];                // cuadros previos al inicio de voz
let stt = null;                 // sesión de reconocimiento activa
let bargeFrames = 0;

function f32ToI16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return out.buffer;
}

async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const source = ctx.createMediaStreamSource(micStream);
  vadNode = await vad.AudioNodeVAD.new(ctx, {
    model: "legacy",
    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.45,
    redemptionFrames: CFG.END_OF_TURN_FRAMES || 8,
    preSpeechPadFrames: 2,
    minSpeechFrames: 3,
    onFrameProcessed: onFrame,
    onSpeechStart,
    onSpeechEnd,
    onVADMisfire,
  });
  vadNode.receive(source);
  vadNode.start();
  micStream.getAudioTracks()[0].addEventListener("ended", () => pauseSession("El micrófono se cortó. Toca Continuar."));
}

function onFrame(probs, frame) {
  if (!frame) return;
  ring.push(frame); if (ring.length > 4) ring.shift();
  if (stt && !stt.closed) { stt.push.write(f32ToI16(frame)); stt.frames++; }
  // Interrupción: solo si la voz es sostenida (evita que el eco del parlante corte al personaje)
  if (S.state === "speaking" && stt && S.bargeIn) {
    bargeFrames = probs.isSpeech > 0.85 ? bargeFrames + 1 : Math.max(0, bargeFrames - 1);
    if (bargeFrames >= 3) { bargeFrames = 0; logDebug("Interrupción"); stopSpeaking(); setState("hearing", ""); }
  }
}

function onSpeechStart() {
  if (S.state === "paused" || S.state === "idle") return;
  if (S.state === "speaking" && !S.bargeIn) return;
  bargeFrames = 0;
  openStt();
  for (const f of ring) { stt.push.write(f32ToI16(f)); stt.frames++; }
  if (S.state !== "speaking") setState("hearing", "");
}

function onVADMisfire() {
  if (stt) { stt.discard = true; closeStt(); }
  if (S.state === "hearing") setState("listening");
}

async function onSpeechEnd() {
  if (!stt) return;
  const tEnd = now();
  const sess = stt;
  const text = await closeStt();
  if (sess.discard) return;
  if (!text) { if (S.state === "hearing") setState("listening", "No te entendí. Repite, por favor."); return; }
  // Eco: si lo reconocido se parece a lo que dijo el personaje, se descarta.
  const lastBot = [...S.history].reverse().find((t) => t.role === "assistant");
  if (lastBot && similarity(text, lastBot.content) > 0.6) { logDebug("Descartado por eco: " + text); return; }
  userSaid(text, { speechEnd: tEnd, sttDone: now() });
}

function openStt() {
  if (stt) { stt.discard = true; closeStt(); }
  const fmt = SDK.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const push = SDK.AudioInputStream.createPushStream(fmt);
  const cfg = SDK.SpeechConfig.fromAuthorizationToken(AZ.token, AZ.region);
  cfg.speechRecognitionLanguage = "en-US";
  cfg.outputFormat = SDK.OutputFormat.Simple;
  const rec = new SDK.SpeechRecognizer(cfg, SDK.AudioConfig.fromStreamInput(push));
  const sess = { rec, push, parts: [], partial: "", frames: 0, closed: false, discard: false, error: null, done: null };
  sess.done = new Promise((resolve) => { sess.resolve = resolve; });
  rec.recognizing = (_s, e) => { sess.partial = e.result.text; if (!sess.discard) $("#live").textContent = [...sess.parts, sess.partial].join(" "); };
  rec.recognized = (_s, e) => { if (e.result.reason === SDK.ResultReason.RecognizedSpeech && e.result.text) sess.parts.push(e.result.text); sess.partial = ""; };
  rec.canceled = (_s, e) => {
    if (e.reason === SDK.CancellationReason.Error) { sess.error = e.errorDetails || String(e.errorCode); logDebug("STT error: " + sess.error); }
    sess.resolve();
  };
  rec.sessionStopped = () => sess.resolve();
  rec.startContinuousRecognitionAsync(() => {}, (err) => { sess.error = String(err); sess.resolve(); });
  stt = sess;
}

async function closeStt() {
  const sess = stt; if (!sess) return "";
  stt = null;
  if (!sess.closed) { sess.closed = true; try { sess.push.close(); } catch {} }
  S.usage.sttSeconds += (sess.frames * 1536) / 16000;
  await Promise.race([sess.done, new Promise((r) => setTimeout(r, 3000))]);
  try { sess.rec.stopContinuousRecognitionAsync(() => sess.rec.close(), () => sess.rec.close()); } catch {}
  if (sess.error && !sess.discard) {
    if (/quota|429|throttl/i.test(sess.error)) notice("Se agotó el cupo gratis de voz de Azure por este mes o hay demasiadas conexiones. Puedes seguir escribiendo abajo.");
    else if (/401|auth/i.test(sess.error)) { azureToken(true).catch(() => {}); }
  }
  return [...sess.parts, sess.partial].join(" ").replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  const wa = new Set(a.toLowerCase().match(/[a-z']+/g) || []);
  const wb = new Set(b.toLowerCase().match(/[a-z']+/g) || []);
  if (!wa.size) return 0;
  let hit = 0; for (const w of wa) if (wb.has(w)) hit++;
  return hit / wa.size;
}

/* ---------------- un turno ---------------- */
async function userSaid(text, m = {}) {
  stopSpeaking();                         // invalida cualquier respuesta previa
  const gen = S.gen;
  S.turnMetrics = { speechEnd: m.speechEnd || now(), sttDone: m.sttDone || now(), firstToken: 0, firstAudio: 0 };
  const prev = [...S.history].reverse().find((t) => t.role === "assistant")?.content || "";
  S.history.push({ role: "user", content: text });
  const bubble = addBubble("user", text);
  setState("thinking", "");
  correct(text, prev, bubble);            // en paralelo, no bloquea la voz
  await characterTurn(gen);
}

async function characterTurn(gen) {
  const ctl = new AbortController(); S.chatCtl = ctl;
  let full = "", pending = "", sentences = 0, bubble = null;
  const flush = (force) => {
    // Primera frase sola (arranca rápido); el resto se agrupa para ahorrar peticiones a Azure.
    if (sentences === 0) {
      const m = pending.match(/^(.+?[.!?…])(\s+)/s);
      if (m && m[1].trim().length > 1) { speakSentence(m[1].trim(), gen); sentences++; pending = pending.slice(m[0].length); }
    }
    if (force && pending.trim()) { speakSentence(pending.trim(), gen); sentences++; pending = ""; }
  };
  try {
    const r = await fnFetch("chat", { persona: S.scene.persona, history: S.history, level: S.level }, ctl.signal);
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw { code: j.error || "chat", status: j.status || r.status }; }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (gen !== S.gen) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).replace(/^data:\s?/, ""); buf = buf.slice(i + 2);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.d) {
          if (!S.turnMetrics.firstToken) S.turnMetrics.firstToken = now();
          full += ev.d; pending += ev.d;
          if (!bubble) bubble = addBubble("assistant", "");
          bubble.querySelector(".bubble").textContent = full;
          flush(false);
        } else if (ev.done) {
          const u = ev.usage || {};
          S.usage.haikuIn += (u.input_tokens || 0); S.usage.haikuOut += (u.output_tokens || 0);
          S.usage.haikuCacheRead += (u.cache_read_input_tokens || 0); S.usage.turns++;
        } else if (ev.error) throw { code: ev.error };
      }
    }
    if (gen !== S.gen) return;
    flush(true);
    full = full.trim();
    if (full) S.history.push({ role: "assistant", content: full });
    scrollLog();
    player.onIdle = () => { if (gen === S.gen && S.state === "speaking") setState("listening", ""); };
    if (!player.playing && !player.queue.length) setState("listening", "");
  } catch (e) {
    if (e?.name === "AbortError" || gen !== S.gen) return;
    const msg = {
      rate_limited: "Vas muy rápido: espera unos segundos.",
      unauthorized: "Tu sesión venció. Vuelve a entrar.",
      anthropic: "Claude no respondió. Repite tu frase.",
      no_session: "Tu sesión venció. Vuelve a entrar.",
    }[e.code] || "No hubo respuesta. Revisa tu conexión y repite tu frase.";
    notice(msg);
    logDebug("chat error " + JSON.stringify(e));
    setState("listening", "");
  }
}

async function correct(text, prev, bubble) {
  try {
    const r = await fnFetch("corregir", { scene: S.scene.title, prev, text });
    if (!r.ok) return;
    const c = await r.json();
    c.original = text;
    if (!c.ok && !c.better) c.ok = true;
    S.usage.sonnetIn += c.usage?.input_tokens || 0; S.usage.sonnetOut += c.usage?.output_tokens || 0;
    bubble.insertAdjacentHTML("beforeend", proofHTML(c));
    scrollLog();
  } catch {}
}

/* ---------------- métricas ---------------- */
function finishMetrics() {
  const m = S.turnMetrics; if (!m || !m.firstAudio) return;
  const row = {
    total: Math.round(m.firstAudio - m.speechEnd),
    stt: Math.round(m.sttDone - m.speechEnd),
    llm: m.firstToken ? Math.round(m.firstToken - m.sttDone) : null,
    tts: m.firstToken ? Math.round(m.firstAudio - m.firstToken) : null,
    at: Date.now(),
  };
  S.metrics.push(row); S.metrics = S.metrics.slice(-200); store.set("metrics", S.metrics);
  S.turnMetrics = null;
  renderDebug();
}
function pct(arr, p) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; }
const debugLines = [];
function logDebug(t) { debugLines.push(new Date().toLocaleTimeString() + " " + t); if (debugLines.length > 40) debugLines.shift(); renderDebug(); }
function renderDebug() {
  const d = $("#debug"); if (d.hidden) return;
  const tot = S.metrics.map((m) => m.total);
  const last = S.metrics[S.metrics.length - 1];
  const u = S.usage;
  d.querySelector("pre").textContent =
`Latencia fin-de-habla → primer audio (n=${tot.length})
  mediana ${pct(tot, 0.5) ?? "–"} ms · p95 ${pct(tot, 0.95) ?? "–"} ms   (meta ≤1200 / ≤2000)
  último: total ${last?.total ?? "–"} = STT ${last?.stt ?? "–"} + Claude ${last?.llm ?? "–"} + TTS ${last?.tts ?? "–"}
Sesión: ${u.turns} turnos · STT ${u.sttSeconds.toFixed(0)} s enviados · TTS ${u.ttsChars} caracteres
Tokens Haiku: in ${u.haikuIn} (caché ${u.haikuCacheRead}) · out ${u.haikuOut}
Tokens Sonnet: in ${u.sonnetIn} · out ${u.sonnetOut}
Voces disponibles: ${S.availableVoices ? S.availableVoices.join(", ") : "sin verificar"}

${debugLines.join("\n")}`;
}

/* ---------------- sesión de conversación ---------------- */
let wakeLock = null;
async function keepAwake() { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }

async function startScene(scene) {
  S.scene = scene; S.history = []; S.gen++;
  $("#log").innerHTML = "";
  $("#sceneName").textContent = scene.title;
  $("#sceneWho").textContent = scene.name + " · " + scene.who;
  notice("");
  show("talk");
  setState("idle", "Toca el círculo para empezar. La app usará el micrófono para escucharte.");
}

async function begin() {
  if (S.state !== "idle") return;
  unlockAudio();                                  // iOS: debe ocurrir dentro del toque
  setState("thinking", "Preparando micrófono y voz…");
  try {
    await azureToken();
    if (!AZ.synth) makeSynth();
    if (!vadNode) await startMic();
    keepAwake();
    checkVoices();
    const open = S.scene.open;
    S.history.push({ role: "assistant", content: open });
    addBubble("assistant", open);
    S.turnMetrics = null;
    const gen = S.gen;
    player.onIdle = () => { if (gen === S.gen && S.state === "speaking") setState("listening", ""); };
    speakSentence(open, gen);
  } catch (e) {
    logDebug("inicio falló " + JSON.stringify(e) + " " + (e?.message || ""));
    if (e?.name === "NotAllowedError") notice("No diste permiso al micrófono. Actívalo en Ajustes → Safari → Micrófono, o escribe abajo.");
    else if (e?.code === "azure_token") notice(e.status === 429 ? "Azure no da más tokens por ahora (cupo gratis). Escribe abajo." : "No se pudo conectar con la voz de Azure. Escribe abajo.");
    else notice("No se pudo iniciar la voz. Puedes escribir abajo.");
    setState("listening", "");
  }
}

function pauseSession(msg) {
  stopSpeaking();
  if (stt) { stt.discard = true; closeStt(); }
  try { vadNode?.pause(); } catch {}
  setState("paused", msg || "");
}
function resumeSession() {
  unlockAudio();
  try { vadNode?.start(); } catch {}
  keepAwake();
  notice("");
  setState("listening", "");
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden && S.scene && !["idle", "paused"].includes(S.state)) pauseSession("Pausé la conversación al salir de la app. Toca Continuar.");
});

async function checkVoices() {
  try {
    const r = await fetch(`https://${AZ.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, { headers: { Authorization: "Bearer " + AZ.token } });
    if (!r.ok) return;
    const list = await r.json();
    const names = new Set(list.map((v) => v.ShortName));
    S.availableVoices = window.VOICE_CANDIDATES.filter((v) => names.has(v));
    renderDebug(); renderVoicePicker();
  } catch {}
}

/* ---------------- pantallas ---------------- */
function renderHome() {
  $("#scenes").innerHTML = window.SCENES.map((s) => `
    <button class="scene" data-id="${s.id}">
      <span class="who">${esc(s.who)}</span>
      <span class="t">${esc(s.title)}</span>
      <span class="d">${esc(s.desc)}</span>
    </button>`).join("");
  for (const b of document.querySelectorAll(".scene")) b.onclick = () => startScene(window.SCENES.find((s) => s.id === b.dataset.id));
  $("#levelSel").value = S.level;
  $("#rateSel").value = String(S.rate);
  $("#bargeChk").checked = S.bargeIn;
}
function renderVoicePicker() {
  const sel = $("#voiceSel"); if (!S.scene) return;
  const opts = S.availableVoices || window.VOICE_CANDIDATES;
  const cur = voiceFor(S.scene);
  sel.innerHTML = opts.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${v.replace("en-US-", "").replace("Neural", "")}</option>`).join("");
}

function wire() {
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#loginErr").textContent = "";
    const { error } = await sb.auth.signInWithPassword({ email: $("#email").value.trim(), password: $("#password").value });
    if (error) $("#loginErr").textContent = "No pude entrar: revisa el correo y la contraseña.";
  });
  $("#orb").onclick = () => {
    if (S.state === "idle") begin();
    else if (S.state === "paused") resumeSession();
    else if (S.state === "speaking") { stopSpeaking(); setState("listening", ""); }
  };
  $("#pauseBtn").onclick = () => (S.state === "paused" ? resumeSession() : pauseSession(""));
  $("#backBtn").onclick = () => { pauseSession(""); S.scene = null; show("home"); };
  $("#typeForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = $("#typeBox").value.trim(); if (!t) return;
    $("#typeBox").value = "";
    if (S.state === "idle") unlockAudio();
    if (!AZ.synth) azureToken().then(makeSynth).catch(() => {});
    userSaid(t);
  });
  $("#levelSel").onchange = (e) => { S.level = e.target.value; store.set("level", S.level); };
  $("#rateSel").onchange = (e) => { S.rate = Number(e.target.value); store.set("rate", S.rate); };
  $("#bargeChk").onchange = (e) => { S.bargeIn = e.target.checked; store.set("bargeIn", S.bargeIn); };
  $("#voiceSel").onchange = (e) => { S.voices[S.scene.id] = e.target.value; store.set("voices", S.voices); };
  $("#voiceTry").onclick = () => { if (S.state === "idle") return; speakSentence("Hi, this is how I sound. Does this voice work for you?", S.gen); };
  $("#settingsBtn").onclick = () => { renderVoicePicker(); $("#settings").hidden = !$("#settings").hidden; };
  let taps = 0, tt = null;
  $("#sceneName").onclick = () => { taps++; clearTimeout(tt); tt = setTimeout(() => (taps = 0), 1200); if (taps >= 5) { taps = 0; $("#debug").hidden = !$("#debug").hidden; renderDebug(); } };
  if (location.hash === "#debug") $("#debug").hidden = false;
  $("#signOut").onclick = async () => { await sb.auth.signOut(); };
}

async function boot() {
  wire();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!configured()) { show("setup"); return; }
  if (!SDK || !window.vad) { show("setup"); $("#setupMsg").textContent = "No cargaron las librerías de voz. Revisa tu conexión y vuelve a abrir la app."; return; }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  sb.auth.onAuthStateChange((_ev, session) => {
    S.session = session;
    if (!session) show("login"); else if (!S.scene) { renderHome(); show("home"); }
  });
  if (S.session) { renderHome(); show("home"); } else show("login");
}
boot();
})();
