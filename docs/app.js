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
  level: store.get("level", "B1"),   // sin nivel elegido ni test: B1 (B2 dejaba atrás a quien empieza en A2)
  rate: store.get("rate", 0),          // % de velocidad SSML
  voices: store.get("voices", {}),     // sceneId → voz elegida
  bargeIn: store.get("bargeIn", true),
  voiceCorr: store.get("voiceCorr", true),   // la corrección también se dice en voz alta
  lastCoachText: "",
  sesion: null,           // fila de la tabla sesiones (F2)
  cefrVotes: [],
  gen: 0,                 // generación del turno: invalida audio y streams viejos
  chatCtl: null,
  turnMetrics: null,
  metrics: store.get("metrics", []),   // últimas latencias (ms)
  usage: { haikuIn: 0, haikuOut: 0, haikuCacheRead: 0, sonnetIn: 0, sonnetOut: 0, turns: 0, sttSeconds: 0, ttsChars: 0 },
  availableVoices: null,
};
let sb = null;

/* ---------------- UI helpers ---------------- */
const icon = (n) => `<svg class="ii" aria-hidden="true"><use href="#i-${n}"/></svg>`;
window.IC = { play: icon("play"), mic: icon("mic"), bell: icon("bell"), pen: icon("pen"), loop: icon("loop"), trash: icon("trash"), hide: icon("hide") };
function show(id) {
  const antes = document.activeElement;
  for (const el of document.querySelectorAll(".screen")) el.hidden = el.id !== id;
  // El foco no se queda en un botón que ya no se ve: pasa al título de la pantalla nueva (lector de pantalla y teclado)
  if (!antes || antes === document.body || antes.closest("[hidden]")) {
    const t = document.getElementById(id)?.querySelector('h1, [role="heading"][aria-level="1"]');
    if (t) { if (!t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1"); t.focus({ preventScroll: true }); }
  }
}
// Lo que está en inglés se marca como inglés: el lector de pantalla lo pronuncia en inglés (WCAG 3.1.2)
const EN_SEL = ".bubble, .en, .ins, .alt, .fixed, .del, .live, .pwords, .tline, .dict";
function marcarIngles(raiz) {
  if (raiz.nodeType !== 1) return;
  if (raiz.matches(EN_SEL) && !raiz.lang) raiz.lang = "en";
  for (const el of raiz.querySelectorAll(EN_SEL)) if (!el.lang) el.lang = "en";
}
new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) marcarIngles(n); }).observe(document.documentElement, { childList: true, subtree: true });
function setState(st, caption) {
  S.state = st;
  const orb = $("#orb");
  const noMic = st === "listening" && !vadNode;   // sesión escrita: la app no está oyendo
  orb.dataset.state = noMic ? "idle" : st;
  const label = noMic ? "Escribe abajo o toca para hablar" : ({ idle: "Toca para empezar", listening: "Escuchando", hearing: "Te escucho…", thinking: "Pensando", speaking: "Hablando", paused: "En pausa" }[st] || st);
  $("#stateLabel").textContent = label;
  orb.setAttribute("aria-label", noMic ? "Activar el micrófono" : ({ idle: "Empezar a hablar", listening: "Escuchando", hearing: "Te escucho", thinking: "Pensando", speaking: "Interrumpir al personaje", paused: "Continuar la conversación" }[st] || st));
  if (caption !== undefined) $("#live").textContent = caption;
  $("#pauseBtn").textContent = st === "paused" ? "Continuar" : "Pausa";
  $("#pauseBtn").hidden = st === "idle" || noMic;   // sin sesión de voz no hay nada que pausar
  $("#endBtn").hidden = st === "idle";
  const conPartes = st === "listening" && turno.partes.length > 0;
  $("#listoBtn").hidden = !(st === "hearing" || conPartes);
  if (conPartes) { $("#stateLabel").textContent = "Sigue o toca Listo"; $("#live").textContent = turno.partes.join(" "); }
  else if (st === "hearing" && modoManual()) $("#stateLabel").textContent = "Te escucho… toca Listo al terminar";
  if (st === "listening" && S.pruebaFin && !S.pruebaCerrando) { S.pruebaCerrando = true; setTimeout(terminarPrueba, 900); }
}
// iPhone: con el teclado abierto la altura útil es la del viewport visual, no la de la pantalla
function fitViewport() {
  const vv = window.visualViewport;
  if (!vv || vv.scale > 1.05) return;
  document.documentElement.style.setProperty("--app-h", Math.round(vv.height) + "px");
  document.body.classList.toggle("kb", window.innerHeight - vv.height > 120);
  if (window.scrollY) window.scrollTo(0, 0);
}
function notice(msg, kind = "warn") {
  const n = $("#notice");
  n.textContent = msg || "";
  n.dataset.kind = kind;
  n.hidden = !msg;
}
// Cada personaje conserva su color: la inicial y el tono salen de su nombre
function avatar(name, cls = "") {
  const n = String(name || "?").trim() || "?";
  let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="av av${h % 4} ${cls}" aria-hidden="true">${esc(n[0].toUpperCase())}</span>`;
}
function addBubble(role, text) {
  const el = document.createElement("div");
  el.className = "msg " + (role === "user" ? "me" : "char");
  el.innerHTML = `<span class="lbl">${role === "user" ? "Tú" : avatar(S.scene.name, "xs") + esc(S.scene.name)}</span><div class="bubble"></div>`;
  el.querySelector(".bubble").textContent = text;
  $("#log").appendChild(el);
  scrollLog();
  return el;
}
// Ayudas bajo cada frase del personaje. En el simulacro solo se puede pedir que repita, como en una entrevista real.
function addAyudas(el, texto) {
  if (!texto || el.querySelector(".char-acts")) return;
  const acts = document.createElement("div"); acts.className = "char-acts";
  el.querySelector(".bubble").after(acts);
  const oir = (label, rate, aria) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "replay"; b.innerHTML = IC.play + label; b.setAttribute("aria-label", aria);
    b.onclick = () => repetirFrase(texto, rate);
    acts.appendChild(b);
  };
  oir("Repetir", undefined, "Repetir esta frase");
  if (S.scene?.prep) return;
  oir("Lento", LENTO, "Repetir esta frase más lento");
  addTraducir(el, texto, acts);
}
// Suena como una corrección: el micrófono no la toma como si la hubieras dicho tú, y se salta tocando el círculo.
let repetirHasta = 0;
function repetirFrase(texto, rate) {
  if (Date.now() < repetirHasta) return;   // otro toque mientras suena no la encola de nuevo
  repetirHasta = Date.now() + 8000 + texto.length * 150;
  unlockAudio();
  const gen = S.gen;
  S.lastCoachText = texto;
  speakItem({ coach: true, gen, text: texto, plain: texto, ssml: ssml(texto, voiceFor(S.scene), rate),
    onStart: () => { $("#live").textContent = ""; $("#stateLabel").textContent = "Repitiendo · toca el círculo para saltarla"; },
    onEnd: () => { repetirHasta = 0; } });
  player.onIdle = () => { if (gen === S.gen && S.state === "speaking") setState("listening", ""); maybeCoach(); };
}
// El personaje habla en inglés; el español solo aparece si lo pides.
function addTraducir(el, texto, acts) {
  const escena = S.scene.title, VER = "Ver en español", OCULTAR = "Ocultar español";
  const contexto = (S.history || []).filter((t) => t.content !== texto).slice(-6);   // lo dicho hasta esta frase: da el sentido
  const b = document.createElement("button");
  b.type = "button"; b.className = "replay"; b.textContent = VER; b.setAttribute("aria-expanded", "false");
  let caja = null, ocupado = false;
  const mostrar = () => { if (el === $("#log").lastElementChild) scrollLog(); else caja.scrollIntoView({ block: "nearest" }); };
  b.onclick = async () => {
    if (ocupado) return;
    if (caja) {
      caja.hidden = !caja.hidden;
      b.textContent = caja.hidden ? VER : OCULTAR; b.setAttribute("aria-expanded", String(!caja.hidden));
      if (!caja.hidden) mostrar();
      return;
    }
    ocupado = true; b.textContent = "Traduciendo…";
    try {
      const r = await fnFetch("generar", { modo: "traducir", texto, escena, contexto });
      const j = await r.json();
      if (!r.ok || !j.es) throw j;
      S.usage.sonnetIn += j.usage?.input_tokens || 0; S.usage.sonnetOut += j.usage?.output_tokens || 0;
      caja = document.createElement("p"); caja.className = "trad-es"; caja.lang = "es"; caja.textContent = j.es;
      acts.after(caja);
      b.textContent = OCULTAR; b.setAttribute("aria-expanded", "true");
      mostrar();
    } catch (e) {
      b.textContent = e?.error === "cuota_diaria" ? "Ya no hay más traducciones hoy" : e?.error === "sin_horas" ? "Sin horas en tu pase"
        : e?.error === "rate_limited" ? "Espera un momento y toca de nuevo" : "No se pudo traducir. Toca para reintentar";
    }
    ocupado = false;
  };
  acts.appendChild(b);
}
function scrollLog() { requestAnimationFrame(() => { const m = $("#logWrap"); m.scrollTop = m.scrollHeight; }); }
// Compara por palabras (sin mayúsculas ni puntuación) y marca solo lo que cambió.
const normWord = (w) => w.toLowerCase().replace(/[’]/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
function wordDiff(a, b) {
  const A = String(a).split(/\s+/).filter(Boolean), B = String(b).split(/\s+/).filter(Boolean);
  const na = A.map(normWord), nb = B.map(normWord);
  const T = Array.from({ length: na.length + 1 }, () => new Array(nb.length + 1).fill(0));
  for (let i = na.length - 1; i >= 0; i--) for (let j = nb.length - 1; j >= 0; j--) T[i][j] = na[i] === nb[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
  const keepA = new Set(), keepB = new Set();
  for (let i = 0, j = 0; i < na.length && j < nb.length;) {
    if (na[i] === nb[j]) { keepA.add(i++); keepB.add(j++); } else if (T[i + 1][j] >= T[i][j + 1]) i++; else j++;
  }
  return {
    said: A.map((w, i) => (keepA.has(i) ? esc(w) : `<span class="del">${esc(w)}</span>`)).join(" "),
    fixed: B.map((w, i) => (keepB.has(i) ? esc(w) : `<span class="ins">${esc(w)}</span>`)).join(" "),
  };
}
// Qué tanto se parece lo que repetiste a la frase objetivo (0 a 1); «I'm» y «I am» cuentan igual.
function repeatScore(said, target) {
  const expand = (t) => t.toLowerCase().replace(/[’]/g, "'").replace(/\b(\w+)'m\b/g, "$1 am").replace(/\b(\w+)'re\b/g, "$1 are").replace(/\b(\w+)'ve\b/g, "$1 have").replace(/\b(\w+)'ll\b/g, "$1 will").replace(/\b(\w+)n't\b/g, "$1 not");
  const A = expand(said).split(/\s+/).map(normWord).filter(Boolean), B = expand(target).split(/\s+/).map(normWord).filter(Boolean);
  if (!A.length || !B.length) return 0;
  const T = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) T[i][j] = A[i] === B[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
  return T[0][0] / Math.max(A.length, B.length);
}
function proofHTML(c) {
  if (!c) return "";
  // Si estuvo bien y es larga, la versión escrita muestra dónde van las pausas y los puntos.
  const escrita = c.ok && c.better && !c.natural && String(c.better).split(/\s+/).length >= 12;
  if (c.ok && !c.natural && !c.tip && !escrita) return `<div class="proof good"><span class="ok">✓ Correcto</span></div>`;
  let h = `<div class="proof ${c.ok ? "good" : ""}">`;
  if (c.ok) h += `<span class="ok">✓ Correcto</span>`;
  if (escrita) h += `<div class="row"><b>Con puntos</b><span class="alt">${esc(c.better)}</span></div>`;
  if (!c.ok && c.better) h += `<div class="row"><b>Correcto</b><span class="fixed">${wordDiff(c.original, c.better).fixed}</span></div>`;
  if (c.natural) h += `<div class="row"><b>Nativo</b><span class="alt">${esc(c.natural)}</span></div>`;
  if (c.tip) h += `<div class="tip">${esc(c.tip)}</div>`;
  return h + `</div>`;
}

/* ---------------- Supabase ---------------- */
function configured() {
  return CFG && CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes("REEMPLAZAR") && CFG.SUPABASE_ANON_KEY && !CFG.SUPABASE_ANON_KEY.includes("REEMPLAZAR");
}
async function fnFetch(name, body, signal) {
  let auth;
  if (S.pruebaToken) auth = "Prueba " + S.pruebaToken;   // conversación de prueba sin cuenta
  else {
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw { code: "no_session" };
    auth = "Bearer " + token;
  }
  const r = await fetch(`${CFG.SUPABASE_URL}/functions/v1/${name}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: auth, apikey: CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
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
    if (j.error === "sin_horas") throw { code: "sin_horas", motivo: j.motivo };
    if (j.error === "prueba_agotada") throw { code: "prueba_agotada" };
    throw { code: "azure_token", status: j.status || r.status };
  }
  const j = await r.json();
  AZ.token = j.token; AZ.region = j.region; AZ.exp = Date.now() + (j.ttlSeconds || 480) * 1000;
  if (AZ.synth) AZ.synth.authorizationToken = AZ.token;
  if (AZ.speechCfg) AZ.speechCfg.authorizationToken = AZ.token;
  return AZ.token;
}
setInterval(() => { if ((S.session || S.pruebaToken) && AZ.token && Date.now() > AZ.exp - 60_000) azureToken(true).catch(() => {}); }, 30_000);

