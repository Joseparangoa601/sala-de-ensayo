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
let repetida = null;   // tarjeta que ya se marcó «Otra vez» en esta vuelta
let faltante = "", ayudada = false;   // lo que le faltó decir, y si ya vio ese final en esta vuelta
let listenGen = 0, listenTimer = null, voiceMsg = "";   // listenGen invalida una escucha en curso al salir o avanzar
let pron = [], sonidos = "";   // pronunciación por sonido del último intento hablado y su recuadro
let repite = null;   // si el intento volvió a decir el error que corrige la tarjeta: { falto, repitio }

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
// El reconocimiento escribe «10», «3rd» o «US» aunque la tarjeta diga «ten», «3» o «U.S.»: no es un error de quien habla.
const NUM = new Map();
"zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ").forEach((w, i) => NUM.set(w, i));
"first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth".split(" ").forEach((w, i) => NUM.set(w, i + 1));
"twenty thirty forty fifty sixty seventy eighty ninety".split(" ").forEach((w, i) => { NUM.set(w, (i + 2) * 10); NUM.set(w.replace(/y$/, "ieth"), (i + 2) * 10); });
// Palabras normalizadas con su posición en el texto original. El teclado del iPhone escribe ’
function tokens(s) {
  const out = [];
  for (const m of s.replace(/[‘’]/g, "'").toLowerCase().matchAll(/[a-z](?:\.[a-z])+\.?|[a-z0-9']+/g)) {
    const raw = m[0].replace(/\./g, "");
    const ord = raw.match(/^(\d+)(?:st|nd|rd|th)$/);
    const n = ord ? Number(ord[1]) : /^\d+$/.test(raw) ? Number(raw) : NUM.get(raw);
    const prev = out[out.length - 1];
    // «twenty-one» o «thirty first» son un solo número
    if (NUM.has(raw) && n > 0 && n < 10 && prev?.n >= 20 && prev.n < 100 && prev.n % 10 === 0) { prev.n += n; prev.w = String(prev.n); continue; }
    out.push({ w: n != null ? String(n) : raw, i: m.index, n });
  }
  return out;
}
const words = (s) => tokens(s).map((t) => t.w);
function wordSim(a, b) {
  const A = words(a), B = words(b);
  if (!A.length || !B.length) return 0;
  const d = Array.from({ length: A.length + 1 }, (_, i) => [i, ...Array(B.length).fill(0)]);
  for (let j = 1; j <= B.length; j++) d[0][j] = j;
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
  return Math.max(0, 1 - d[A.length][B.length] / Math.max(A.length, B.length));
}
// Si lo dicho es el comienzo exacto de la frase (3 palabras o más), devuelve lo que faltó.
function faltaFinal(said, target) {
  if (!target) return null;
  const dicho = words(said), meta = tokens(target);
  if (dicho.length < 3 || dicho.length >= meta.length || dicho.some((w, i) => w !== meta[i].w)) return null;
  return target.slice(meta[dicho.length].i);
}
// Las palabras que cambió la corrección: «sobran» (lo dicho mal) y «faltan» (lo que la corrección puso), por subsecuencia común.
function cambios(dijiste, correcta) {
  const A = words(dijiste), B = words(correcta);
  const L = Array.from({ length: A.length + 1 }, () => Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const sobran = [], faltan = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) sobran.push(A[i++]);
    else faltan.push(B[j++]);
  }
  sobran.push(...A.slice(i)); faltan.push(...B.slice(j));
  return { sobran: sobran.filter((w) => !B.includes(w)), faltan };
}
// ¿Repitió el error que la tarjeta corrige? Falta una palabra que puso la corrección o volvió a decir la que sobraba.
// Si lo dicho se parece más a la versión nativa, se juzga por esa versión y no se aplica.
function errorRepetido(said, c) {
  if (!said || !c.dijiste || c.origen === "natural") return null;
  if (c.nativo && wordSim(said, c.nativo) > wordSim(said, c.correcta)) return null;
  const { sobran, faltan } = cambios(c.dijiste, c.correcta);
  if (!sobran.length && !faltan.length) return null;
  const S = new Set(words(said));
  const falto = faltan.filter((w) => !S.has(w)), repitio = sobran.filter((w) => S.has(w));
  return falto.length || repitio.length ? { falto, repitio } : null;
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
  repetida = null; ayudada = false; faltante = ""; repite = null;
  phase = "ask"; heard = ""; sim = null; voiceMsg = ""; pron = []; sonidos = "";
  render();
}

// Cuántas palabras coinciden con la versión más cercana. Compara palabras, no pronunciación.
function palabrasDichas() {
  const t = [current.correcta, current.nativo].filter(Boolean).reduce((a, b) => (wordSim(heard, b) > wordSim(heard, a) ? b : a));
  const max = Math.max(words(heard).length, words(t).length);
  return `${Math.round(sim * max)} de ${max} palabras`;
}

// Oír una frase suelta, normal o más despacio
const oirBtns = (t) => `<div class="char-acts"><button class="replay" data-oir="${esc(t)}" data-rate="0%" aria-label="Repetir esta frase">${IC.play}Repetir</button><button class="replay" data-oir="${esc(t)}" data-rate="-15%" aria-label="Repetir esta frase más lento">${IC.play}Lento</button></div>`;

function render() {
  const left = queue.length + (current ? 1 : 0);
  $("#reviewCount").textContent = current ? `${left} por repasar · ${done} ${done === 1 ? "hecha" : "hechas"}` : `${done} ${done === 1 ? "repasada" : "repasadas"}`;
  const box = $("#reviewCard");
  if (!current) {
    const all = Datos.all();
    const nextDue = all.map((c) => new Date(c.due)).sort((a, b) => a - b)[0];
    const soon = nextDue && nextDue - Date.now() < 3600_000;   // las de «Otra vez» vuelven en minutos
    const due = Datos.due().length;
    const titulo = done ? (soon ? "Listo por ahora" : "Listo por hoy") : "No tienes frases pendientes";
    const detalle = !all.length ? "Cada corrección de tus conversaciones se guarda aquí para repasarla."
      : due ? `${due === 1 ? "Tienes 1 frase lista" : `Tienes ${due} frases listas`} para repasar otra vez.`
      : `Tu próximo repaso es en ${fmtWhen(nextDue)}.`;
    box.innerHTML = `<div class="donecard">
      ${done ? `<span class="donemark" aria-hidden="true">✓</span>` : ""}
      <h2>${titulo}</h2>
      <p class="muted">${detalle}</p>
      ${due ? `<button class="primary wide" id="rcAgain">Repasar ${due === 1 ? "esa frase" : `esas ${due} frases`}</button>` : ""}
      <button class="ghost wide" id="rcHome">Volver a Hoy</button>
    </div>`;
    wire();
    renderList();
    return;
  }
  const c = current;
  let h = `<div class="rc-meta">${esc(c.escena || "Conversación")}${c.reps ? ` · repasada ${c.reps} ${c.reps === 1 ? "vez" : "veces"}` : " · nueva"}</div>`;
  if (c.contexto) h += `<div class="rc-ctx"><b>El personaje dijo</b><span>${esc(c.contexto)}</span>${phase === "listening" ? "" : oirBtns(c.contexto)}</div>`;
  const natural = c.origen === "natural";   // la frase estaba bien: se muestra sin tachar y se practica la versión natural
  if (c.dijiste) h += `<div class="rc-ctx"><b>${natural ? "Tu frase estaba bien" : "Tú dijiste"}</b><span class="${natural ? "" : "del"}">${esc(c.dijiste)}</span></div>`;
  if (phase === "ask") {
    h += `<p class="rc-q">${natural ? "¿Cómo lo diría un nativo? Dilo en voz alta." : c.dijiste ? "¿Cómo se dice bien? Dilo en voz alta." : "Di la expresión en voz alta."}</p>
      ${voiceMsg ? `<div class="notice" role="alert">${esc(voiceMsg)}</div>` : ""}
      <div class="rc-actions">
        <button class="primary big" id="rcSpeak">${IC.mic}Decirlo</button>
        <button class="ghost" id="rcShow">Mostrar respuesta</button>
      </div>
      <form id="rcType" class="row2"><input id="rcTypeBox" placeholder="…o escríbelo" autocomplete="off" aria-label="Escribir la respuesta"><button class="ghost">OK</button></form>`;
  } else if (phase === "listening") {
    h += `<p class="rc-q listening">Te escucho…</p><div class="live">${esc(heard)}</div>
      <div class="rc-actions"><button class="ghost" id="rcStop">Listo</button></div>`;
  } else if (phase === "ok") {
    h += `<div class="rc-ctx"><b>Ahora dijiste</b><span>${esc(heard)}</span> <em class="sim">${palabrasDichas()}</em></div>
      ${sonidos ? `${sonidos}<p class="rc-q" role="status">Bien dicha. Solo pule ese sonido.</p><div class="rc-actions"><button class="primary big" id="rcNext">Siguiente</button></div>` : `<p class="rc-q" role="status">Bien dicho. Sigue la próxima frase…</p>`}`;
  } else if (phase === "parcial") {
    h += `<div class="rc-ctx"><b>Ahora dijiste</b><span>${esc(heard)}</span> <em class="sim">${palabrasDichas()}</em></div>
      <div class="proof"><div class="row"><b>Te faltó</b><span class="ins">${esc(faltante)}</span></div></div>${sonidos}
      <p class="rc-q" role="status">Bien el comienzo. Ahora dila completa.</p>
      <div class="rc-actions">
        <button class="primary big" id="rcSpeak">${IC.mic}Decirla completa</button>
        <button class="ghost" id="rcShow">Mostrar respuesta</button>
      </div>
      <form id="rcType" class="row2"><input id="rcTypeBox" placeholder="…o escríbela" autocomplete="off" aria-label="Escribir la frase completa"><button class="ghost">OK</button></form>`;
  } else {
    const s = repite ? 1 : suggest(sim);   // repetir el error no es «Bien», aunque casi todas las palabras coincidan
    h += heard ? `<div class="rc-ctx"><b>Ahora dijiste</b><span>${esc(heard)}</span>${sim != null ? ` <em class="sim">${palabrasDichas()}</em>` : ""}</div>${sonidos}` : "";
    if (repite) h += `<div class="notice" data-kind="warn" role="status"><b>Se repitió el error.</b> ${[
      repite.repitio.length ? `Volviste a decir «${esc(repite.repitio.join(" "))}».` : "",
      repite.falto.length ? `Faltó «${esc(repite.falto.join(" "))}».` : "",
    ].filter(Boolean).join(" ")}</div>`;
    h += `<div class="proof"><div class="row"><b>${natural ? "Nativo" : "Correcto"}</b><span class="${natural ? "alt" : "ins"}">${esc(c.correcta)}</span></div>${oirBtns(c.correcta)}`;
    if (c.nativo) h += `<div class="row"><b>Nativo</b><span class="alt">${esc(c.nativo)}</span></div>${oirBtns(c.nativo)}`;
    if (c.tip) h += `<div class="tip">${esc(c.tip)}</div>`;
    h += `<button class="replay" id="rcListen">${IC.play}Escuchar</button></div>`;
    const prev = Datos.preview(c);
    h += `<p class="rc-q small">¿Qué tan bien te salió?</p><p class="muted small" style="margin-top:-8px">Elige cómo te salió; el tiempo indica cuándo vuelve esta frase.</p><div class="rates">` +
      [1, 2, 3, 4].map((r) => `<button class="rate ${r === s ? "sug" : ""}" data-r="${r}"><span>${RATING[r]}</span><small>${fmtWhen(prev[r])}</small></button>`).join("") +
      `</div><button class="linklike" id="rcArchive">Ya no la necesito: quitar del cuaderno</button>`;
  }
  box.innerHTML = h;
  wire();
  renderList();
}

function wire() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on("rcAgain", open);
  on("rcHome", () => Sala.backHome());
  on("rcSpeak", listen);
  on("rcNext", () => next());
  on("rcShow", () => reveal(""));
  on("rcStop", () => { if (rec) rec.parar(); });
  on("rcListen", () => leerTarjeta(current));
  for (const b of document.querySelectorAll("[data-oir]")) b.onclick = () => { Sala.stopAudio(); Sala.speakEN(b.dataset.oir, { rate: b.dataset.rate }).catch(() => {}); };
  on("rcArchive", () => { Datos.archive(current); next(); });
  const f = document.getElementById("rcType");
  if (f) f.onsubmit = (e) => { e.preventDefault(); const t = $("#rcTypeBox").value.trim(); if (t) reveal(t); };
  for (const b of document.querySelectorAll(".rate")) b.onclick = () => {
    const r = Number(b.dataset.r);
    if (r === 1) return otraVez();
    Datos.review(current, r, { dicho: heard || null, similitud: sim }); done++; next();
  };
}
// «Otra vez» vuelve a la misma frase para decirla de nuevo; repetirla varias veces seguidas cuenta como un solo fallo.
function otraVez() {
  if (repetida !== current.id) Datos.review(current, 1, { dicho: heard || null, similitud: sim });
  repetida = current.id;
  stopRec(); Sala.stopAudio();
  phase = "ask"; heard = ""; sim = null; voiceMsg = ""; repite = null; pron = []; sonidos = "";
  render();
}

