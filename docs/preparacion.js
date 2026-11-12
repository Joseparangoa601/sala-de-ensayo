/* Sala de Ensayo · Modo entrevista
   Expediente (hoja de vida, oferta, preguntas, historias), corrección de cómo te vendes,
   simulacro con informe e índice de preparación. Nunca se inventan datos; el audio no se guarda. */
(() => {
"use strict";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const E = () => window.Estudio;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const SIM = "Simulacro de entrevista";
const BACK = "‹ Expediente";
const P = { row: null, intentos: [], sims: [], hist: null };
let run = 0;   // cambia con cada pantalla: lo que llegue tarde no pinta sobre otra

const scr = (title, sub, back, label) => { run++; E()._screen(title, sub, back, label); return run; };
const paint = (h) => E()._body(h);
const on = (id, fn) => E()._on(id, fn);
const sb = () => Sala.sb();
const preguntas = () => P.row?.analisis?.preguntas ?? [];
const historias = () => P.row?.historias ?? [];
const respuestas = (id) => P.intentos.filter((x) => x.tipo === "respuesta" && x.pregunta_id === id);
const mejor = (id) => { const r = respuestas(id); return r.length ? Math.max(...r.map((x) => x.puntaje ?? 0)) : null; };
const completa = (h) => !!(h.situacion?.trim() && h.accion?.trim() && h.resultado?.trim());
/* Avance de cada historia: sus prácticas se guardan con la pregunta h1…h5 */
const deHistoria = (i) => respuestas("h" + (i + 1));
/* En voz alta: respuestas grabadas con el micrófono (marcadas desde v81) + cada respuesta de un simulacro */
const enVoz = (r) => r.filter((x) => x.evaluacion?.en_voz === true).length;
const vecesEnVoz = () => enVoz(P.intentos.filter((x) => x.tipo === "respuesta"))
  + P.intentos.filter((x) => x.tipo === "simulacro").reduce((a, x) => a + (x.evaluacion?.respuestas?.length ?? 0), 0);
const avanceTxt = (r) => (r.length > 1 ? `${r[0].puntaje} → ${r[r.length - 1].puntaje}` : r.length ? `${r[0].puntaje}` : "");
/* Tablero: en el último intento de cada pregunta o historia, cuántas respuestas cumplen cada criterio */
function tablero() {
  const ult = new Map();
  for (const x of P.intentos) if (x.tipo === "respuesta" && x.evaluacion?.criterios) ult.set(x.pregunta_id, x.evaluacion.criterios);
  const n = ult.size;
  const filas = CRIT.map(([k, l]) => {
    let si = 0, parcial = 0;
    for (const c of ult.values()) { if (c[k]?.estado === "si") si++; else if (c[k]?.estado === "parcial") parcial++; }
    return { k, l, si, parcial };
  });
  const flojo = n ? filas.reduce((a, b) => (b.si + b.parcial / 2 < a.si + a.parcial / 2 ? b : a)) : null;
  return { n, filas, flojo: flojo && flojo.si < n ? flojo : null };
}
const CONSEJO = {
  hecho: "Empieza por un caso real: dónde, cuándo y qué estaba pasando.",
  accion: "Di «I», no «we»: lo que hiciste tú, con verbos de acción.",
  resultado: "Cierra con un número: tiempo, dinero, porcentaje o cantidad de personas.",
  relacion: "Termina conectando con el cargo: por qué eso sirve en este puesto.",
};
/* ---------------- hoja de vida desde un archivo: el texto se saca en el teléfono, nada se sube hasta crear el expediente ---------------- */
const LIB_PDF = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
const LIB_PDF_W = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
const LIB_DOCX = "https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js";
const cargado = {};
const cargar = (src) => cargado[src] ||= new Promise((ok, mal) => {
  const t = document.createElement("script"); t.src = src; t.onload = ok; t.onerror = () => { delete cargado[src]; mal(new Error("lib")); };
  document.head.appendChild(t);
});
async function textoDeArchivo(f) {
  const nombre = (f.name || "").toLowerCase();
  if (f.type === "application/pdf" || nombre.endsWith(".pdf")) {
    await cargar(LIB_PDF);
    const lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = LIB_PDF_W;
    const doc = await lib.getDocument({ data: await f.arrayBuffer() }).promise;
    const paginas = [];
    for (let i = 1; i <= Math.min(doc.numPages, 8); i++) {
      const c = await (await doc.getPage(i)).getTextContent();
      // Cada renglón del PDF en su línea: así las fechas y los cargos no quedan pegados
      let linea = "", y = null; const out = [];
      for (const it of c.items) { const yy = it.transform?.[5]; if (y != null && Math.abs(yy - y) > 2) { out.push(linea); linea = ""; } linea += (linea && !linea.endsWith(" ") ? " " : "") + it.str; y = yy; }
      out.push(linea); paginas.push(out.map((l) => l.trim()).filter(Boolean).join("\n"));
    }
    return paginas.join("\n\n");
  }
  if (nombre.endsWith(".docx") || f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    await cargar(LIB_DOCX);
    return (await window.mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() })).value;
  }
  if (nombre.endsWith(".txt") || f.type.startsWith("text/")) return await f.text();
  throw new Error("tipo");
}
const friendly = {
  cv_corta: "Pega tu hoja de vida completa: lo que hay es muy poco para preparar historias reales.",
  oferta_corta: "Pega el texto completo de la oferta.",
  sin_cargo: "Escribe el cargo para el que te preparas.",
  muy_corta: "Esa respuesta es muy corta para evaluarla.",
  rate_limited: "Vas muy rápido. Espera un minuto e inténtalo de nuevo.",
};
const failMsg = (j) => Sala.limiteMsg(j) || friendly[j?.error] || "No pude completar eso. Revisa tu conexión e inténtalo de nuevo.";