function makeSynth() {
  const cfg = SDK.SpeechConfig.fromAuthorizationToken(AZ.token, AZ.region);
  cfg.speechSynthesisOutputFormat = SDK.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;
  AZ.speechCfg = cfg;
  AZ.synth = new SDK.SpeechSynthesizer(cfg, null); // null: devuelve el audio, no lo reproduce
  try { SDK.Connection.fromSynthesizer(AZ.synth).openConnection(); } catch {}
}
function voiceFor(scene) { return S.voices[scene.id] || scene.voice; }
// «Lento» no estira las vocales: baja solo un poco la velocidad y pone pausas donde una persona respira.
const LENTO = -15;
function conPausas(text, lento) {
  const t = escXml(text);
  return lento ? t.replace(/([,;:])\s+/g, '$1<break time="300ms"/> ').replace(/([.!?])\s+(?=\S)/g, '$1<break time="450ms"/> ') : t;
}
function ssml(text, voice, velocidad = S.rate) {
  const rate = velocidad ? `${velocidad > 0 ? "+" : ""}${velocidad}%` : "0%";
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}"><prosody rate="${rate}">${conPausas(text, velocidad <= LENTO)}</prosody></voice></speak>`;
}
function azureSynthSsml(doc, chars) {
  return new Promise((resolve, reject) => {
    if (!AZ.synth) return reject({ code: "tts", detail: "sin sintetizador" });
    AZ.synth.speakSsmlAsync(doc, (res) => {
      if (res.reason === SDK.ResultReason.SynthesizingAudioCompleted) { S.usage.ttsChars += chars; resolve(res.audioData); }
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
  if (!ctx) {
    const c = ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Interrupción sin salir de la app (llamada, Siri): el audio y el micrófono se detienen sin aviso.
    // Se espera medio segundo para ignorar los cambios breves al configurar la sesión de audio.
    c.onstatechange = () => {
      if (c.state === "running") return;
      setTimeout(() => {
        if (c === ctx && c.state !== "running" && !preparing && S.scene && ["listening", "hearing", "thinking", "speaking"].includes(S.state)) pauseSession("Se interrumpió el audio. Toca Continuar.");
      }, 500);
    };
  }
  if (ctx.state !== "running") ctx.resume().catch(() => {});   // iOS usa también «interrupted» tras una llamada
  const b = ctx.createBuffer(1, 1, 22050); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
  try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record"; } catch {}
}
// La voz de Azure no depende de haber conversado antes: se prepara aquí y, si la conexión quedó vieja, se reintenta una vez.
async function sintetizar(item) {
  for (let intento = 0; ; intento++) {
    try {
      await azureToken();
      if (!AZ.synth) makeSynth();
      return await azureSynthSsml(item.ssml, item.text.length);
    } catch (e) {
      if (intento || e?.code === "sin_horas") throw e;
      logDebug("TTS reintento: " + (e?.detail || e?.code));
      try { AZ.synth?.close(); } catch {}
      AZ.synth = null; AZ.exp = 0;
    }
  }
}
// Encola una frase: arranca la síntesis ya y reproduce en orden.
function speakSentence(text, gen) {
  speakItem({ text, gen, ssml: ssml(text, voiceFor(S.scene)) });
}
function speakItem(item) {
  // Tope de 8 s: una síntesis colgada no debe dejar la cola bloqueada para siempre
  item.ready = Promise.race([
    sintetizar(item).then((ab) => ctx.decodeAudioData(ab.slice(0))),
    new Promise((_, rej) => setTimeout(() => rej({ code: "tts", detail: "sin respuesta en 8 s" }), 8000)),
  ])
    .catch((e) => { logDebug("TTS Azure falló → voz del sistema: " + (e.detail || e.code)); return { fallback: true }; });
  player.queue.push(item);
  if (!player.playing) playNext();
}
async function playNext() {
  const item = player.queue.shift();
  if (!item) { player.playing = null; if (player.onIdle) player.onIdle(); return; }
  player.playing = item;
  const buf = await item.ready;
  if (item.gen !== S.gen) { player.playing = null; item.onEnd?.(); return playNext(); }   // quien la espera no debe quedarse colgado
  // Probar una voz con la voz del sistema engañaría: se avisa que no cargó
  if (item.preview && buf && buf.fallback) { notice("No pude cargar esa voz. Intenta de nuevo o elige otra."); item.onEnd?.(); return playNext(); }
  if (S.turnMetrics && !S.turnMetrics.firstAudio && !item.coach) { S.turnMetrics.firstAudio = now(); finishMetrics(); }
  if (!item.preview && S.state !== "speaking" && S.state !== "paused") setState("speaking");   // oír algo en pausa no reanuda la conversación
  if (item.onStart) item.onStart();
  if (buf && buf.fallback) {
    // Cambiar a la voz del teléfono sin decirlo hace pensar que la app se dañó: se avisa una vez por escena
    if (S.scene && !S.avisoVozSistema && $("#talk") && !$("#talk").hidden) { S.avisoVozSistema = true; notice("La voz del personaje no cargó. Por ahora uso la voz del teléfono; el texto de cada respuesta queda escrito arriba.", "info"); }
    if (item.parts) {   // corrección: cada parte en su idioma
      for (const [lang, t] of item.parts) {
        if (item.gen !== S.gen) break;
        await systemSpeak(t, item, lang === "es" ? "es-MX" : "en-US");
      }
    } else await systemSpeak(item.coach ? item.plain : item.text, item);
  } else {
    await new Promise((res) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination);
      item.src = src; item.finish = res; src.onended = res; src.start(0);
      setTimeout(res, buf.duration * 1000 + 1500);   // con el audio suspendido «ended» no llega y la voz quedaría esperando para siempre
      if (item.preview && ctx.state !== "running") notice("El audio del teléfono está en pausa. Toca Probar otra vez.");
    });
  }
  if (item.onEnd) item.onEnd();
  playNext();
}
function systemSpeak(text, item, lang = "en-US") {
  return new Promise((res) => {
    if (!("speechSynthesis" in window)) return res();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang; u.onend = res; u.onerror = res;
    item.utter = true; item.finish = res;   // iOS a veces no avisa el final: stopSpeaking debe poder liberar la cola
    speechSynthesis.speak(u);
  });
}
/* ---------------- corrección por voz (coach) ----------------
   Voz distinta a la del personaje. Suena cuando el personaje termina su turno,
   nunca encima de él, y resalta la tarjeta que se está leyendo. */
// Una voz nativa por idioma: la voz multilingüe salía ronca en la primera palabra al pasar del inglés al español.
const COACH_VOICES = [{ en: "en-US-AvaNeural", es: "es-MX-DaliaNeural" }, { en: "en-US-AndrewNeural", es: "es-MX-JorgeNeural" }];
function coachVoice() { const v = S.scene ? voiceFor(S.scene) : ""; return /Ava/.test(v) ? COACH_VOICES[1] : COACH_VOICES[0]; }
function coachParts(c) {
  // [idioma, texto]: el español lo dice en español y las frases en inglés, en inglés y un poco más lento.
  const p = [];
  if (!c.ok && c.better) { p.push(["es", "Mejor di:"], ["en", c.better]); }
  if (c.natural) { p.push(["es", c.ok ? "Está bien. Un nativo diría:" : "Y más natural:"], ["en", c.natural]); }
  if (c.tip) p.push(...trozosTip(c.tip));
  return p;
}
// La explicación mezcla español con frases en inglés entre comillas: cada trozo se lee en su idioma.
// Sin comillas leídas como signos: la ' tras un número se pronunciaba «minutos».
function trozosTip(tip) {
  const t = String(tip), out = [], letra = (c) => !!c && /[A-Za-zÀ-ÿ0-9]/.test(c);
  let es = "", i = 0;
  const cierraEs = () => { const s = es.replace(/^[\s,.;:]+/, "").trim(); if (/[A-Za-zÀ-ÿ]/.test(s)) out.push(["es", s]); es = ""; };
  while (i < t.length) {
    const c = t[i], par = { '"': '"', "“": "”", "«": "»" }[c];
    let fin = -1;
    if (par) fin = t.indexOf(par, i + 1);
    else if ((c === "'" || c === "‘") && !letra(t[i - 1])) {
      for (let j = i + 1; j < t.length; j++) if ((t[j] === "'" || t[j] === "’") && !letra(t[j + 1])) { fin = j; break; }   // friend's no cierra
    }
    if (fin > i + 1) {
      const cita = t.slice(i + 1, fin).trim();
      if (/[áéíóúñ¿¡]/i.test(cita)) es += " " + cita + " ";   // lo citado está en español
      else { cierraEs(); out.push(["en", cita]); }
      i = fin + 1;
    } else { es += c; i++; }
  }
  cierraEs();
  return out;
}
// Un bloque <voice> por trozo: garantiza que cada uno salga en su idioma, también a mitad de frase.
function coachSsml(parts) {
  const v = coachVoice();
  const body = parts.map(([lang, t]) => lang === "es"
    ? `<voice name="${v.es}">${escXml(t)}<break time="120ms"/></voice>`
    : `<voice name="${v.en}"><prosody rate="-12%">${escXml(t)}</prosody><break time="200ms"/></voice>`).join("");
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">${body}</speak>`;
}
const AVISO_COACH = "Corrección · toca el círculo para saltarla";
const coachQ = [];
function queueCoach(c, card, gen) {
  if (!S.voiceCorr) return;
  const parts = coachParts(c);
  if (!parts.length) return;
  coachQ.push({ parts, card, gen });
  maybeCoach();
}
function maybeCoach() {
  if (!coachQ.length || player.playing || player.queue.length) return;
  if (!["listening", "speaking"].includes(S.state)) return;
  while (coachQ.length && coachQ[0].gen !== S.gen) coachQ.shift();   // José ya habló otra vez: las viejas quedan solo en pantalla
  if (!coachQ.length) return;
  const job = coachQ.shift();
  const plain = job.parts.map((p) => p[1]).join(" ");
  S.lastCoachText = plain;
  const gen = S.gen;
  speakItem({
    coach: true, gen, text: plain, plain, parts: job.parts, ssml: coachSsml(job.parts),
    onStart: () => { job.card.classList.add("reading"); job.card.scrollIntoView({ block: "nearest", behavior: "smooth" }); $("#live").textContent = ""; $("#stateLabel").textContent = AVISO_COACH; },
    onEnd: () => { job.card.classList.remove("reading"); },
  });
  player.onIdle = () => { if (gen === S.gen && S.state === "speaking") setState("listening", ""); maybeCoach(); };
}
let replayNow = null;   // la corrección que ya está sonando: otro toque en la misma tarjeta no la repite
function replayCoach(c, card) {
  unlockAudio();   // viene de un toque; si Azure no está, speakItem cae a la voz del sistema
  const parts = coachParts(c); if (!parts.length) return;
  const plain = parts.map((p) => p[1]).join(" ");
  if (replayNow && replayNow.card === card && replayNow.gen === S.gen && Date.now() < replayNow.until) return;
  S.lastCoachText = plain;
  const gen = S.gen;
  replayNow = { card, gen, until: Date.now() + 12000 + plain.length * 150 };
  speakItem({ coach: true, gen, text: plain, plain, parts, ssml: coachSsml(parts),
    onStart: () => { card.classList.add("reading"); $("#stateLabel").textContent = AVISO_COACH; }, onEnd: () => { card.classList.remove("reading"); replayNow = null; } });
  player.onIdle = () => { if (gen === S.gen && S.state === "speaking") setState("listening", ""); };
}

// Fuera de una conversación (Repaso): lee la corrección completa, cada parte en su idioma
function leerCorreccion(c) {
  unlockAudio();
  stopSpeaking();
  const parts = coachParts(c);
  if (!parts.length) return Promise.resolve();
  const plain = parts.map((p) => p[1]).join(" ");
  return new Promise((res) => speakItem({ coach: true, gen: S.gen, text: plain, plain, parts, ssml: coachSsml(parts), onEnd: res }));
}

function stopSpeaking() {
  S.gen++;
  document.querySelectorAll(".proof.reading").forEach((el) => el.classList.remove("reading"));
  for (const it of player.queue) it.gen = -1;
  player.queue = [];
  if (player.playing) {
    try { player.playing.src && player.playing.src.stop(0); } catch {}
    player.playing.finish?.();   // con el AudioContext suspendido «ended» no llega: se libera la cola igual
    if (player.playing.utter && "speechSynthesis" in window) speechSynthesis.cancel();
  }
  if (S.chatCtl) { try { S.chatCtl.abort(); } catch {} S.chatCtl = null; }
}

/* ---------------- micrófono + VAD + STT ---------------- */
let micStream = null, vadNode = null;
let micLost = false;            // la pista del micrófono murió: Continuar debe abrirlo de nuevo
let preparing = false;          // abriendo micrófono y voz (el aviso de permisos puede interrumpir el audio)
const ring = [];                // cuadros previos al inicio de voz
let stt = null;                 // sesión de reconocimiento activa
let bargeFrames = 0;

// WAV de 16 kHz, 16 bits, mono, a partir de los cuadros del micrófono
function wavDe(cuadros) {
  const n = cuadros.reduce((a, f) => a + f.length, 0), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const txt = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  txt(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); txt(8, "WAVE"); txt(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); txt(36, "data"); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const f of cuadros) for (let i = 0; i < f.length; i++, o += 2) { const s = Math.max(-1, Math.min(1, f[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: "audio/wav" });
}
function f32ToI16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return out.buffer;
}

// Justo después de una llamada el teléfono puede dejar estas esperas sin respuesta: la app no debe quedarse «Preparando…»
const conTope = (p, ms, code) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej({ code }), ms))]);
const TOPE_MIC = 10000;

/* Micrófono apagado de verdad cuando no se usa: en iPhone el punto naranja no debe quedar encendido en «Hoy» o en el repaso.
   Solo fuera de una escena o con la escena en pausa; Continuar y la próxima escucha lo vuelven a abrir. */
let vadPausaDesde = 0;
function apagarMic() {
  const st = micStream;
  try { vadNode?.pause(); } catch {}
  try { vadNode?.destroy?.(); } catch {}
  vadNode = null; micStream = null; micLost = true;
  st?.getTracks().forEach((t) => t.stop());
}
setInterval(() => {
  if (!micStream || !vadPausaDesde || unaVez || stt || preparing) return;
  if (S.scene && S.state !== "paused") return;
  if (Date.now() - vadPausaDesde > 15000) apagarMic();
}, 5000);
/* La detección de voz (onnxruntime, 127 KB comprimido, + vad) se carga al abrir el micrófono por primera vez,
   o en reposo unos segundos después de abrir la app: el inicio no la espera */
