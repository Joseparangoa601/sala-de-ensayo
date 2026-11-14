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
let pron = [], sonidos = "";
/* Tu toma, para compararla con el modelo: solo en la memoria de esta tarjeta; se borra al pasar a otra o salir */
let toma = null, tomaAudio = null;
function pararToma() { try { tomaAudio?.pause(); } catch {} tomaAudio = null; }
function soltarToma() { pararToma(); if (toma) { try { URL.revokeObjectURL(toma); } catch {} toma = null; } }
const yoBtn = () => (toma ? `<button class="replay" id="rcYo" aria-label="Escuchar cómo lo dijiste">${IC.play}Cómo lo dijiste</button>` : "");   // pronunciación por sonido del último intento hablado y su recuadro
let distinta = false;   // lo dicho no se parece a la frase de la tarjeta
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
// «I'm» y «I am», «20%» y «20 percent», «$500» y «five hundred dollars», «OK» y «okay» cuentan igual (auditoría 14-nov:
// antes «I'm» contra «I am» bajaba la nota y «I do not» contra «I don't» marcaba «Se repitió el error»).
const CONTRA = { "n't": ["not"], "'m": ["am"], "'re": ["are"], "'ve": ["have"], "'ll": ["will"], "'d": ["would"], "'s": ["is"] };
const RAIZ = { ca: "can", wo: "will", sha: "shall", ai: "am" };
const SINON = { ok: "okay", dollar: "dollars", percentage: "percent", pct: "percent" };
const PARTIR = { cannot: ["can", "not"], gonna: ["going", "to"], wanna: ["want", "to"] };
function partes(raw) {
  if (raw === "let's") return ["let", "us"];
  const m = raw.match(/^(.+?)(n't|'m|'re|'ve|'ll|'d|'s)$/);
  if (!m) { const r = raw.replace(/'/g, ""); return PARTIR[r] ?? [r]; }
  const base = m[2] === "n't" ? (RAIZ[m[1]] ?? m[1]) : m[1];
  return [base, ...CONTRA[m[2]]];
}
function tokens(s) {
  const out = [];
  const txt = s.replace(/[‘’]/g, "'").toLowerCase().replace(/per cent/g, "percent");
  for (const m of txt.matchAll(/\$?(?:[a-z](?:\.[a-z])+\.?|[a-z0-9',]*[a-z0-9]'?[a-z]*)%?/g)) {
    let raw = m[0].replace(/\./g, "");
    const dolar = raw.startsWith("$"), pct = raw.endsWith("%");
    raw = raw.replace(/^\$|%$/g, "");
    if (/^\d{1,3}(,\d{3})+$/.test(raw)) raw = raw.replace(/,/g, "");   // 1,500 → 1500
    raw = raw.replace(/,/g, "");
    for (let w of partes(raw)) {
      w = SINON[w] ?? w;
      const ord = w.match(/^(\d+)(?:st|nd|rd|th)$/);
      const n = ord ? Number(ord[1]) : /^\d+$/.test(w) ? Number(w) : NUM.get(w);
      const prev = out[out.length - 1];
      // «twenty-one», «five hundred», «two thousand five hundred and twenty» son un solo número
      const pon = (t) => { t.n = t.tot + t.cur; t.w = String(t.n); };
      if (prev?.nw) {
        if (w === "hundred") { prev.cur = (prev.cur || 1) * 100; pon(prev); continue; }
        if (w === "thousand") { prev.tot += (prev.cur || 1) * 1000; prev.cur = 0; pon(prev); continue; }
        if (w === "and" && prev.cur % 100 === 0) continue;
        const c = prev.cur;
        if (NUM.has(w) && !ord && (c === 0 || (c % 100 === 0 && n < 100) || (c % 10 === 0 && c % 100 !== 0 && n < 10))) { prev.cur += n; pon(prev); continue; }
      }
      if (NUM.has(w) && !ord && !/(th|st|nd|rd)$/.test(w) && w !== "second") { out.push({ w: String(n), i: m.index, n, nw: true, tot: 0, cur: n }); continue; }
      out.push({ w: n != null ? String(n) : w, i: m.index, n });
    }
    if (pct) out.push({ w: "percent", i: m.index });
    if (dolar) out.push({ w: "dollars", i: m.index });
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
  // Se cuenta cuántas veces aparece cada palabra: «that» bien usado en otra parte de la frase no es repetir el error
  const cuenta = (arr) => arr.reduce((m, w) => m.set(w, (m.get(w) || 0) + 1), new Map());
  const D = cuenta(words(said)), C = cuenta(words(c.correcta));
  const falto = [...new Set(faltan)].filter((w) => (D.get(w) || 0) < (C.get(w) || 0));
  const repitio = [...new Set(sobran)].filter((w) => (D.get(w) || 0) > (C.get(w) || 0));
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
    // Las frases nuevas que pasan del cupo diario no están listas hoy: entran a la medianoche (antes decía «en 1 min»)
    const dueIds = new Set(Datos.due().map((c) => c.id)), ahora = new Date();
    const manana = new Date(ahora); manana.setHours(24, 0, 0, 0);
    const nextDue = all.map((c) => (new Date(c.due) > ahora ? new Date(c.due) : dueIds.has(c.id) ? ahora : manana)).sort((a, b) => a - b)[0];
    const soon = nextDue && nextDue - Date.now() < 3600_000;   // las de «Otra vez» vuelven en minutos
    const due = dueIds.size;
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
  const elegida = c.origen === "manual";   // frase que la persona eligió del texto de un video
  let h = `<div class="rc-meta">${elegida ? `<span class="chip-elegida">Frase elegida</span>` : ""}${esc(c.escena || "Conversación")}${c.reps ? ` · repasada ${c.reps} ${c.reps === 1 ? "vez" : "veces"}` : " · nueva"}</div>`;
  if (c.contexto) h += `<div class="rc-ctx"><b>El personaje dijo</b><span>${esc(c.contexto)}</span>${phase === "listening" ? "" : oirBtns(c.contexto)}</div>`;
  const natural = c.origen === "natural";   // la frase estaba bien: se muestra sin tachar y se practica la versión natural
  if (c.dijiste) h += `<div class="rc-ctx"><b>${natural ? "Tu frase estaba bien" : "Tú dijiste"}</b><span class="${natural ? "" : "del"}">${esc(c.dijiste)}</span></div>`;
  if (phase === "ask" && elegida) {
    // Sin error que corregir: la pista es lo que quiere decir (si se tradujo) o la frase misma para imitarla
    h += c.tip ? `<div class="rc-ctx"><b>Qué quiere decir</b><span lang="es">${esc(c.tip)}</span></div><p class="rc-q">¿Cómo lo dicen en el video? Dilo en voz alta.</p>`
      : `<div class="rc-ctx"><b>Escúchala</b>${oirBtns(c.correcta)}</div><p class="rc-q">Dila igual, con el mismo ritmo.</p>`;
    h += `${voiceMsg ? `<div class="notice" role="alert">${esc(voiceMsg)}</div>` : ""}
      <div class="rc-actions">
        <button class="primary big" id="rcSpeak">${IC.mic}Decirlo</button>
        <button class="ghost" id="rcShow">Mostrar respuesta</button>
      </div>
      <form id="rcType" class="row2"><input id="rcTypeBox" placeholder="…o escríbelo" autocomplete="off" aria-label="Escribir la respuesta"><button class="ghost">OK</button></form>`;
  } else if (phase === "ask") {
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
    h += `<div class="rc-ctx"><b>Ahora dijiste</b><span>${esc(heard)}</span> <em class="sim">${palabrasDichas()}</em>${sonidos && toma ? `<div class="char-acts">${yoBtn()}<button class="replay" data-oir="${esc(c.correcta)}" data-rate="0%">${IC.play}Cómo se dice</button><button class="replay" data-oir="${esc(c.correcta)}" data-rate="-30%">${IC.play}En lento</button></div>` : ""}</div>
      ${sonidos ? `${sonidos}<p class="rc-q" role="status">Bien dicha. Solo pule ese sonido.</p><div class="rc-actions"><button class="primary big" id="rcNext">Siguiente</button></div>` : `<p class="rc-q" role="status">Bien dicho. Sigue la próxima frase…</p>`}`;
  } else if (phase === "parcial") {
    h += `<div class="rc-ctx"><b>Ahora dijiste</b><span>${esc(heard)}</span> <em class="sim">${palabrasDichas()}</em>${toma ? `<div class="char-acts">${yoBtn()}</div>` : ""}</div>
      <div class="proof"><div class="row"><b>Te faltó</b><span class="ins">${esc(faltante)}</span></div></div>${sonidos}
      <p class="rc-q" role="status">Bien el comienzo. Ahora dila completa.</p>
      ${voiceMsg ? `<div class="notice" role="alert">${esc(voiceMsg)}</div>` : ""}
      <div class="rc-actions">
        <button class="primary big" id="rcSpeak">${IC.mic}Decirla completa</button>
        <button class="ghost" id="rcShow">Mostrar respuesta</button>
      </div>
      <form id="rcType" class="row2"><input id="rcTypeBox" placeholder="…o escríbela" autocomplete="off" aria-label="Escribir la frase completa"><button class="ghost">OK</button></form>`;
  } else {
    const s = repite ? 1 : suggest(sim);   // repetir el error no es «Bien», aunque casi todas las palabras coincidan
    h += heard ? `<div class="rc-ctx"><b>Ahora dijiste</b><span>${esc(heard)}</span>${sim != null ? ` <em class="sim">${palabrasDichas()}</em>` : ""}${toma ? `<div class="char-acts">${yoBtn()}</div>` : ""}</div>${sonidos}` : "";
    if (distinta) h += `<div class="notice" role="status"><b>Eso no se parece a la frase de esta tarjeta.</b> Escúchala abajo y toca «Otra vez» para decirla.</div>`;
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
  on("rcStop", () => { if (rec) rec.parar(); else { stopRec(); phase = "ask"; render(); } });   // aún abría el micrófono: «Listo» cancela
  on("rcListen", () => leerTarjeta(current));
  for (const b of document.querySelectorAll("[data-oir]")) b.onclick = () => { pararToma(); Sala.stopAudio(); Sala.speakEN(b.dataset.oir, { rate: b.dataset.rate }).catch(() => {}); };
  on("rcYo", () => { if (!toma) return; Sala.stopAudio(); pararToma(); tomaAudio = new Audio(toma); tomaAudio.play().catch(() => {}); });
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
  Sala.stopAudio(); pararToma();   // la voz de la app sonando no debe entrar como tu intento
  try { await Sala.ensureVoice(); } catch (e) {
    if (gen === listenGen) {
      // Sin voz se vuelve a preguntar con el aviso a la vista: antes el intento anterior se quedaba en pantalla y parecía trabado
      phase = "ask"; heard = ""; soltarToma();
      voiceMsg = e?.code === "sin_horas"
        ? (e.motivo === "inactivo" ? "Tu pase ya no está activo" : "Tu pase de 30 días ya venció") + ", así que la voz del repaso se apagó. Puedes seguir escribiendo tus respuestas."
        : "No se pudo conectar con la voz. Escribe tu respuesta o intenta de nuevo en un momento.";
      render();
    }
    return;
  }
  if (gen !== listenGen) return;   // mientras cargaba la voz, saliste o ya viste la respuesta
  voiceMsg = "";
  phase = "listening"; heard = ""; render();
  const nMeta = words(current?.correcta || "").length;
  let oido;
  try {
    soltarToma();
    oido = await Sala.escucharUnaVez((t) => { if (gen !== listenGen) return; heard = t; const l = document.querySelector("#reviewCard .live"); if (l) l.textContent = t; }, { pron: true, grabar: true, minPalabras: nMeta > 12 ? Math.ceil(nMeta * 0.7) : 0 });
  } catch {
    if (gen === listenGen) { phase = "ask"; heard = ""; voiceMsg = "No se pudo activar la voz. Revisa el permiso del micrófono o escribe tu respuesta."; render(); }
    return;
  }
  if (gen !== listenGen) { oido.cancelar(); return; }
  rec = oido;
  listenTimer = setTimeout(() => oido.parar(), Math.max(15000, 6000 + nMeta * 700));   // tope por si no se detecta voz; las frases largas tienen más tiempo
  const t = await oido.promesa;
  if (gen !== listenGen) return;
  clearTimeout(listenTimer); rec = null;
  pron = oido.palabras();
  // No te oyó (micrófono en silencio, «Listo» antes de hablar, voz caída): se dice, no se salta a la respuesta
  if (!(t || heard).trim()) { phase = "ask"; heard = ""; voiceMsg = "No te escuché. Toca Decirlo y habla cerca del micrófono, o escribe tu respuesta."; render(); return; }
  const g = (t || heard).trim() ? oido.grabacion?.() : null;
  if (g) toma = URL.createObjectURL(g);
  reveal((t || heard).trim(), true);
}
function stopRec() {
  soltarToma();
  listenGen++;   // lo que siga llegando de esta escucha ya no cuenta
  clearTimeout(listenTimer);
  if (!rec) return;
  const r = rec; rec = null;
  r.cancelar();
}
const leerTarjeta = (c) => c.origen === "manual" ? Sala.speakEN(c.correcta) : Sala.leerCorreccion(c.origen === "natural"
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
  if (!hablado) { pron = []; soltarToma(); }   // escrito o «Mostrar respuesta»: ni sonidos que evaluar ni grabación de antes
  sonidos = window.Estudio?._sonidos?.(pron) || "";
  sim = said ? wordSim(said, current.correcta) : null;
  if (said && current.nativo) sim = Math.max(sim, wordSim(said, current.nativo));
  // Solo se busca el error repetido si lo dicho se parece a la frase: con otra frase marcaba «Se repitió el error» sin razón
  const parecida = sim != null && sim >= 0.5;
  repite = parecida ? errorRepetido(said, current) : null;
  if (sim != null && sim >= 0.95 && !repite) return acierto();
  const falta = said ? faltaFinal(said, current.nativo) || faltaFinal(said, current.correcta) : null;
  if (falta) { faltante = falta; ayudada = true; phase = "parcial"; render(); return; }   // no se equivocó: no hay «Mejor di» que leerle
  distinta = !!said && !parecida;
  phase = "answer";
  render();
  leerTarjeta(current).catch(() => {});
}

function renderList() {
  const det = $("#reviewAll");
  const todas = Datos.all().slice().sort((a, b) => new Date(a.due) - new Date(b.due));
  const nEl = todas.filter((c) => c.origen === "manual").length;
  if (!nEl) filtro = "todas";
  const all = filtro === "elegidas" ? todas.filter((c) => c.origen === "manual") : todas;
  const listas = new Set(Datos.due().map((c) => c.id));
  det.querySelector("summary").textContent = `Ver todo el cuaderno (${todas.length})`;
  det.querySelector(".list").innerHTML = (nEl ? `<div class="chips" role="group" aria-label="Filtrar el cuaderno">
      <button class="chip ${filtro === "todas" ? "on" : ""}" data-filtro="todas" aria-pressed="${filtro === "todas"}">Todas (${todas.length})</button>
      <button class="chip ${filtro === "elegidas" ? "on" : ""}" data-filtro="elegidas" aria-pressed="${filtro === "elegidas"}">Elegidas por ti (${nEl})</button></div>` : "") + all.map((c) => `
    <div class="li"><span class="ins">${c.origen === "manual" ? `<span class="chip-elegida">Frase elegida</span>` : ""}${esc(c.correcta)}</span>
    ${c.dijiste ? `<span class="${c.origen === "natural" ? "" : "del "}small">${esc(c.dijiste)}</span>` : ""}
    <span class="meta">${c.escena ? `${esc(c.escena)} · ` : ""}${new Date(c.due) <= Date.now() ? (listas.has(c.id) ? "lista para repasar" : "nueva: entra mañana") : `próximo repaso ${enCuanto(c.due)}`}</span></div>`).join("") || `<p class="muted">Vacío.</p>`;
  for (const b of det.querySelectorAll("[data-filtro]")) b.onclick = () => { filtro = b.dataset.filtro; renderList(); };
}
let filtro = "todas";

document.addEventListener("DOMContentLoaded", () => {
  const back = $("#reviewBack");
  if (back) back.onclick = () => { stopRec(); Sala.stopAudio(); Sala.backHome(); };
});
window.Repaso = { open, _wordSim: wordSim, _faltaFinal: faltaFinal, _errorRepetido: errorRepetido };
})();