async function load() {
  const [a, b, c] = await Promise.all([
    sb().from("expediente").select("*").maybeSingle(),
    sb().from("expediente_intentos").select("*").order("creado", { ascending: true }).limit(800),
    sb().from("sesiones").select("evaluacion,inicio").eq("escena", SIM).not("evaluacion", "is", null).order("inicio", { ascending: true }).limit(60),
  ]);
  if (a.error) throw a.error;
  // Solo los intentos de este expediente: los de una oferta anterior tenían otras preguntas (se conservan, no se mezclan)
  P.row = a.data; P.intentos = (b.data ?? []).filter((x) => !P.row?.iniciado || x.expediente_iniciado === P.row.iniciado); P.sims = c.data ?? [];
}

async function open() {
  const g = scr("Modo entrevista", "", null);
  paint(`<p class="muted">Abriendo tu expediente…</p>`);
  try { await load(); } catch { if (g === run) paint(E()._err("No pude abrir tu expediente. Revisa tu conexión.") + `<button class="primary wide" id="pRetry">Intentar otra vez</button>`); on("pRetry", open); return; }
  if (g !== run) return;
  if (!P.row) return start();
  if (P.row.estado === "creando") return waitCreate();
  if (P.row.estado === "error") return createFailed();
  hub();
}

/* ---------------- entrada ---------------- */
function start() {
  scr("Modo entrevista", "Prepárate en inglés", null);
  paint(`<h1>Tu entrevista en inglés</h1>
    <p class="muted">Primero armamos tu expediente: tus historias reales, las preguntas que te harían y un plan. Todo lo que practiques se queda aquí.</p>
    <button class="tile" id="pOferta"><span class="ic" aria-hidden="true"><svg><use href="#i-target"/></svg></span><span><b>Tengo una oferta</b><small>Pega el aviso del cargo y te preparas para ese puesto</small></span></button>
    <button class="tile" id="pPreparo"><span class="ic" aria-hidden="true"><svg><use href="#i-flag"/></svg></span><span><b>Me preparo para cuando llegue</b><small>Elige el tipo de cargo y deja listas tus historias</small></span></button>`);
  on("pOferta", () => form("oferta"));
  on("pPreparo", () => form("preparo"));
}
function form(entrada) {
  const oferta = entrada === "oferta";
  scr(oferta ? "Tengo una oferta" : "Me preparo", "Tu expediente", start, "‹ Volver");
  paint(`<label for="fCargo">${oferta ? "Cargo (si no está claro en el aviso)" : "¿Para qué cargo te preparas?"}</label>
    <input id="fCargo" maxlength="120" placeholder="Ej.: Analista de datos">
    ${oferta ? `<label for="fEmpresa">Empresa (opcional)</label><input id="fEmpresa" maxlength="120">
    <label for="fFecha">Fecha de la entrevista (opcional)</label><input id="fFecha" type="date">
    <label for="fOferta">Texto completo de la oferta</label><textarea id="fOferta" rows="7" maxlength="8000" placeholder="Pega aquí el aviso"></textarea>` : ""}
    <label for="fCv">Tu hoja de vida</label>
    <input id="fArchivo" type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" class="sr">
    <label class="ghost wide subir" for="fArchivo">${IC.pen}Subir mi hoja de vida (PDF o Word)</label>
    <p class="small" id="fArchivoMsg" role="status"></p>
    <textarea id="fCv" rows="9" maxlength="12000" placeholder="…o pega aquí el texto de tu hoja de vida"></textarea>
    <p class="muted small">Tu hoja de vida se guarda en tu cuenta y se procesa con inteligencia artificial para preparar tus respuestas. Puedes borrarla cuando quieras. La app solo usa datos que estén en lo que pegas.</p>
    <div id="fErr"></div>
    <button class="primary wide" id="fGo">Crear mi expediente</button>`);
  $("#fArchivo").onchange = async (e) => {
    const f = e.target.files?.[0], msg = $("#fArchivoMsg"); if (!f) return;
    msg.className = "small muted"; msg.textContent = `Leyendo «${f.name}»…`;
    try {
      const t = (await textoDeArchivo(f)).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      const palabras = (t.match(/\S+/g) || []).length;
      if (palabras < 30) { msg.className = "small"; msg.textContent = "No encontré texto en ese archivo: puede ser una imagen escaneada. Súbelo en Word o pega el texto."; return; }
      $("#fCv").value = t.slice(0, 12000); $("#fErr").innerHTML = "";
      msg.className = "small ok"; msg.textContent = `Listo: leí ${palabras} palabras. Revisa abajo que esté todo bien antes de crear tu expediente.`;
    } catch (x) {
      msg.className = "small"; msg.textContent = x?.message === "tipo" ? "Ese tipo de archivo no lo puedo leer. Usa PDF o Word (.docx)." : "No pude leer el archivo. Revisa tu conexión o pega el texto.";
    } finally { e.target.value = ""; }
  };
  on("fGo", async () => {
    const btn = $("#fGo");
    const v = (id) => document.getElementById(id)?.value.trim() || "";
    // Las mismas reglas que el servidor, antes de enviar: el aviso aparece sin esperar
    const falta = v("fCv").length < 150 ? "cv_corta" : oferta && v("fOferta").length < 80 ? "oferta_corta" : !oferta && v("fCargo").length < 3 ? "sin_cargo" : null;
    if (falta) { $("#fErr").innerHTML = E()._err(friendly[falta]); return; }
    btn.disabled = true; btn.textContent = "Enviando…";
    try {
      const r = await Sala.fnFetch("entrevista", { modo: "crear", entrada, cv: v("fCv"), oferta: v("fOferta"), cargo: v("fCargo"), empresa: v("fEmpresa"), fecha: v("fFecha") || null, level: Sala.level() });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw j;
      waitCreate();
    } catch (j) { $("#fErr").innerHTML = E()._err(failMsg(j)); btn.disabled = false; btn.textContent = "Crear mi expediente"; }
  });
}
const PASOS_CREAR = [[0, "Leyendo tu hoja de vida"], [15, "Buscando tus historias reales"], [35, "Armando las preguntas que te harían"], [60, "Conectando tus historias con el cargo"], [90, "Últimos detalles"]];
async function waitCreate() {
  const g = scr("Modo entrevista", "Creando tu expediente", () => Sala.backHome(), "‹ Inicio");
  paint(`<h1>Estoy armando tu expediente</h1>
    <ol class="pasos-crear" id="cPasos">${PASOS_CREAR.map(([, t]) => `<li>${t}</li>`).join("")}</ol>
    <p class="muted small" id="cSeg" role="status">Suele tardar cerca de un minuto.</p>
    <p class="muted small">Puedes salir: el expediente se sigue armando y lo encuentras listo al volver.</p>`);
  const t0 = Date.now();
  const pintar = () => {
    const s = Math.round((Date.now() - t0) / 1000), k = PASOS_CREAR.filter(([d]) => s >= d).length - 1;
    document.querySelectorAll("#cPasos li").forEach((li, i) => { li.className = i < k ? "hecho" : i === k ? "ahora" : ""; li.toggleAttribute("aria-current", i === k); });
    const el = $("#cSeg"); if (el) el.textContent = s < 60 ? `Van ${s} segundos. Suele tardar cerca de un minuto.` : `Van ${s} segundos. Esta vez va más lento; sigo esperando.`;
  };
  pintar();
  while (g === run && Date.now() - t0 < 240000) {
    await sleep(3500);
    if (g !== run) return;
    pintar();
    let row = null;
    try { ({ data: row } = await sb().from("expediente").select("estado").maybeSingle()); } catch {}
    if (row?.estado === "listo") { return open(); }
    if (row?.estado === "error") { return createFailed(); }
  }
  if (g === run) createFailed();
}
function createFailed() {
  scr("Modo entrevista", "", null);
  paint(E()._err("No se pudo crear el expediente.") + `<button class="primary wide" id="pAgain">Empezar otra vez</button>`);
  on("pAgain", async () => {
    let row = null;
    try { ({ data: row } = await sb().from("expediente").select("estado,actualizado").maybeSingle()); } catch {}
    if (row?.estado === "listo") return open();
    if (row?.estado === "creando" && Date.now() - Date.parse(row.actualizado) < 300000) return waitCreate();   // todavía trabaja: no se borra lo que está por terminar
    await sb().from("expediente").delete().eq("user_id", (await sb().auth.getUser()).data.user.id); P.row = null; start();
  });
}