const LIB_ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort.min.js";
const LIB_VAD = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.22/dist/bundle.min.js";
let vadLista = null;
const cargarScript = (src) => new Promise((ok, mal) => {
  const t = document.createElement("script"); t.src = src; t.onload = ok; t.onerror = () => { t.remove(); mal(new Error("lib_voz")); };
  document.head.appendChild(t);
});
function cargarVad() {
  return vadLista ||= (async () => { if (!window.ort) await cargarScript(LIB_ORT); if (!window.vad) await cargarScript(LIB_VAD); })()
    .catch((e) => { vadLista = null; throw e; });
}
function precargarVad() {
  const ya = () => cargarVad().catch(() => {});
  setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(ya, { timeout: 4000 }) : ya()), 2500);
}
async function startMic() {
  await cargarVad();
  const pedido = navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // Si el permiso llega tarde, ese micrófono ya nadie lo usa: se apaga
  micStream = await conTope(pedido, TOPE_MIC, "mic_tope").catch((e) => { pedido.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {}); throw e; });
  const stream = micStream;
  try {
    const source = ctx.createMediaStreamSource(stream);
    vadNode = await conTope(vad.AudioNodeVAD.new(ctx, {
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
    }), TOPE_MIC, "vad_tope");
    vadNode.receive(source);
    // Se anota desde cuándo está en pausa la detección de voz: si nadie la usa, el micrófono se apaga (ver apagarSiOcioso)
    const vp = vadNode.pause.bind(vadNode), vs = vadNode.start.bind(vadNode);
    vadNode.pause = () => { vadPausaDesde = Date.now(); return vp(); };
    vadNode.start = () => { vadPausaDesde = 0; return vs(); };
    vadNode.start();
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    micStream = null; vadNode = null;
    throw e;
  }
  micLost = false;
  stream.getAudioTracks()[0].addEventListener("ended", () => {
    if (stream !== micStream) return;
    try { vadNode?.pause(); } catch {}
    try { vadNode?.destroy?.(); } catch {}
    vadNode = null; micStream = null; micLost = true;   // Continuar o la próxima escena lo abren de nuevo
    if (S.scene && S.state !== "idle") pauseSession("El micrófono se cortó. Toca Continuar.");
  });
  // Una llamada silencia el micrófono sin apagarlo: la app diría «Escuchando» sin oír nada
  const pista = stream.getAudioTracks()[0];
  pista.addEventListener("mute", () => setTimeout(() => {
    if (stream === micStream && pista.muted && !preparing && S.scene && ["listening", "hearing", "thinking", "speaking"].includes(S.state)) pauseSession("Se interrumpió el micrófono. Toca Continuar.");
  }, 800));
}
// ¿El audio quedó inservible? iOS puede dejarlo así tras una llamada, y reactivarlo no siempre basta.
function audioDanado() {
  if (!ctx || ctx.state !== "running") return true;
  const pista = micStream?.getAudioTracks()[0];
  return !pista || pista.muted || pista.readyState !== "live";
}
// Suelta todo lo de audio. Debe correr dentro del toque en Continuar, para que iOS permita crearlo de nuevo.
function reiniciarAudio() {
  try { vadNode?.pause(); } catch {}
  try { vadNode?.destroy?.(); } catch {}
  vadNode = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  const viejo = ctx; ctx = null;
  if (viejo) { viejo.onstatechange = null; viejo.close().catch(() => {}); }
}

function onFrame(probs, frame) {
  if (!frame) return;
  ring.push(frame); if (ring.length > 4) ring.shift();
  if (stt && !stt.closed) { stt.push.write(f32ToI16(frame)); stt.frames++; if (unaVez) unaVez.audio?.push(frame); }
  // Interrupción: solo si la voz es sostenida (evita que el eco del parlante corte al personaje)
  if (S.state === "speaking" && stt && S.bargeIn && !player.playing?.coach) {
    bargeFrames = probs.isSpeech > 0.85 ? bargeFrames + 1 : Math.max(0, bargeFrames - 1);
    if (bargeFrames >= 3) { bargeFrames = 0; logDebug("Interrupción"); stopSpeaking(); setState("hearing", ""); }
  }
}

// El turno en curso. En modo manual cada tramo de voz se suma a «partes» y nada se envía hasta tocar Listo.
const turno = { partes: [], cerrando: false, segmento: null };
function modoManual() { return !!S.scene && store.get(S.scene.prep ? "manualSim" : "manualConv", !!S.scene.prep); }

// Seguridad de lo reconocido en este turno: [confianza de Azure, palabras]
const confTurno = [];
function confianzaDe(result) {
  try {
    const j = JSON.parse(result.properties?.getProperty?.(SDK.PropertyId.SpeechServiceResponse_JsonResult) || result.json);
    const v = j.NBest?.[0]?.Confidence;
    return typeof v === "number" ? v : null;
  } catch { return null; }
}
function promedioConf() {
  const palabras = confTurno.reduce((n, x) => n + x[1], 0);
  return palabras ? confTurno.reduce((n, x) => n + x[0] * x[1], 0) / palabras : null;
}
const CONF_MINIMA = 0.5;   // estimado: se ajusta con las confianzas que guarda cada sesión
// Devuelve por qué no conviene corregir lo oído, o null si se puede corregir.
function oidoDudoso(text, conf) {
  const ws = String(text).match(/[A-Za-z0-9']+/g) || [];
  if (ws.length < 2) return "corta";     // de una sola palabra no se puede saber qué querías decir
  if (ws.some((w) => /[bcdfghjklmnpqrstvwxz]{6,}/i.test(w))) return "ruido";   // 6 consonantes seguidas: ninguna palabra común («strengths» tiene 5)
  if (conf != null && conf < CONF_MINIMA) return "dudosa";
  return null;
}

// Una sola frase fuera de la conversación (Repaso). Usa el mismo micrófono y reconocimiento de la conversación.
let unaVez = null;
// pron: además evalúa la pronunciación por sonido (sin frase de referencia: se evalúa lo que la persona dijo)
// grabar: guarda en memoria los mismos cuadros que van a Azure (16 kHz) para que la persona se oiga; nunca se sube
async function escucharUnaVez(parcial, { pron = false, grabar = false } = {}) {
  if (!vadNode) await startMic(); else vadNode.start();
  let terminar;
  const promesa = new Promise((r) => { terminar = r; });
  const u = unaVez = { parcial, pron: pron ? [] : null, audio: grabar ? [] : null, cerrando: null, fin: (t) => { if (unaVez !== u) return; unaVez = null; try { vadNode?.pause(); } catch {} terminar(t); } };
  return {
    promesa,
    palabras: () => u.pron || [],
    grabacion: () => (u.audio?.length ? wavDe(u.audio) : null),
    parar: async () => { const s = stt; const t = s ? await closeStt() : u.cerrando ? await u.cerrando : ""; if (s && u.pron) u.pron.push(...s.pron); u.fin(t); },
    cancelar: () => { if (unaVez === u && stt) { stt.discard = true; closeStt(); } u.fin(""); },
  };
}

function onSpeechStart() {
  if (unaVez) { if (!stt) { openStt(!!unaVez.pron); for (const f of ring) { stt.push.write(f32ToI16(f)); stt.frames++; unaVez.audio?.push(f); } } return; }
  if (S.state === "paused" || S.state === "idle" || turno.cerrando) return;
  if (S.state === "thinking" && modoManual()) return;   // ya cerraste tu turno: lo que suene ahora no es parte de él
  if (player.playing?.coach) return;     // repetir en voz baja o un ruido no corta la corrección; se salta tocando el círculo
  bargeFrames = 0;                      // sin interrupción también se abre: si sigues hablando al terminar el personaje, cuenta
  openStt(PRON_CONV, true);
  for (const f of ring) { stt.push.write(f32ToI16(f)); stt.frames++; }
  if (S.state !== "speaking") setState("hearing", "");
}

function onVADMisfire() {
  if (stt) { stt.discard = true; closeStt(); }
  if (S.state === "hearing") setState("listening", "");
}

// ¿Lo reconocido es un trozo, en el mismo orden, de lo que acaba de sonar por el parlante?
function isEcho(text, ref) {
  if (!ref) return false;
  const A = text.toLowerCase().match(/[a-z']+/g) || [], B = ref.toLowerCase().match(/[a-z']+/g) || [];
  if (!A.length) return false;
  const T = new Array(B.length + 1).fill(0);
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1, prev = 0; j >= 0; j--) { const cur = T[j]; T[j] = A[i] === B[j] ? prev + 1 : Math.max(T[j], T[j + 1]); prev = cur; }
  return T[0] / A.length > 0.75;
}

async function onSpeechEnd() {
  if (!stt) return;
  if (unaVez) {
    const u = unaVez, s = stt;
    u.cerrando = closeStt();
    const t = await u.cerrando;
    if (u.pron) u.pron.push(...s.pron);
    if (t) u.fin(t);                     // sin texto sigue escuchando hasta Listo o el tope de tiempo
    return;
  }
  const tEnd = now();
  const sess = stt, scene = S.scene;
  turno.segmento = closeStt();           // si tocas Listo ahora, espera a este tramo
  const text = await turno.segmento;
  if (sess.discard) return;
  if (S.state === "paused" || S.scene !== scene) return;   // pausaste o saliste mientras se cerraba el reconocimiento
  if (!text) { if (S.state === "hearing") setState("listening", turno.partes.length ? undefined : "No te entendí. Repite, por favor."); return; }
  if (sess.overTTS && !S.bargeIn && S.state === "speaking") return;   // hablaste encima con la interrupción apagada
  // Eco: solo si la voz empezó con el parlante sonando. Una respuesta normal puede repetir palabras de la pregunta.
  if (sess.overTTS) {
    const lastBot = [...S.history].reverse().find((t) => t.role === "assistant");
    if (isEcho(text, lastBot?.content) || isEcho(text, S.lastCoachText)) {
      logDebug("Descartado por eco: " + text); S.pronTurno = [];
      if (S.state === "hearing") setState("listening", "");
      return;
    }
  }
  if (S.retry && !turno.partes.length && handleRetry(text)) return;   // repetir una frase no necesita Listo
  if (modoManual()) {
    if (S.state === "speaking") return;  // el personaje seguía hablando: tu respuesta aún no ha empezado
    turno.partes.push(text);
    if (S.state === "hearing") setState("listening");
    return;
  }
  userSaid(text, { speechEnd: tEnd, sttDone: now() });
}

// Botón Listo: cierra el turno ya, sin esperar el silencio
async function cerrarTurno() {
  if (turno.cerrando || !S.scene || S.state === "paused") return;
  if (!modoManual() && !stt) return;    // el cierre automático ya va en camino
  const scene = S.scene, tEnd = now();
  turno.cerrando = true;
  setState("thinking", "");
  let resto = "";
  if (stt) { const sess = stt; resto = await closeStt(); if (sess.discard) resto = ""; }
  await turno.segmento;
  const text = [...turno.partes, resto].filter(Boolean).join(" ").trim();
  turno.partes = []; turno.cerrando = false;
  if (S.scene !== scene || S.state !== "thinking") return;   // pausaste o saliste mientras se cerraba
  if (!text) { setState("listening", "No te entendí. Repite, por favor."); return; }
  if (S.retry && handleRetry(text)) { setState("listening", ""); return; }
  userSaid(text, { speechEnd: tEnd, sttDone: now() });
}

// La conversación también puntúa cada sonido (mismo audio, mismo costo). Apagar aquí si sube la latencia.
const PRON_CONV = true;
function openStt(conPron = false, conv = false) {
  if (stt) { stt.discard = true; closeStt(); }
  const fmt = SDK.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const push = SDK.AudioInputStream.createPushStream(fmt);
  const cfg = SDK.SpeechConfig.fromAuthorizationToken(AZ.token, AZ.region);
  cfg.speechRecognitionLanguage = "en-US";
  cfg.outputFormat = SDK.OutputFormat.Detailed;   // trae la confianza de cada frase
  if (!turno.partes.length) confTurno.length = 0;
  const rec = new SDK.SpeechRecognizer(cfg, SDK.AudioConfig.fromStreamInput(push));
  if (conPron) {   // repaso: puntaje de cada sonido de lo que dijo (mismo audio, mismo costo)
    try {
      const pac = new SDK.PronunciationAssessmentConfig("", SDK.PronunciationAssessmentGradingSystem.HundredMark, SDK.PronunciationAssessmentGranularity.Phoneme, false);
      pac.phonemeAlphabet = "IPA"; pac.nbestPhonemeCount = 1;
      pac.applyTo(rec);
    } catch (e) { logDebug("pronunciación " + e); }
  }
  const sess = { rec, push, conv, pron: [], parts: [], partial: "", frames: 0, closed: false, discard: false, error: null, done: null, overTTS: S.state === "speaking" };
  sess.done = new Promise((resolve) => { sess.resolve = resolve; });
  rec.recognizing = (_s, e) => { sess.partial = e.result.text; if (!sess.discard) unaVez?.parcial?.([...sess.parts, sess.partial].join(" ")); if (!sess.discard && (S.bargeIn || S.state !== "speaking")) $("#live").textContent = [...turno.partes, ...sess.parts, sess.partial].join(" "); };
  rec.recognized = (_s, e) => {
    if (e.result.reason === SDK.ResultReason.RecognizedSpeech && e.result.text) {
      sess.parts.push(e.result.text);
      if (conPron) { try { sess.pron.push(...(window.Estudio?._parseSeg?.(e.result)?.words || [])); } catch {} }
      const c = confianzaDe(e.result);
      if (c != null && !sess.discard) confTurno.push([c, e.result.text.split(/\s+/).length]);
    }
    sess.partial = "";
  };
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
  const juntar = () => { if (sess.conv && !sess.discard && sess.pron.length) (S.pronTurno ||= []).push(...sess.pron); };
  S.usage.sttSeconds += (sess.frames * 1536) / 16000;
  await Promise.race([sess.done, new Promise((r) => setTimeout(r, 3000))]);
  try { sess.rec.stopContinuousRecognitionAsync(() => sess.rec.close(), () => sess.rec.close()); } catch {}
  juntar();
  if (sess.error && !sess.discard) {
    if (/quota|429|throttl/i.test(sess.error)) notice("La voz no está disponible por ahora. Puedes seguir escribiendo abajo.");
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
  turno.partes = [];                      // si escribes, lo escrito reemplaza lo dicho a medias
  notice("");
  S.lastCoachText = "";
  const gen = S.gen;
  S.turnMetrics = { speechEnd: m.speechEnd || now(), sttDone: m.sttDone || now(), firstToken: 0, firstAudio: 0 };
  const prev = [...S.history].reverse().find((t) => t.role === "assistant")?.content || "";
  S.history.push({ role: "user", content: text });
  if (S.sesion) {
    S.sesion.turnos++; S.sesion.palabras_jose += countWords(text);
    if (S.sesion.turnos % 5 === 0) saveSessionNow();
    if (S.prueba || S.scene?.turnosMax) pruebaTurno(S.sesion.turnos);   // prueba sin cuenta y medición: número fijo de respuestas
  }
  const bubble = addBubble("user", text);
  const pw = m.speechEnd ? (S.pronTurno || []).splice(0) : [];   // escrito a mano no tiene audio
  S.pronTurno = [];
  if (pw.length) {
    (S.pronSesion ||= []).push(...pw);
    const linea = !S.scene?.prep && window.Estudio?._sonidoLinea?.(pw);   // en el simulacro todo queda para el final
    if (linea) bubble.insertAdjacentHTML("beforeend", linea);
  }
  setState("thinking", "");
  const conf = m.speechEnd ? promedioConf() : null;   // escrito a mano no tiene confianza
  confTurno.length = 0;
  if (conf != null) (S.confs ||= []).push(Math.round(conf * 100) / 100);
  S.corrPend = (S.corrPend || 0) + 1;
  correct(text, prev, bubble, conf).finally(() => { S.corrPend--; });      // en paralelo, no bloquea la voz
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
    const r = await fnFetch("chat", { persona: S.scene.persona, history: S.history, level: S.scene.nivel || S.level }, ctl.signal);   // una lección puede elegir su propio nivel
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw { code: j.error || "chat", status: j.status || r.status, motivo: j.motivo }; }
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
          if (S.turnMetrics && !S.turnMetrics.firstToken) S.turnMetrics.firstToken = now();   // puede ser null si ya sonó la primera frase
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
    if (full && bubble) addAyudas(bubble, full);
    if (S.sesion && full) S.sesion.palabras_pers += countWords(full);
    scrollLog();
    player.onIdle = () => { if (gen === S.gen && S.state === "speaking") setState("listening", ""); maybeCoach(); };
    if (!player.playing && !player.queue.length) { setState("listening", ""); maybeCoach(); }
  } catch (e) {
    if (e?.name === "AbortError" || gen !== S.gen) return;
    const msg = e.code === "sin_horas" ? paseMsg(e.motivo) : {
      rate_limited: "Vas muy rápido: espera unos segundos.",
      prueba_agotada: PRUEBA_AGOTADA,
      unauthorized: "Tu sesión venció. Vuelve a entrar.",
      anthropic: "El personaje no respondió. Repite tu frase.",
      no_session: "Tu sesión venció. Vuelve a entrar.",
    }[e.code] || "No hubo respuesta. Revisa tu conexión y repite tu frase.";
    notice(msg);
    logDebug("chat error " + JSON.stringify(e));
    setState("listening", "");
  }
}

