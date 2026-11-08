/* Repaso del cuaderno con recuperación activa:
   1) ves lo que dijiste mal y el contexto, 2) lo dices bien en voz alta (o lo escribes),
   3) la app compara, te muestra y te lee la forma correcta, 4) calificas y FSRS agenda el próximo repaso. */
(() => {
"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SDK = window.SpeechSDK;
const RATING = { 1: "Otra vez", 2: "Difícil", 3: "Bien", 4: "Fácil" };

let queue = [], current = null, phase = "ask", heard = "", sim = null, rec = null, done = 0;
let listenGen = 0, listenTimer = null, voiceMsg = "";   // listenGen invalida una escucha en curso al salir o avanzar

function fmtWhen(d) {
  const ms = new Date(d) - Date.now();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const days = Math.round(h / 24);
  if (days < 31) return `${days} d`;
  const months = Math.round(days / 30);
  return `${months} ${months === 1 ? "mes" : "meses"}`;
}
const enCuanto = (d) => (new Date(d) <= Date.now() ? "ahora" : `en ${fmtWhen(d)}`);

// Similitud por palabras en orden (distancia de edición sobre palabras), 0..1
const words = (s) => s.toLowerCase().replace(/[‘’]/g, "'").match(/[a-z0-9']+/g) || [];   // el teclado del iPhone escribe ’
function wordSim(a, b) {
  const A = words(a), B = words(b);
  if (!A.length || !B.length) return 0;
  const d = Array.from({ length: A.length + 1 }, (_, i) => [i, ...Array(B.length).fill(0)]);
  for (let j = 1; j <= B.length; j++) d[0][j] = j;
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
  return Math.max(0, 1 - d[A.length][B.length] / Math.max(A.length, B.length));
}
// Sin intento que comparar no se sugiere ninguna calificación (0 no coincide con ningún botón)
function suggest(s) { return s == null ? 0 : s >= 0.95 ? 4 : s >= 0.8 ? 3 : s >= 0.6 ? 2 : 1; }

function open() {
  queue = Datos.due();
  done = 0;
  Sala.show("review");
  next();
}

function next() {
  stopRec();
  Sala.stopAudio();   // que la frase anterior no siga sonando ni la capte el micrófono
  current = queue.shift() || null;
  phase = "ask"; heard = ""; sim = null; voiceMsg = "";
  render();
}

function render() {
  const left = queue.length + (current ? 1 : 0);
  $("#reviewCount").textContent = current ? `${left} por repasar · ${done} ${done === 1 ? "hecha" : "hechas"}` : `${done} ${done === 1 ? "repasada" : "repasadas"}`;
  const box = $("#reviewCard");
  if (!current) {
    const all = Datos.all();
    const nextDue = all.map((c) => new Date(c.due)).sort((a, b) => a - b)[0];
    const soon = nextDue && nextDue - Date.now() < 3600_000;   // las de «Otra vez» vuelven en minutos
    box.innerHTML = `<div class="empty">
      <p><strong>${done ? (soon ? "¡Listo por ahora!" : "¡Listo por hoy!") : "No tienes frases pendientes."}</strong></p>
      <p class="muted">${all.length ? `Tienes ${all.length} ${all.length === 1 ? "frase" : "frases"} en el cuaderno.${nextDue ? ` El próximo repaso es ${enCuanto(nextDue)}.` : ""}` : "Cada corrección de tus conversaciones se guarda aquí para repasarla."}</p>
    </div>`;
    renderList();
    return;
  }
  const c = current;
  let h = `<div class="rc-meta">${esc(c.escena || "Conversación")}${c.reps ? ` · repasada ${c.reps} ${c.reps === 1 ? "vez" : "veces"}` : " · nueva"}</div>`;
  if (c.contexto) h += `<div class="rc-ctx"><b>El personaje dijo</b><span>${esc(c.contexto)}</span></div>`;
  if (c.dijiste) h += `<div class="rc-ctx"><b>Tú dijiste</b><span class="del">${esc(c.dijiste)}</span></div>`;
  if (phase === "ask") {
    h += `<p class="rc-q">${c.dijiste ? "¿Cómo se dice bien? Dilo en voz alta." : "Di la expresión en voz alta."}</p>
      ${voiceMsg ? `<div class="notice" role="alert">${esc(voiceMsg)}</div>` : ""}
      <div class="rc-actions">
        <button class="primary big" id="rcSpeak">${IC.mic}Decirlo</button>
        <button class="ghost" id="rcShow">Mostrar respuesta</button>
      </div>
      <form id="rcType" class="row2"><input id="rcTypeBox" placeholder="…o escríbelo" autocomplete="off" aria-label="Escribir la respuesta"><button class="ghost">OK</button></form>`;
  } else if (phase === "listening") {
    h += `<p class="rc-q listening">Te escucho…</p><div class="live">${esc(heard)}</div>
      <div class="rc-actions"><button class="ghost" id="rcStop">Listo</button></div>`;
  } else {
    const s = suggest(sim);
    h += heard ? `<div class="rc-ctx"><b>Ahora dijiste</b><span>${esc(heard)}</span>${sim != null ? ` <em class="sim">${Math.round(sim * 100)} % igual</em>` : ""}</div>` : "";
    h += `<div class="proof"><div class="row"><b>Correcto</b><span class="ins">${esc(c.correcta)}</span></div>`;
    if (c.nativo) h += `<div class="row"><b>Nativo</b><span class="alt">${esc(c.nativo)}</span></div>`;
    if (c.tip) h += `<div class="tip">${esc(c.tip)}</div>`;
    h += `<button class="replay" id="rcListen">${IC.play}Escuchar</button></div>`;
    const prev = Datos.preview(c);
    h += `<p class="rc-q small">¿Qué tan bien te salió?</p><div class="rates">` +
      [1, 2, 3, 4].map((r) => `<button class="rate ${r === s ? "sug" : ""}" data-r="${r}"><span>${RATING[r]}</span><small>${fmtWhen(prev[r])}</small></button>`).join("") +
      `</div><button class="linklike" id="rcArchive">Ya no la necesito: quitar del cuaderno</button>`;
  }
  box.innerHTML = h;
  wire();
  renderList();
}

function wire() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on("rcSpeak", listen);
  on("rcShow", () => reveal(""));
  on("rcStop", () => { if (rec) rec.stopContinuousRecognitionAsync(() => {}, () => {}); });
  on("rcListen", () => Sala.speakEN(current.correcta));
  on("rcArchive", () => { Datos.archive(current); next(); });
  const f = document.getElementById("rcType");
  if (f) f.onsubmit = (e) => { e.preventDefault(); const t = $("#rcTypeBox").value.trim(); if (t) reveal(t); };
  for (const b of document.querySelectorAll(".rate")) b.onclick = () => { Datos.review(current, Number(b.dataset.r), { dicho: heard || null, similitud: sim }); done++; next(); };
}

async function listen() {
  const gen = ++listenGen;
  try { await Sala.ensureVoice(); } catch {
    if (gen === listenGen) { voiceMsg = "No se pudo conectar con la voz. Escribe tu respuesta."; render(); }
    return;
  }
  if (gen !== listenGen) return;   // mientras cargaba la voz, saliste o ya viste la respuesta
  voiceMsg = "";
  const az = Sala.azure();
  const cfg = SDK.SpeechConfig.fromAuthorizationToken(az.token, az.region);
  cfg.speechRecognitionLanguage = "en-US";
  cfg.setProperty(SDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, "1200");
  rec = new SDK.SpeechRecognizer(cfg, SDK.AudioConfig.fromDefaultMicrophoneInput());
  const parts = [];
  phase = "listening"; heard = ""; render();
  let ended = false;
  const said = () => parts.join(" ").trim() || heard.trim();
  const finish = () => { if (ended || gen !== listenGen) return; ended = true; const t = said(); stopRec(); reveal(t); };
  // Si falla el micrófono o la conexión no se revela la respuesta: se puede intentar otra vez o escribirla
  const fail = () => {
    if (ended || gen !== listenGen) return;
    ended = true;
    const t = said();
    stopRec();
    if (t) { reveal(t); return; }
    phase = "ask"; heard = ""; voiceMsg = "No se pudo activar la voz. Revisa el permiso del micrófono o escribe tu respuesta.";
    render();
  };
  rec.recognizing = (_s, e) => { if (ended || gen !== listenGen) return; heard = [...parts, e.result.text].join(" "); const l = document.querySelector("#reviewCard .live"); if (l) l.textContent = heard; };
  rec.recognized = (_s, e) => { if (gen === listenGen && e.result.reason === SDK.ResultReason.RecognizedSpeech && e.result.text) { parts.push(e.result.text); finish(); } };
  rec.canceled = (_s, e) => { if (e.reason === SDK.CancellationReason.Error) fail(); else finish(); };
  rec.sessionStopped = () => finish();
  rec.startContinuousRecognitionAsync(() => {}, () => fail());
  listenTimer = setTimeout(finish, 15000); // tope por si no se detecta voz
}
function stopRec() {
  listenGen++;   // lo que siga llegando de esta escucha ya no cuenta
  clearTimeout(listenTimer);
  if (!rec) return;
  const r = rec; rec = null;
  try { r.stopContinuousRecognitionAsync(() => r.close(), () => r.close()); } catch {}
}

function reveal(said) {
  listenGen++;   // una escucha que aún estaba cargando no debe abrir el micrófono después
  heard = said;
  sim = said ? wordSim(said, current.correcta) : null;
  if (said && current.nativo) sim = Math.max(sim, wordSim(said, current.nativo));
  phase = "answer";
  render();
  Sala.speakEN(current.correcta).catch(() => {});
}

function renderList() {
  const det = $("#reviewAll");
  const all = Datos.all().slice().sort((a, b) => new Date(a.due) - new Date(b.due));
  det.querySelector("summary").textContent = `Ver todo el cuaderno (${all.length})`;
  det.querySelector(".list").innerHTML = all.map((c) => `
    <div class="li"><span class="ins">${esc(c.correcta)}</span>
    ${c.dijiste ? `<span class="del small">${esc(c.dijiste)}</span>` : ""}
    <span class="meta">${c.escena ? `${esc(c.escena)} · ` : ""}próximo repaso ${enCuanto(c.due)}</span></div>`).join("") || `<p class="muted">Vacío.</p>`;
}

document.addEventListener("DOMContentLoaded", () => {
  const back = $("#reviewBack");
  if (back) back.onclick = () => { stopRec(); Sala.stopAudio(); Sala.backHome(); };
});
window.Repaso = { open, _wordSim: wordSim };
})();