/* ---------------- índice y plan: los calcula el código, siempre con la misma fórmula ---------------- */
function indice() {
  const qs = preguntas();
  const buenas = qs.filter((q) => (mejor(q.id) ?? 0) >= 75).length;
  const pPreg = qs.length ? Math.round((buenas / qs.length) * 30) : 0;
  const hs = historias();
  const pHist = Math.round((hs.filter(completa).length / 5) * 20);
  const venta = P.intentos.filter((x) => x.tipo === "simulacro").pop()?.puntaje ?? null;
  const ingles = P.sims[P.sims.length - 1]?.evaluacion?.puntaje ?? null;
  const pSim = Math.round(((venta ?? 0) * 0.25) + ((ingles ?? 0) * 0.25));
  return { total: pPreg + pHist + pSim, pPreg, pHist, pSim, buenas, venta, ingles };
}
const etapa = (n) => (n >= 85 ? "Listo para tu entrevista" : n >= 70 ? "Casi listo" : n >= 40 ? "En camino" : "Empezando");
function diasRestantes() {
  if (!P.row?.fecha) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  return Math.round((new Date(P.row.fecha + "T00:00:00") - hoy) / 86400000);
}
function plan() {
  const d = diasRestantes();
  const corto = d != null && d <= 2;
  const nombre = d == null ? "Plan semanal" : d <= 2 ? "Plan de 48 horas" : d <= 7 ? "Plan de 7 días" : "Plan semanal";
  const orden = [...preguntas().filter((q) => q.id === "u1"), ...preguntas().filter((q) => q.tipo === "cargo"), ...preguntas().filter((q) => q.tipo === "universal" && q.id !== "u1")];
  const tareas = [];
  historias().forEach((h, i) => { if (!completa(h)) tareas.push({ k: "h", i, t: `Completa tu historia: ${h.titulo}` }); });
  if (corto) tareas.splice(3);
  orden.filter((q) => (mejor(q.id) ?? 0) < 75).slice(0, corto ? 8 : 20).forEach((q) => tareas.push({ k: "q", q, t: `Responde: ${q.en}` }));
  const ultimo = P.intentos.filter((x) => x.tipo === "simulacro").pop()?.puntaje;
  if (ultimo == null || ultimo < 75) tareas.push({ k: "s", t: "Haz un simulacro completo" });
  const cupo = d != null && d > 0 ? Math.max(3, Math.ceil(tareas.length / d)) : d == null ? 5 : tareas.length;
  return { nombre, d, hoy: tareas.slice(0, cupo), total: tareas.length };
}