async function correct(text, prev, bubble, conf) {
  const gen = S.gen;
  const corrections = S.corrections;   // la lista de esta sesión, aunque llegue después de salir
  const failed = () => { if (corrections) corrections.failed = (corrections.failed || 0) + 1; S.recapRender?.(); };
  const simulacro = !!S.scene?.prep;   // en una entrevista real nadie te corrige: todo queda para el informe
  // Corregir lo que la app no oyó bien sería corregirte algo que no dijiste: ni corrección ni tarjeta.
  const dudoso = oidoDudoso(text, conf);
  if (dudoso) {
    if (dudoso !== "corta" && !simulacro) { bubble.insertAdjacentHTML("beforeend", `<div class="proof"><span class="muted small">No te entendí con claridad, así que no corrijo esta frase.</span></div>`); scrollLog(); }
    return;
  }
  try {
    const escena = S.scene.title;      // la de este turno, aunque ya hayas cambiado de escena
    const leccion_id = S.scene.returnTo?.kind === "lesson" ? S.scene.returnTo.id : null;
    const r = await fnFetch("corregir", { scene: escena, prev, text });
    if (!r.ok) { failed(); return; }
    const c = await r.json();
    c.original = text;
    if (!c.ok && !c.better) c.ok = true;
    S.usage.sonnetIn += c.usage?.input_tokens || 0; S.usage.sonnetOut += c.usage?.output_tokens || 0;
    if (/^(A1|A2|B1|B2|C1|C2)$/.test(c.cefr)) S.cefrVotes.push(c.cefr);
    // Solo un error de verdad entra solo al repaso; una frase que estaba bien y tiene forma más natural se guarda con un toque
    const tarjeta = { escena, dijiste: text, correcta: c.ok ? "" : c.better, nativo: c.natural, tip: c.tip, contexto: prev, leccion_id };
    if (window.Datos && !c.ok) Datos.addFromCorrection(tarjeta);
    if (!c.ok && c.better && corrections) corrections.push({ original: text, better: c.better, tip: c.tip || "" });
    if (simulacro) { S.recapRender?.(); return; }
    if (!c.ok && c.better) bubble.querySelector(".bubble").innerHTML = wordDiff(text, c.better).said;
    bubble.insertAdjacentHTML("beforeend", proofHTML(c));
    const card = bubble.lastElementChild;
    const acts = document.createElement("div"); acts.className = "proof-acts";
    if (coachParts(c).length) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "replay"; b.innerHTML = `${IC.play}Escuchar la corrección`;
      b.onclick = () => replayCoach(c, card);
      acts.appendChild(b);
    }
    const target = c.ok ? c.natural : c.better;
    if (target) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "replay"; b.innerHTML = `${IC.mic}Dilo otra vez`;
      b.onclick = () => askRetry(target, card);
      acts.appendChild(b);
    }
    if (c.ok && c.natural && window.Datos) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "replay"; b.textContent = "+ Guardar en mi repaso";
      b.onclick = () => { Datos.addFromCorrection(tarjeta); b.disabled = true; b.textContent = "✓ En tu repaso"; };
      acts.appendChild(b);
    }
    if (acts.children.length) card.appendChild(acts);
    scrollLog();
    queueCoach(c, card, gen);
    S.recapRender?.();
  } catch { failed(); }
}

/* ---------------- «Dilo otra vez»: practicar la frase corregida sin que cuente como turno ---------------- */
function retryBox(card, html) {
  let box = card.querySelector(".retry");
  if (!box) { box = document.createElement("div"); box.className = "retry"; box.setAttribute("role", "status"); card.appendChild(box); }
  box.innerHTML = html;
  requestAnimationFrame(() => box.scrollIntoView({ block: "nearest", behavior: "smooth" }));   // la tarjeta puede no ser la última del chat
}
function askRetry(target, card) {
  unlockAudio();
  if (player.playing?.coach) { stopSpeaking(); setState("listening", ""); }   // si aún sonaba la corrección, tu turno de repetir va primero
  if (S.state === "paused") resumeSession();
  S.retry = { target, card };
  const cuando = !vadNode ? "Escríbelo abajo o toca el círculo para hablar." : S.state === "speaking" || S.state === "thinking" ? "Dilo en voz alta cuando termine el personaje." : "Dilo en voz alta ahora. Te escucho.";
  retryBox(card, `<b>Ahora dilo tú:</b> ${esc(target)}<span class="muted small">${cuando}</span>`);
}
// Devuelve false si lo dicho no era un intento de repetir: entonces sigue la conversación normal.
function handleRetry(text) {
  const { target, card } = S.retry;
  const score = repeatScore(text, target);
  S.retry = null;
  if (score < 0.4) { card.querySelector(".retry")?.remove(); return false; }
  if (S.sesion) S.sesion.palabras_jose += countWords(text);
  if (S.state === "hearing") setState("listening", "");
  if (score >= 0.85) retryBox(card, `<span class="ok">✓ Te salió bien. Sigue con la conversación.</span>`);
  else {
    const d = wordDiff(text, target);
    retryBox(card, `<b>Casi.</b><span class="said">${d.said}</span><span class="fixed">${d.fixed}</span><button type="button" class="replay" data-again>${IC.mic}Intentar de nuevo</button>`);
    card.querySelector("[data-again]").onclick = () => askRetry(target, card);
  }
  return true;
}