async function listen() {
  const gen = ++listenGen;
  try { await Sala.ensureVoice(); } catch {
    if (gen === listenGen) { voiceMsg = "No se pudo conectar con la voz. Escribe tu respuesta."; render(); }
    return;
  }
  if (gen !== listenGen) return;   // mientras cargaba la voz, saliste o ya viste la respuesta
  voiceMsg = "";
  phase = "listening"; heard = ""; render();
  let oido;
  try {
    oido = await Sala.escucharUnaVez((t) => { if (gen !== listenGen) return; heard = t; const l = document.querySelector("#reviewCard .live"); if (l) l.textContent = t; }, { pron: true });
  } catch {
    if (gen === listenGen) { phase = "ask"; heard = ""; voiceMsg = "No se pudo activar la voz. Revisa el permiso del micrófono o escribe tu respuesta."; render(); }
    return;
  }
  if (gen !== listenGen) { oido.cancelar(); return; }
  rec = oido;
  listenTimer = setTimeout(() => oido.parar(), 15000);   // tope por si no se detecta voz
  const t = await oido.promesa;
  if (gen !== listenGen) return;
  clearTimeout(listenTimer); rec = null;
  pron = oido.palabras();
  reveal((t || heard).trim(), true);
}
function stopRec() {
  listenGen++;   // lo que siga llegando de esta escucha ya no cuenta
  clearTimeout(listenTimer);
  if (!rec) return;
  const r = rec; rec = null;
  r.cancelar();
}
const leerTarjeta = (c) => Sala.leerCorreccion(c.origen === "natural"
  ? { ok: true, better: "", natural: c.correcta, tip: c.tip }
  : { ok: false, better: c.correcta, natural: c.nativo && c.nativo !== c.correcta ? c.nativo : "", tip: c.tip });