/* ---------------- expediente ---------------- */
function hub() {
  scr("Modo entrevista", P.row.cargo || "", null);
  const ix = indice(), pl = plan(), a = P.row.analisis || {};
  const hs = historias();
  const quando = pl.d == null ? "" : pl.d < 0 ? "La fecha de tu entrevista ya pasó" : pl.d === 0 ? "Tu entrevista es hoy" : pl.d === 1 ? "Tu entrevista es mañana" : `Faltan ${pl.d} días`;
  const reqs = a.requisitos || [];
  const lbl = { cubierto: "Con evidencia", parcial: "Evidencia parcial", sin_evidencia: "Sin evidencia" };
  paint(`<h1>${esc(P.row.cargo || "Tu entrevista")}</h1>
    <p class="muted">${esc(P.row.empresa || "")}${P.row.empresa && quando ? " · " : ""}${esc(quando)}</p>
    ${pendiente() ? `<div class="notice" data-kind="info"><b>Tienes un simulacro sin informe.</b> Quedó guardado en este teléfono. <button class="primary wide" id="pPend">Pedir el informe</button><button class="linklike" id="pPendNo">Descartarlo</button></div>` : ""}
    <div class="prep-ix"><b>${ix.total}</b><span><strong>${esc(etapa(ix.total))}</strong><small>Índice de preparación de 0 a 100</small></span></div>
    <div class="kpis"><div><small>Preguntas</small><b>${ix.buenas}/${preguntas().length}</b></div><div><small>Historias</small><b>${hs.filter(completa).length}/5</b></div><div><small>Simulacros</small><b>${P.intentos.filter((x) => x.tipo === "simulacro").length}</b></div></div>
    ${vecesEnVoz() ? `<p class="small"><b>Ensayaste en voz alta ${vecesEnVoz()} ${vecesEnVoz() === 1 ? "respuesta" : "respuestas"}</b>, contando las de tus simulacros.</p>` : ""}
    <p class="muted small">El índice mide lo que ensayaste aquí: preguntas con 75 o más (30), historias completas (20), último simulacro (50). No predice la decisión de la empresa.</p>
    ${P.row.fecha ? `<button class="linklike" id="pFecha">Cambiar la fecha de la entrevista</button>` : `<div class="notice" data-kind="info"><b>¿Ya sabes cuándo es tu entrevista?</b> Con la fecha, el plan reparte lo pendiente entre los días que faltan.<label for="pFechaIn">Fecha de la entrevista</label><input id="pFechaIn" type="date"><div id="pFechaErr"></div><button class="primary wide" id="pFechaOk">Guardar la fecha</button></div>`}
    ${tableroHTML()}
    <h2>${esc(pl.nombre)} · hoy</h2>
    ${pl.hoy.length ? `<div class="list">${pl.hoy.map((t, i) => `<button class="li lesson" data-t="${i}"><span>${esc(t.t)}</span></button>`).join("")}</div>` : `<div class="proof good"><span class="ok">✓ Completaste todo lo pendiente del plan. Repite un simulacro antes de la entrevista.</span></div>`}
    <button class="primary wide" id="pSim">Hacer un simulacro con voz</button>
    <div class="tiles one">
      <button class="tile" id="pQs"><span class="ic" aria-hidden="true"><svg><use href="#i-chat"/></svg></span><span><b>Las 20 preguntas</b><small>Practica y mira cómo te vendes</small></span></button>
      <button class="tile" id="pHs"><span class="ic" aria-hidden="true"><svg><use href="#i-pen"/></svg></span><span><b>Tus 5 historias</b><small>${hs.some((h, i) => deHistoria(i).length) ? `${hs.filter((h, i) => Math.max(0, ...deHistoria(i).map((x) => x.puntaje ?? 0)) >= 75).length} de ${hs.length} ya convencen (75 o más)` : "Tus hechos, con tus palabras"}</small></span></button>
      <button class="tile" id="pKit"><span class="ic" aria-hidden="true"><svg><use href="#i-flag"/></svg></span><span><b>Para el día de la entrevista</b><small>Guion de salario y correo de agradecimiento</small></span></button>
      <button class="tile" id="pAv"><span class="ic" aria-hidden="true"><svg><use href="#i-trend"/></svg></span><span><b>Tu avance</b><small>Primer intento contra el último</small></span></button>
    </div>
    ${a.resumen_es ? `<div class="rc-ctx"><b>Lo que pide este cargo</b><span>${esc(a.resumen_es)}</span></div>` : ""}
    ${reqs.length ? `<details class="prefs"><summary>Tu evidencia frente al cargo</summary><div class="list">${reqs.map((r) => `<div class="li"><span>${esc(r.requisito_es)}</span><span class="meta">${r.origen === "tipico" ? "Típico del cargo · " : ""}${esc(lbl[r.estado] || "")}${r.evidencia_es ? " · " + esc(r.evidencia_es) : ""}</span></div>`).join("")}</div></details>` : ""}
    <button class="linklike" id="pDel">Borrar mi expediente</button>`);
  on("pPend", () => afterSim());
  on("pPendNo", () => { Sala.store.set(PENDIENTE, null); hub(); });
  for (const b of document.querySelectorAll("[data-t]")) b.onclick = () => {
    const t = pl.hoy[Number(b.dataset.t)];
    if (t.k === "h") story(t.i); else if (t.k === "q") practice(t.q); else simulacro();
  };
  on("pFecha", fechaEditar);
  on("pFechaOk", () => guardarFecha($("#pFechaIn").value, "pFechaErr"));
  on("pSim", simulacro); on("pQs", questions); on("pHs", stories); on("pKit", kit); on("pAv", avance); on("pDel", borrar);
}
function tableroHTML() {
  const t = tablero();
  if (!t.n) return "";
  return `<h2>Tus 4 criterios</h2>
    <p class="muted small">En el último intento de cada una de tus ${t.n} ${t.n === 1 ? "respuesta practicada" : "respuestas practicadas"}.</p>
    <div class="crit">${t.filas.map((f) => `<div class="crit-f${t.flojo?.k === f.k ? " flojo" : ""}"><span class="crit-l">${esc(f.l)}</span><span class="crit-b" role="img" aria-label="${f.si} de ${t.n} lo cumplen, ${f.parcial} a medias"><i style="width:${Math.round((f.si / t.n) * 100)}%"></i><i class="m" style="width:${Math.round((f.parcial / t.n) * 100)}%"></i></span><span class="crit-n">${f.si}/${t.n}</span></div>`).join("")}</div>
    ${t.flojo ? `<div class="reto"><span class="lbl">Lo que más te sube el puntaje ahora: ${esc(t.flojo.l.toLowerCase())}</span><span>${esc(CONSEJO[t.flojo.k])}</span></div>` : `<p class="muted small">Tus respuestas cumplen los 4 criterios. Ahora sostenlo en un simulacro completo.</p>`}`;
}
async function guardarFecha(v, errId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || "")) { $("#" + errId).innerHTML = E()._err("Elige una fecha."); return; }
  const { error } = await sb().from("expediente").update({ fecha: v, actualizado: new Date().toISOString() }).eq("user_id", P.row.user_id);
  if (error) { $("#" + errId).innerHTML = E()._err("No se pudo guardar. Inténtalo de nuevo."); return; }
  P.row.fecha = v; hub();
}
function fechaEditar() {
  scr("Fecha de la entrevista", "", hub, BACK);
  paint(`<label for="fdIn">Fecha de la entrevista</label><input id="fdIn" type="date" value="${esc(P.row.fecha || "")}"><div id="fdErr"></div>
    <button class="primary wide" id="fdOk">Guardar</button><button class="ghost wide" id="fdQuitar">Todavía no tengo fecha</button>`);
  on("fdOk", () => guardarFecha($("#fdIn").value, "fdErr"));
  on("fdQuitar", async () => {
    const { error } = await sb().from("expediente").update({ fecha: null, actualizado: new Date().toISOString() }).eq("user_id", P.row.user_id);
    if (error) { $("#fdErr").innerHTML = E()._err("No se pudo guardar. Inténtalo de nuevo."); return; }
    P.row.fecha = null; hub();
  });
}
function borrar() {
  scr("Borrar expediente", "", hub, BACK);
  paint(`<h1>¿Borrar tu expediente?</h1><p class="muted">Se borran tu hoja de vida, la oferta, tus historias y todos tus intentos. No se puede deshacer.</p><div id="dErr"></div><button class="primary wide" id="dYes">Sí, borrar todo</button><button class="ghost wide" id="dNo">Cancelar</button>`);
  on("dNo", hub);
  on("dYes", async () => {
    $("#dYes").disabled = true;
    try {
      const { data } = await sb().auth.getUser(); const uid = data.user.id;
      const a = await sb().from("expediente_intentos").delete().eq("user_id", uid);
      const b = await sb().from("expediente").delete().eq("user_id", uid);
      if (a.error || b.error) throw 0;
      P.row = null; P.intentos = []; start();
    } catch { $("#dErr").innerHTML = E()._err("No se pudo borrar. Inténtalo de nuevo."); $("#dYes").disabled = false; }
  });
}