/* ---------------- balance al terminar ---------------- */
const CRITERIOS = [["objetivo", "Lograste el objetivo"], ["desarrollo", "Desarrollaste tus respuestas"], ["precision", "Inglés correcto"], ["naturalidad", "Sonó natural"]];
const MIN_EVAL = 3;   // con menos respuestas no hay material para evaluar y no se gasta la llamada
function evalHTML(ev) {
  if (ev.corta) return `<p class="muted small">Con ${MIN_EVAL} respuestas o más recibes una evaluación de la práctica completa.</p>`;
  if (ev.loading) return `<div class="eval" role="status"><span class="lbl">Evaluación de la práctica</span><span class="muted">Leyendo toda la conversación…</span></div>`;
  if (ev.failed) return `<div class="eval" role="status"><span>No pude evaluar esta práctica.</span><button class="ghost" id="rcEval">Intentar de nuevo</button></div>`;
  const v = ev.v, d = ev.prev ? v.puntaje - ev.prev.puntaje : null;
  // Una diferencia de 5 puntos es una sola nota de un criterio: no se presenta como avance ni retroceso.
  const delta = d === null ? "" : Math.abs(d) <= 5 ? `Parecido a tu intento anterior (${ev.prev.puntaje})` : `${d > 0 ? "+" : "−"}${Math.abs(d)} frente a tu intento anterior (${ev.prev.puntaje})`;
  const logro = { si: `<span class="ok">✓ Cumpliste el reto anterior</span>`, parcial: `<span class="muted small">Cumpliste en parte el reto anterior</span>`, no: `<span class="muted small">El reto anterior sigue pendiente</span>` }[v.reto_logrado] || "";
  return `<div class="eval">
    <span class="lbl">Evaluación de la práctica</span>
    <div class="evtop"><div class="evring" style="--p:${v.puntaje}"><span class="evnum">${v.puntaje}</span></div><span class="muted">de 100</span></div>
    ${delta ? `<span class="evdelta">${delta}</span>` : ""}${logro}
    ${CRITERIOS.map(([k, t]) => { const c = v.criterios[k]; return `<div class="crit"><div class="crit-h"><span>${t}</span><span class="dots" role="img" aria-label="${c.nota} de 5">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= c.nota ? "on" : ""}"></i>`).join("")}</span></div><span class="muted small">${esc(c.por_que_es)}</span></div>`; }).join("")}
    <div class="rc-ctx"><b>Lo mejor</b><span>${esc(v.lo_mejor_es)}</span></div>
    <div class="reto"><span class="lbl">Tu reto para el próximo intento</span><span>${esc(v.reto_es)}</span></div>
    <div class="rc-ctx"><b>Una respuesta que podía ser más fuerte</b><span class="muted small">${esc(v.mejor.dijiste)}</span><span class="en">${esc(v.mejor.mejor_en)}</span><span class="muted small">Es un ejemplo: cambia los datos por los tuyos.</span><button class="replay" id="rcMejor">${IC.play}Escuchar</button></div>
    <p class="muted small" style="margin:0">Se evalúa el texto de lo que dijiste. La pronunciación no entra en este puntaje.</p>
  </div>`;
}
function showRecap(scene, ses, list, leave, hist = []) {
  const pronRecap = S.pronSesion || [];
  const users = hist.filter((t) => t.role === "user").length;
  if (scene.prep) window.Prep?.setHist(hist);
  let ev = users >= MIN_EVAL ? { loading: true } : { corta: true };
  const paint = () => { if (S.recapRender === render) render(); };
  const evaluate = async () => {
    ev = { loading: true }; paint();
    try {
      const r = await fnFetch("generar", { modo: "evaluar_escena", escena: scene.title, sesion: ses.id, desc: scene.desc || "", personaje: `${scene.name}, ${scene.who || ""}`, level: scene.nivel || S.level, turnos: hist });
      if (!r.ok) throw new Error("evaluar " + r.status);
      const j = await r.json();
      ev = { v: j.evaluacion, prev: j.previo };
      ses.evaluacion = j.evaluacion;
      window.Datos?.saveSession(ses);
      store.set("retos", { ...store.get("retos", {}), [scene.title]: j.evaluacion.reto_es });
      logDebug("evaluación " + JSON.stringify(j.usage));
    } catch (e) { logDebug("evaluación falló " + (e?.message || e)); ev = { failed: true }; }
    paint();
  };
  function render() {
    const last = (scene.prep ? list.slice() : list.slice(-3)).reverse();   // en el simulacro aquí se ven todas
    const due = window.Datos ? Datos.due().length : 0;
    const scored = !!ev.v;
    $("#recapBody").innerHTML = `<h1>Terminaste esta práctica</h1>
      <p class="muted">${esc(scene.title)}</p>
      ${evalHTML(ev)}
      <div class="kpis"><div><small>Turnos</small><b>${ses.turnos}</b></div><div><small>Palabras tuyas</small><b>${ses.palabras_jose}</b></div><div><small>Correcciones</small><b>${list.length}</b></div></div>
      ${window.Estudio?._sonidos?.(pronRecap) || ""}
      ${last.length ? `<div class="rc-ctx"><b>Frase para mañana</b><span class="en">${esc(last[0].better)}</span></div>
        <h2>${scene.prep ? "Correcciones de tu inglés en el simulacro" : "Lo que más conviene repasar"}</h2>
        <div class="list">${last.map((c) => { const d = wordDiff(c.original, c.better); return `<div class="li"><span class="said">${d.said}</span><span class="fixed">${d.fixed}</span>${c.tip ? `<span class="meta">${esc(c.tip)}</span>` : ""}</div>`; }).join("")}</div>
        <p class="muted small">${S.prueba ? "Con tu acceso, estas frases quedan en tu cuaderno de errores y vuelven en tu repaso hasta que te salgan solas." : "Estas frases ya están en tu cuaderno de errores."}</p>`
      : list.failed ? `<p class="muted small">No pude revisar todas tus frases en esta práctica.</p>`
      : `<div class="proof good"><span class="ok">✓ Sin errores que corregir en esta práctica.</span></div>`}
      ${S.prueba ? pruebaCierreHTML() : `
      ${scored ? `<button class="primary wide" id="rcAgain">Ensayar otra vez con este reto</button>` : ""}
      ${due ? `<button class="${scored ? "ghost" : "primary"} wide" id="rcReview">Repasar ahora · ${due} ${due === 1 ? "pendiente" : "pendientes"}</button>` : ""}
      ${scored ? "" : `<button class="ghost wide" id="rcAgain">Ensayar otra vez esta escena</button>`}
      <button class="${scene.prep || scene.medicion ? "primary" : "ghost"} wide" id="rcDone">${scene.prep ? "Ver cómo te vendiste" : scene.medicion ? "Ver mi medición" : scene.returnTo ? "Volver a la lección" : "Volver al inicio"}</button>`}`;
    const off = () => { S.recapRender = null; stopSpeaking(); };
    const rv = $("#rcReview"); if (rv) rv.onclick = () => {
      off();
      if (scene.returnTo) {   // al salir del repaso vuelves a la lección de donde venías
        S.backTo = scene.returnTo;
        $("#reviewBack").textContent = "‹ Lección"; $("#reviewBack").setAttribute("aria-label", "Volver a la lección");
      }
      Repaso.open();
    };
    const re = $("#rcEval"); if (re) re.onclick = evaluate;
    const m = $("#rcMejor"); if (m) m.onclick = () => speakEN(ev.v.mejor.mejor_en).catch(() => {});
    $("#rcAgain").onclick = () => { off(); if (S.prueba) pruebaEscena(); else startScene(scene); };
    const dn = $("#rcDone"); if (dn) dn.onclick = () => { off(); leave(); };
    const en = $("#rcEntrar"); if (en) en.onclick = salirDePrueba;
    const rs = $("#rcReservar"); if (rs) rs.onclick = () => trackPrueba("reservar");
    if (scene.medicion) $("#rcAgain")?.remove();   // la medición vale por el primer intento: no se repite en el momento
  }
  S.recapRender = render;
  render();
  show("recap");
  if (ev.loading) evaluate();
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
async function keepAwake() { if (wakeLock && !wakeLock.released) return; try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }
function releaseAwake() { const w = wakeLock; wakeLock = null; try { w?.release()?.catch?.(() => {}); } catch {} }

// Antes de empezar: qué vas a ensayar y tres frases que sirven en cualquier conversación
const RESCUE = [["Sorry, could you say that again?", "si no entendiste"], ["Let me think for a second.", "para ganar tiempo"], ["What I mean is…", "para decirlo de otra forma"]];
function briefHTML(scene) {
  const reto = store.get("retos", {})[scene.title];
  return `<div class="brief">
    <span class="lbl">Tu práctica</span>
    <strong>${esc(scene.title)}</strong>
    ${scene.desc ? `<span>${esc(scene.desc)}</span>` : ""}
    ${reto ? `<div class="reto"><span class="lbl">Tu reto en este intento</span><span>${esc(reto)}</span></div>` : ""}
    <span class="muted small">Hablas con ${esc(scene.name)}${scene.who ? `, ${esc(scene.who.replace(/\.+$/, ""))}` : ""}.</span>
    <span class="lbl" style="margin-top:6px">Frases que te sacan de apuros</span>
    <ul>${RESCUE.map(([en, es]) => `<li><span class="en">${esc(en)}</span> <span class="muted small">${es}</span></li>`).join("")}</ul>
  </div>`;
}
// Conversación de prueba sin cuenta
const PRUEBA_URL = new URLSearchParams(location.search).has("prueba");
const PRUEBA_TURNOS = 5, PRUEBA_ESCENA = "recruiter", PRUEBA_NIVEL = "B1";
const PRUEBA_AGOTADA = "Ya usaste la prueba gratis de hoy. Compra tu acceso para seguir practicando.";
const START_CAPTION = "Toca el círculo para empezar. La app usará el micrófono para escucharte.";
async function startScene(scene) {
  stopSpeaking();                         // también sube S.gen y corta lo que siguiera sonando
  coachQ.length = 0;
  S.scene = scene; S.history = []; S.retry = null; S.corrections = []; S.pronTurno = []; S.pronSesion = []; S.pruebaFin = false; S.pruebaCerrando = false; S.recapRender = null; S.lastCoachText = ""; S.avisoVozSistema = false;
  turno.partes = []; turno.cerrando = false; turno.segmento = null;
  $("#log").innerHTML = briefHTML(scene);
  $("#sceneName").textContent = scene.title;
  $("#sceneWho").textContent = [scene.name, scene.who].filter(Boolean).join(" · ");
  $("#settings").hidden = true;
  $("#typeBox").value = "";
  $("#backBtn").textContent = scene.prep ? "‹ Terminar" : scene.returnTo ? "‹ Lección" : "‹ Escenas";
  $("#backBtn").setAttribute("aria-label", scene.prep ? "Terminar el simulacro" : scene.returnTo ? "Volver a la lección" : "Volver a las escenas");
  notice("");
  show("talk");
  setState("idle", modoManual() ? "Toca el círculo para empezar. Aquí tú decides cuándo terminas: habla con calma y toca Listo." : START_CAPTION);
}

async function begin() {
  if (S.state !== "idle") return;
  const scene = S.scene;
  preparing = true;
  unlockAudio();                                  // iOS: debe ocurrir dentro del toque
  setState("thinking", "Preparando micrófono y voz…");
  try {
    await azureToken();
    if (!AZ.synth) makeSynth();
    if (!vadNode) await startMic(); else vadNode.start();   // al salir de una escena el micrófono queda en pausa
    if (S.scene !== scene || S.state !== "thinking") {      // saliste o pausaste mientras se preparaba
      try { vadNode?.pause(); } catch {}
      if (S.scene === scene) setState("idle", START_CAPTION);
      return;
    }
    keepAwake();
    checkVoices();
    openScene();
    S.turnMetrics = null;
    const gen = S.gen;
    player.onIdle = () => { if (gen === S.gen && S.state === "speaking") setState("listening", ""); };
    speakSentence(S.scene.open, gen);
  } catch (e) {
    if (S.scene !== scene) return;
    voiceFailed(e);
    if (!S.history.length) openScene();
    setState("listening", "");
  } finally { preparing = false; }
}
// La escena queda abierta igual si empiezas hablando o escribiendo: cuenta la sesión y el personaje dice su primera frase.
function openScene() {
  S.usage = { haikuIn: 0, haikuOut: 0, haikuCacheRead: 0, sonnetIn: 0, sonnetOut: 0, turns: 0, sttSeconds: 0, ttsChars: 0 };
  S.cefrVotes = []; S.confs = [];
  S.sesion = window.Datos ? Datos.newSession(S.scene.title) : null;
  if (S.sesion && S.scene.returnTo?.kind === "lesson") S.sesion.leccion_id = S.scene.returnTo.id;   // si borras la lección, esta conversación se va con ella
  S.history.push({ role: "assistant", content: S.scene.open });
  addAyudas(addBubble("assistant", S.scene.open), S.scene.open);
  if (S.pase && S.pase.segundos_total - S.pase.segundos_usados <= AVISO_SEG && S.pase.segundos_usados < S.pase.segundos_total) notice(`Te quedan ${durVozConv(S.pase.segundos_total - S.pase.segundos_usados)} en tu pase.`);
}
const paseMsg = (motivo) => (motivo === "vencido" ? "Tu pase de 30 días ya venció." : motivo === "inactivo" ? "Tu pase ya no está activo." : "Ya usaste todas las conversaciones de tu pase.") + " No se cobró nada más. En Tú → Tu pase ves cómo seguir.";
// Respuestas del servidor por pase o por tope diario, en palabras de la persona (null si no es ninguno de los dos)
function limiteMsg(j) {
  if (j?.error === "sin_horas" || j?.code === "sin_horas") return paseMsg(j.motivo);
  if (j?.error === "cuota_diaria") return "Llegaste al máximo de hoy para esto. Mañana puedes seguir.";
  return null;
}
// Quien compró el pase ve Hoy centrado en su entrevista; el resto ve la pantalla de siempre.
function marcarPase(hay) {
  document.body.classList.toggle("con-pase", hay);
  $("#prepBtn b").textContent = hay ? "Prepara tu entrevista" : "Modo entrevista";
  $("#masTitulo").textContent = hay ? "Otras conversaciones" : "Practica también";
  if (!hay) $("#paseHoy").hidden = true;
}
// Enlace de pago de Hotmart. Black Friday (USD 15) hasta el 27-nov a las 23:59 de Colombia; desde el 28, el precio regular (USD 27).
const BF_FIN = Date.parse("2026-11-28T00:00:00-05:00");
const enBF = () => Date.now() < BF_FIN;
const COMPRA_URL = enBF() ? "https://pay.hotmart.com/Q108477434E?off=tero3dlt" : "https://pay.hotmart.com/Q108477434E?off=i760w6y0";
const COMPRA_TXT = enBF() ? "Black Friday: USD 15 por 30 días (regular USD 27)" : "Empieza hoy · USD 27 por 30 días";
// El pase se gasta por respuesta (80 s fijos cada una, en la base); se muestra en conversaciones de 15 respuestas
const SEG_RESPUESTA = 80, RESP_CONVERSACION = 15, SEG_CONVERSACION = SEG_RESPUESTA * RESP_CONVERSACION;
const conversaciones = (seg) => Math.floor(seg / SEG_CONVERSACION);
const durVozConv = (seg) => { const n = conversaciones(seg); return n >= 1 ? `${n} ${n === 1 ? "conversación" : "conversaciones"}` : `${Math.floor(seg / SEG_RESPUESTA)} respuestas`; };
const AVISO_DIAS = 3, AVISO_SEG = 2 * SEG_CONVERSACION;   // avisar antes de que se acabe: 3 días o 2 conversaciones
// Días de calendario hasta la fecha (0 = hoy, 1 = mañana): «vence en 2 días» debe coincidir con la fecha que se muestra
const diasHasta = (iso, ahora = Date.now()) => { const d = new Date(iso), h = new Date(ahora); return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(h.getFullYear(), h.getMonth(), h.getDate())) / 864e5); };
const cuandoVence = (dias) => dias <= 0 ? "hoy" : dias === 1 ? "mañana" : `en ${dias} días`;
const durVoz = (seg) => { const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60); return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`; };
// Estado del pase en palabras: lo usan la tarjeta de Tú y el aviso de Hoy
function estadoPase(p, ahora = Date.now()) {
  const seg = Math.max(0, p.segundos_total - p.segundos_usados);
  const vence = Date.parse(p.vence), dias = diasHasta(p.vence, ahora);
  const fin = new Date(p.vence).toLocaleDateString("es", { day: "numeric", month: "long" });
  if (p.activo === false) return { fin: true, corto: "Tu pase ya no está activo", hoy: "Tu pase ya no está activo. No se cobró nada más." };
  if (ahora >= vence) return { fin: true, corto: `Terminó el ${fin}`, hoy: `Tu pase terminó el ${fin}. No se cobró nada más.` };
  if (seg < SEG_RESPUESTA) return { fin: true, corto: "Usaste todas tus conversaciones", hoy: "Usaste todas las conversaciones de tu pase. No se cobró nada más." };
  const corto = `Te quedan ${durVozConv(seg)} · hasta el ${fin}`;
  if (dias <= AVISO_DIAS) return { alerta: true, corto, hoy: `Tu pase vence ${cuandoVence(dias)} y te quedan ${durVozConv(seg)}. No se renueva solo.` };
  if (seg <= AVISO_SEG) return { alerta: true, corto, hoy: `Te quedan ${durVozConv(seg)} en tu pase (hasta el ${fin}).` };
  return { corto, hoy: corto };
}
// Muestra el pase en Tú (tarjeta con el detalle) y en Hoy (una línea; avisa antes de que se acabe). Sin fila no hay tope y no se muestra nada.
async function paintPase() {
  const tile = $("#paseTile");
  if (!tile || !S.session) return;
  try {
    const { data, error } = await sb.from("pases").select("segundos_total,segundos_usados,vence,activo").maybeSingle();
    if (error) throw error;
    S.pase = data || null;
    store.set("conPase", !!data);
    marcarPase(!!data);
    renderToday();
    if (!data) { tile.hidden = true; return; }
    const e = estadoPase(data), seg = Math.max(0, data.segundos_total - data.segundos_usados);
    const usado = Math.min(1, data.segundos_usados / data.segundos_total);
    $("#paseNow").textContent = e.corto;
    $("#paseHoras").innerHTML = `<b>${durVozConv(seg)}</b> de ${conversaciones(data.segundos_total)} en total`;
    $("#paseBarra i").style.width = Math.round(usado * 100) + "%";
    $("#paseBarra").setAttribute("aria-label", `Usaste el ${Math.round(usado * 100)} % de tus conversaciones`);
    $("#paseVence").textContent = e.fin ? e.hoy : `Vence el ${new Date(data.vence).toLocaleDateString("es", { day: "numeric", month: "long" })} (${cuandoVence(diasHasta(data.vence))}).`;
    $("#paseComprar").hidden = !COMPRA_URL; if (COMPRA_URL) $("#paseComprar").href = COMPRA_URL;
    $("#paseMas").hidden = !!COMPRA_URL;
    const hoy = $("#paseHoy");
    hoy.textContent = e.hoy;
    hoy.classList.toggle("alerta", !!(e.alerta || e.fin));
    hoy.hidden = false;
    tile.hidden = false;
    if (e.alerta || e.fin) tile.open = true;   // cuando hay algo que decidir, el detalle ya está a la vista
  } catch { tile.hidden = true; }
}
// Botón para ver u ocultar lo escrito en los campos de contraseña
function ojoClave(raiz) {
  for (const campo of raiz.querySelectorAll('input[type="password"]')) {
    const caja = document.createElement("div");
    caja.className = "pwbox";
    campo.replaceWith(caja);
    const ojo = document.createElement("button");
    ojo.type = "button";
    ojo.className = "pweye";
    const pinta = () => {
      const visible = campo.type === "text", texto = visible ? "Ocultar contraseña" : "Mostrar contraseña";
      ojo.innerHTML = `<svg aria-hidden="true"><use href="#${visible ? "i-eye-off" : "i-eye"}"/></svg>`;
      ojo.setAttribute("aria-label", texto);
      ojo.title = texto;
    };
    ojo.onclick = () => { campo.type = campo.type === "password" ? "text" : "password"; pinta(); };
    campo.form?.addEventListener("submit", () => { campo.type = "password"; pinta(); });   // nunca queda a la vista al entrar
    pinta();
    caja.append(campo, ojo);
  }
}
function voiceFailed(e) {
  logDebug("inicio falló " + JSON.stringify(e) + " " + (e?.message || ""));
  if (e?.code === "sin_horas") notice(paseMsg(e.motivo));
  else if (e?.code === "prueba_agotada") notice(PRUEBA_AGOTADA);
  else if (e?.name === "NotAllowedError") notice("No diste permiso al micrófono. Actívalo en Ajustes → Safari → Micrófono, o escribe abajo.");
  else notice("La voz no está disponible por ahora. Puedes escribir abajo.");
}
// Empezaste escribiendo y ahora quieres hablar
async function enableMic() {
  const scene = S.scene, gen = S.gen;
  preparing = true;
  unlockAudio();
  setState("thinking", "Preparando micrófono y voz…");
  try {
    await azureToken();
    if (!AZ.synth) makeSynth();
    await startMic();
    notice("");
    keepAwake();
    checkVoices();
  } catch (e) { voiceFailed(e); }
  preparing = false;
  if (S.scene !== scene || S.state === "paused") { try { vadNode?.pause(); } catch {} return; }
  if (S.gen === gen) setState("listening", "");   // si escribiste mientras tanto, ese turno sigue su curso
}