// Dijo bien la frase: no hay nada que corregirle, se registra y sigue con la próxima.
function acierto() {
  const c = current, gen = listenGen;
  sonidos = window.Estudio?._sonidos?.(pron) || "";
  // Si acaba de ver la respuesta por «Otra vez», acertar no demuestra que la recuerde tanto como para espaciarla mucho.
  Datos.review(c, repetida === c.id || ayudada ? 3 : 4, { dicho: heard, similitud: sim });
  done++;
  phase = "ok";
  render();
  if (sonidos) return;   // con un sonido por pulir no avanza solo: primero lo lees y tocas Siguiente
  setTimeout(() => { if (gen === listenGen && current === c) next(); }, 1500);
}

function reveal(said, hablado = false) {
  listenGen++;   // una escucha que aún estaba cargando no debe abrir el micrófono después
  heard = said;
  if (!hablado) pron = [];   // escrito o «Mostrar respuesta»: no hay sonidos que evaluar
  sonidos = window.Estudio?._sonidos?.(pron) || "";
  sim = said ? wordSim(said, current.correcta) : null;
  if (said && current.nativo) sim = Math.max(sim, wordSim(said, current.nativo));
  repite = errorRepetido(said, current);
  if (sim != null && sim >= 0.95 && !repite) return acierto();
  const falta = said ? faltaFinal(said, current.nativo) || faltaFinal(said, current.correcta) : null;
  if (falta) { faltante = falta; ayudada = true; phase = "parcial"; render(); return; }   // no se equivocó: no hay «Mejor di» que leerle
  phase = "answer";
  render();
  leerTarjeta(current).catch(() => {});
}

function renderList() {
  const det = $("#reviewAll");
  const all = Datos.all().slice().sort((a, b) => new Date(a.due) - new Date(b.due));
  det.querySelector("summary").textContent = `Ver todo el cuaderno (${all.length})`;
  det.querySelector(".list").innerHTML = all.map((c) => `
    <div class="li"><span class="ins">${esc(c.correcta)}</span>
    ${c.dijiste ? `<span class="${c.origen === "natural" ? "" : "del "}small">${esc(c.dijiste)}</span>` : ""}
    <span class="meta">${c.escena ? `${esc(c.escena)} · ` : ""}${new Date(c.due) <= Date.now() ? "lista para repasar" : `próximo repaso ${enCuanto(c.due)}`}</span></div>`).join("") || `<p class="muted">Vacío.</p>`;
}

document.addEventListener("DOMContentLoaded", () => {
  const back = $("#reviewBack");
  if (back) back.onclick = () => { stopRec(); Sala.stopAudio(); Sala.backHome(); };
});
window.Repaso = { open, _wordSim: wordSim, _faltaFinal: faltaFinal, _errorRepetido: errorRepetido };
})();