/* ---------------- preguntas y corrección ---------------- */
function questions() {
  scr("Las 20 preguntas", "", hub, BACK);
  const row = (q) => { const m = mejor(q.id); return `<button class="li lesson" data-q="${esc(q.id)}"><span>${esc(q.en)}</span><span class="meta">${esc(q.es)}${m != null ? ` · mejor puntaje ${m}` : " · sin practicar"}</span></button>`; };
  const qs = preguntas();
  paint(`<h2>De este cargo</h2><div class="list">${qs.filter((q) => q.tipo === "cargo").map(row).join("")}</div><h2>Las que casi siempre hacen</h2><div class="list">${qs.filter((q) => q.tipo === "universal").map(row).join("")}</div>`);
  for (const b of document.querySelectorAll("[data-q]")) b.onclick = () => practice(qs.find((q) => q.id === b.dataset.q));
}
function practice(q, opts = {}) {
  const back = opts.historia != null ? stories : questions;
  const g = scr("Responde en inglés", "", back, "‹ Volver");
  let rec = null, pron = null;
  paint(`<p class="rc-q">${esc(q.en)}</p><p class="muted">${esc(q.es || "")}</p>
    ${q.por_que_es ? `<p class="muted small">${esc(q.por_que_es)}</p>` : ""}
    <button class="replay" id="pListen">Escuchar la pregunta</button>
    <button class="primary wide" id="pRec">Grabar mi respuesta</button>
    <label for="pAns">Tu respuesta (también la puedes escribir)</label>
    <textarea id="pAns" rows="6" maxlength="2500"></textarea>
    <div id="pErr"></div>
    <button class="ghost wide" id="pGo">Revisar cómo me vendí</button>`);
  on("pListen", () => E()._say(q.en));
  on("pRec", async () => {
    const b = $("#pRec");
    if (rec) { b.disabled = true; b.textContent = "Terminando…"; rec.stop(); return; }
    b.textContent = "Detener";
    const ta = $("#pAns");
    rec = E()._recognize({ maxMs: 180000, onPartial: (t) => { if (g === run) ta.value = t; } });
    const r = await rec.promise; rec = null;
    if (g !== run) return;
    pron = r; b.disabled = false; b.textContent = "Grabar otra vez";
    if (r.text) ta.value = r.text;
    else $("#pErr").innerHTML = E()._err("No escuché nada. Revisa el permiso del micrófono o escribe tu respuesta.");
  });
  on("pGo", async () => {
    const texto = $("#pAns").value.trim();
    if (rec) { rec.stop(); }
    if (texto.length < 8) { $("#pErr").innerHTML = E()._err(friendly.muy_corta); return; }
    const b = $("#pGo"); b.disabled = true; b.textContent = "Revisando…";
    try {
      const r = await Sala.fnFetch("entrevista", { modo: "vender", pregunta_id: q.id, pregunta: q.en, texto, historia: opts.historia ?? null, voz: !!pron?.text, level: Sala.level() });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw j;
      if (g !== run) return;
      P.intentos.push({ tipo: "respuesta", pregunta_id: q.id, puntaje: j.puntaje, creado: new Date().toISOString(), evaluacion: j.evaluacion });
      result(q, opts, texto, j, pron);
    } catch (j) { if (g === run) { $("#pErr").innerHTML = E()._err(failMsg(j)); b.disabled = false; b.textContent = "Revisar cómo me vendí"; } }
  });
}
const SIGNO = { si: ["✓", "Sí"], parcial: ["◐", "A medias"], no: ["✕", "Falta"] };
const CRIT = [["hecho", "Hecho concreto"], ["accion", "Lo que tú hiciste"], ["resultado", "Resultado con número"], ["relacion", "Relación con el cargo"]];
const marks = (t) => esc(t).replace(/\[([^\]]+)\]/g, `<mark class="ph">[$1]</mark>`);
function result(q, opts, texto, j, pron) {
  const back = opts.historia != null ? stories : questions;
  scr("Cómo te vendiste", "", back, "‹ Volver");
  const v = j.evaluacion;
  const cmp = j.primero != null ? `Primer intento ${j.primero} · ahora ${j.puntaje}` : "Primer intento";
  const adj = v.adjetivos_sin_prueba || [], falt = v.preguntas_faltantes_es || [], usa = v.usa_expediente_es || [];
  paint(`<div class="prep-ix"><b>${j.puntaje}</b><span><strong>${esc(cmp)}</strong><small>Puntaje de 0 a 100 con 4 criterios</small></span></div>
    <div class="list">${CRIT.map(([k, l]) => { const c = v.criterios[k]; const s = SIGNO[c.estado] || SIGNO.no; return `<div class="li"><span><b aria-hidden="true">${s[0]}</b> ${esc(l)}: ${s[1]}</span><span class="meta">${esc(c.por_que_es)}</span></div>`; }).join("")}</div>
    ${adj.length ? `<div class="rc-ctx"><b>Dices esto sin prueba</b>${adj.map((a) => `<span><em>${esc(a.frase_en)}</em>: ${esc(a.pide_es)}</span>`).join("")}</div>` : ""}
    ${falt.length ? `<div class="rc-ctx"><b>Datos que te harían más creíble</b><ul class="ul">${falt.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    <div class="reto"><span class="lbl">Para el próximo intento</span><span>${esc(v.siguiente_es)}</span></div>
    <div class="rc-ctx"><b>Tu versión más fuerte</b><span class="en">${marks(v.version_fuerte_en)}</span>
      ${/\[/.test(v.version_fuerte_en) ? `<span class="muted small">Lo que está entre corchetes solo lo sabes tú. Cámbialo por tu dato real.</span>` : ""}
      ${(v.confirmar || []).length ? `<span class="small"><b>Confirma antes de decirlo:</b> ${v.confirmar.map((n) => `«${esc(n)}»`).join(", ")} ${v.confirmar.length === 1 ? "no aparece" : "no aparecen"} en tu hoja de vida. Si es exacto, ten a mano cómo lo mediste: en la entrevista te lo pueden preguntar.</span>` : ""}
      ${usa.length ? `<span class="muted small">Tomado de tu expediente, confírmalo: ${esc(usa.join("; "))}</span>` : ""}
      <button class="replay" id="rListen">Escuchar</button></div>
    ${v.ingles?.better ? `<div class="rc-ctx"><b>${v.ingles.ok ? "✓ Tu inglés está correcto" : "Tu inglés, corregido"}</b><span class="en">${esc(v.ingles.better)}</span>${v.ingles.natural ? `<span class="muted small">Más natural: <span class="en">${esc(v.ingles.natural)}</span></span>` : ""}${v.ingles.tip_es ? `<span class="muted small">${esc(v.ingles.tip_es)}</span>` : ""}</div>` : ""}
    ${pron?.palabras?.length ? `<details class="prefs"><summary>Tu pronunciación</summary>${E()._scores(pron)}${E()._words(pron.palabras)}</details>` : ""}
    <button class="primary wide" id="rAgain">Intentarlo otra vez</button>
    <button class="ghost wide" id="rBack">Volver</button>`);
  on("rListen", () => E()._say(v.version_fuerte_en.replace(/\[[^\]]*\]/g, "...")));
  on("rAgain", () => practice(q, opts));
  on("rBack", back);
}

/* ---------------- historias ---------------- */
function stories() {
  scr("Tus 5 historias", "", hub, BACK);
  const hs = historias();
  paint(`<p class="muted">Salen de tu hoja de vida. Corrige lo que no sea exacto y completa lo que falte: solo tú conoces esos datos.</p>
    <div class="list">${hs.map((h, i) => `<button class="li lesson" data-h="${i}"><span>${esc(h.titulo)}</span><span class="meta">${completa(h) ? "Completa" : "Falta información"}${deHistoria(i).length ? ` · puntaje ${avanceTxt(deHistoria(i))}${enVoz(deHistoria(i)) ? ` · ${enVoz(deHistoria(i))} en voz alta` : ""}` : " · sin practicar"}</span></button>`).join("")}</div>`);
  for (const b of document.querySelectorAll("[data-h]")) b.onclick = () => story(Number(b.dataset.h));
}
function story(i) {
  scr("Tu historia", "", stories, "‹ Volver");
  const h = historias()[i];
  const f = (id, l, ph, v) => `<label for="${id}">${l}</label><textarea id="${id}" rows="3" maxlength="900" placeholder="${esc(ph)}">${esc(v)}</textarea>`;
  paint(`<h2>${esc(h.titulo)}</h2>
    ${h.falta?.length ? `<div class="rc-ctx"><b>Para completarla, responde</b><ul class="ul">${h.falta.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    ${f("hS", "Qué estaba pasando", "El problema o la situación", h.situacion)}
    ${f("hA", "Qué hiciste tú", "Lo que hiciste personalmente", h.accion)}
    ${f("hR", "Qué cambió", "El resultado, con el número exacto si lo tienes", h.resultado)}
    <div id="hErr"></div>
    <button class="primary wide" id="hPr">Guardar y practicar en inglés</button>
    <button class="ghost wide" id="hSave">Guardar</button>`);
  const save = async () => {
    const list = historias().slice();
    list[i] = { ...h, situacion: $("#hS").value.trim(), accion: $("#hA").value.trim(), resultado: $("#hR").value.trim() };
    const { error } = await sb().from("expediente").update({ historias: list, actualizado: new Date().toISOString() }).eq("user_id", P.row.user_id);
    if (error) { $("#hErr").innerHTML = E()._err("No se pudo guardar. Inténtalo de nuevo."); return false; }
    P.row.historias = list; return true;
  };
  on("hSave", async () => { if (await save()) stories(); });
  on("hPr", async () => {
    if (!(await save())) return;
    practice({ id: "h" + (i + 1), en: h.pregunta_en, es: h.pregunta_es }, { historia: i });
  });
}

/* ---------------- simulacro e informe ---------------- */
function simulacro() {
  const a = P.row.analisis || {}, qs = preguntas();
  const lista = [...qs.filter((q) => q.tipo === "cargo").slice(0, 3), qs.find((q) => q.id === "u6"), qs.find((q) => q.id === "u3")].filter(Boolean);
  const reqs = (a.requisitos || []).slice(0, 6).map((r) => r.requisito_es).join("; ");
  const cargo = P.row.cargo || "the position", empresa = P.row.empresa || "the company";
  const persona = `You are Morgan Reed, the hiring manager for the position of ${cargo} at ${empresa}, conducting a real job interview in English. You are polite, professional and hard to impress.
What the job needs (notes in Spanish, never read them aloud): ${reqs}
What you know about the candidate: ${a.candidato_en || "only what they tell you"}
Interview plan. The candidate already heard "Tell me about yourself". Then ask these questions one at a time, in this order: ${lista.map((q, i) => `(${i + 1}) ${q.en}`).join(" ")}
After each answer you may ask ONE short follow-up if it was vague, asking for a specific example or number. Never give feedback, praise or coaching during the interview. When all the questions are done, thank the candidate, say what happens next in one sentence and end the interview.`;
  Sala.startScene({ id: "simulacro", prep: true, returnTo: { kind: "prep" }, title: SIM, name: "Morgan Reed", who: "Gerente de contratación", desc: `Entrevista de trabajo para ${cargo}: responder con hechos concretos, acciones propias y resultados medibles.`, persona: persona.slice(0, 3900), open: `Hi, thanks for making the time. I'm Morgan Reed, the hiring manager for this role. Let's get started. Tell me about yourself.`, voice: "en-US-AndrewMultilingualNeural" });
}
// El simulacro queda guardado en este equipo hasta que llegue su informe: sin señal o si iOS cierra la app no se pierde.
const PENDIENTE = "simPendiente";
const pendiente = () => {
  const p = Sala.store.get(PENDIENTE, null);
  return p && Array.isArray(p.hist) && Date.now() - Date.parse(p.fecha) < 7 * 864e5 ? p : null;
};
function guardarSim(hist) {
  P.hist = hist;
  if (hist && hist.filter((t) => t.role === "user").length >= 3) Sala.store.set(PENDIENTE, { hist, fecha: new Date().toISOString() });
}
async function afterSim() {
  const hist = P.hist || pendiente()?.hist; P.hist = null;
  if (!hist || hist.filter((t) => t.role === "user").length < 3) return open();
  const g = scr("Informe del simulacro", "", open, BACK);
  paint(`<p class="muted">Revisando cómo te vendiste en cada respuesta…</p>`);
  try {
    const r = await Sala.fnFetch("entrevista", { modo: "informe", turnos: hist });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw j;
    Sala.store.set(PENDIENTE, null);
    if (g !== run) return;
    report(j.informe, j.puntaje);
  } catch (j) {
    if (g !== run) return;
    paint(E()._err(failMsg(j)) + `<p class="muted small">Tu simulacro quedó guardado en este teléfono. Puedes pedir el informe ahora o más tarde desde tu expediente.</p>
      <button class="primary wide" id="iRetry">Pedir el informe otra vez</button><button class="ghost wide" id="iBack">Volver al expediente</button>`);
    on("iRetry", () => { P.hist = hist; afterSim(); });
    on("iBack", open);
  }
}
function report(v, puntaje) {
  const dot = (e) => (SIGNO[e] || SIGNO.no)[0];
  paint(`<div class="prep-ix"><b>${puntaje}</b><span><strong>Cómo te vendiste</strong><small>Promedio de tus respuestas, de 0 a 100</small></span></div>
    <div class="rc-ctx"><b>Lo que se repite</b><span>${esc(v.patron_es)}</span></div>
    <div class="reto"><span class="lbl">Arregla primero</span><ul class="ul">${(v.prioridades_es || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    <h2>Respuesta por respuesta</h2>
    <div class="list">${(v.respuestas || []).map((a) => `<div class="li"><span class="meta">${esc(a.pregunta_en)}</span><span>${esc(a.dijiste)}</span><span class="meta">Hecho ${dot(a.hecho)} · Acción ${dot(a.accion)} · Resultado ${dot(a.resultado)} · Cargo ${dot(a.relacion)}</span><span class="small">${esc(a.mejora_es)}</span></div>`).join("")}</div>
    <button class="primary wide" id="iDone">Volver al expediente</button>`);
  on("iDone", open);
}
/* ---------------- kit para el día de la entrevista ---------------- */
function copiar(id, texto) {
  on(id, async () => { const b = document.getElementById(id); try { await navigator.clipboard.writeText(texto); b.textContent = "Copiado"; } catch { b.textContent = "No se pudo copiar"; } });
}
function kit() {
  scr("Para el día de la entrevista", "", hub, BACK);
  paint(`<div class="tiles one">
    <button class="tile" id="kSal"><span class="ic" aria-hidden="true"><svg><use href="#i-chat"/></svg></span><span><b>Guion de salario</b><small>Qué decir si te preguntan cuánto aspiras</small></span></button>
    <button class="tile" id="kCor"><span class="ic" aria-hidden="true"><svg><use href="#i-send"/></svg></span><span><b>Correo de agradecimiento</b><small>Para enviar después de la entrevista</small></span></button>
  </div>`);
  on("kSal", salario); on("kCor", correo);
}
async function pedirKit(modo, datos, btn, errId, volver) {
  const orig = btn.textContent; btn.disabled = true; btn.textContent = "Preparando…"; const g = run;
  try {
    const r = await Sala.fnFetch("entrevista", { modo, ...datos, level: Sala.level() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw j;
    if (g !== run) return;
    P.row.analisis = { ...(P.row.analisis || {}), kit: { ...(P.row.analisis?.kit || {}), [modo]: j.resultado } };
    volver(j.resultado);
  } catch (j) { if (g === run) { document.getElementById(errId).innerHTML = E()._err(failMsg(j)); btn.disabled = false; btn.textContent = orig; } }
}
function salario() {
  scr("Guion de salario", "", kit, "‹ Volver");
  const prev = P.row.analisis?.kit?.guion_salario;
  paint(`<p class="muted">Los números los pones tú. La app no inventa rangos de mercado: averigua el de tu cargo y tu país antes de la entrevista.</p>
    <label for="sObj">Tu aspiración (ejemplo: USD 3.000 a 3.500 al mes)</label><input id="sObj" maxlength="80">
    <label for="sMin">Lo mínimo que aceptarías (solo lo ves tú)</label><input id="sMin" maxlength="80">
    <div id="sErr"></div>
    <button class="primary wide" id="sGo">${prev ? "Preparar de nuevo" : "Preparar mi guion"}</button>
    ${prev ? guionHTML(prev) : ""}`);
  on("sGo", () => pedirKit("guion_salario", { objetivo: $("#sObj").value.trim(), minimo: $("#sMin").value.trim() }, $("#sGo"), "sErr", () => salario()));
  wireGuion(prev);
}
const LINEAS = [["primera_en", "Si te preguntan cuánto aspiras"], ["insisten_en", "Si insisten en un número"], ["baja_en", "Si la oferta es más baja"], ["tiempo_en", "Para pedir tiempo y pensarlo"]];
const guionHTML = (s) => LINEAS.map(([k, l], i) => `<div class="rc-ctx"><b>${l}</b><span class="en">${marks(s[k])}</span><button class="replay" id="sL${i}">Escuchar</button></div>`).join("") + `<div class="rc-ctx"><b>Antes de usarlo</b><ul class="ul">${(s.notas_es || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
function wireGuion(s) { if (!s) return; LINEAS.forEach(([k], i) => on("sL" + i, () => E()._say(String(s[k]).replace(/\[[^\]]*\]/g, "...")))); }
function correo() {
  scr("Correo de agradecimiento", "", kit, "‹ Volver");
  const prev = P.row.analisis?.kit?.correo_gracias;
  paint(`<label for="cNom">Nombre de quien te entrevistó</label><input id="cNom" maxlength="80">
    <label for="cTem">Algo específico que hablaron (en español o inglés)</label><textarea id="cTem" rows="3" maxlength="500" placeholder="Ej.: el reto de abrir el mercado de Perú"></textarea>
    <div id="cErr"></div>
    <button class="primary wide" id="cGo">${prev ? "Escribirlo de nuevo" : "Escribir mi correo"}</button>
    ${prev ? `<div class="rc-ctx"><b>Asunto</b><span class="en">${marks(prev.asunto_en)}</span></div><div class="rc-ctx"><b>Correo</b><span class="en" style="white-space:pre-wrap">${marks(prev.cuerpo_en)}</span><button class="replay" id="cCopy">Copiar</button></div>${(prev.notas_es || []).length ? `<p class="muted small">${esc(prev.notas_es.join(" "))}</p>` : ""}` : ""}`);
  on("cGo", () => pedirKit("correo_gracias", { entrevistador: $("#cNom").value.trim(), tema: $("#cTem").value.trim() }, $("#cGo"), "cErr", () => correo()));
  if (prev) copiar("cCopy", `${prev.asunto_en}\n\n${prev.cuerpo_en}`);
}
function avance() {
  scr("Tu avance", "", hub, BACK);
  const filas = preguntas().map((q) => ({ q, r: respuestas(q.id) })).filter((x) => x.r.length);
  const vent = P.intentos.filter((x) => x.tipo === "simulacro");
  const ing = P.sims.map((s) => s.evaluacion?.puntaje).filter((n) => n != null);
  const par = (a) => (a.length > 1 ? `${a[0]} → ${a[a.length - 1]}` : a.length ? String(a[0]) : "Sin datos");
  paint(`<div class="kpis"><div><small>Simulacro: cómo te vendes</small><b>${par(vent.map((x) => x.puntaje))}</b></div><div><small>Simulacro: inglés y objetivo</small><b>${par(ing)}</b></div></div>
    ${historias().some((h, i) => deHistoria(i).length) ? `<h2>Historia por historia</h2><div class="list">${historias().map((h, i) => ({ h, r: deHistoria(i) })).filter((x) => x.r.length).map(({ h, r }) => `<div class="li"><span>${esc(h.titulo)}</span><span class="meta">${r.length} ${r.length === 1 ? "intento" : "intentos"} · ${r.length > 1 ? `primero ${r[0].puntaje} · último ${r[r.length - 1].puntaje}` : `puntaje ${r[0].puntaje}`}</span></div>`).join("")}</div>` : ""}
    <h2>Pregunta por pregunta</h2>
    ${filas.length ? `<div class="list">${filas.map(({ q, r }) => `<div class="li"><span>${esc(q.en)}</span><span class="meta">${r.length} ${r.length === 1 ? "intento" : "intentos"} · primero ${r[0].puntaje} · último ${r[r.length - 1].puntaje}</span></div>`).join("")}</div>` : `<p class="muted">Aún no has practicado ninguna pregunta.</p>`}`);
}

document.addEventListener("DOMContentLoaded", () => { on("prepBtn", open); });
window.Prep = { open, afterSim, setHist: guardarSim };
})();