function countWords(t) { return (String(t).match(/[A-Za-zÀ-ÿ']+/g) || []).length; }
function saveSessionNow() {
  if (!S.sesion || !window.Datos || !S.sesion.turnos) return;
  store.set("practicaHoy", dayKey());
  const u = S.usage;
  const since = Date.parse(S.sesion.inicio);
  const votes = S.cefrVotes.reduce((m, v) => (m[v] = (m[v] || 0) + 1, m), {});
  Object.assign(S.sesion, {
    fin: new Date().toISOString(),
    stt_segundos: Math.round(u.sttSeconds), tts_caracteres: u.ttsChars,
    tokens: { haiku_in: u.haikuIn, haiku_out: u.haikuOut, haiku_cache: u.haikuCacheRead, sonnet_in: u.sonnetIn, sonnet_out: u.sonnetOut, confianza: S.confs || [], pron: window.Estudio?._pronResumen?.(S.pronSesion || []) || null, nivel_escena: S.scene?.nivel || S.level },
    latencias: S.metrics.filter((m) => m.at >= since).map((m) => m.total),
    nivel_estimado: Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0] || null,
  });
  Datos.saveSession(S.sesion);
}

function pauseSession(msg) {
  saveSessionNow();
  stopSpeaking();
  if (stt) { stt.discard = true; closeStt(); }
  try { vadNode?.pause(); } catch {}
  releaseAwake();
  setState("paused", msg || "");
}
async function resumeSession() {
  // Sesión escrita (sin micrófono): no hay audio que revisar
  const reconstruir = micLost || (!!vadNode && audioDanado());
  if (reconstruir) reiniciarAudio();
  unlockAudio();
  azureToken().catch(() => {});           // tras un rato en segundo plano el token puede haber vencido
  keepAwake();
  notice("");
  if (reconstruir) {
    micLost = false;
    const scene = S.scene;
    preparing = true;
    setState("thinking", "Preparando micrófono y voz…");
    try { await conTope(azureToken(), TOPE_MIC, "token_tope"); await startMic(); } catch (e) { voiceFailed(e); }
    preparing = false;
    if (S.scene !== scene || S.state !== "thinking") { try { vadNode?.pause(); } catch {} return; }
    setState("listening", "");
    return;
  }
  try { vadNode?.start(); } catch {}
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
// Escenas personales (de «Mis objetivos» o «Crea tu escena», guardadas en el perfil del usuario) + las universales
function allScenes() { return [...store.get("myScenes", []), ...store.get("customScenes", []), ...window.SCENES]; }
// Las de fábrica son iguales para todos: no se borran, se ocultan en este equipo y se pueden volver a mostrar.
const ocultas = () => new Set(store.get("escenasOcultas", []));
function visibleScenes() { const o = ocultas(); return allScenes().filter((s) => !o.has(s.id)); }
// Conversar funciona igual que Tus lecciones: en celular se desliza la tarjeta (Editar y Borrar las propias, Ocultar las de fábrica);
// en computador esas acciones van como íconos al lado. Las ocultas se recuperan con «Mostrar ocultas (N)» al final de la lista.
let verOcultas = false;
const tactil = matchMedia("(pointer: coarse)").matches;
const ETQ = { editar: "Editar", borrar: "Borrar", ocultar: "Ocultar", mostrar: "Mostrar" };
const ICO = { editar: "pen", borrar: "trash", ocultar: "hide" };
// Deslizar (escenas en Conversar y Tus lecciones): la fila .desliza tiene detrás .sfondo con las acciones y delante el contenido.
function cerrarDeslizadas(salvo) {
  for (const r of document.querySelectorAll(".desliza.abierta")) if (r !== salvo) { r.classList.remove("abierta"); if (r._dz) r._dz.style.transform = ""; }
}
document.addEventListener("touchstart", (e) => { if (!e.target.closest?.(".desliza.abierta")) cerrarDeslizadas(); }, { passive: true });
// Solo un gesto claramente horizontal mueve la tarjeta; uno vertical deja desplazar la lista (touch-action: pan-y)
function deslizable(row, frente = ".scene", alAbrir) {
  const c = row.querySelector(frente), fondo = row.querySelector(".sfondo");
  row._dz = c;
  let x0 = 0, y0 = 0, dx = 0, base = 0, modo = null;
  const fin = () => {
    row.classList.remove("moviendo"); c.style.transition = "";
    if (modo !== "h") return;
    const abrir = dx < -fondo.offsetWidth / 2;
    row.classList.toggle("abierta", abrir);
    c.style.transform = abrir ? `translateX(${-fondo.offsetWidth}px)` : "";
    if (abrir) alAbrir?.();
    row.dataset.recien = "1"; setTimeout(() => delete row.dataset.recien, 350);   // el toque que suelta no inicia la escena
  };
  row.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = 0; modo = null;
    base = row.classList.contains("abierta") ? -fondo.offsetWidth : 0;
  }, { passive: true });
  row.addEventListener("touchmove", (e) => {
    const t = e.touches[0], mx = t.clientX - x0, my = t.clientY - y0;
    if (!modo) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      modo = Math.abs(mx) > Math.abs(my) * 1.5 ? "h" : "v";
      if (modo === "h") { cerrarDeslizadas(row); row.classList.add("moviendo"); c.style.transition = "none"; }
    }
    if (modo !== "h") return;
    dx = Math.min(0, Math.max(-fondo.offsetWidth - 24, base + mx));
    c.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  row.addEventListener("touchend", fin);
  row.addEventListener("touchcancel", fin);
}
function renderHome() {
  const card = (s) => `
    <button class="scene" data-id="${esc(s.id)}">
      ${avatar(s.name)}
      <span class="sc"><span class="t">${esc(s.title)}</span>
      <span class="who">${esc([s.name, s.who].filter(Boolean).join(" · "))}</span>
      <span class="d">${esc(s.desc)}</span></span>
    </button>`;
  const propias = new Set(store.get("myScenes", []).map((s) => s.id)), fabrica = new Set(window.SCENES.map((s) => s.id)), o = ocultas();
  const accionesDe = (s) => (propias.has(s.id) ? ["editar", "borrar"] : !fabrica.has(s.id) ? [] : o.has(s.id) ? ["mostrar"] : ["ocultar"]);
  const texto = (a, s) => `<button class="sbtn sa-${a}" data-a="${a}" aria-label="${ETQ[a]} la escena ${esc(s.title)}">${ETQ[a]}</button>`;
  const icono = (a, s) => (a === "mostrar"
    ? `<button class="ghost smostrar" data-a="mostrar" aria-label="Volver a mostrar ${esc(s.title)}">Mostrar</button>`
    : `<button class="lpen${a === "borrar" ? " lbin" : ""}" data-a="${a}" aria-label="${ETQ[a]} la escena ${esc(s.title)}" title="${ETQ[a]}">${icon(ICO[a])}</button>`);
  const fila = (s) => {
    const acc = accionesDe(s), oculta = o.has(s.id);
    const desliza = tactil && acc.length && !oculta;   // una oculta muestra «Mostrar» a la vista, también en celular
    return `<div class="srow${desliza ? " desliza" : ""}${oculta ? " oculta" : ""}" data-id="${esc(s.id)}">`
      + (desliza ? `<div class="sfondo">${acc.map((a) => texto(a, s)).join("")}</div>` : "")
      + card(s) + (desliza || !acc.length ? "" : `<div class="sacc">${acc.map((a) => icono(a, s)).join("")}</div>`) + `</div>`;
  };
  const visibles = visibleScenes(), escondidas = allScenes().filter((s) => o.has(s.id));
  if (!escondidas.length) verOcultas = false;
  const lista = verOcultas ? [...visibles, ...escondidas] : visibles;
  $("#scenes").innerHTML = (tactil && visibles.some((s) => accionesDe(s).length) && !store.get("pistaDeslizar", false) ? `<p class="muted small lpista">Desliza una escena a la izquierda para editarla, borrarla u ocultarla.</p>` : "")
    + (lista.length ? lista.map(fila).join("") : `<p class="muted small">${escondidas.length ? "Ocultaste todas las escenas." : "No tienes escenas. Crea una con «+ Crea tu escena»."}</p>`)
    + (escondidas.length ? `<button class="linklike" id="verOcultas">${verOcultas ? "Esconder las ocultas" : `Mostrar ocultas (${escondidas.length})`}</button>` : "");
  $("#verOcultas") && ($("#verOcultas").onclick = () => { verOcultas = !verOcultas; renderHome(); });
  for (const b of $("#scenes").querySelectorAll("[data-a]")) b.onclick = () => {
    const row = b.closest(".srow"), id = row.dataset.id, s = allScenes().find((x) => x.id === id);
    if (b.dataset.a === "ocultar") { store.set("escenasOcultas", [...ocultas(), id]); renderHome(); }
    else if (b.dataset.a === "mostrar") { store.set("escenasOcultas", [...ocultas()].filter((x) => x !== id)); renderHome(); }
    else if (b.dataset.a === "editar") renombrarEscena(row, s);
    else confirmarBorrarEscena(row, s);
  };
  // Usar el gesto una vez (aquí o en Tus lecciones) basta para aprenderlo: la pista ya no vuelve
  for (const r of $("#scenes").querySelectorAll(".srow.desliza")) deslizable(r, ".scene", () => { store.set("pistaDeslizar", true); $("#scenes .lpista")?.remove(); });
  const dayId = sceneOfDay()?.id;
  $("#hoyScenes").innerHTML = visibleScenes().filter((s) => s.id !== dayId).slice(0, 3).map(card).join("");
  for (const b of document.querySelectorAll(".scene[data-id]")) b.onclick = () => {
    const row = b.closest("#scenes .srow");
    if (row?.dataset.recien) return;                                             // recién soltaste un deslizamiento
    if (row?.classList.contains("abierta")) { cerrarDeslizadas(); return; }     // con las acciones a la vista, tocar las cierra
    startScene(allScenes().find((s) => s.id === b.dataset.id));
  };
  paintNivel();
  const t = store.get("lastTest", null);
  $("#levelNow").textContent = t ? `Tu nivel: ${t.nivel} · test del ${new Date(t.fecha).toLocaleDateString("es-CO", { day: "numeric", month: "short" })}` : `Nivel ${S.level} · sin test todavía`;
  const gs = window.Estudio?.goalsSummary?.() || "";
  $("#goalsNow").textContent = gs || "Para qué quieres el inglés";
  marcarPase(store.get("conPase", false));
  paintPase();
  // Primer día: un paso a la vez. Primero para qué quieres el inglés, luego el nivel; la semana y las otras escenas esperan.
  // Quien entra con pase viene a preparar su entrevista: no se le piden objetivos (ver styles.css, con-pase)
  const faltaObjetivo = !gs && store.get("perfilSynced", false) && !document.body.classList.contains("con-pase");
  const faltaNivel = store.get("level", null) === null && !t;   // solo a quien nunca eligió nivel ni hizo el test
  $("#goalsNudge").hidden = !faltaObjetivo;
  $("#levelNudge").hidden = !faltaNivel || faltaObjetivo;
  $("#homeBody").classList.toggle("primer-dia", faltaObjetivo || faltaNivel);
  $("#rateSel").value = String(S.rate);
  $("#bargeChk").checked = S.bargeIn;
  $("#corrChk").checked = S.voiceCorr;
  paintPrefs();
  renderReviewCount();
  renderReminder();
  refreshToday();
}
// Cambiar el nombre de una escena propia (se guarda en el perfil: vale en todos tus equipos)
function renombrarEscena(row, s) {
  row.className = "srow editing";
  row.innerHTML = `<input class="lname" maxlength="80" value="${esc(s.title)}" aria-label="Nombre de la escena">
    <div class="lname-btns"><button class="primary" data-b="si">Guardar</button><button class="ghost" data-b="no">Cancelar</button></div>
    <p class="small lname-err" role="alert"></p>`;
  const inp = row.querySelector("input"), si = row.querySelector('[data-b="si"]');
  inp.focus();
  row.querySelector('[data-b="no"]').onclick = () => renderHome();
  const guardar = async () => {
    const t = inp.value.trim();
    if (!t) { row.querySelector(".lname-err").textContent = "Escribe un nombre."; return; }
    if (t === s.title) return renderHome();
    si.disabled = true;
    try { await Estudio.renombrarEscena(s.id, t); } catch {
      si.disabled = false; row.querySelector(".lname-err").textContent = "No se pudo guardar. Revisa tu conexión e intenta de nuevo."; return;
    }
    renderHome();
  };
  si.onclick = guardar;
  inp.onkeydown = (e) => { if (e.key === "Enter") guardar(); else if (e.key === "Escape") renderHome(); };
}
// Borrar una escena propia la quita del perfil (todos tus equipos). Lo que ya practicaste con ella se queda.
function confirmarBorrarEscena(row, s) {
  row.className = "srow editing";
  row.innerHTML = `<p class="small" style="margin:0">¿Borrar <b>${esc(s.title)}</b>? No se puede deshacer. Tus conversaciones y las frases de tu cuaderno se quedan.</p>
    <div class="lname-btns"><button class="ldanger" data-b="si">Sí, borrar</button><button class="ghost" data-b="no">Cancelar</button></div>
    <p class="small lname-err" role="alert"></p>`;
  row.querySelector('[data-b="no"]').onclick = () => renderHome();
  const si = row.querySelector('[data-b="si"]');
  si.onclick = async () => {
    si.disabled = true;
    try { await Estudio.borrarEscena(s.id); } catch {
      si.disabled = false; row.querySelector(".lname-err").textContent = "No se pudo borrar. Revisa tu conexión e intenta de nuevo."; return;
    }
    renderHome();
  };
}
function renderReviewCount() {
  if (!window.Datos) return;
  const due = Datos.due().length, total = Datos.all().length;
  $("#reviewNow").textContent = due ? `${due} ${due === 1 ? "pendiente" : "pendientes"}` : (total ? `${total} ${total === 1 ? "frase" : "frases"} · al día` : "Aún vacío");
  renderToday();
}
/* ---------------- «Hoy»: lo que toca practicar ---------------- */
const dayKey = (d = new Date()) => d.toLocaleDateString("en-CA");
const TODAY = { practiced: false, lesson: null };
// Una escena por día, en rotación; primero las personales del usuario
function sceneOfDay() {
  const all = visibleScenes(); if (!all.length) return null;
  const mine = all.filter((s) => s.custom), pool = mine.length ? mine : all;
  const n = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 864e5);
  return pool[n % pool.length];
}
function renderToday() {
  const el = $("#today"); if (!el || !window.Datos) return;
  const due = Datos.due().length, scene = sceneOfDay();
  const did = TODAY.practiced || store.get("practicaHoy", "") === dayKey();
  const items = [];
  // Unos 25 s por frase (estimado: decirla, ver la respuesta y calificar)
  if (due) items.push({ a: "review", t: `Repasa ${due} ${due === 1 ? "frase" : "frases"} · ${Math.max(1, Math.round(due * 25 / 60))} min`, s: "Tus errores, antes de que se olviden" });
  if (scene && !document.body.classList.contains("con-pase")) items.push({ a: "scene", done: did, t: did ? "Ya conversaste hoy" : `Conversa: ${scene.title}`, s: did ? `Si quieres más: ${scene.title}` : `Con ${scene.name}` });
  const next = items.find((i) => !i.done);
  if (TODAY.lesson) items.push({ a: "lesson", t: "Sigue tu lección", s: `${TODAY.lesson.titulo || "Lección"} · paso ${TODAY.lesson.progreso?.paso || 1} de 6`, optional: true });
  el.innerHTML = items.map((i, n) => `<button class="ti ${i.done ? "done" : ""} ${i === next ? "next" : ""}" data-a="${i.a}"><span class="tick" aria-hidden="true">${i.done ? "✓" : n + 1}</span><span class="ti-t"><b>${esc(i.t)}</b><small>${esc(i.s)}</small></span>${i === next ? `<svg class="go" aria-hidden="true"><use href="#i-chev"/></svg>` : ""}</button>`).join("")
    + (!next && items.length ? `<p class="today-ok">Lo de hoy está hecho.</p>` : "");
  for (const b of el.querySelectorAll(".ti")) b.onclick = () => {
    if (b.dataset.a === "review") Repaso.open();
    else if (b.dataset.a === "scene") startScene(sceneOfDay());
    else Estudio.open(TODAY.lesson.id);
  };
}
// Racha, si ya practicó hoy y la lección en curso (desde el servidor, por si practicó en otro equipo)
async function refreshToday() {
  try {
    const since = new Date(Date.now() - 400 * 864e5).toISOString();
    // Lo más reciente primero: si el servidor recorta filas, se pierde lo viejo y no la racha actual
    const [ses, rep, lec, ent] = await Promise.all([
      sb.from("sesiones").select("inicio,fin,turnos").gt("turnos", 0).gte("inicio", since).order("inicio", { ascending: false }),
      sb.from("repasos").select("repasado").gte("repasado", since).order("repasado", { ascending: false }),
      sb.from("lecciones").select("id,titulo,progreso,tokens").order("actualizado", { ascending: false }).limit(8),
      sb.from("expediente_intentos").select("creado").eq("tipo", "respuesta").gte("creado", new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
    ]);
    if (ses.error) return;
    const today = dayKey();
    const convDays = new Set((ses.data || []).map((s) => dayKey(new Date(s.inicio))));
    if (store.get("practicaHoy", "") === today) convDays.add(today);
    TODAY.practiced = convDays.has(today);
    const days = new Set([...convDays, ...(rep.data || []).map((r) => dayKey(new Date(r.repasado)))]);
    renderWeek(days);
    renderMeta(ses.data || [], rep.data || [], ent.data || []);
    const d = new Date();
    if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);   // hoy aún no cuenta en contra
    let streak = 0;
    while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
    $("#streak").textContent = streak ? `Racha de ${streak} ${streak === 1 ? "día" : "días"}` : "";
    TODAY.lesson = (lec.data || []).find((l) => !["creando", "error"].includes(l.tokens?.estado) && (l.progreso?.paso || 1) < 6 && !l.progreso?.conversada) || null;
    if (!$("#home").hidden) renderToday();
  } catch {}
}
/* Meta del día: 10 minutos. Conversaciones medidas de inicio a fin (máximo 30 min cada una);
   repaso estimado en 25 s por frase y cada respuesta de entrevista en 2 min */
const META_MIN = 10;
function renderMeta(ses, rep, ent) {
  const el = $("#metaHoy"); if (!el) return;
  const hoy = dayKey();
  const conv = ses.filter((s) => dayKey(new Date(s.inicio)) === hoy).reduce((a, s) => a + Math.min(1800, Math.max(0, (Date.parse(s.fin || s.inicio) - Date.parse(s.inicio)) / 1000)), 0);
  const repaso = rep.filter((r) => dayKey(new Date(r.repasado)) === hoy).length * 25;
  const min = Math.floor((conv + repaso + ent.length * 120) / 60);
  const pct = Math.min(100, Math.round((min / META_MIN) * 100));
  el.hidden = false;
  el.innerHTML = `<div class="meta-t"><b>${min >= META_MIN ? `✓ Meta de hoy cumplida: ${min} min` : `Hoy: ${min} de ${META_MIN} min`}</b><small>${min >= META_MIN ? "Lo que sigas haciendo hoy es extra." : min ? `Te faltan ${META_MIN - min} min` : "10 minutos al día bastan para avanzar"}</small></div>
    <div class="meta-b" role="progressbar" aria-label="Minutos de práctica hoy" aria-valuemin="0" aria-valuemax="${META_MIN}" aria-valuenow="${Math.min(min, META_MIN)}"><i style="width:${pct}%"></i></div>`;
}
function renderWeek(days) {
  const el = $("#week"); if (!el) return;
  const mon = new Date(); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const today = dayKey();
  let n = 0;
  const html = ["L", "M", "M", "J", "V", "S", "D"].map((l, i) => {
    const x = new Date(mon); x.setDate(mon.getDate() + i);
    const k = dayKey(x), ok = days.has(k); if (ok) n++;
    return `<div class="wd ${ok ? "on" : ""} ${k === today ? "now" : ""}"><span>${l}</span><i>${ok ? "✓" : ""}</i></div>`;
  }).join("");
  el.innerHTML = html;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", `Esta semana practicaste ${n} de 7 ${n === 1 ? "día" : "días"}`);
}
function renderReminder() {
  const r = store.get("recordatorio", {});
  if (!$("#reminderNow")) return;
  $("#reminderNow").textContent = r.activo ? `Cada día, ${hourLabel(r.hora)}` : "Un aviso cada día";
}
const hourLabel = (h) => `${((Number(h) + 11) % 12) + 1}:00 ${Number(h) < 12 ? "a. m." : "p. m."}`;
function renderVoicePicker() {
  const sel = $("#voiceSel"); if (!S.scene) return;
  const opts = S.availableVoices || window.VOICE_CANDIDATES;
  const cur = voiceFor(S.scene);
  sel.innerHTML = opts.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${v.replace("en-US-", "").replace("MultilingualNeural", "").replace(/Neural$/, " (clásica)")}</option>`).join("");
}

function wire() {
  $("#allScenes").onclick = () => document.querySelector('.tabbar [data-tab="conversar"]').click();
  for (const b of document.querySelectorAll(".tabbar button")) b.onclick = () => {
    for (const x of document.querySelectorAll(".tabbar button")) { if (x === b) x.setAttribute("aria-current", "page"); else x.removeAttribute("aria-current"); }
    for (const t of document.querySelectorAll(".tabpanel")) t.hidden = t.dataset.tab !== b.dataset.tab;
    $("#homeBody").scrollTop = 0;
    cerrarDeslizadas();
  };
  $("#forgotBtn").onclick = async () => {
    const email = $("#email").value.trim().toLowerCase(), err = $("#loginErr");
    if (!email) { err.textContent = "Escribe tu correo y vuelve a tocar «Olvidé mi contraseña»."; return; }
    const btn = $("#forgotBtn"); btn.disabled = true;
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    btn.disabled = false;
    err.textContent = error && error.status === 429 ? "Ya pediste varios correos. Espera un rato e inténtalo de nuevo." : "Si ese correo tiene cuenta, te llegará un enlace para crear una contraseña nueva.";
  };
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#loginErr").textContent = "";
    const email = $("#email").value.trim().toLowerCase(), clave = $("#password").value;   // el correo nunca distingue mayúsculas
    const { error } = await sb.auth.signInWithPassword({ email, password: clave });
    if (!error && clave === email.split("@")[0]) { store.set("forzarClave", true); setTimeout(() => window.Estudio?.password(true), 80); }   // entró con la clave inicial: debe cambiarla
    if (error) $("#loginErr").textContent = error.status >= 400 && error.status < 500 && error.status !== 429 ? "No pude entrar: revisa el correo y la contraseña." : "No pude conectar. Revisa tu internet e intenta de nuevo.";
  });
  $("#orb").onclick = () => {
    if (S.state === "idle") begin();
    else if (S.state === "listening" && !vadNode) enableMic();
    else if (S.state === "paused") resumeSession();
    else if (S.state === "speaking") { stopSpeaking(); setState("listening", ""); }
  };
  $("#pauseBtn").onclick = () => (S.state === "paused" ? resumeSession() : pauseSession(""));
  $("#backBtn").onclick = () => {
    if (turno.partes.length && S.sesion) {   // terminaste sin tocar Listo: esa respuesta también cuenta
      const dicho = turno.partes.join(" "); turno.partes = [];
      S.history.push({ role: "user", content: dicho }); addBubble("user", dicho);
      S.sesion.turnos++; S.sesion.palabras_jose += countWords(dicho);
    }
    pauseSession(""); apagarMic(); const scene = S.scene, ses = S.sesion, list = S.corrections || [], from = scene?.returnTo, hist = S.history || []; S.scene = null; S.sesion = null; S.retry = null;
    const leave = () => { if (S.prueba) return; if (from && window.Estudio) Estudio.reopen(from, ses?.turnos > 0); else { renderHome(); show("home"); } };
    if (scene && ses?.turnos > 0) showRecap(scene, ses, list, leave, hist); else leave();
  };
  $("#endBtn").onclick = () => $("#backBtn").click();   // termina la práctica y lleva al resumen
  $("#listoBtn").onclick = cerrarTurno;
  document.addEventListener("keydown", (e) => {          // en computador, la barra espaciadora es Listo
    if (e.code !== "Space" || e.repeat || $("#talk").hidden || $("#listoBtn").hidden) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    e.preventDefault();
    cerrarTurno();
  });
  $("#manualChk").onchange = (e) => {
    store.set(S.scene?.prep ? "manualSim" : "manualConv", e.target.checked);
    if (!e.target.checked && turno.partes.length) cerrarTurno();   // si vuelves a automático no se pierde lo que ya dijiste
  };
  $("#reviewBtn").onclick = () => { if (window.Repaso) Repaso.open(); };
  $("#typeForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = $("#typeBox").value.trim(); if (!t) return;
    if (!S.history.length && S.state !== "idle") return;   // aún se prepara la escena: el texto se queda en la caja
    $("#typeBox").value = "";
    if (S.retry && handleRetry(t)) return;
    unlockAudio();                        // tras volver de segundo plano el audio puede estar suspendido
    if (S.state === "idle") openScene();
    if (vadNode) { try { vadNode.start(); } catch {} keepAwake(); }   // escribir también reanuda el micrófono: «Escuchando» debe ser cierto
    if (!AZ.synth) azureToken().then(makeSynth).catch(() => {});
    userSaid(t);
  });
  for (const b of document.querySelectorAll("[data-nivel]")) b.onclick = () => { setLevel(b.dataset.nivel); paintNivel(); };
  $("#rateSel").onchange = (e) => { S.rate = Number(e.target.value); store.set("rate", S.rate); paintPrefs(); };
  $("#rateSel2").onchange = (e) => { S.rate = Number(e.target.value); store.set("rate", S.rate); $("#rateSel").value = e.target.value; paintPrefs(); };
  $("#bargeChk").onchange = (e) => { S.bargeIn = e.target.checked; store.set("bargeIn", S.bargeIn); paintPrefs(); };
  $("#corrChk").onchange = (e) => { S.voiceCorr = e.target.checked; store.set("voiceCorr", S.voiceCorr); $("#corrChk2").checked = S.voiceCorr; paintPrefs(); };
  $("#corrChk2").onchange = (e) => { S.voiceCorr = e.target.checked; store.set("voiceCorr", S.voiceCorr); $("#corrChk").checked = S.voiceCorr; if (!S.voiceCorr) coachQ.length = 0; paintPrefs(); };
  $("#voiceSel").onchange = (e) => { S.voices[S.scene.id] = e.target.value; store.set("voices", S.voices); };
  $("#voiceTry").onclick = async () => {
    const btn = $("#voiceTry"), scene = S.scene;
    const text = "Hi, this is how I sound. Does this voice work for you?";
    unlockAudio();                        // iOS: debe ocurrir dentro del toque
    if (["thinking", "hearing", "speaking"].includes(S.state)) { notice("Espera a que termine este turno para probar la voz."); return; }
    stopSpeaking();                       // un audio anterior colgado no debe dejar la muestra en cola para siempre
    notice("");
    const done = () => { btn.disabled = false; btn.textContent = "Probar"; };
    btn.disabled = true; btn.textContent = "Cargando…";
    try { await azureToken(); if (!AZ.synth) makeSynth(); }
    catch { done(); notice("No se pudo probar la voz. Revisa tu conexión e intenta de nuevo."); return; }
    if (S.scene !== scene) { done(); return; }
    try { vadNode?.pause(); } catch {}    // el micrófono no debe tomar la muestra como si hubieras hablado tú
    player.onIdle = () => maybeCoach();
    speakItem({ text, gen: S.gen, ssml: ssml(text, voiceFor(scene)), preview: true,
      onStart: () => { btn.textContent = "Sonando…"; },
      onEnd: () => { done(); if (S.state === "listening") { try { vadNode?.start(); } catch {} } },
    });
  };
  $("#settingsBtn").onclick = () => { renderVoicePicker(); $("#rateSel2").value = String(S.rate); $("#corrChk2").checked = S.voiceCorr; $("#manualChk").checked = modoManual(); $("#settings").hidden = !$("#settings").hidden; };
  let taps = 0, tt = null;
  $("#sceneName").onclick = () => { taps++; clearTimeout(tt); tt = setTimeout(() => (taps = 0), 1200); if (taps >= 5) { taps = 0; $("#debug").hidden = !$("#debug").hidden; renderDebug(); } };
  if (location.hash === "#debug") $("#debug").hidden = false;
  $("#signOut").onclick = async () => {
    if (navigator.onLine === false) { alert("Necesitas conexión para cerrar la sesión. Intenta de nuevo cuando tengas internet."); return; }
    const btn = $("#signOut");
    btn.disabled = true;
    try { await window.Datos?.sync(); } catch {}   // sube lo pendiente antes de cerrar la sesión
    const pend = window.Datos?.pendingWrites?.() || 0;
    if (pend && !confirm(`Hay ${pend} ${pend === 1 ? "cambio" : "cambios"} sin subir al servidor. Si sales ahora, ${pend === 1 ? "se pierde" : "se pierden"}. ¿Quieres salir de todos modos?`)) { btn.disabled = false; return; }
    // Este teléfono deja de recibir los avisos de esta cuenta (va antes de cerrar la sesión: la tabla exige estar autenticado)
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager?.getSubscription();
      if (sub) { await sb.from("push_subs").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
    } catch (e) { console.warn("push al salir", e); }
    let failed = false;
    try { const { error } = await sb.auth.signOut(); failed = !!error; } catch { failed = true; }
    if (failed) { btn.disabled = false; alert("No pude cerrar la sesión. Revisa tu conexión e intenta de nuevo."); return; }
    // Lo personal de este usuario no debe verlo quien entre después en el mismo teléfono
    for (const k of ["objetivos", "myScenes", "perfilSynced", "customScenes", "lastTest", "lessonIndex", "tarjetas", "cola", "sincronizado", "recordatorio", "practicaHoy", "retos", "level", "voices", "metrics", "escenasSinSubir", "forzarClave", "escenasOcultas", "simPendiente", "pistaDeslizar", "tradLineas", "pistaTraducir", "nivelSinSubir"]) localStorage.removeItem("sala:" + k);
    for (const k of Object.keys(localStorage)) if (k.startsWith("sala:lesson:")) localStorage.removeItem(k);
    location.reload();   // limpia también lo que está en memoria (cuaderno, cola)
  };
  $("#goalsBtn").onclick = () => window.Estudio?.goals();
  $("#paseHoy").onclick = () => { document.querySelector('.tabbar [data-tab="tu"]').click(); const t = $("#paseTile"); t.open = true; t.scrollIntoView({ block: "center" }); };
  $("#goalsNudgeBtn").onclick = () => window.Estudio?.goals();
  for (const b of document.querySelectorAll("#levelNudge [data-lv]")) b.onclick = () => { setLevel(b.dataset.lv); renderHome(); };
  $("#levelTest").onclick = () => window.Estudio?.test();
  ojoClave($("#loginForm"));
}

async function boot() {
  wire();
  fitViewport();
  window.visualViewport?.addEventListener("resize", fitViewport);
  window.visualViewport?.addEventListener("scroll", fitViewport);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  precargarVad();
  if (!configured()) { show("setup"); return; }
  if (!SDK || !window.supabase) { show("setup"); $("#setupTitle").textContent = "No se pudo abrir"; $("#setupMsg").textContent = "No cargaron las librerías de la app. Revisa tu conexión y vuelve a abrir la app."; return; }
  // Enlace del correo de bienvenida o de recuperación: se lee antes de que la librería limpie la dirección
  const enlace = location.hash;
  if (/type=(invite|recovery)/.test(enlace)) store.set("forzarClave", "nueva");
  if (/error_code=/.test(enlace)) { history.replaceState(null, "", location.pathname); setTimeout(() => { const e = $("#loginErr"); if (e) e.textContent = "Ese enlace ya no sirve. Escribe tu correo y toca «Olvidé mi contraseña» para recibir otro."; }, 300); }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  // ?prueba: conversación de prueba sin cuenta. Quien ya tiene cuenta entra normal.
  if (PRUEBA_URL && !S.session) { iniciarPrueba(); return; }
  if (PRUEBA_URL) history.replaceState(null, "", location.pathname);
  if (window.Datos) { Datos.init(sb); Datos.onChange(() => { if (!$("#home").hidden) renderReviewCount(); }); }
  sb.auth.onAuthStateChange((_ev, session) => {
    const fromLogin = !$("#login").hidden || !$("#splash").hidden;
    S.session = session;
    if (!session) {
      if (S.scene) { pauseSession(""); S.scene = null; S.sesion = null; S.retry = null; }   // sesión vencida en plena escena: al volver a entrar se va a Inicio
      show("login");
      return;
    }
    // Solo una entrada real lleva a Inicio: volver a la app o renovar el token no te saca de donde estás
    if (fromLogin) { renderHome(); show("home"); }
    if (_ev === "SIGNED_IN" && !S.scene) { window.Estudio?.syncPerfil?.(); window.Datos?.sync(); }
  });
  if (S.session) { renderHome(); show("home"); window.Estudio?.syncPerfil?.(); if (store.get("forzarClave")) { const pedir = () => window.Estudio?.password(store.get("forzarClave") === "nueva" ? "nueva" : true); document.readyState === "complete" ? pedir() : addEventListener("load", pedir, { once: true }); } } else show("login");
  // ?leccion=id viene de tocar una notificación con la app cerrada
  const lid = new URLSearchParams(location.search).get("leccion");
  if (lid) { history.replaceState(null, "", location.pathname); if (S.session && window.Estudio) Estudio.open(lid); }
}
/* ---------------- conversación de prueba sin cuenta ---------------- */
// Entra desde la landing o desde el login con ?prueba. El servidor entrega un pase firmado (función espera)
// que solo abre la conversación, la corrección, la voz y la evaluación final, con topes en la base (PRUEBA_TOPES).
// No se crea cuenta y en el teléfono no se guarda nada: ni cuaderno ni sesiones. El pase vive en esta pestaña.
async function iniciarPrueba() {
  S.prueba = true;
  document.body.classList.add("prueba");
  if (window.Datos) { Datos.saveSession = () => {}; Datos.addFromCorrection = () => {}; }
  show("splash");
  let tok = null;
  try { tok = sessionStorage.getItem("sala:prueba"); } catch {}
  if (!tok) {
    let j = {}, st = 0;
    try {
      const r = await fetch(`${CFG.SUPABASE_URL}/functions/v1/espera`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evento: "prueba", donde: "inicio", sid: sidEmbudo(), utm: Object.fromEntries(new URLSearchParams(location.search)) }) });
      st = r.status; j = await r.json().catch(() => ({}));
    } catch {}
    tok = j.token || null;
    if (!tok) {
      logDebug("prueba sin pase " + st + " " + (j.error || ""));
      history.replaceState(null, "", location.pathname);
      S.prueba = false; document.body.classList.remove("prueba");
      show("login");
      $("#loginErr").textContent = j.error === "prueba_agotada" ? "Ya usaste las pruebas gratis de hoy en esta conexión. Vuelve mañana o compra tu acceso." : "La prueba sin cuenta no está disponible en este momento. Intenta más tarde.";
      return;
    }
    try { sessionStorage.setItem("sala:prueba", tok); } catch {}
  }
  S.pruebaToken = tok;
  pruebaEscena();
}
function pruebaEscena() {
  S.pruebaFin = false; S.pruebaCerrando = false;
  const base = window.SCENES.find((s) => s.id === PRUEBA_ESCENA) || window.SCENES[0];
  startScene({ ...base, nivel: PRUEBA_NIVEL });
  $("#backBtn").textContent = "‹ Terminar";
  $("#backBtn").setAttribute("aria-label", "Terminar la prueba");
  $("#log").insertAdjacentHTML("afterbegin", `<div class="prueba-aviso"><b>Prueba gratis · ${PRUEBA_TURNOS} respuestas</b><span>Sin cuenta. Responde en voz alta o escribe. Al final ves tu evaluación. Tu voz no se guarda.</span></div>`);
}
function pruebaTurno(n) {
  const max = S.scene?.turnosMax || PRUEBA_TURNOS;
  if (n === max - 1) notice(S.prueba ? "Te queda una respuesta en esta prueba." : "Te queda una respuesta en esta medición.");
  if (n >= max) S.pruebaFin = true;
}
// El personaje terminó de responder la última: se cierra la escena cuando llegue la última corrección (máx. 6 s)
function terminarPrueba() {
  if (!(S.prueba || S.scene?.turnosMax) || !S.scene) return;
  try { vadNode?.pause(); } catch {}
  setState("thinking", "Preparando tu evaluación…");
  const t0 = Date.now();
  const listo = () => {
    if (!S.scene) return;
    if (S.corrPend > 0 && Date.now() - t0 < 6000) { setTimeout(listo, 300); return; }
    if (S.prueba) trackPrueba("fin");
    $("#backBtn").click();
  };
  listo();
}
function pruebaCierreHTML() {
  return `<div class="prueba-cierre">
    <h2>Esto fue una sola escena</h2>
    <p class="muted">Con tu acceso ensayas todas las etapas de la entrevista, preparas tus respuestas con lo que de verdad hiciste y tus errores vuelven en el repaso hasta que te salgan solos.</p>
    <a class="primary wide" id="rcReservar" href="${COMPRA_URL}">${COMPRA_TXT}</a>
    <button class="ghost wide" id="rcAgain">Ensayar otra vez</button>
    <button class="linklike" type="button" id="rcEntrar">Ya tengo acceso: entrar</button>
  </div>`;
}
function salirDePrueba() {
  try { sessionStorage.removeItem("sala:prueba"); } catch {}
  location.href = location.pathname;
}
function sidEmbudo() {
  let sid = "";
  try { sid = sessionStorage.getItem("espera:sid") || ""; if (!sid) { sid = crypto.randomUUID(); sessionStorage.setItem("espera:sid", sid); } } catch {}
  return sid;
}
// Embudo de la landing (función espera): solo cuenta el sitio publicado
function trackPrueba(donde) {
  if (location.hostname !== "sala.lead10x.com.co") return;
  fetch(`${CFG.SUPABASE_URL}/functions/v1/espera`, { method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
    body: JSON.stringify({ evento: "prueba", donde, sid: sidEmbudo(), utm: Object.fromEntries(new URLSearchParams(location.search)) }) }).catch(() => {});
}
// Lo mínimo que necesita el repaso (repaso.js) de este módulo
async function ensureVoice() {
  unlockAudio();
  await azureToken();
  if (!AZ.synth) makeSynth();
}
let enNow = null;   // lo que suena por un botón «Escuchar»: tocar varias veces no acumula audio ni gasta voz de más
function speakEN(text, opts = {}) {
  const key = `${text}|${opts.voice || ""}|${opts.rate || ""}`;
  if (enNow && enNow.gen === S.gen) {
    if (enNow.key === key && Date.now() < enNow.until) return enNow.promise;
    stopSpeaking();   // otra frase, o una que quedó colgada: reemplaza en lugar de ponerse en fila
  }
  unlockAudio();                          // con el AudioContext suspendido el audio nunca termina y la cola queda bloqueada
  const voice = opts.voice || "en-US-AvaMultilingualNeural";
  const rate = opts.rate || "-8%";
  const doc = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}"><prosody rate="${rate}">${conPausas(text, parseInt(rate, 10) <= LENTO)}</prosody></voice></speak>`;
  const now_ = { key, gen: S.gen, until: Date.now() + 12000 + text.length * 150 };
  now_.promise = new Promise((resolve) => speakItem({ text, gen: S.gen, ssml: doc, coach: true, plain: text, onEnd: () => { if (enNow === now_) enNow = null; resolve(); } }));
  enNow = now_;
  return now_.promise;
}
// desdeCuenta: el nivel llegó del servidor; no se vuelve a subir
function setLevel(l, desdeCuenta = false) { S.level = l; store.set("level", l); if (!desdeCuenta) window.Estudio?.guardarNivel(l); }
// Resumen de la tarjeta Preferencias con lo que está elegido
function paintPrefs() {
  const voz = { "-15": "Voz más lenta", "-8": "Voz un poco lenta", "0": "Voz natural", "8": "Voz un poco rápida" }[String(S.rate)] || "Voz natural";
  $("#prefsNow").textContent = [voz, S.bargeIn ? "puedes interrumpir" : "sin interrumpir", S.voiceCorr ? "correcciones en voz alta" : "correcciones solo en texto"].join(" · ");
}
// Tarjeta «Tu nivel» en Tú: cambiarlo sin hacer el test
const NIVEL_NOMBRE = { A1: "Principiante", A2: "Básico", B1: "Intermedio", B2: "Intermedio alto", C1: "Avanzado", C2: "Casi nativo" };
function paintNivel() {
  for (const b of document.querySelectorAll("[data-nivel]")) { const on = b.dataset.nivel === S.level; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }
  const t = store.get("lastTest", null);
  $("#nivelNombre").textContent = `${S.level} · ${NIVEL_NOMBRE[S.level] || ""}${t ? ` · tu último test dio ${t.nivel}` : ""}`;
}
window.Sala = {
  ojoClave, limiteMsg, deslizable, cerrarDeslizadas, tactil,
  // Lo que una escena deja guardado en este equipo: voz elegida y reto pendiente
  olvidarEscena(id, titulos) {
    delete S.voices[id]; store.set("voices", S.voices);
    const retos = store.get("retos", {}); for (const t of titulos) delete retos[t]; store.set("retos", retos);
  },
  sb: () => sb, show, ensureVoice, speakEN, leerCorreccion, escucharUnaVez, similarity, notice, fnFetch, store, esc,
  azure: () => ({ token: AZ.token, region: AZ.region, refresh: () => azureToken() }),
  backHome: () => {
    const back = S.backTo; S.backTo = null;
    $("#reviewBack").textContent = "‹ Inicio"; $("#reviewBack").setAttribute("aria-label", "Volver al inicio");
    if (back && window.Estudio) Estudio.reopen(back); else { renderHome(); show("home"); }
  },
  hourLabel,
  stopAudio: stopSpeaking,
  level: () => S.level, setLevel,
  startScene,                       // acepta escenas propias: {id, title, name, who, desc, persona, open, voice, returnTo?}
  rate: () => S.rate,
};

// Espera a que carguen todos los scripts: boot usa Estudio y Repaso, que van después de este archivo
document.addEventListener("DOMContentLoaded", boot);
})();
