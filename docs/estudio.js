/* Sala de Ensayo · Estudio (F3–F4)
   - Test de nivel: parte receptiva adaptativa (vocabulario, gramática, escucha) + parte oral evaluada por Opus.
   - Lecciones desde YouTube: ciclo de 6 pasos (antes, global, con texto, frase por frase, de nuevo, hablar).
   - Shadowing con evaluación de pronunciación de Azure (por palabra). No se guarda audio.
   - Crea tu escena y Mi progreso. */
(() => {
"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SDK = window.SpeechSDK;
const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];
const LB = { A1: -2.5, A2: -1.5, B1: -0.5, B2: 0.5, C1: 1.5, C2: 2.5 };     // dificultad de cada nivel en la escala θ
const SKILL = { vocab: "Vocabulario", gramatica: "Gramática", escucha: "Escucha", habla: "Habla" };
const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const store = () => Sala.store;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- marco de pantalla ---------------- */
let onBack = null;
let screenGen = 0;   // cambia al salir de una pantalla: lo asíncrono que llega tarde no debe pintar sobre otra
let loopRun = 0;     // cancela el «×3» de la lección
const cleanups = [];
function leave() {
  screenGen++; loopRun++;
  while (cleanups.length) { try { cleanups.pop()(); } catch {} }
  stopRec();
  try { Sala.stopAudio(); } catch {}
}
function screen(title, sub, back, label) {
  leave();
  $("#studyTitle").textContent = title;
  $("#studySub").textContent = sub || "";
  onBack = back || null;
  $("#studyBack").textContent = label || (back && back !== home ? "‹ Lecciones" : "‹ Inicio");
  Sala.show("study");
  $("#studyWrap").scrollTop = 0;
}
function body(html) { $("#studyBody").innerHTML = html; }
function home() { leave(); Sala.backHome(); }
function on(id, fn) { const el = document.getElementById(id); if (el) el.onclick = fn; return el; }
function err(msg) { return `<div class="notice" data-kind="warn">${esc(msg)}</div>`; }
// Inglés con la voz de Azure: prepara la voz antes de hablar y reactiva el audio dentro del toque (iOS lo suspende al salir de la app)
function sayEN(text, opts) { const g = screenGen; return Sala.ensureVoice().catch(() => {}).then(() => { if (g === screenGen) return Sala.speakEN(text, opts); }).catch(() => {}); }
// Evita que la pantalla se apague mientras se responde en voz alta; devuelve cómo soltarla
function keepAwake() {
  let lock = null, off = false;
  try { navigator.wakeLock?.request("screen").then((l) => { if (off) l.release().catch(() => {}); else lock = l; }, () => {}); } catch {}
  return () => { off = true; try { lock?.release().catch(() => {}); } catch {} lock = null; };
}

/* ---------------- micrófono + Azure: reconocimiento con evaluación de pronunciación ---------------- */
let rec = null, recGen = 0;
function stopRec() { recGen++; closeRec(); }
function closeRec() {
  if (!rec) return;
  const r = rec; rec = null;
  try { r.stopContinuousRecognitionAsync(() => r.close(), () => r.close()); } catch {}
}
// reference: texto de referencia (shadowing) o null (habla libre). Devuelve {promise, stop}.
function recognize({ reference = null, maxMs = 75000, onPartial = () => {}, autoEnd = false } = {}) {
  let resolveFn; const promise = new Promise((r) => (resolveFn = r));
  const segs = []; let done = false, idle = null, cap = null, heardAny = false, own = null;
  const rg = recGen;
  const refWords = reference ? (reference.match(/[A-Za-z0-9']+/g) || []).length : 0;
  const finish = () => {
    if (done) return; done = true;
    clearTimeout(idle); clearTimeout(cap);
    if (own && rec === own) closeRec();   // solo el propio: nunca detener una grabación más nueva
    resolveFn(summarize(segs));
  };
  const armIdle = () => { clearTimeout(idle); if (autoEnd && heardAny) idle = setTimeout(finish, 3500); };
  (async () => {
    try { await Sala.ensureVoice(); } catch { finish(); return; }
    if (done) return;                                  // ya se detuvo: no abrir el micrófono
    if (rg !== recGen) { finish(); return; }           // se salió de la pantalla o del paso durante la espera
    const az = Sala.azure();
    const cfg = SDK.SpeechConfig.fromAuthorizationToken(az.token, az.region);
    cfg.speechRecognitionLanguage = "en-US";
    cfg.outputFormat = SDK.OutputFormat.Detailed;
    cfg.setProperty(SDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, reference ? "1200" : "1800");
    const r = new SDK.SpeechRecognizer(cfg, SDK.AudioConfig.fromDefaultMicrophoneInput());
    const pac = new SDK.PronunciationAssessmentConfig(reference || "", SDK.PronunciationAssessmentGradingSystem.HundredMark, SDK.PronunciationAssessmentGranularity.Word, !!reference);
    try { pac.enableProsodyAssessment = true; } catch {}
    pac.applyTo(r);
    rec = own = r;
    r.recognizing = (_s, e) => { heardAny = true; armIdle(); onPartial([...segs.map((s) => s.text), e.result.text].join(" ")); };
    r.recognized = (_s, e) => {
      if (e.result.reason !== SDK.ResultReason.RecognizedSpeech || !e.result.text) return;
      segs.push(parseSeg(e.result));
      onPartial(segs.map((s) => s.text).join(" "));
      armIdle();
      if (autoEnd && reference && segs.reduce((n, s) => n + s.words.filter((w) => w.error !== "Omission").length, 0) >= refWords * 0.8) finish();
    };
    r.canceled = () => finish();
    r.sessionStopped = () => finish();
    r.startContinuousRecognitionAsync(() => {}, () => finish());
    cap = setTimeout(finish, maxMs);
  })();
  return { promise, stop: () => { if (own && rec === own) { const r = own; try { r.stopContinuousRecognitionAsync(() => setTimeout(finish, 300), finish); } catch { finish(); } } else finish(); } };
}
function parseSeg(result) {
  let j = {};
  try { j = JSON.parse(result.properties.getProperty(SDK.PropertyId.SpeechServiceResponse_JsonResult)); } catch {}
  const nb = j.NBest?.[0] || {};
  const pa = nb.PronunciationAssessment || {};
  return {
    text: result.text,
    secs: (result.duration || 0) / 1e7,
    exactitud: pa.AccuracyScore ?? null, fluidez: pa.FluencyScore ?? null, prosodia: pa.ProsodyScore ?? null,
    completitud: pa.CompletenessScore ?? null, total: pa.PronScore ?? null,
    words: (nb.Words || []).map((w) => ({ w: w.Word, score: w.PronunciationAssessment?.AccuracyScore ?? null, error: w.PronunciationAssessment?.ErrorType || "None" })),
  };
}
function summarize(segs) {
  const out = { text: segs.map((s) => s.text).join(" ").trim(), segundos: Math.round(segs.reduce((a, s) => a + s.secs, 0)), palabras: segs.flatMap((s) => s.words) };
  for (const k of ["exactitud", "fluidez", "prosodia", "completitud", "total"]) {
    let a = 0, n = 0;
    for (const s of segs) if (s[k] != null) { const w = Math.max(1, s.words.length); a += s[k] * w; n += w; }
    out[k] = n ? Math.round(a / n) : null;
  }
  out.nPalabras = (out.text.match(/[A-Za-z0-9']+/g) || []).length;
  out.ppm = out.segundos ? Math.round(out.nPalabras / (out.segundos / 60)) : null;
  return out;
}
function wordsHTML(words) {
  return `<p class="pwords">${words.map((w) => {
    const cls = w.error === "Omission" ? "om" : w.error === "Insertion" ? "ins-w" : w.score == null ? "" : w.score >= 80 ? "good" : w.score >= 60 ? "mid" : "bad";
    if (w.score == null) return `<span class="${cls}">${esc(w.w)}</span>`;
    return `<button type="button" class="${cls}" data-w="${esc(w.w)}" data-sc="${esc(w.score)}" aria-label="${esc(w.w)}: ${esc(w.score)} de 100">${esc(w.w)}</button>`;
  }).join(" ")}</p>`;
}
// Tocar una palabra muestra su puntaje (en el teléfono no existe el «hover»)
document.addEventListener("click", (e) => {
  const b = e.target.closest?.(".pwords button[data-sc]"); if (!b) return;
  const p = b.closest(".pwords");
  let hint = p.nextElementSibling;
  if (!hint?.classList.contains("pw-hint")) { hint = document.createElement("p"); hint.className = "pw-hint muted small"; hint.setAttribute("role", "status"); p.after(hint); }
  hint.textContent = `«${b.dataset.w}»: ${b.dataset.sc} de 100`;
});
function scoresHTML(r) {
  const k = [["exactitud", "Exactitud"], ["fluidez", "Fluidez"], ["prosodia", "Entonación"], ["completitud", "Completitud"]].filter(([x]) => r[x] != null);
  return `<div class="scores">${k.map(([x, l]) => `<div><b>${r[x]}</b><small>${l}</small></div>`).join("")}</div>`;
}
function savePron(origen, referencia, r, leccion_id = null) {
  if (!r.text) return;
  Datos.put("pronunciacion", { id: Datos.uuid(), origen, referencia, leccion_id, dicho: r.text, exactitud: r.exactitud, fluidez: r.fluidez, prosodia: r.prosodia, completitud: r.completitud, total: r.total, palabras: r.palabras.slice(0, 120), creado: new Date().toISOString() });
}

/* =====================================================================
   TEST DE NIVEL
   ===================================================================== */
const GRID = Array.from({ length: 81 }, (_, i) => -4 + i * 0.1);
const prior = () => GRID.map((t) => Math.exp(-(t * t) / (2 * 1.5 * 1.5)));
const pCorrect = (t, b) => 0.25 + 0.75 / (1 + Math.exp(-1.7 * (t - b)));   // 4 opciones: 25 % de acierto al azar
function updatePost(post, b, ok) {
  const p = post.map((w, i) => w * (ok ? pCorrect(GRID[i], b) : 1 - pCorrect(GRID[i], b)));
  const s = p.reduce((a, x) => a + x, 0) || 1;
  return p.map((x) => x / s);
}
function eap(post) {
  const s = post.reduce((a, x) => a + x, 0) || 1;
  const m = post.reduce((a, w, i) => a + w * GRID[i], 0) / s;
  const v = post.reduce((a, w, i) => a + w * (GRID[i] - m) ** 2, 0) / s;
  return { theta: +m.toFixed(2), sd: +Math.sqrt(v).toFixed(2) };
}
const levelOf = (t) => LEVELS[Math.max(0, Math.min(5, Math.floor(t) + 3))];
const MAX_ITEMS = 18, MIN_ITEMS = 12;
const ORAL = [
  { tipo: "descripción", nivel: "A2–B1", consigna: "Tell me about your job. What do you do on a typical day?", ayuda: "Habla de tu trabajo y de un día normal. Unos 30 a 45 segundos." },
  { tipo: "narración", nivel: "B1–B2", consigna: "Tell me about a difficult situation with a client or a colleague. What happened, and how did you handle it?", ayuda: "Cuenta una historia en pasado: qué pasó y qué hiciste. Entre 45 y 60 segundos." },
  { tipo: "argumentación", nivel: "B2–C1", consigna: "Some people say artificial intelligence will replace many jobs within ten years. Do you agree? Give reasons and examples.", ayuda: "Da tu opinión con razones, ejemplos y matices. Alrededor de un minuto." },
];

let T = null;
const testBack = () => { if (window.confirm("¿Salir del test? Se pierden las respuestas que llevas.")) home(); };
async function bank() {
  if (T?.bank) return T.bank;
  const r = await fetch("banco.json", { cache: "no-cache" }).catch(() => null) || await fetch("banco.json");
  return (await r.json()).items;
}
function testIntro() {
  screen("Test de nivel", "A1 a C2 · unos 15 minutos", home);
  const last = store().get("lastTest", null);
  body(`
    <p>Son dos partes. La primera se adapta a tus respuestas: si aciertas, sube la dificultad; si fallas, baja.</p>
    <ol class="steps-list">
      <li><b>Entender</b> · unas ${MAX_ITEMS} preguntas de vocabulario, gramática y escucha (oyes audios cortos).</li>
      <li><b>Hablar</b> · 3 preguntas que respondes en voz alta, de menor a mayor exigencia.</li>
    </ol>
    <p class="muted small">Responde sin diccionario. Si no sabes, toca «No lo sé»: adivinar distorsiona el resultado. El resultado es una estimación; para calibrarla compárala con el EF SET (gratuito).</p>
    ${last ? `<p class="muted small">Último test: <b>${esc(last.nivel)}</b> (${new Date(last.fecha).toLocaleDateString("es-CO")}).</p>` : ""}
    <button class="primary wide" id="tStart">Empezar</button>
    <button class="ghost wide" id="tOnlyOral">Solo la parte oral</button>`);
  on("tStart", () => startTest(false));
  on("tOnlyOral", () => startTest(true));
}
async function startTest(onlyOral) {
  Sala.ensureVoice().catch(() => {});                  // desbloquea el audio dentro del toque
  body(`<p class="muted">Cargando preguntas…</p>`);
  let items;
  const g = screenGen;
  try { items = await bank(); } catch { if (g === screenGen) body(err("No pude cargar el banco de preguntas. Revisa tu conexión.")); return; }
  if (g !== screenGen) return;
  T = { bank: items, id: Datos.uuid(), inicio: new Date().toISOString(), post: prior(), used: new Set(), resp: [], n: 0, cur: null, plays: 0, oral: [], onlyOral };
  onBack = testBack;
  if (onlyOral) return oralStep(0);
  nextItem();
}
function pickItem() {
  const types = ["vocab", "gramatica", "escucha"];
  const tipo = types[T.n % 3];
  const target = LEVELS.indexOf(levelOf(eap(T.post).theta));
  for (const d of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) {
    const lv = LEVELS[target + d]; if (!lv) continue;
    const pool = T.bank.filter((it) => it.tipo === tipo && it.nivel === lv && !T.used.has(it.id));
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  }
  return null;
}
function nextItem() {
  const { sd } = eap(T.post);
  if (T.n >= MAX_ITEMS || (T.n >= MIN_ITEMS && sd < 0.3)) return receptiveDone();
  const it = pickItem(); if (!it) return receptiveDone();
  T.cur = it; T.used.add(it.id); T.plays = 0; T.shownAt = Date.now();
  $("#studySub").textContent = `Parte 1 · pregunta ${T.n + 1} de ~${MAX_ITEMS}`;
  const isL = it.tipo === "escucha";
  body(`
    <div class="rc-meta">${SKILL[it.tipo]}</div>
    ${isL ? `<button class="ghost wide" id="tPlay">${IC.play}Escuchar (máximo 2 veces)</button>` : ""}
    <p class="tq">${esc(it.pregunta)}</p>
    <div class="opts">${it.opciones.map((o, i) => `<button class="opt" data-i="${i}">${esc(o)}</button>`).join("")}
      <button class="opt idk" data-i="-1">No lo sé</button></div>
    <div class="bar"><span style="width:${Math.round((T.n / MAX_ITEMS) * 100)}%"></span></div>`);
  if (isL) { on("tPlay", playItem); playItem(); }
  for (const b of document.querySelectorAll(".opt")) b.onclick = () => answer(Number(b.dataset.i));
}
function playItem() {
  if (T.plays >= 2) return;
  T.plays++;
  const b = $("#tPlay"); if (b) { b.disabled = T.plays >= 2; b.innerHTML = T.plays >= 2 ? "Ya escuchaste 2 veces" : `${IC.play}Escuchar otra vez (1 más)`; }
  sayEN(T.cur.audio_en, { rate: "0%" });
}
function answer(i) {
  Sala.stopAudio();
  const it = T.cur, ok = i === it.correcta;
  T.post = updatePost(T.post, LB[it.nivel], ok);
  T.resp.push({ id: it.id, tipo: it.tipo, nivel: it.nivel, ok, elegida: i, ms: Date.now() - T.shownAt });
  T.n++;
  nextItem();
}
function skillTheta(tipo) {
  let post = prior();
  for (const r of T.resp) if (r.tipo === tipo) post = updatePost(post, LB[r.nivel], r.ok);
  const e = eap(post);
  return { ...e, nivel: levelOf(e.theta), n: T.resp.filter((r) => r.tipo === tipo).length };
}
function receptiveDone() {
  const e = eap(T.post);
  T.receptivo = { theta: e.theta, sd: e.sd, nivel: levelOf(e.theta), rango: `${levelOf(e.theta - e.sd)}–${levelOf(e.theta + e.sd)}`,
    por_destreza: { vocab: skillTheta("vocab"), gramatica: skillTheta("gramatica"), escucha: skillTheta("escucha") }, respuestas: T.resp };
  $("#studySub").textContent = "Parte 2 · hablar";
  body(`<p><b>Parte 1 lista.</b> Ahora vas a hablar. Escucharás cada pregunta; responde con calma, como en una conversación.</p>
    <p class="muted small">Necesito el micrófono. La app no guarda el audio: solo el texto reconocido y las métricas.</p>
    <button class="primary wide" id="tOral">Ir a la parte oral</button>
    <button class="ghost wide" id="tSkipOral">Saltar la parte oral (resultado menos fiable)</button>`);
  on("tOral", () => oralStep(0));
  on("tSkipOral", () => finishTest());
}
function oralStep(k) {
  if (k >= ORAL.length) return finishTest();
  const q = ORAL[k];
  $("#studySub").textContent = `Parte 2 · pregunta ${k + 1} de ${ORAL.length}`;
  body(`
    <div class="rc-meta">Hablar · ${esc(q.tipo)}</div>
    <p class="tq">${esc(q.consigna)}</p>
    <p class="muted small">${esc(q.ayuda)}</p>
    <button class="ghost" id="oHear">${IC.play}Escuchar la pregunta</button>
    <button class="primary big" id="oGo">${IC.mic}Responder</button>`);
  const hear = () => sayEN(q.consigna, { rate: "-5%" });
  on("oHear", hear); hear();
  on("oGo", () => oralListen(k));
}
function oralListen(k) {
  Sala.stopAudio();
  const t0 = Date.now(), g = screenGen, wake = keepAwake();
  cleanups.push(wake);
  body(`<div class="rc-meta">Te escucho · habla hasta terminar</div>
    <p class="tq small">${esc(ORAL[k].consigna)}</p>
    <div class="live big-live" id="oLive">…</div>
    <div class="timer" id="oTimer">0:00</div>
    <button class="primary wide" id="oStop">Terminé</button>`);
  const tick = setInterval(() => { const el = $("#oTimer"); if (el) el.textContent = mmss((Date.now() - t0) / 1000); }, 500);
  cleanups.push(() => clearInterval(tick));
  const h = recognize({ maxMs: 90000, onPartial: (t) => { const el = $("#oLive"); if (el) el.textContent = t; } });
  on("oStop", () => { $("#oStop").disabled = true; $("#oStop").textContent = "Procesando…"; h.stop(); });
  h.promise.then((r) => {
    clearInterval(tick); wake();
    if (g !== screenGen) return;
    T.oral[k] = { tipo: ORAL[k].tipo, nivel: ORAL[k].nivel, consigna: ORAL[k].consigna, texto: r.text, segundos: r.segundos, palabras: r.nPalabras, ppm: r.ppm,
      azure: { exactitud: r.exactitud, fluidez: r.fluidez, prosodia: r.prosodia } };
    body(`<div class="rc-meta">Pregunta ${k + 1} · lo que entendí</div>
      <div class="rc-ctx"><span>${esc(r.text || "(no reconocí voz)")}</span></div>
      <p class="muted small">${r.nPalabras} ${r.nPalabras === 1 ? "palabra" : "palabras"} · ${r.segundos} s de habla${r.ppm ? ` · ${r.ppm} palabras/min` : ""}</p>
      <div class="rc-actions"><button class="ghost" id="oAgain">Repetir</button><button class="primary big" id="oNext">${k + 1 < ORAL.length ? "Siguiente" : "Ver resultado"}</button></div>`);
    on("oAgain", () => oralStep(k));
    on("oNext", () => oralStep(k + 1));
  });
}
async function finishTest(skipEval) {
  const t = T, g = screenGen;   // si sales y empiezas otro test, este termina con sus propios datos
  const oral = t.oral.filter((o) => o && o.texto);
  let ev = null;
  if (oral.length && !skipEval) {
    onBack = home;   // salir durante la evaluación no pierde nada: el resultado se guarda igual
    body(`<p class="muted">Evaluando tu parte oral con criterios del MCER… (unos 20 a 40 s)</p><div class="spinner"></div>`);
    let fallo = null;
    const ctl = new AbortController(); const kill = setTimeout(() => ctl.abort(), 120_000);
    try {
      const r = await Sala.fnFetch("generar", { modo: "evaluar", tareas: oral, receptivo: t.receptivo ? { nivel: t.receptivo.nivel, rango: t.receptivo.rango, destrezas: Object.fromEntries(Object.entries(t.receptivo.por_destreza).map(([k, v]) => [k, v.nivel])) } : {} }, ctl.signal);
      const j = await r.json();
      if (r.ok && j.evaluacion) ev = j.evaluacion; else throw j;
    } catch (e) { console.warn("evaluar", e); fallo = e || {}; }
    clearTimeout(kill);
    if (fallo) {
      if (g !== screenGen) return;
      onBack = testBack;
      body(err("No pude evaluar tu parte oral. Tus respuestas siguen guardadas aquí: intenta de nuevo.")
        + `<p class="muted small">Detalle: ${esc(fallo.error || fallo.name || fallo.code || fallo.message || "sin respuesta")}</p>
          <button class="primary wide" id="tRetry">Reintentar</button>
          ${t.receptivo ? `<button class="ghost wide" id="tNoOral">Ver el resultado sin la parte oral</button>` : ""}`);
      on("tRetry", () => finishTest());
      on("tNoOral", () => finishTest(true));
      return;
    }
  }
  // combinar: promedio en la escala θ entre la parte receptiva y la oral
  const parts = [];
  if (t.receptivo) parts.push(t.receptivo.theta);
  if (ev?.nivel) parts.push(LB[ev.nivel]);
  if (!parts.length) { if (g === screenGen) { onBack = home; body(err("No hubo respuestas suficientes para estimar un nivel.") + `<button class="ghost wide" id="tBack">Volver</button>`); on("tBack", home); } return; }
  const theta = parts.reduce((a, x) => a + x, 0) / parts.length;
  const nivel = levelOf(theta);
  const perfil = {};
  if (t.receptivo) for (const [k, v] of Object.entries(t.receptivo.por_destreza)) perfil[k] = v.nivel;
  if (ev?.nivel) perfil.habla = ev.nivel;
  const lo = t.receptivo ? levelOf(Math.min(theta, t.receptivo.theta - t.receptivo.sd)) : nivel;
  const hi = t.receptivo ? levelOf(Math.max(theta, t.receptivo.theta + t.receptivo.sd)) : nivel;
  const rango = lo === hi ? nivel : `${lo}–${hi}`;
  const fin = new Date().toISOString();
  Datos.put("test_intentos", { id: t.id, inicio: t.inicio, fin, receptivo: t.receptivo || {}, oral: { tareas: t.oral.filter(Boolean), evaluacion: ev }, nivel, nivel_rango: ev?.rango_es ? `${rango} · oral: ${ev.rango_es}` : rango, perfil });
  Datos.put("perfil", { nivel });
  store().set("lastTest", { nivel, rango, fecha: fin, perfil });
  if (g === screenGen) renderResult({ nivel, rango, perfil, ev });
}
function renderResult({ nivel, rango, perfil, ev }) {
  onBack = home;
  $("#studySub").textContent = "Resultado";
  const wrong = T.receptivo ? T.receptivo.respuestas.filter((r) => !r.ok).map((r) => T.bank.find((b) => b.id === r.id)).filter(Boolean) : [];
  const cur = Sala.level();
  body(`
    <div class="result"><small>Tu nivel estimado</small><strong>${nivel}</strong><span>rango probable ${esc(rango)}</span></div>
    <div class="skills">${Object.entries(perfil).map(([k, v]) => `<div><small>${SKILL[k]}</small><b>${v}</b></div>`).join("")}</div>
    ${ev ? `
      <div class="rc-ctx"><b>Habla · confianza ${esc(ev.confianza)}</b>
        <span>${Object.entries(ev.criterios || {}).map(([k, v]) => `${esc({ alcance: "alcance", correccion: "corrección", fluidez: "fluidez", coherencia: "coherencia", pronunciacion: "pronunciación" }[k] || k)}: <b>${esc(v)}</b>`).join(" · ")}</span></div>
      ${list("Lo que lo muestra", ev.evidencia_es)}${list("Tus fortalezas", ev.fortalezas_es)}${list("En qué enfocarte ahora", ev.foco_es)}` : `<p class="muted small">Sin parte oral: el nivel sale solo de comprensión.</p>`}
    ${nivel !== cur ? `<button class="primary wide" id="tUse">Usar ${nivel} en mis conversaciones (ahora: ${cur})</button>` : `<p class="muted small">Tus conversaciones ya usan ${cur}.</p>`}
    ${wrong.length ? `<details class="prefs"><summary>${wrong.length === 1 ? "Repasar la pregunta que fallaste" : `Repasar las ${wrong.length} preguntas que fallaste`}</summary><div class="list">${wrong.map((b) => `
      <div class="li"><span>${esc(b.pregunta)}</span>${b.tipo === "escucha" ? `<span class="small muted">Audio: “${esc(b.audio_en)}”</span>` : ""}
      <span class="ins">${esc(b.opciones[b.correcta])}</span><span class="meta">${esc(b.explicacion_es)}</span></div>`).join("")}</div></details>` : ""}
    <p class="muted small">Estimación con ${[T.resp.length ? `${T.resp.length} preguntas` : "", ev ? (T.oral.filter(Boolean).length === 1 ? "1 respuesta oral" : `${T.oral.filter(Boolean).length} respuestas orales`) : ""].filter(Boolean).join(" y ")}. No es una certificación; compárala con el EF SET para calibrar.</p>
    <button class="ghost wide" id="tHome">Volver al inicio</button>`);
  on("tUse", () => { Sala.setLevel(nivel); $("#tUse").outerHTML = `<p class="ok">✓ Listo: tus conversaciones y lecciones usan ${nivel}.</p>`; });
  on("tHome", home);
}
const list = (t, arr) => (arr?.length ? `<div class="rc-ctx"><b>${esc(t)}</b><ul class="ul">${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "");

/* =====================================================================
   LECCIONES DESDE YOUTUBE
   ===================================================================== */
const videoIdFrom = (u) => { const m = String(u).match(/(?:youtu\.be\/|v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/); return m ? m[1] : (/^[A-Za-z0-9_-]{11}$/.test(u) ? u : null); };
function localLessons() { return store().get("lessonIndex", []); }
function cacheLesson(row) {
  store().set("lesson:" + row.id, row);
  const idx = localLessons().filter((x) => x.id !== row.id);
  idx.unshift({ id: row.id, titulo: row.titulo, video_id: row.video_id, nivel: row.nivel, creado: row.creado, paso: row.progreso?.paso || 1 });
  const keep = idx.slice(0, 40);
  store().set("lessonIndex", keep);
  // Las copias fuera del índice ya no se usan y llenarían el almacenamiento del teléfono
  try { const ok = new Set(keep.map((x) => "sala:lesson:" + x.id)); for (const k of Object.keys(localStorage)) if (k.startsWith("sala:lesson:") && !ok.has(k)) localStorage.removeItem(k); } catch {}
}
// Une el avance de este teléfono con el del servidor: nada de lo hecho en otro equipo se pisa
function mergeProgress(a = {}, b = {}) {
  return { ...b, ...a, paso: Math.max(a.paso || 1, b.paso || 1), hechos: [...new Set([...(a.hechos || []), ...(b.hechos || [])])], dictado: { ...(b.dictado || {}), ...(a.dictado || {}) }, conversada: !!(a.conversada || b.conversada) };
}
async function loadLesson(id) {
  const local = store().get("lesson:" + id, null);
  if (local && lessonReady(local)) {
    // Abre sin esperar a una red lenta: 2,5 s como máximo para traer el avance de otro equipo
    const res = await Promise.race([Sala.sb().from("lecciones").select("progreso").eq("id", id).maybeSingle(), sleep(2500).then(() => null)]).catch(() => null);
    if (res && !res.error && res.data === null) { forgetLesson(id); return null; }   // se eliminó desde otro equipo
    if (res?.data?.progreso) { local.progreso = mergeProgress(local.progreso || {}, res.data.progreso); cacheLesson(local); }
    return local;
  }
  const { data } = await Sala.sb().from("lecciones").select("*").eq("id", id).single();
  if (data && lessonReady(data)) cacheLesson(data);
  return data;
}
async function videoHome(prefill) {
  screen("Aprender con un video", `Nivel ${Sala.level()}`, home);
  body(`
    <form id="vForm" class="stack" novalidate>
      <label for="vUrl">Enlace de YouTube (video en inglés)</label>
      <input id="vUrl" type="url" inputmode="url" placeholder="https://www.youtube.com/watch?v=…" value="${esc(prefill?.url || "")}">
      <button class="primary wide">Preparar lección</button>
    </form>
    <div id="vStatus"></div>
    <details class="prefs" id="vPasteBox" ${prefill?.paste ? "open" : ""}>
      <summary>¿Sin subtítulos automáticos? Pega la transcripción</summary>
      <div class="stack">
        <p class="muted small">En YouTube: «…más» → «Mostrar transcripción», selecciona todo y cópialo. Con las marcas de tiempo, la lección salta a cada frase del video.</p>
        <input id="vTitle" placeholder="Título del video (opcional)" value="${esc(prefill?.title || "")}">
        <textarea id="vPaste" rows="7" placeholder="0:00&#10;So, let me tell you about…"></textarea>
        <button class="ghost wide" id="vPasteGo">Usar este texto</button>
      </div>
    </details>
    ${pushSupported() && Notification.permission !== "granted" ? `<button class="ghost wide" id="vPush">${IC.bell}Avisarme cuando una lección esté lista</button>` : ""}
    <h2>Tus lecciones</h2>
    <div class="list" id="vList"><p class="muted small">Cargando…</p></div>
    <p class="muted small">Cómo funciona: 1) antes de ver, de qué trata y las expresiones clave, 2) idea general sin texto, 3) con el texto en inglés, 4) frase por frase con dictado, explicación y repetición, 5) de nuevo sin texto, 6) conversación con un personaje sobre el tema. Las expresiones van a tu cuaderno de repaso.</p>`);
  $("#vForm").onsubmit = (e) => { e.preventDefault(); fromUrl($("#vUrl").value.trim()); };
  on("vPasteGo", () => fromPaste());
  on("vPush", (ev) => testPush(ev.currentTarget));
  renderLessonList();
}
async function renderLessonList() {
  let rows = localLessons();
  try {
    const { data } = await Sala.sb().from("lecciones").select("id,titulo,auto:leccion->>titulo_es,video_id,nivel,tramo_min,creado,actualizado,progreso,tokens").order("creado", { ascending: false }).limit(40);
    if (data) {
      const ids = new Set(data.map((d) => d.id));
      const onlyLocal = rows.filter((r) => !ids.has(r.id));
      // Con menos de 40 filas el servidor trajo todas: lo que solo esté aquí se eliminó desde otro equipo
      if (data.length < 40) onlyLocal.forEach((r) => forgetLesson(r.id));
      rows = [...data.map((d) => ({ ...d, paso: d.progreso?.paso || 1, estado: d.tokens?.estado === "creando" && !inProgress(d) ? "atascada" : d.tokens?.estado })), ...(data.length < 40 ? [] : onlyLocal)];
      // Un nombre puesto en otro equipo también debe verse al abrir la copia guardada en este
      for (const d of data) { const c = store().get("lesson:" + d.id, null); if (c && c.titulo !== d.titulo) { c.titulo = d.titulo; store().set("lesson:" + d.id, c); } }
    }
  } catch {}
  const el = $("#vList"); if (!el) return;
  const estado = (r) => r.estado === "creando" ? "creándose…" : r.estado === "error" ? "no se pudo crear" : r.estado === "atascada" ? "no terminó de crearse" : `paso ${r.paso || 1} de 6`;
  const thumb = (r) => r.video_id
    ? `<img class="lthumb" src="https://i.ytimg.com/vi/${esc(r.video_id)}/mqdefault.jpg" alt="" loading="lazy" onerror="this.outerHTML='<span class=&quot;lthumb none&quot;></span>'">`
    : `<span class="lthumb none"></span>`;
  el.innerHTML = rows.length ? rows.map((r) => `
    <div class="lrow" data-id="${esc(r.id)}">
      <button class="lesson lopen" data-id="${esc(r.id)}">${thumb(r)}
        <span class="ltxt"><b>${esc(r.titulo || "Lección")}</b>
        <span class="meta">${esc(r.nivel)}${r.tramo_min ? ` · desde el min ${esc(r.tramo_min)}` : ""} · ${estado(r)} · ${new Date(r.creado).toLocaleDateString("es-CO", { day: "numeric", month: "short" })}</span></span></button>
      ${r.estado === "creando" ? "" : `<button class="lpen" aria-label="Cambiar el nombre de ${esc(r.titulo || "la lección")}" title="Cambiar el nombre">${IC.pen}</button><button class="lpen lbin" aria-label="Eliminar ${esc(r.titulo || "la lección")}" title="Eliminar la lección">${IC.trash}</button>`}
    </div>`).join("")
    : `<p class="muted small">Todavía no tienes lecciones.</p>`;
  for (const b of el.querySelectorAll(".lesson")) b.onclick = () => openLesson(b.dataset.id);
  for (const b of el.querySelectorAll(".lpen")) b.onclick = () => {
    const row = b.closest(".lrow"), r = rows.find((x) => x.id === row.dataset.id);
    (b.classList.contains("lbin") ? confirmDelete : renameLesson)(row, r);
  };
}
// Borrar una lección borra todo lo creado desde ella (la base lo hace en cascada). Antes dice exactamente qué se va.
async function confirmDelete(el, r) {
  el.classList.add("editing");
  el.innerHTML = `<p class="small ldel-txt" style="margin:0">Revisando qué se va a borrar…</p>
    <div class="lname-btns"><button class="ldanger" data-a="yes" disabled>Sí, eliminar todo</button><button class="ghost" data-a="no">Cancelar</button></div>
    <p class="small lname-err" role="alert"></p>`;
  el.querySelector('[data-a="no"]').onclick = () => renderLessonList();
  const cuenta = (t) => Sala.sb().from(t).select("id", { count: "exact", head: true }).eq("leccion_id", r.id).then((x) => (x.error ? null : x.count)).catch(() => null);
  const [frases, charlas, pron] = await Promise.all(["tarjetas", "sesiones", "pronunciacion"].map(cuenta));
  if (!el.isConnected) return;
  const n = (c, uno, varios) => (c ? [`${c} ${c === 1 ? uno : varios}`] : []);
  const extras = frases == null || charlas == null || pron == null
    ? ["sus frases del cuaderno", "sus conversaciones", "sus prácticas de pronunciación"]
    : [...n(frases, "frase del cuaderno con sus repasos", "frases del cuaderno con sus repasos"), ...n(charlas, "conversación", "conversaciones"), ...n(pron, "práctica de pronunciación", "prácticas de pronunciación")];
  el.querySelector(".ldel-txt").innerHTML = `Se borrará <b>${esc(r.titulo || "esta lección")}</b>: su transcripción, tu avance${extras.length ? `, ${esc(extras.join(", "))}` : ""}. No se puede deshacer. Tus horas de voz no cambian.`;
  const yes = el.querySelector('[data-a="yes"]');
  yes.disabled = false;
  yes.onclick = async () => {
    yes.disabled = true;
    let ok = false;
    try { const { data, error } = await Sala.sb().from("lecciones").delete().eq("id", r.id).select("id"); ok = !error && data?.length > 0; } catch {}
    if (!ok) { yes.disabled = false; el.querySelector(".lname-err").textContent = "No se pudo eliminar. Revisa tu conexión e intenta de nuevo."; return; }
    forgetLesson(r.id);
    Datos.forgetLesson(r.id);
    Sala.olvidarEscena("lec-" + r.id, [r.titulo, r.auto].filter(Boolean));
    Datos.sync();
    renderLessonList();
  };
}
function forgetLesson(id) {
  try { localStorage.removeItem("sala:lesson:" + id); } catch {}
  store().set("lessonIndex", localLessons().filter((x) => x.id !== id));
}
// Renombrar: el nombre vive en «titulo»; si se deja vacío vuelve el título original de la lección.
function renameLesson(el, r) {
  el.classList.add("editing");
  el.innerHTML = `<input class="lname" maxlength="120" value="${esc(r.titulo || "")}" placeholder="${esc(r.auto || "Nombre de la lección")}" aria-label="Nombre de la lección">
    <div class="lname-btns"><button class="primary" data-a="save">Guardar</button><button class="ghost" data-a="cancel">Cancelar</button></div>
    <p class="muted small">Si lo dejas vacío, vuelve el título original.</p><p class="small lname-err" role="alert"></p>`;
  const input = el.querySelector("input"), save = el.querySelector('[data-a="save"]');
  input.focus(); input.select();
  el.querySelector('[data-a="cancel"]').onclick = () => renderLessonList();
  const submit = async () => {
    const titulo = (input.value.trim() || r.auto || "Lección").slice(0, 200);
    save.disabled = true;
    let ok = false;
    try { const { data, error } = await Sala.sb().from("lecciones").update({ titulo }).eq("id", r.id).select("id"); ok = !error && data?.length > 0; } catch {}
    if (!ok) { save.disabled = false; el.querySelector(".lname-err").textContent = "No se pudo guardar. Revisa tu conexión e intenta de nuevo."; return; }
    const c = store().get("lesson:" + r.id, null);
    if (c) { c.titulo = titulo; store().set("lesson:" + r.id, c); }
    renderLessonList();
  };
  save.onclick = submit;
  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } else if (e.key === "Escape") renderLessonList(); };
}
function status(html) { const el = $("#vStatus"); if (el) el.innerHTML = html; }
let urlBusy = -1;   // pantalla con una búsqueda en curso: un doble toque no gasta dos transcripciones
async function fromUrl(url, otraParte = false) {
  const g = screenGen;
  if (urlBusy === g) return;
  urlBusy = g;
  try { await fetchTranscript(url, g, otraParte); } finally { if (urlBusy === g) urlBusy = -1; }
}
async function fetchTranscript(url, g, otraParte = false) {
  const live = () => g === screenGen;
  const vid = videoIdFrom(url);
  if (!vid) { status(err("Ese enlace no parece de un video de YouTube.")); return; }
  waitRun++;   // empieza otro video: la espera anterior sigue en el servidor, pero ya no interrumpe este
  const lv = Sala.level();
  if (!otraParte) {
    // ¿Ya existe (en este equipo, en otro o en preparación)? Se puede abrir sin gastar transcripción ni Opus
    let ya = localLessons().find((l) => l.video_id === vid && l.nivel === lv)?.id || null;
    if (!ya) try {
      const { data } = await Sala.sb().from("lecciones").select("id,leccion->segmentos,tokens,creado,actualizado").eq("video_id", vid).eq("nivel", lv).order("creado", { ascending: true }).limit(1);
      if (!live()) return;
      const prev = data?.[0];
      if (prev && inProgress(prev)) { openLesson(prev.id); return; }
      if (prev && Array.isArray(prev.segmentos) && prev.segmentos.length) ya = prev.id;
    } catch {}
    if (ya) {
      status(`<div class="rc-ctx"><b>Ya tienes una lección de este video en nivel ${esc(lv)}</b></div>
        <button class="primary wide" id="vAbrir">Abrir la lección</button>
        <button class="ghost wide" id="vOtraParte">Crear otra lección desde otro minuto</button>`);
      on("vAbrir", () => openLesson(ya));
      on("vOtraParte", () => fromUrl(url, true));
      return;
    }
  }
  status(`<p class="muted">Buscando los subtítulos del video…</p><div class="spinner"></div>`);
  let j;
  try {
    const r = await Sala.fnFetch("transcripcion", { url });
    j = await r.json();
    // Cada 7 s: el servidor admite 10 consultas por minuto; a más ritmo cortaba los videos largos
    for (let i = 0; j.pending && i < 26; i++) {
      if (!live()) return;
      status(`<p class="muted">Video largo: YouTube tarda un poco… (${(i + 1) * 7} s)</p><div class="spinner"></div>`);
      await sleep(7000);
      if (!live()) return;
      const next = await (await Sala.fnFetch("transcripcion", { jobId: j.jobId })).json();
      if (next.error !== "rate_limited") j = next;
    }
  } catch { j = { error: "red" }; }
  if (!live()) return;
  if (!j.error && j.lang && !/^en([-_]|$)/i.test(j.lang)) j = { error: "no_ingles" };
  if (j.error || !j.chunks?.length) {
    const msg = {
      no_ingles: "Los subtítulos de este video no están en inglés. Prueba otro video o pega abajo la transcripción en inglés.",
      supadata_key_missing: "La búsqueda automática de subtítulos todavía no está activa. Pega la transcripción abajo y sigo.",
      no_transcript: "Este video no tiene subtítulos en inglés que pueda leer. Pega la transcripción abajo (si YouTube la muestra) o prueba otro video.",
      supadata_quota: "Se acabó el cupo gratuito de transcripciones de este mes. Pega la transcripción abajo.",
      red: "No pude conectarme. Revisa tu conexión o pega la transcripción abajo.",
    }[j.error] || "No pude traer los subtítulos. Pega la transcripción abajo.";
    status(err(msg));
    const box = $("#vPasteBox"); if (box) box.open = true;
    return;
  }
  confirmGenerate({ videoId: vid, chunks: j.chunks, fuente: "supadata", title: "" });
}
function parsePasted(txt) {
  const lines = txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const toS = (h, m, s) => (s != null ? (+h) * 3600 + (+m) * 60 + (+s) : (+h) * 60 + (+m));
  const only = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/, lead = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*[-–·]?\s+(.+)$/;
  const out = []; let pend = null, timed = false;
  for (const l of lines) {
    let m = l.match(only);
    if (m) { pend = toS(m[1], m[2], m[3]); timed = true; continue; }
    m = l.match(lead);
    if (m) { out.push({ t: toS(m[1], m[2], m[3]), text: m[4] }); pend = null; timed = true; continue; }
    if (pend != null) { out.push({ t: pend, text: l }); pend = null; }
    else if (out.length && timed) out[out.length - 1].text += " " + l;
    else out.push({ t: null, text: l });
  }
  if (!timed) {
    // sin tiempos: frases con un ritmo de 2,5 palabras por segundo (aproximado)
    const sentences = txt.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+["')\]]?|\S[^.!?]*$/g) || [];
    let t = 0;
    return { timed: false, chunks: sentences.map((s) => { const d = Math.max(1, s.split(" ").length / 2.5); const c = { t: +t.toFixed(1), d: +d.toFixed(1), text: s.trim() }; t += d; return c; }) };
  }
  const chunks = out.filter((c) => c.t != null);
  for (let i = 0; i < chunks.length; i++) chunks[i].d = +(i + 1 < chunks.length ? Math.min(30, Math.max(0.5, chunks[i + 1].t - chunks[i].t)) : Math.max(1, chunks[i].text.split(" ").length / 2.5)).toFixed(1);
  return { timed: true, chunks };
}
function fromPaste() {
  const txt = $("#vPaste").value.trim();
  if (txt.split(/\s+/).length < 40) { status(err("Pega al menos un párrafo (40 palabras o más).")); return; }
  const { timed, chunks } = parsePasted(txt);
  const vid = videoIdFrom($("#vUrl").value.trim());
  waitRun++;
  confirmGenerate({ videoId: timed ? vid : null, chunks, fuente: "pegada", title: $("#vTitle").value.trim(), timed });
}
// Tope del servidor por lección: 25 min o 5.000 palabras, contados desde donde empieza; de ahí Opus elige un tramo de unos 10 min
function ventana(chunks, desdeSeg) {
  const sel = chunks.filter((c) => c.t >= desdeSeg), base = sel.length ? sel[0].t : desdeSeg, out = [];
  let acc = 0;
  for (const c of sel) { const n = c.text.split(/\s+/).length; if (c.t - base > 1500 || acc + n > 5000) break; acc += n; out.push(c); }
  const fin = out.length ? out[out.length - 1].t + out[out.length - 1].d : base;
  return { chunks: out, ini: base, fin, palabras: acc };
}
function confirmGenerate(src, level) {
  const words = src.chunks.reduce((a, c) => a + c.text.split(/\s+/).length, 0);
  const last = src.chunks[src.chunks.length - 1];
  const dur = last ? last.t + last.d : 0;
  const lv = level || Sala.level();
  const todo = ventana(src.chunks, 0), long = todo.fin < dur - 5, maxMin = last ? Math.floor(last.t / 60) : 0;
  status(`<div class="rc-ctx"><b>Transcripción lista</b>
      <span>${mmss(dur)} min · ${words} palabras${src.fuente === "pegada" && !src.videoId ? " · sin video: los audios los leerá la voz de la app" : ""}</span></div>
    ${long ? `<div class="stack"><label for="vDesde">Empezar desde el minuto</label><input id="vDesde" type="number" inputmode="numeric" min="0" max="${maxMin}" step="1" value="0"></div><div class="notice" data-kind="warn" id="vNota" role="status"></div>` : ""}
    <button class="primary wide" id="vGen">Crear lección para nivel ${lv}</button>
    <p class="muted small">Tarda cerca de 1 minuto. Te aviso con una notificación cuando esté lista.</p>`);
  let elegida = todo;
  if (long) {
    const pintar = () => {
      const m = Math.min(maxMin, Math.max(0, parseInt($("#vDesde").value, 10) || 0));
      elegida = ventana(src.chunks, m * 60);
      const poco = elegida.palabras < 40;
      $("#vGen").disabled = poco;
      $("#vNota").innerHTML = poco ? "Desde ese minuto queda muy poco texto. Elige un minuto anterior."
        : `<b>Video largo.</b> Cada lección toma hasta 25 minutos. Esta usará del minuto ${mmss(elegida.ini)} al ${mmss(elegida.fin)}, y de ahí elegirá unos 10 minutos para estudiar. Para estudiar otra parte, crea otra lección desde ese minuto.`;
    };
    $("#vDesde").oninput = pintar;
    pintar();
  }
  on("vGen", () => { askPush(); generate({ ...src, chunks: elegida.chunks }, lv); });
}
/* ---------- notificaciones push ---------- */
// iOS solo permite pedir el permiso tocando un botón y con la app instalada en la pantalla de inicio.
function pushSupported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && !!window.SALA_CONFIG?.VAPID_PUBLIC_KEY; }
// En una pestaña de Safari en iPhone «Notification» no existe: leerla sin comprobar lanza un error
const pushDenied = () => typeof Notification !== "undefined" && Notification.permission === "denied";
function b64uToBytes(s) { const p = "=".repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }
function askPush() {
  if (!pushSupported() || Notification.permission === "denied") return Promise.resolve(false);
  // se llama sin await previo para conservar el gesto del toque
  const perm = Notification.permission === "granted" ? Promise.resolve("granted") : Notification.requestPermission();
  return perm.then(async (p) => {
    if (p !== "granted") return false;
    const reg = await Promise.race([navigator.serviceWorker.ready, sleep(8000).then(() => { throw new Error("sw_timeout"); })]);
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(window.SALA_CONFIG.VAPID_PUBLIC_KEY) });
    const j = sub.toJSON();
    const { error } = await Sala.sb().from("push_subs").upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "user_id,endpoint" });
    if (error) console.warn("push_subs", error);
    return !error;
  }).catch((e) => { console.warn("push", e); return false; });
}
async function testPush(btn) {
  btn.disabled = true; btn.textContent = "Activando…";
  const ok = await askPush();
  if (!ok) {
    btn.disabled = false;
    btn.textContent = pushDenied() ? "Permiso negado: actívalo en Ajustes › Notificaciones › Sala" : "No se pudo activar (¿la app está en la pantalla de inicio?)";
    return;
  }
  try { const r = await Sala.fnFetch("generar", { modo: "push_test" }); const j = await r.json(); btn.textContent = r.ok ? `✓ Enviada a ${j.suscripciones} ${j.suscripciones === 1 ? "dispositivo" : "dispositivos"}` : "Falló el envío"; }
  catch { btn.textContent = "Falló el envío"; }
  btn.disabled = false;
}
async function generate(src, level) {
  const lv = level || Sala.level();
  status(`<p class="muted">Enviando la transcripción…</p><div class="spinner"></div>`);
  let j;
  try {
    const ctl = new AbortController(); const kill = setTimeout(() => ctl.abort(), 30_000);
    const r = await Sala.fnFetch("generar", { modo: "leccion", level: lv, title: src.title || "", chunks: src.chunks, video_id: src.videoId || null, fuente: src.fuente }, ctl.signal);
    j = await r.json();
    clearTimeout(kill);
    if (!r.ok || !j?.id) throw j || {};
  } catch (e) {
    console.warn("generar", e);
    const net = !e?.error;   // sin respuesta del servidor = problema de red; con código = el servidor contestó
    const msg = e?.error === "rate_limited" ? "Demasiadas solicitudes seguidas. Espera un minuto."
      : net ? "No pude enviar el video para crear la lección. Revisa tu conexión e intenta de nuevo."
      : "El servidor no pudo empezar la lección. Intenta de nuevo en unos minutos.";
    status(err(msg) + `<p class="muted small">Detalle: ${esc([e?.error || e?.name || e?.message || "sin respuesta", e?.detail].filter(Boolean).join(" · "))}</p><button class="ghost wide" id="vRetry">Reintentar</button>`);
    on("vRetry", () => generate(src, lv));
    return;
  }
  if (j.estado === "lista") { openLesson(j.id); return; }   // ya existía: se abre sin costo
  waitLesson(j.id, Date.parse(j.creado) || Date.now());
}
// La lección se arma en el servidor; aquí solo se consulta la fila hasta que esté lista (sobrevive a salir de la app).
let waitRun = 0;   // solo una espera a la vez: otra lección nueva cancela la anterior en esta pantalla
async function waitLesson(id, t0) {
  const run = ++waitRun;
  status(`<p class="muted">Diseñando tu lección… <span id="vSec">0</span> s</p><div class="spinner"></div>
    <p class="muted small">Suele tardar 1 minuto. Puedes salir de esta pantalla o de la app: la lección queda en «Tus lecciones» cuando esté lista.</p>`);
  const tick = setInterval(() => { const el = $("#vSec"); if (el) el.textContent = Math.max(0, Math.round((Date.now() - t0) / 1000)); }, 1000);
  cleanups.push(() => clearInterval(tick));
  let alive = true; cleanups.push(() => { alive = false; });
  const live = () => alive && run === waitRun;
  while (live() && Date.now() - t0 < 240_000) {
    await sleep(4000);
    if (!live() || !$("#vStatus")) break;
    let row = null;
    try { ({ data: row } = await Sala.sb().from("lecciones").select("*").eq("id", id).maybeSingle()); } catch {}
    const est = row?.tokens?.estado;
    if (row && lessonReady(row)) {
      clearInterval(tick);
      try { cacheLesson(row); await openLesson(row.id); }
      catch (e) { status(err("La lección se creó, pero no pude abrirla.") + `<p class="muted small">Detalle: ${esc(e?.message || String(e))}</p>`); }
      return;
    }
    if (est === "error") {
      clearInterval(tick);
      const e = row.tokens.error;
      status(err(e === "truncated" ? "El video es demasiado largo para una sola lección. Prueba uno más corto." : "No pude crear la lección.") + `<p class="muted small">Detalle: ${esc(e || "error")}</p><button class="ghost wide" id="vBack2">Volver</button>`);
      on("vBack2", () => videoHome());
      return;
    }
  }
  clearInterval(tick);
  if (!live() || !$("#vStatus")) return;
  status(err("Está tardando más de lo normal. Revisa en unos minutos en «Tus lecciones»."));
  renderLessonList();
  // Sigue consultando con calma: la lista se actualiza sola cuando termine
  for (let i = 0; i < 40; i++) {
    await sleep(15000);
    if (!live() || !$("#vStatus")) return;
    let row = null;
    try { ({ data: row } = await Sala.sb().from("lecciones").select("leccion,tokens").eq("id", id).maybeSingle()); } catch {}
    if (!live() || !$("#vStatus")) return;
    if (row && (lessonReady(row) || row.tokens?.estado === "error")) {
      status(lessonReady(row) ? `<p class="ok">✓ Tu lección ya está lista. Ábrela en «Tus lecciones».</p>` : err("No pude crear la lección. Tócala en «Tus lecciones» para intentarlo de nuevo."));
      renderLessonList();
      return;
    }
  }
}
const lessonReady = (row) => Array.isArray(row?.leccion?.segmentos) && row.leccion.segmentos.length > 0;
// «creando» solo cuenta mientras el servidor puede seguir trabajando (el mismo plazo que usa generar)
const inProgress = (r) => r?.tokens?.estado === "creando" && Date.now() - Date.parse(r.actualizado || r.creado) < 240_000;
// Lección que falló o quedó a medias: su transcripción sigue guardada, así que se puede reintentar sin pegar nada
function offerRetry(row) {
  const est = row.tokens?.estado;
  status(err(est === "error" ? "Esta lección no se pudo crear." : "Esta lección no terminó de crearse.")
    + `<p class="muted small">Detalle: ${esc(row.tokens?.error || est || "error")}</p><button class="ghost wide" id="vRetryRow">Intentarlo de nuevo</button>`);
  on("vRetryRow", () => {
    generate({ videoId: row.video_id || null, chunks: row.transcripcion || [], fuente: row.fuente || "supadata", title: row.titulo === "Lección en preparación" ? "" : row.titulo || "" }, row.nivel);
    // Sin video el servidor crea una fila nueva: se quita la fallida para no dejarla repetida
    if (!row.video_id) Sala.sb().from("lecciones").delete().eq("id", row.id).then(() => { forgetLesson(row.id); renderLessonList(); }, () => {});
  });
}

/* ---------- reproductor ---------- */
let YTP = null, ytReady = false, rangeTimer = null, mountRun = 0, hintTimer = null;
function ytApi() {
  if (window.YT?.Player) return Promise.resolve();
  return new Promise((res, rej) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); res(); };
    if (!document.getElementById("ytApi")) { const s = document.createElement("script"); s.id = "ytApi"; s.src = "https://www.youtube.com/iframe_api"; s.onerror = (e) => { s.remove(); rej(e); }; document.head.appendChild(s); }
    setTimeout(() => rej(new Error("timeout")), 15000);
  });
}
function videoFailed() {
  if (LS) LS.hasVideo = false;
  const box = document.querySelector(".ytbox");
  if (box) box.outerHTML = err("No pude cargar el video de YouTube. Te leo cada parte con la voz de la app.");
}
// Suelta el reproductor: uno viejo no debe seguir contando como «listo» en la lección siguiente
function dropPlayer() { stopRange(); mountRun++; ytReady = false; const p = YTP; YTP = null; try { p?.destroy(); } catch {} }
async function mountPlayer(videoId, start) {
  dropPlayer();
  const run = ++mountRun;
  try { await ytApi(); } catch { return false; }
  if (run !== mountRun || !document.getElementById("ytp")) return false;
  return new Promise((res) => {
    YTP = new YT.Player("ytp", {
      videoId, width: "100%", height: "100%",
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1, cc_load_policy: 0, iv_load_policy: 3, start: Math.floor(start || 0) },
      events: {
        onReady: () => { if (run !== mountRun) return; ytReady = true; res(true); },
        // Puede llegar después de onReady (video que no permite insertarse): pasa a la voz de la app
        onError: () => { if (run !== mountRun) return; dropPlayer(); videoFailed(); res(false); },
      },
    });
    setTimeout(() => { if (run === mountRun && !ytReady) mountRun++; res(ytReady); }, 12000);
  });
}
function stopRange() { clearInterval(rangeTimer); rangeTimer = null; clearTimeout(hintTimer); hintTimer = null; }
// Reproduce [a, b] del video; sin video, lee el texto con la voz de la app
function playRange(a, b, { rate = 1, text = "" } = {}) {
  stopRange(); Sala.stopAudio();
  document.getElementById("ytHint")?.remove();
  if (YTP && ytReady) {
    try { YTP.setPlaybackRate(rate); } catch {}
    YTP.seekTo(a, true); YTP.playVideo();
    rangeTimer = setInterval(() => { try { if (YTP.getCurrentTime() >= b) { YTP.pauseVideo(); stopRange(); } } catch {} }, 150);
    // iPhone puede exigir el primer toque dentro del propio video: si a los 3 s no arrancó, se avisa
    hintTimer = setTimeout(() => {
      let st; try { st = YTP?.getPlayerState(); } catch {}
      if (st == null || st === 1 || st === 3 || document.getElementById("ytHint")) return;
      $("#stepBody")?.insertAdjacentHTML("afterbegin", `<p class="muted small" id="ytHint">¿No arranca? En iPhone a veces hay que tocar primero el botón de reproducir dentro del video. Tócalo una vez y vuelve a intentarlo.</p>`);
    }, 3000);
  } else if (text) {
    sayEN(text, { rate: rate < 1 ? "-25%" : "0%" });
  }
}
function stopVideo() { stopRange(); try { YTP?.pauseVideo(); } catch {} }

/* ---------- lección ---------- */
const STEPS = ["Antes", "Idea general", "Con texto", "Frase a frase", "De nuevo", "Hablar"];
let LS = null;   // {row, step, seg, hasVideo}
async function openLesson(id, step) {
  screen("Lección", "", () => { stopVideo(); videoHome(); });
  body(`<p class="muted">Abriendo…</p>`);
  const g = screenGen;
  const row = await loadLesson(id).catch(() => null);
  if (g !== screenGen) return;
  if (!row) { body(err("No pude abrir la lección (¿sin conexión?).")); return; }
  if (!lessonReady(row)) {
    // Todavía en preparación: volver a la lista y esperar ahí. Si falló o quedó a medias: ofrecer reintentar
    await videoHome();
    if (inProgress(row)) waitLesson(row.id, Date.parse(row.creado) || Date.now());
    else offerRetry(row);
    return;
  }
  const L = row.leccion;
  row.progreso = row.progreso || { paso: 1, hechos: [], dictado: {} };
  // Retoma en el primer segmento que falte
  const hechos = new Set(row.progreso.hechos || []);
  let seg0 = 0; while (seg0 < (L.segmentos || []).length - 1 && hechos.has(seg0)) seg0++;
  LS = { row, L, step: step || row.progreso.paso || 1, seg: seg0, hasVideo: false };
  $("#studyTitle").textContent = row.titulo;
  $("#studySub").textContent = `${row.nivel} · ${({ facil: "fácil para ti", adecuado: "a tu medida", exigente: "exigente", muy_exigente: "muy exigente" })[L.encaje] || ""}`;
  body(`${row.video_id ? `<div class="ytbox"><div id="ytp"></div></div>` : ""}
    <nav class="stepper">${STEPS.map((s, i) => `<button class="chip" data-s="${i + 1}">${i + 1}. ${s}</button>`).join("")}</nav>
    <div id="stepBody" class="stack"></div>`);
  for (const b of document.querySelectorAll(".stepper .chip")) b.onclick = () => goStep(Number(b.dataset.s));
  cleanups.push(dropPlayer, endHighlight);
  if (row.video_id) {
    const mine = LS;
    mountPlayer(row.video_id, L.tramo?.inicio).then((ok) => {
      if (LS !== mine) return;
      LS.hasVideo = ok;
      if (!ok) videoFailed();
    }).catch(() => { if (LS === mine) videoFailed(); });
  }
  goStep(LS.step);
}
function saveProgress(patch) {
  Object.assign(LS.row.progreso, patch);
  cacheLesson(LS.row);
  Datos.patch("lecciones", LS.row.id, { progreso: LS.row.progreso });
}
let hlStop = null;   // resaltado del paso 3: solo vive mientras se está en ese paso
function endHighlight() { if (hlStop) { hlStop(); hlStop = null; } }
function goStep(n) {
  stopVideo(); stopRec(); Sala.stopAudio();
  endHighlight(); loopRun++;
  LS.step = n;
  document.querySelector(".ytbox")?.classList.toggle("stick", n === 3);
  for (const b of document.querySelectorAll(".stepper .chip")) b.classList.toggle("on", Number(b.dataset.s) === n);
  document.querySelector(`.stepper .chip[data-s="${n}"]`)?.scrollIntoView({ inline: "center", block: "nearest" });
  [step1, step2, step3, step4, step5, step6][n - 1]();
}
const sb_ = (html) => { $("#stepBody").innerHTML = html; };
const nextBtn = (n, label) => `<button class="primary wide" id="stNext">${label || `Siguiente: ${STEPS[n - 1]}`}</button>`;
// El avance solo sube al terminar un paso con «Siguiente»; tocar las pestañas únicamente navega.
function advanceTo(n) { if (n > (LS.row.progreso.paso || 1)) saveProgress({ paso: n }); goStep(n); $("#studyWrap").scrollTop = 0; }
const wireNext = (n) => on("stNext", () => advanceTo(n));
const tramoText = () => LS.row.transcripcion.filter((c) => c.t + c.d > LS.L.tramo.inicio && c.t < LS.L.tramo.fin).map((c) => c.text).join(" ");
function playTramo(rate = 1) { playRange(LS.L.tramo.inicio, LS.L.tramo.fin, { rate, text: tramoText() }); }
// La parte del video que trabaja la lección, dicha siempre igual en todos los pasos
function parteVideo() {
  const { inicio, fin } = LS.L.tramo;
  return { rango: `del minuto ${mmss(inicio)} al ${mmss(fin)}`, dura: mmss(fin - inicio), mira: LS.row.video_id ? "Mira" : "Escucha", ver: LS.row.video_id ? "Ver" : "Escuchar" };
}

function exprHTML(e, i) {
  const has = Datos.has(e.en);
  return `<div class="expr"><div class="row2 between"><b class="en">${esc(e.en)}</b><button class="mini" data-say="${esc(e.ejemplo_en || e.en)}" aria-label="Escuchar">${IC.play}</button></div>
    <span class="alt">${esc(e.es)}</span>${e.ejemplo_en ? `<i class="small">“${esc(e.ejemplo_en)}”</i>` : ""}${e.uso_es ? `<span class="small muted">${esc(e.uso_es)}</span>` : ""}
    <button class="mini add" data-i="${i}" ${has ? "disabled" : ""}>${has ? "✓ En tu cuaderno" : "+ Cuaderno"}</button></div>`;
}
function addExpr(e) {
  Datos.addCard({ origen: "video", escena: LS.row.titulo, correcta: e.en, nativo: null, tip: [e.es, e.uso_es].filter(Boolean).join(" · "), contexto: e.ejemplo_en || null, leccion_id: LS.row.id });
}
function wireSay(root = document) { for (const b of root.querySelectorAll("[data-say]")) b.onclick = () => sayEN(b.dataset.say); }

function step1() {
  const L = LS.L;
  sb_(`
    <p>${esc(L.resumen_es)}</p>
    <div class="rc-ctx"><b>¿Es para tu nivel?</b><span>${esc(L.encaje_es)}</span></div>
    <div class="rc-ctx"><b>La parte que vas a estudiar: ${parteVideo().rango} (dura ${parteVideo().dura})</b><span>${esc(L.tramo.por_que_es)}</span></div>
    <div class="rc-ctx"><b>Antes de ver, piensa</b><span>${esc(L.prediccion_es)}</span></div>
    <h3>Expresiones clave</h3>
    <div class="exprs">${(L.expresiones || []).map(exprHTML).join("")}</div>
    <button class="ghost wide" id="addAll">Añadir todas al cuaderno de repaso</button>
    ${nextBtn(2)}
    <details class="prefs"><summary>¿Muy fácil o muy difícil? Rehacer para otro nivel</summary>
      <p class="muted small">Usa el mismo video y crea una lección nueva; esta se conserva.</p>
      <div class="chips">${["A2", "B1", "B2", "C1", "C2"].filter((l) => l !== LS.row.nivel).map((l) => `<button class="chip relevel" data-l="${l}">${l}</button>`).join("")}</div>
    </details>`);
  for (const b of document.querySelectorAll(".relevel")) b.onclick = () => relevel(b.dataset.l);
  wireSay($("#stepBody"));
  const exprs = L.expresiones || [];
  for (const b of document.querySelectorAll(".expr .add")) b.onclick = () => { addExpr(exprs[Number(b.dataset.i)]); b.disabled = true; b.textContent = "✓ En tu cuaderno"; };
  on("addAll", () => { exprs.forEach(addExpr); for (const b of document.querySelectorAll(".expr .add")) { b.disabled = true; b.textContent = "✓ En tu cuaderno"; } $("#addAll").disabled = true; $("#addAll").textContent = "✓ Añadidas"; });
  wireNext(2);
}
async function relevel(lv) {
  const r = LS.row;
  const src = { videoId: r.video_id || null, chunks: r.transcripcion || [], fuente: r.fuente || "supadata", title: r.leccion?.titulo_es || r.titulo || "" };
  stopVideo();
  await videoHome();
  // ¿Ya existe para ese nivel? Se abre sin costo
  if (src.videoId) {
    try {
      const { data: prev } = await Sala.sb().from("lecciones").select("id,leccion->segmentos,tokens,creado,actualizado").eq("video_id", src.videoId).eq("nivel", lv).maybeSingle();
      if (prev && (Array.isArray(prev.segmentos) && prev.segmentos.length || inProgress(prev))) { openLesson(prev.id); return; }
    } catch {}
  }
  confirmGenerate(src, lv);
  $("#vStatus")?.scrollIntoView({ block: "start" });
}
function selfRate(key, label) {
  const v = LS.row.progreso[key];
  return `<p class="rc-q small">${esc(label)}</p><div class="rates five">${[0, 25, 50, 75, 100].map((p) => `<button class="rate ${v === p ? "sug" : ""}" data-pct="${p}" data-k="${key}"><span>${p} %</span></button>`).join("")}</div>`;
}
function wireSelfRate() { for (const b of document.querySelectorAll("[data-pct]")) b.onclick = () => { saveProgress({ [b.dataset.k]: Number(b.dataset.pct) }); for (const x of document.querySelectorAll(`[data-k="${b.dataset.k}"]`)) x.classList.toggle("sug", x === b); }; }
function step2() {
  const g = LS.L.preguntas_gist || [], pv = parteVideo();
  sb_(`
    <p><b>${pv.mira} esta parte sin leer nada: ${pv.rango}.</b> Busca solo la idea general; no te detengas en palabras sueltas.</p>
    <ol class="ul">${g.map((q) => `<li><span>${esc(q.q_en)}</span><br><span class="small muted">${esc(q.q_es)}</span></li>`).join("")}</ol>
    <button class="primary wide" id="pPlay">${IC.play}${pv.ver} esta parte (${pv.dura})</button>
    <button class="ghost wide" id="pAns">Mostrar respuestas</button>
    <div id="ans" hidden>${g.map((q, i) => `<div class="rc-ctx"><b>Pregunta ${i + 1}</b><span>${esc(q.respuesta_es)}</span></div>`).join("")}</div>
    ${selfRate("comprension_inicial", "¿Cuánto entendiste en esta primera vez?")}
    ${nextBtn(3)}`);
  on("pPlay", () => playTramo(1));
  on("pAns", () => { $("#ans").hidden = false; $("#pAns").hidden = true; });
  wireSelfRate(); wireNext(3);
}
// Los fragmentos del video no coinciden con las frases: se reparte el tiempo por palabras y se corta por puntuación.
function sentenceLines(chunks) {
  const words = [];
  chunks.forEach((c, ci) => {
    const toks = String(c.text).split(/\s+/).filter(Boolean);
    const total = toks.reduce((a, w) => a + w.length, 0) || 1;
    // Los subtítulos automáticos se solapan: cada fragmento termina donde empieza el siguiente, o el tiempo retrocedería
    const next = chunks[ci + 1];
    const span = next && next.t > c.t ? Math.min(c.d, next.t - c.t) : c.d;
    let acc = 0;
    for (const w of toks) { words.push({ w, t: c.t + (span * acc) / total }); acc += w.length; }
  });
  const out = []; let cur = [];
  const flush = () => { if (cur.length) { out.push({ t: cur[0].t, text: cur.map((x) => x.w).join(" ") }); cur = []; } };
  for (const x of words) {
    cur.push(x);
    if ((/[.!?…]["”')\]]*$/.test(x.w) && !/^(Mr|Mrs|Ms|Dr|St|vs|e\.g|i\.e)\.$/i.test(x.w)) || cur.length >= 22) flush();
  }
  flush();
  const last = chunks[chunks.length - 1];
  const end = last ? last.t + last.d : 0;
  return out.map((l, i) => ({ ...l, d: Math.max(0.3, (out[i + 1]?.t ?? end) - l.t) }));
}
function step3() {
  const lines = sentenceLines(LS.row.transcripcion.filter((c) => c.t + c.d > LS.L.tramo.inicio && c.t < LS.L.tramo.fin));
  let lastCur = -1;
  sb_(`
    <p><b>La misma parte, ahora con el texto en inglés: ${parteVideo().rango}.</b> Toca una línea para oírla de nuevo.</p>
    <div class="rc-actions"><button class="primary big" id="cPlay">${IC.play}Ver con texto</button><button class="ghost" id="cSlow">${IC.play}0,75×</button></div>
    <div class="transcript" id="tr">${lines.map((c, i) => `<button class="tline" data-i="${i}" data-t="${c.t}"><span class="ts">${mmss(c.t)}</span> ${esc(c.text)}</button>`).join("")}</div>
    ${nextBtn(4)}`);
  on("cPlay", () => playTramo(1));
  on("cSlow", () => playTramo(0.75));
  for (const b of document.querySelectorAll(".tline")) b.onclick = () => { const c = lines[Number(b.dataset.i)]; playRange(c.t, c.t + c.d + 0.3, { text: c.text }); };
  // Si la persona está moviendo la lista, el video no se la arrebata durante 4 s
  const wrap = $("#studyWrap");
  let userScrollAt = 0;
  const noteScroll = () => { userScrollAt = Date.now(); };
  wrap.addEventListener("touchmove", noteScroll, { passive: true });
  const hl = setInterval(() => {
    if (!YTP || !ytReady) return;
    let t; try { t = YTP.getCurrentTime(); } catch { return; }
    let cur = -1; lines.forEach((c, i) => { if (t >= c.t && t < c.t + c.d) cur = i; });
    for (const b of document.querySelectorAll(".tline")) b.classList.toggle("now", Number(b.dataset.i) === cur);
    let playing = false; try { playing = YTP.getPlayerState() === 1; } catch {}
    if (cur >= 0 && cur !== lastCur && playing && Date.now() - userScrollAt > 4000) {   // la línea activa se mantiene a la vista bajo el video
      lastCur = cur;
      document.querySelector(`.tline[data-i="${cur}"]`)?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }, 300);
  hlStop = () => { clearInterval(hl); wrap.removeEventListener("touchmove", noteScroll); };
  wireNext(4);
}
function step4() {
  const segs = LS.L.segmentos || [];
  if (!segs.length) { sb_(`<p class="muted">Esta lección no tiene segmentos.</p>${nextBtn(5)}`); wireNext(5); return; }
  const k = Math.min(LS.seg, segs.length - 1), s = segs[k];
  const done = new Set(LS.row.progreso.hechos || []);
  const d = s.dictado;
  let gapN = 0;
  const dictHTML = d ? esc(d.texto).replace(/___/g, () => `<input class="gap" data-g="${gapN++}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Palabra ${gapN}">`) : "";
  sb_(`
    <div class="segnav"><button class="mini" id="sPrev" ${k ? "" : "disabled"}>‹</button>
      <span>Segmento ${k + 1} de ${segs.length}${done.has(k) ? " · ✓" : ""}</span>
      <button class="mini" id="sNext2" ${k + 1 < segs.length ? "" : "disabled"}>›</button></div>
    <div class="rc-actions"><button class="primary big" id="sPlay">${IC.play}Escuchar</button><button class="ghost" id="sSlow">${IC.play}Lento</button><button class="ghost" id="sLoop">${IC.loop}×3</button></div>
    ${d ? `<div class="rc-ctx"><b>Dictado · completa lo que oyes</b><p class="dict">${dictHTML}</p><button class="ghost" id="sCheck">Comprobar</button><div id="dRes"></div></div>` : ""}
    <button class="ghost wide" id="sReveal">Ver texto y explicación</button>
    <div id="sExp" hidden class="stack">
      <div class="rc-ctx"><b>Texto</b><span class="en">${esc(s.texto)}</span></div>
      <div class="rc-ctx"><b>Qué quiere decir aquí</b><span>${esc(s.explicacion_es)}</span><span class="small muted">${esc(s.por_que_es)}</span></div>
      ${(s.expresiones || []).length ? `<div class="chips">${s.expresiones.map((x) => `<button class="chip addx" data-x="${esc(x)}" ${Datos.has(x) ? "disabled" : ""}>${Datos.has(x) ? "✓ " : "+ "}${esc(x)}</button>`).join("")}</div>` : ""}
    </div>
    <div class="rc-ctx shadow"><b>Shadowing${s.shadowing ? " · recomendado aquí" : ""}</b>
      <span class="small">Escucha y repite imitando ritmo y entonación, casi al mismo tiempo que el hablante. Luego mira qué palabras salieron claras.</span>
      <button class="primary" id="shGo">${IC.mic}Repetir esta frase</button><div id="shRes"></div></div>
    ${k + 1 < segs.length ? `<button class="ghost wide" id="sNext">Siguiente segmento ›</button>` : nextBtn(5)}`);
  const play = (rate) => playRange(s.inicio, s.fin, { rate, text: s.texto });
  on("sPlay", () => { loopRun++; play(1); });
  on("sSlow", () => { loopRun++; play(0.75); });
  on("sLoop", async () => {
    const run = ++loopRun;
    for (let i = 0; i < 3 && run === loopRun; i++) {
      play(i === 1 ? 0.75 : 1);
      await sleep(((s.fin - s.inicio) / (i === 1 ? 0.75 : 1)) * 1000 + (LS.hasVideo ? 900 : 2500));
    }
  });
  // Cambiar de segmento corta lo que suena, el «×3» y la grabación en curso
  const goSeg = (n) => { loopRun++; stopVideo(); stopRec(); Sala.stopAudio(); LS.seg = n; step4(); };
  on("sPrev", () => goSeg(k - 1));
  on("sNext2", () => goSeg(k + 1));
  on("sNext", () => { markDone(k); goSeg(k + 1); $("#studyWrap").scrollTop = 0; });
  wireNext(5);
  on("stNext", () => { markDone(k); advanceTo(5); });
  on("sReveal", () => { $("#sExp").hidden = false; $("#sReveal").hidden = true; markDone(k); });
  for (const b of document.querySelectorAll(".addx")) b.onclick = () => {
    Datos.addCard({ origen: "video", escena: LS.row.titulo, correcta: b.dataset.x, tip: null, contexto: s.texto, leccion_id: LS.row.id });
    b.disabled = true; b.textContent = "✓ " + b.dataset.x;
  };
  on("sCheck", () => {
    const inps = [...document.querySelectorAll(".gap")], escrito = inps.map((i) => i.value.trim());
    if (!escrito.some(Boolean)) { $("#dRes").innerHTML = `<span class="small">Escribe primero lo que oíste.</span>`; return; }
    const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");   // se evalúa lo que oíste: comas, mayúsculas y apóstrofos no cuentan
    // Huecos seguidos («___ ___»): escribir las dos palabras en una sola casilla también es acertar
    const partes = d.texto.split("___"), grupos = [];
    inps.forEach((_, i) => { if (i > 0 && !partes[i].trim()) grupos[grupos.length - 1].push(i); else grupos.push([i]); });
    const bien = inps.map(() => false);
    for (const g of grupos) {
      const juntas = norm(g.map((i) => escrito[i]).join("")) === norm(g.map((i) => d.respuestas[i] || "").join(""));
      for (const i of g) bien[i] = juntas || norm(escrito[i]) === norm(d.respuestas[i] || "");
    }
    inps.forEach((inp, i) => {
      inp.classList.toggle("right", bien[i]); inp.classList.toggle("wrong", !bien[i]);
      inp.value = bien[i] && escrito[i] && norm(escrito[i]) === norm(d.respuestas[i] || "") ? escrito[i] : d.respuestas[i] || "";
      inp.readOnly = true;
    });
    const ok = bien.filter(Boolean).length;
    const fallos = inps.map((_, i) => (bien[i] ? "" : `<li>${escrito[i] ? `Escribiste «${esc(escrito[i])}»` : "Casilla en blanco"}: era <b>${esc(d.respuestas[i] || "")}</b></li>`)).join("");
    $("#sCheck").disabled = true;   // las respuestas ya quedaron escritas: comprobar otra vez daría todo correcto
    $("#dRes").innerHTML = `<span class="${ok === d.respuestas.length ? "ok" : "small"}">${ok} de ${d.respuestas.length} correctas</span>${fallos ? `<ul class="ul small">${fallos}</ul>` : ""}`;
    saveProgress({ dictado: { ...(LS.row.progreso.dictado || {}), [k]: { ok, de: d.respuestas.length, escrito } } });
  });
  on("shGo", () => shadow(s));
}
function markDone(k) { const h = new Set(LS.row.progreso.hechos || []); if (!h.has(k)) { h.add(k); saveProgress({ hechos: [...h] }); } }
function shadow(s) {
  const btn = $("#shGo"), res = $("#shRes");
  btn.disabled = true; btn.textContent = "Te escucho… repite la frase";
  res.innerHTML = `<div class="live" id="shLive"></div><button class="ghost" id="shStop">Listo</button>`;
  const h = recognize({ reference: s.texto, maxMs: Math.max(12000, (s.fin - s.inicio) * 3000), autoEnd: true, onPartial: (t) => { const el = $("#shLive"); if (el) el.textContent = t; } });
  on("shStop", h.stop);
  h.promise.then((r) => {
    if (!document.body.contains(btn)) return;
    btn.disabled = false; btn.innerHTML = `${IC.mic}Otra vez`;
    if (!r.text) { res.innerHTML = `<p class="small muted">No te oí. Revisa el micrófono e intenta de nuevo.</p>`; return; }
    savePron("leccion", s.texto, r, LS.row.id);
    const weak = r.palabras.filter((w) => w.error !== "Insertion" && (w.error === "Omission" || (w.score != null && w.score < 60))).map((w) => w.w);
    const amber = r.palabras.some((w) => w.error !== "Insertion" && w.score != null && w.score < 80);
    res.innerHTML = `${scoresHTML(r)}${wordsHTML(r.palabras)}
      <p class="small muted">${weak.length ? `Practica: <b>${esc([...new Set(weak)].slice(0, 5).join(", "))}</b>. Escúchalas en lento y repite.` : amber ? "Ninguna palabra quedó en rojo; las de color ámbar todavía se pueden pulir." : "Todas las palabras salieron claras."}</p>
      <p class="small muted">Verde: clara · ámbar: mejorable · rojo: no se entendió · tachada: no la dijiste.</p>`;
  });
}
function step5() {
  const pv = parteVideo();
  sb_(`
    <p><b>${pv.mira} otra vez la misma parte, sin texto: ${pv.rango}.</b> Compara con la primera vez.</p>
    <div class="rc-ctx"><b>Para pensar</b><span>${esc(LS.L.reflexion_es)}</span></div>
    <button class="primary wide" id="fPlay">${IC.play}${pv.ver} esta parte (${pv.dura})</button>
    ${selfRate("comprension_final", "¿Cuánto entendiste ahora?")}
    <div id="gain"></div>
    ${nextBtn(6)}`);
  on("fPlay", () => playTramo(1));
  const showGain = () => {
    const a = LS.row.progreso.comprension_inicial, b = LS.row.progreso.comprension_final;
    if (a != null && b != null) $("#gain").innerHTML = `<p class="ok">${b > a ? `Subiste de ${a} % a ${b} % de comprensión.` : `Primera vez: ${a} % · ahora: ${b} %.`}</p>`;
  };
  wireSelfRate(); showGain();
  for (const b of document.querySelectorAll("[data-k='comprension_final']")) { const f = b.onclick; b.onclick = () => { f(); showGain(); }; }
  wireNext(6);
}
const NIVELES_HABLA = ["A1", "A2", "B1", "B2", "C1"];
const nivelHabla = (n) => (n === "C2" ? "C1" : NIVELES_HABLA.includes(n) ? n : null);
function step6() {
  const p = LS.L.personaje || {};
  const exprs = (LS.L.expresiones || []).map((e) => e.en);
  const mine = LS, guardado = nivelHabla(LS.row.progreso.nivel_habla);
  let test = nivelHabla(store().get("lastTest", null)?.nivel), elegido = guardado || test || "B2", tocado = !!guardado;
  sb_(`
    <div class="stack"><p class="rc-q small" style="margin:0">¿En qué nivel quieres practicar?</p>
      <div class="rates five" role="group" aria-label="Nivel de la conversación">${NIVELES_HABLA.map((n) => `<button class="rate" data-nv="${n}"><span>${n}</span></button>`).join("")}</div>
      <p class="muted small" id="nvNota" style="margin:0"></p></div>
    <p><b>Úsalo hablando.</b> ${esc(p.nombre || "Un personaje")}${p.who_es ? ` (${esc(String(p.who_es).replace(/\.+$/, ""))})` : ""} quiere conversar contigo sobre el tema del video. Intenta usar estas expresiones:</p>
    <div class="chips">${exprs.map((x) => `<span class="chip static">${esc(x)}</span>`).join("")}</div>
    <button class="primary wide" id="talkGo">${IC.mic}Conversar con ${esc(p.nombre || "el personaje")}</button>
    <p class="muted small">Las correcciones de esta conversación van a tu cuaderno, igual que en las demás escenas.</p>`);
  const pintarNivel = () => {
    for (const b of document.querySelectorAll("[data-nv]")) { const on_ = b.dataset.nv === elegido; b.classList.toggle("sug", on_); b.setAttribute("aria-pressed", String(on_)); }
    const nota = $("#nvNota");
    if (nota) nota.textContent = `${test ? `Por defecto es el nivel de tu test (${test}).` : "Aún no tienes test, así que por defecto es B2."} Cambia cómo te habla el personaje; las expresiones de la lección son las mismas.`;
  };
  for (const b of document.querySelectorAll("[data-nv]")) b.onclick = () => { elegido = b.dataset.nv; tocado = true; saveProgress({ nivel_habla: elegido }); pintarNivel(); };
  pintarNivel();
  // En un equipo nuevo el resultado del test solo está en el servidor
  if (!test) Sala.sb().from("test_intentos").select("nivel").not("fin", "is", null).order("fin", { ascending: false }).limit(1).maybeSingle().then(({ data }) => {
    const n = nivelHabla(data?.nivel);
    if (!n || LS !== mine) return;
    test = n;
    if (!tocado) elegido = n;
    pintarNivel();
  }, () => {});
  on("talkGo", () => {
    stopVideo();
    Sala.startScene({
      id: "lec-" + LS.row.id, title: LS.row.titulo, name: p.nombre || "Partner", who: p.who_es || "", desc: "", nivel: elegido,
      persona: `${p.persona_en || ""}\nThe learner just studied a video lesson on this topic. Create natural chances for them to use these expressions (never list them, never quiz): ${exprs.join("; ")}.`,
      open: p.open_en || "So, what did you think of the video?", voice: p.voz || "en-US-AvaMultilingualNeural",
      returnTo: { kind: "lesson", id: LS.row.id },
    });
  });
}

/* =====================================================================
   MIS OBJETIVOS · cada usuario dice para qué quiere el inglés
   Se guarda en perfil.objetivos (servidor): los prompts de conversación, lecciones y escenas lo leen.
   ===================================================================== */
const GOALS = [
  ["viajes", "Viajar"], ["trabajo", "Mi trabajo"], ["reuniones", "Reuniones y presentaciones"], ["entrevistas", "Entrevistas de trabajo"],
  ["ventas", "Ventas y clientes"], ["estudios", "Estudios o exámenes"], ["exterior", "Vivir en otro país"], ["cotidiano", "Conversación cotidiana"],
  ["amigos", "Hacer amigos"], ["hijos", "Ayudar a mis hijos"], ["series", "Series, películas y música"], ["salud", "Citas médicas"],
];
const GOAL_EXAMPLES = {
  viajes: "Pedir un cambio de vuelo en el aeropuerto porque perdí la conexión", trabajo: "Explicarle a un colega extranjero en qué consiste mi trabajo",
  reuniones: "Presentar los resultados del trimestre en una reunión por video", entrevistas: "Entrevista de trabajo: háblame de ti y de tu mayor logro",
  ventas: "Negociar el precio con un cliente que pide 15 % de descuento", estudios: "Preguntarle a un profesor por la fecha y el formato del examen",
  exterior: "Abrir una cuenta en el banco y preguntar por las comisiones", cotidiano: "Pedir en un restaurante y preguntar qué lleva un plato",
  amigos: "Conocer a alguien en una fiesta y quedar para tomar algo", hijos: "Hablar con la profesora de inglés de mi hijo sobre sus tareas",
  series: "Comentar con un amigo el final de una serie que vimos", salud: "Explicarle a un médico qué síntomas tengo y desde cuándo",
};
const myScenes = () => store().get("myScenes", []);
const goals = () => store().get("objetivos", {});
let pushRestored = false;
// Trae objetivos y escenas del servidor; sube las escenas viejas que solo vivían en este teléfono
async function syncPerfil() {
  try {
    const { data, error: e0 } = await Sala.sb().from("perfil").select("objetivos,escenas,recordatorio").maybeSingle();
    if (e0) throw e0;
    store().set("recordatorio", data?.recordatorio || {});
    let escenas = data?.escenas || [];
    // Una escena guardada sin conexión sigue aquí: se sube en vez de perderse al sincronizar
    if (store().get("escenasSinSubir", false)) {
      const local = myScenes(), ids = new Set(local.map((e) => e.id));
      escenas = [...local, ...escenas.filter((e) => !ids.has(e.id))];
      const { error } = await Sala.sb().from("perfil").upsert({ escenas }, { onConflict: "user_id" });
      if (!error) store().set("escenasSinSubir", false);
    }
    const legacy = store().get("customScenes", []);
    if (legacy.length) {
      const ids = new Set(escenas.map((e) => e.id));
      escenas = [...legacy.filter((e) => !ids.has(e.id)), ...escenas];
      const { error } = await Sala.sb().from("perfil").upsert({ escenas }, { onConflict: "user_id" });
      if (!error) store().set("customScenes", []);
    }
    store().set("objetivos", data?.objetivos || {});
    store().set("myScenes", escenas);
    store().set("perfilSynced", true);
    // Tras cerrar y volver a entrar: el nivel se recupera del último test y este teléfono vuelve a recibir los avisos
    if (localStorage.getItem("sala:level") === null) {
      const { data: t } = await Sala.sb().from("test_intentos").select("nivel").not("fin", "is", null).order("fin", { ascending: false }).limit(1).maybeSingle();
      if (t?.nivel) Sala.setLevel(t.nivel);
    }
    if (!pushRestored && data?.recordatorio?.activo && typeof Notification !== "undefined" && Notification.permission === "granted") { pushRestored = true; askPush(); }
    if (!$("#home").hidden) Sala.backHome();
  } catch (e) { console.warn("perfil", e); }
}
async function savePerfil(patch) {
  const { error } = await Sala.sb().from("perfil").upsert(patch, { onConflict: "user_id" });
  if (error) throw error;
  if (patch.objetivos) store().set("objetivos", patch.objetivos);
  if (patch.escenas) { store().set("myScenes", patch.escenas); store().set("escenasSinSubir", false); }
}
// Borra una escena propia del perfil y lo que dejó en este equipo (voz elegida, reto pendiente)
async function deleteScene(id) {
  const s = myScenes().find((x) => x.id === id);
  await savePerfil({ escenas: myScenes().filter((x) => x.id !== id) });
  if (s) Sala.olvidarEscena(id, [s.title].filter(Boolean));
}
// Tope de 16 escenas: nunca se borra ninguna sin decir cuáles y sin un «sí» explícito
function confirmDrop(anchor, titles, onYes) {
  anchor.parentNode.querySelector(".scene-limit")?.remove();
  const w = document.createElement("div"); w.className = "ldel scene-limit";
  w.innerHTML = `<p class="small" style="margin:6px 0 0">El máximo es 16 escenas. Para continuar se ${titles.length === 1 ? "borraría esta" : "borrarían estas"}: ${titles.map((t) => `«${esc(t)}»`).join(", ")}. No se puede deshacer.</p>
    <div class="lname-btns"><button class="ldanger" data-a="yes">Sí, borrar y continuar</button><button class="ghost" data-a="no">No</button></div>`;
  anchor.after(w);
  w.querySelector('[data-a="no"]').onclick = () => w.remove();
  w.querySelector('[data-a="yes"]').onclick = () => { w.remove(); onYes(); };
}
/* ---------------- recordatorio diario ---------------- */
function reminderScreen() {
  screen("Recordatorio diario", "Solo si ese día aún no practicaste", home);
  const r = store().get("recordatorio", {});
  const hora = r.hora ?? 19;
  body(`
    <p>Te enviamos un aviso a la hora que elijas. Si ese día ya conversaste o repasaste, no te llega nada.</p>
    <label class="check"><input type="checkbox" id="rmOn" ${r.activo ? "checked" : ""}> Recordarme cada día</label>
    <label for="rmHour">Hora</label>
    <select id="rmHour">${Array.from({ length: 17 }, (_, i) => i + 6).map((h) => `<option value="${h}" ${h === Number(hora) ? "selected" : ""}>${Sala.hourLabel(h)}</option>`).join("")}</select>
    <button class="primary wide" id="rmSave">Guardar</button>
    <p class="small" id="rmMsg" role="status"></p>
    ${pushSupported() ? `<button class="ghost wide" id="rmTest">Enviar un aviso de prueba</button>` : `<div class="notice" style="margin:0">En iPhone, los avisos solo funcionan con la app agregada a la pantalla de inicio.</div>`}`);
  on("rmTest", (ev) => testPush(ev.currentTarget));
  on("rmSave", () => {
    const activo = $("#rmOn").checked, msg = $("#rmMsg"), btn = $("#rmSave");
    const permiso = activo ? askPush() : Promise.resolve(true);   // se pide dentro del toque (lo exige iOS)
    btn.disabled = true;
    permiso.then(async (ok) => {
      if (!ok) { msg.textContent = pushDenied() ? "Tienes los avisos bloqueados: actívalos en Ajustes › Notificaciones." : "No se pudieron activar los avisos. ¿La app está en tu pantalla de inicio?"; return; }
      const recordatorio = { activo, hora: Number($("#rmHour").value), tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
      await savePerfil({ recordatorio });
      store().set("recordatorio", recordatorio);
      msg.textContent = activo ? `Listo: cada día a ${recordatorio.hora === 13 ? "la" : "las"} ${Sala.hourLabel(recordatorio.hora)}, si aún no has practicado.` : "Recordatorio desactivado.";
    }).catch(() => { msg.textContent = "No se pudo guardar. Revisa tu conexión e intenta de nuevo."; }).finally(() => { btn.disabled = false; });
  });
}
function goalsSummary() {
  const o = goals();
  const names = (o.para_que || []).map((k) => (GOALS.find((g) => g[0] === k) || [])[1]).filter(Boolean);
  if (names.length) return names.slice(0, 3).join(" · ") + (names.length > 3 ? "…" : "");
  return o.contexto || o.situaciones ? "Tus objetivos ya están definidos" : "";   // también vale contarlo solo con texto
}
function goalsScreen() {
  screen("Mis objetivos", "Para qué quieres el inglés", home);
  const o = goals();
  const sel = new Set(o.para_que || []);
  body(`
    <p>Cuéntale a la app para qué quieres el inglés. Con esto ajusta las conversaciones y las lecciones de video, y te crea escenas a tu medida.</p>
    <label for="gName">¿Cómo quieres que te llamen?</label>
    <input id="gName" maxlength="40" placeholder="Tu nombre" value="${esc(o.nombre || "")}">
    <label>¿Para qué lo quieres? <span class="muted small">(elige todos los que apliquen)</span></label>
    <div class="chips" id="gChips">${GOALS.map(([k, t]) => `<button type="button" class="chip goal ${sel.has(k) ? "on" : ""}" data-k="${k}">${esc(t)}</button>`).join("")}</div>
    <label for="gCtx">Cuéntame de ti <span class="muted small">(trabajo, intereses, con quién hablarías)</span></label>
    <textarea id="gCtx" rows="3" maxlength="400" placeholder="Ej.: Soy odontóloga, quiero viajar con mi familia y entender a los pacientes extranjeros.">${esc(o.contexto || "")}</textarea>
    <label for="gSit">Situaciones concretas que quieres manejar</label>
    <textarea id="gSit" rows="3" maxlength="400" placeholder="Ej.: Hacer el check-in en un hotel, pedir indicaciones, hablar con otros papás en el colegio.">${esc(o.situaciones || "")}</textarea>
    <button class="primary wide" id="gSave">Guardar</button>
    <div id="gOut"></div>`);
  for (const b of document.querySelectorAll(".chip.goal")) b.onclick = () => { b.classList.toggle("on"); };
  on("gSave", async () => {
    const objetivos = {
      nombre: $("#gName").value.trim().slice(0, 40),
      para_que: [...document.querySelectorAll(".chip.goal.on")].map((b) => b.dataset.k),
      contexto: $("#gCtx").value.trim().slice(0, 400),
      situaciones: $("#gSit").value.trim().slice(0, 400),
    };
    if (!objetivos.para_que.length && !objetivos.contexto && !objetivos.situaciones) { $("#gOut").innerHTML = err("Elige al menos un objetivo o escribe algo sobre ti."); return; }
    $("#gSave").disabled = true;
    try {
      await savePerfil({ objetivos });
      $("#gOut").innerHTML = `<div class="notice">✓ Guardado. Desde ahora las conversaciones y las lecciones tienen en cuenta tus objetivos.</div>
        <button class="primary wide" id="gScenes">Crear 4 escenas para mis objetivos</button>
        <p class="muted small">Tardan unos 20 segundos. Aparecen en tu pantalla de inicio.</p>`;
      on("gScenes", () => makeGoalScenes($("#gScenes")));
    } catch (e) { $("#gOut").innerHTML = err("No pude guardar. Revisa tu conexión e intenta de nuevo."); }
    finally { const b = $("#gSave"); if (b) b.disabled = false; }
  });
}
async function makeGoalScenes(btn, confirmar) {
  const g = screenGen;
  btn.dataset.label = btn.dataset.label || btn.textContent;
  if (btn.nextElementSibling?.classList.contains("notice")) btn.nextElementSibling.remove();
  btn.disabled = true; btn.textContent = "Creando tus escenas… (unos 20 s)";
  try {
    const r = await Sala.fnFetch("generar", { modo: "escenas_objetivos", level: Sala.level(), n: 4, ...(confirmar ? { confirmar_recorte: true } : {}) });
    const j = await r.json();
    if (r.status === 409 && j.error === "limite_escenas") {
      btn.disabled = false; btn.textContent = btn.dataset.label;
      if (g === screenGen) confirmDrop(btn, j.se_borran || [], () => makeGoalScenes(btn, true));
      return;
    }
    if (!r.ok) throw j;
    store().set("myScenes", j.escenas || []);
    // Si ya saliste de esta pantalla no te saca de donde estés
    if (g === screenGen) { leave(); Sala.backHome(); } else if (!$("#home").hidden) Sala.backHome();
  } catch (e) {
    btn.disabled = false; btn.textContent = "Reintentar";
    btn.insertAdjacentHTML("afterend", err(`No pude crear las escenas (${e?.error || "error"}).`));
  }
}

/* =====================================================================
   CREA TU ESCENA
   ===================================================================== */
function sceneHome() {
  screen("Crea tu escena", `Nivel ${Sala.level()}`, home);
  const mine = myScenes();
  const ex = (goals().para_que || []).map((k) => GOAL_EXAMPLES[k]).filter(Boolean);
  const examples = (ex.length ? ex : [GOAL_EXAMPLES.viajes, GOAL_EXAMPLES.cotidiano, GOAL_EXAMPLES.entrevistas, GOAL_EXAMPLES.salud]).slice(0, 4);
  body(`
    <p>Describe la situación que quieres ensayar, en español o en inglés: quién es la otra persona, dónde están y qué quieres lograr.</p>
    <textarea id="scDesc" rows="4" placeholder="Ej.: ${esc(examples[0])}"></textarea>
    <div class="chips">${examples.map((x) => `<button class="chip ex">${esc(x)}</button>`).join("")}</div>
    <button class="primary wide" id="scGo">Crear personaje</button>
    <div id="scOut"></div>
    <button class="ghost wide" id="scGoals">${goalsSummary() ? "Crear 4 escenas para mis objetivos" : "Primero, cuéntame tus objetivos"}</button>
    ${mine.length ? `<h3>Tus escenas</h3><div class="list">${mine.map((s) => `<div class="li"><span><b>${esc(s.title)}</b> · ${esc(s.name)}</span><span class="meta">${esc(s.desc)}</span><button class="linklike" data-del="${esc(s.id)}">Borrar</button></div>`).join("")}</div>` : ""}`);
  for (const b of document.querySelectorAll(".chip.ex")) b.onclick = () => { $("#scDesc").value = b.textContent; };
  for (const b of document.querySelectorAll("[data-del]")) b.onclick = () => {
    b.hidden = true;
    const w = document.createElement("div"); w.className = "ldel";
    w.innerHTML = `<p class="small" style="margin:6px 0 0">¿Borrar esta escena? No se puede deshacer.</p><div class="lname-btns"><button class="ldanger" data-a="yes">Sí, borrar</button><button class="ghost" data-a="no">No</button></div>`;
    b.after(w);
    w.querySelector('[data-a="no"]').onclick = () => { w.remove(); b.hidden = false; };
    const yes = w.querySelector('[data-a="yes"]');
    yes.onclick = async () => {
      yes.disabled = true;
      try { await deleteScene(b.dataset.del); sceneHome(); } catch { yes.disabled = false; yes.textContent = "Sin conexión. Reintentar"; }
    };
  };
  on("scGoals", (ev) => (goalsSummary() ? makeGoalScenes(ev.currentTarget) : goalsScreen()));
  on("scGo", async () => {
    const desc = $("#scDesc").value.trim();
    if (desc.length < 8) { $("#scOut").innerHTML = err("Cuéntame un poco más de la situación."); return; }
    $("#scGo").disabled = true;
    $("#scOut").innerHTML = `<p class="muted">Creando el personaje…</p><div class="spinner"></div>`;
    const g = screenGen;
    try {
      const r = await Sala.fnFetch("generar", { modo: "escena", descripcion: desc, level: Sala.level() });
      const j = await r.json(); if (!r.ok) throw j;
      if (g !== screenGen) return;
      const e = j.escena;
      const scene = { id: "c-" + Datos.uuid(), custom: true, title: e.titulo_es, name: e.nombre, who: e.who_es, desc: e.desc_es, persona: e.persona_en, open: e.open_en, voice: e.voz };
      $("#scOut").innerHTML = `<div class="scene static"><span class="who">${esc(scene.who)}</span><span class="t">${esc(scene.title)}</span><span class="d">${esc(scene.desc)}</span><i class="small">“${esc(scene.open)}”</i></div>
        <button class="primary wide" id="scSave">Guardar y practicar</button><button class="ghost wide" id="scRedo">Otra versión</button>`;
      on("scSave", () => {
        const cur = myScenes();
        const doSave = () => {
          const escenas = [scene, ...cur].slice(0, 16);
          store().set("myScenes", escenas);
          store().set("escenasSinSubir", true);       // se apaga cuando el servidor confirma; si falla, se sube al sincronizar
          savePerfil({ escenas }).catch(() => {});
          leave(); Sala.startScene(scene);
        };
        if (cur.length >= 16) confirmDrop($("#scSave"), cur.slice(15).map((s) => s.title), doSave); else doSave();
      });
      on("scRedo", () => $("#scGo").click());
    } catch {
      if (g === screenGen) $("#scOut").innerHTML = err("No pude crear la escena. Intenta de nuevo.");
    } finally { const b = $("#scGo"); if (b && g === screenGen) b.disabled = false; }
  });
}

/* =====================================================================
   MI PROGRESO
   ===================================================================== */
async function progress() {
  screen("Mi progreso", "Últimas 4 semanas", home);
  body(`<p class="muted">Cargando…</p>`);
  const sb = Sala.sb();
  const since = new Date(Date.now() - 28 * 864e5).toISOString();
  const since40 = new Date(Date.now() - 40 * 864e5).toISOString();   // la racha mira lo mismo que la de la pantalla de inicio
  const g = screenGen;
  const [ses, rep, pron, tests, lecs] = await Promise.all([
    sb.from("sesiones").select("inicio,fin,turnos,palabras_jose,nivel_estimado,stt_segundos").gte("inicio", since40),
    sb.from("repasos").select("rating,repasado").gte("repasado", since40),
    sb.from("pronunciacion").select("total,exactitud,fluidez,prosodia,creado").gte("creado", since),
    sb.from("test_intentos").select("nivel,nivel_rango,fin,perfil").not("fin", "is", null).order("fin", { ascending: false }).limit(8),
    sb.from("lecciones").select("id,titulo,progreso,creado,tokens").gte("creado", since).order("creado", { ascending: false }),
  ]).catch(() => []);
  if (g !== screenGen) return;
  if (!ses || ses.error) { body(err("No pude cargar tus datos (¿sin conexión?).")); return; }
  const S = ses.data || [], R = rep.data || [], P = pron.data || [], TT = tests.data || [], LL = (lecs.data || []).filter((x) => !["creando", "error"].includes(x.tokens?.estado));
  const day = 864e5, now = Date.now();
  const mins = (s) => (s.stt_segundos || 0) / 60;   // tiempo real de tu voz, no la duración de la sesión
  const inWeek = (d, w) => { const age = now - Date.parse(d); return age >= w * 7 * day && age < (w + 1) * 7 * day; };
  const wk = (w) => {
    const s = S.filter((x) => inWeek(x.inicio, w)), r = R.filter((x) => inWeek(x.repasado, w)), p = P.filter((x) => inWeek(x.creado, w));
    return {
      min: Math.round(s.reduce((a, x) => a + mins(x), 0)), ses: s.length, pal: s.reduce((a, x) => a + (x.palabras_jose || 0), 0),
      rep: r.length, ret: r.length ? Math.round((r.filter((x) => x.rating > 1).length / r.length) * 100) : null,
      pron: p.filter((x) => x.total != null).length ? Math.round(p.reduce((a, x) => a + (x.total || 0), 0) / p.filter((x) => x.total != null).length) : null,
      lec: LL.filter((x) => inWeek(x.creado, w)).length,
    };
  };
  const a = wk(0), b = wk(1);
  const delta = (x, y, suf = "") => {
    if (x == null) return "—";
    if (y == null || y === x) return x + suf;
    const up = x > y;
    return `${x}${suf} <small class="${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(x - y)}${suf}</small>`;
  };
  // minutos por día, últimos 14 días
  const days = Array.from({ length: 14 }, (_, i) => { const d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - (13 - i)); return d0; });
  const perDay = days.map((d0) => Math.round(S.filter((s) => { const t = new Date(s.inicio); return t >= d0 && t < new Date(+d0 + day); }).reduce((x, s) => x + mins(s), 0)));
  const maxD = Math.max(10, ...perDay);
  const streak = (() => {
    const hit = new Set([...S.filter((s) => (s.turnos || 0) > 0).map((s) => new Date(s.inicio).toDateString()), ...R.map((r) => new Date(r.repasado).toDateString())]);
    const d = new Date(); if (!hit.has(d.toDateString())) d.setDate(d.getDate() - 1);   // hoy aún no cuenta en contra
    let n = 0; while (hit.has(d.toDateString())) { n++; d.setDate(d.getDate() - 1); }
    return n;
  })();
  const in28 = (d) => now - Date.parse(d) < 28 * day;
  // sugerencia de nivel: niveles estimados de las conversaciones de 14 días, ponderados por turnos
  const votes = {};
  for (const s of S) if (s.nivel_estimado && now - Date.parse(s.inicio) < 14 * day) votes[s.nivel_estimado] = (votes[s.nivel_estimado] || 0) + Math.max(1, s.turnos || 1);
  const nSes = S.filter((s) => s.nivel_estimado && now - Date.parse(s.inicio) < 14 * day).length;
  const top = Object.keys(votes).sort((x, y) => votes[y] - votes[x])[0];
  const cur = Sala.level();
  const suggest = top && nSes >= 3 && top !== cur ? top : null;
  body(`
    ${!S.some((x) => in28(x.inicio)) && !R.some((x) => in28(x.repasado)) && !P.length && !LL.length ? `<div class="notice" style="margin:0">Aún no hay práctica en estas semanas. Con una conversación corta empiezan a llenarse estos números. <button class="primary wide" id="pgStart" style="margin-top:8px">Elegir una escena</button></div>` : ""}
    <div class="kpis">
      <div><small>Minutos hablando</small><b>${delta(a.min, b.min)}</b></div>
      <div><small>Palabras tuyas</small><b>${delta(a.pal, b.pal)}</b></div>
      <div><small>Repasos</small><b>${delta(a.rep, b.rep)}</b></div>
      <div><small>Recordaste</small><b>${delta(a.ret, b.ret, " %")}</b></div>
      <div><small>Pronunciación</small><b>${delta(a.pron, b.pron)}</b></div>
      <div><small>Lecciones nuevas</small><b>${delta(a.lec, b.lec)}</b></div>
    </div>
    <p class="muted small">Esta semana frente a la anterior (▲▼). Todo medido por la app; «Recordaste» = repasos que no marcaste «Otra vez».</p>
    <h3>Minutos hablando por día · ${streak ? `racha de ${streak} día${streak > 1 ? "s" : ""}` : "sin racha activa"}</h3>
    <div class="bars">${perDay.map((m, i) => `<div title="${m} min"><span style="height:${Math.round((m / maxD) * 100)}%"></span><small>${days[i].toLocaleDateString("es-CO", { weekday: "narrow" })}</small></div>`).join("")}</div>
    <div class="rc-ctx"><b>Cuaderno</b><span>${Datos.all().length} ${Datos.all().length === 1 ? "frase" : "frases"} · ${Datos.due().length} ${Datos.due().length === 1 ? "pendiente" : "pendientes"} hoy</span></div>
    ${suggest ? `<div class="rc-ctx"><b>Sugerencia de nivel (estimada)</b><span>Tus últimas ${nSes} conversaciones suenan a <b>${suggest}</b>; tienes configurado ${cur}.</span>
      <button class="primary" id="lvUse">Cambiar a ${suggest}</button></div>` : ""}
    <h3>Historial de tests</h3>
    ${TT.length ? `<div class="list">${TT.map((t) => `<div class="li"><span><b>${esc(t.nivel)}</b> · ${esc(t.nivel_rango || "")}</span><span class="meta">${new Date(t.fin).toLocaleDateString("es-CO")} · ${Object.entries(t.perfil || {}).map(([k, v]) => `${SKILL[k] || k} ${v}`).join(" · ")}</span></div>`).join("")}</div>` : `<p class="muted small">Aún no has hecho el test. <button class="linklike" id="goTest">Hacerlo ahora</button></p>`}
    ${LL.length ? `<h3>Lecciones del mes</h3><div class="list">${LL.map((l) => `<button class="li lesson" data-id="${esc(l.id)}"><b>${esc(l.titulo)}</b><span class="meta">paso ${l.progreso?.paso || 1} de 6${l.progreso?.comprension_final != null ? ` · comprensión ${l.progreso.comprension_inicial ?? "?"} → ${l.progreso.comprension_final} %` : ""}</span></button>`).join("")}</div>` : ""}`);
  on("lvUse", () => { Sala.setLevel(suggest); progress(); });
  on("goTest", testIntro);
  on("pgStart", home);
  for (const b of document.querySelectorAll(".lesson")) b.onclick = () => openLesson(b.dataset.id);
}

/* ---------------- arranque ---------------- */
// practiced: la conversación tuvo turnos (lo indica app.js); solo entonces cuenta como hecha
/* ---------------- cambiar contraseña ---------------- */
function passwordScreen(forced = false) {
  // En el paso obligatorio la salida es cerrar la sesión: nadie queda encerrado en esta pantalla.
  const atras = forced ? () => document.getElementById("signOut")?.click() : () => Sala.backHome();
  const nueva = forced === "nueva";
  screen(nueva ? "Crea tu contraseña" : "Cambiar contraseña", forced ? "Paso obligatorio" : "", atras, forced ? "‹ Salir" : "‹ Inicio");
  body(`${forced ? `<div class="notice" data-kind="info">${nueva ? "Elige la contraseña con la que vas a entrar a la app." : "Entraste con la clave inicial. Elige una contraseña solo tuya para seguir."}</div>` : `<label for="pwOld">Contraseña actual</label><input id="pwOld" type="password" autocomplete="current-password">`}
    <label for="pwNew">Contraseña nueva (mínimo 8 caracteres)</label><input id="pwNew" type="password" autocomplete="new-password" minlength="8">
    <label for="pwNew2">Repite la contraseña nueva</label><input id="pwNew2" type="password" autocomplete="new-password">
    <div id="pwErr"></div>
    <button class="primary wide" id="pwGo">Guardar contraseña</button>`);
  Sala.ojoClave(document.getElementById("studyBody"));
  on("pwGo", async () => {
    const show = (m) => { $("#pwErr").innerHTML = err(m); };
    const nueva = $("#pwNew").value, otra = $("#pwNew2").value;
    const { data: u } = await Sala.sb().auth.getUser();
    const email = u?.user?.email?.toLowerCase() || "";
    if (nueva.length < 8) return show("Usa al menos 8 caracteres.");
    if (nueva !== otra) return show("Las dos contraseñas no coinciden.");
    if (nueva.toLowerCase() === email.split("@")[0] || nueva.toLowerCase() === email) return show("Elige una contraseña distinta a tu usuario.");
    const b = $("#pwGo"); b.disabled = true; b.textContent = "Guardando…";
    try {
      if (!forced) {
        const { error } = await Sala.sb().auth.signInWithPassword({ email, password: $("#pwOld").value });
        if (error) throw { msg: "La contraseña actual no es correcta." };
      }
      const { error } = await Sala.sb().auth.updateUser({ password: nueva });
      if (error) throw { msg: /different|same/i.test(error.message) ? "Elige una contraseña distinta a la anterior." : /weak/i.test(error.message) ? "Esa contraseña es muy débil. Prueba con una más larga." : "No se pudo guardar. Revisa tu conexión e inténtalo de nuevo." };
      store().remove ? store().remove("forzarClave") : store().set("forzarClave", false);
      Sala.notice("Tu contraseña quedó cambiada.", "info");
      Sala.backHome();
    } catch (e) { show(e?.msg || "No se pudo guardar. Revisa tu conexión e inténtalo de nuevo."); b.disabled = false; b.textContent = "Guardar contraseña"; }
  });
}
function reopen(from, practiced) {
  if (from?.kind === "prep" && window.Prep) { leave(); Prep.afterSim(); return; }
  if (from?.kind !== "lesson") { home(); return; }
  openLesson(from.id, 6).then(() => { if (practiced && LS?.row?.id === from.id) saveProgress({ paso: 6, conversada: true }); });
}
document.addEventListener("DOMContentLoaded", () => {
  on("studyBack", () => { if (onBack) { const f = onBack; f(); } else home(); });
  on("testBtn", testIntro);
  on("videoBtn", () => videoHome());
  on("progressBtn", progress);
  on("reminderBtn", reminderScreen);
  on("newSceneBtn", sceneHome);
  on("goalsBtn", goalsScreen);
  on("passBtn", () => passwordScreen(false));
});
// Abrir una lección desde una notificación (app ya abierta → mensaje del SW; app cerrada → ?leccion=id)
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (!e.data?.abrirLeccion) return;
  // Con una conversación abierta no se interrumpe: el micrófono seguiría activo detrás de la lección
  if (!document.getElementById("talk").hidden) { Sala.notice("Tu lección está lista. Ábrela en «Aprender con un video» cuando termines esta práctica.", "info"); return; }
  openLesson(e.data.abrirLeccion);
});
window.Estudio = { password: passwordScreen, open: openLesson, goals: goalsScreen, syncPerfil, goalsSummary, reopen, test: testIntro, video: videoHome, progress, scene: sceneHome, borrarEscena: deleteScene, _parsePasted: parsePasted, _eap: eap, _update: updatePost, _prior: prior, _levelOf: levelOf, _screen: screen, _body: body, _on: on, _err: err, _recognize: recognize, _say: sayEN, _scores: scoresHTML, _words: wordsHTML };
})();
