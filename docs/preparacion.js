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
const friendly = {
  cv_corta: "Pega tu hoja de vida completa: lo que hay es muy poco para preparar historias reales.",
  oferta_corta: "Pega el texto completo de la oferta.",
  sin_cargo: "Escribe el cargo para el que te preparas.",
  muy_corta: "Esa respuesta es muy corta para evaluarla.",
  rate_limited: "Vas muy rápido. Espera un minuto e inténtalo de nuevo.",
};
const failMsg = (j) => friendly[j?.error] || "No pude completar eso. Revisa tu conexión e inténtalo de nuevo.";

async function load() {
  const [a, b, c] = await Promise.all([
    sb().from("expediente").select("*").maybeSingle(),
    sb().from("expediente_intentos").select("id,tipo,pregunta_id,puntaje,creado,evaluacion").order("creado", { ascending: true }).limit(800),
    sb().from("sesiones").select("evaluacion,inicio").eq("escena", SIM).not("evaluacion", "is", null).order("inicio", { ascending: true }).limit(60),
  ]);
  if (a.error) throw a.error;
  P.row = a.data; P.intentos = b.data ?? []; P.sims = c.data ?? [];
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
    <label for="fCv">Tu hoja de vida</label><textarea id="fCv" rows="9" maxlength="12000" placeholder="Pega aquí el texto de tu hoja de vida"></textarea>
    <p class="muted small">Tu hoja de vida se guarda en tu cuenta y se procesa con inteligencia artificial para preparar tus respuestas. Puedes borrarla cuando quieras. La app solo usa datos que estén en lo que pegas.</p>
    <div id="fErr"></div>
    <button class="primary wide" id="fGo">Crear mi expediente</button>`);
  on("fGo", async () => {
    const btn = $("#fGo"); btn.disabled = true; btn.textContent = "Enviando…";
    const v = (id) => document.getElementById(id)?.value.trim() || "";
    try {
      const r = await Sala.fnFetch("entrevista", { modo: "crear", entrada, cv: v("fCv"), oferta: v("fOferta"), cargo: v("fCargo"), empresa: v("fEmpresa"), fecha: v("fFecha") || null, level: Sala.level() });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw j;
      waitCreate();
    } catch (j) { $("#fErr").innerHTML = E()._err(failMsg(j)); btn.disabled = false; btn.textContent = "Crear mi expediente"; }
  });
}
async function waitCreate() {
  const g = scr("Modo entrevista", "Creando tu expediente", null);
  paint(`<h1>Estoy leyendo tu hoja de vida</h1><p class="muted">Busco tus historias reales y las preguntas que te harían. Tarda cerca de un minuto. Puedes salir y volver.</p>`);
  const t0 = Date.now();
  while (g === run && Date.now() - t0 < 240000) {
    await sleep(3500);
    if (g !== run) return;
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
  on("pAgain", async () => { await sb().from("expediente").delete().eq("user_id", (await sb().auth.getUser()).data.user.id); P.row = null; start(); });
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
    <div class="prep-ix"><b>${ix.total}</b><span><strong>${esc(etapa(ix.total))}</strong><small>Índice de preparación de 0 a 100</small></span></div>
    <div class="kpis"><div><small>Preguntas</small><b>${ix.buenas}/${preguntas().length}</b></div><div><small>Historias</small><b>${hs.filter(completa).length}/5</b></div><div><small>Simulacros</small><b>${P.intentos.filter((x) => x.tipo === "simulacro").length}</b></div></div>
    <p class="muted small">El índice mide lo que ensayaste aquí: preguntas con 75 o más (30), historias completas (20), último simulacro (50). No predice la decisión de la empresa.</p>
    <h2>${esc(pl.nombre)} · hoy</h2>
    ${pl.hoy.length ? `<div class="list">${pl.hoy.map((t, i) => `<button class="li lesson" data-t="${i}"><span>${esc(t.t)}</span></button>`).join("")}</div>` : `<div class="proof good"><span class="ok">✓ Completaste todo lo pendiente del plan. Repite un simulacro antes de la entrevista.</span></div>`}
    <button class="primary wide" id="pSim">Hacer un simulacro con voz</button>
    <div class="tiles one">
      <button class="tile" id="pQs"><span class="ic" aria-hidden="true"><svg><use href="#i-chat"/></svg></span><span><b>Las 20 preguntas</b><small>Practica y mira cómo te vendes</small></span></button>
      <button class="tile" id="pHs"><span class="ic" aria-hidden="true"><svg><use href="#i-pen"/></svg></span><span><b>Tus 5 historias</b><small>Tus hechos, con tus palabras</small></span></button>
      <button class="tile" id="pAv"><span class="ic" aria-hidden="true"><svg><use href="#i-trend"/></svg></span><span><b>Tu avance</b><small>Primer intento contra el último</small></span></button>
    </div>
    ${a.resumen_es ? `<div class="rc-ctx"><b>Lo que pide este cargo</b><span>${esc(a.resumen_es)}</span></div>` : ""}
    ${reqs.length ? `<details class="prefs"><summary>Tu evidencia frente al cargo</summary><div class="list">${reqs.map((r) => `<div class="li"><span>${esc(r.requisito_es)}</span><span class="meta">${esc(lbl[r.estado] || "")}${r.evidencia_es ? " · " + esc(r.evidencia_es) : ""}</span></div>`).join("")}</div></details>` : ""}
    <button class="linklike" id="pDel">Borrar mi expediente</button>`);
  for (const b of document.querySelectorAll("[data-t]")) b.onclick = () => {
    const t = pl.hoy[Number(b.dataset.t)];
    if (t.k === "h") story(t.i); else if (t.k === "q") practice(t.q); else simulacro();
  };
  on("pSim", simulacro); on("pQs", questions); on("pHs", stories); on("pAv", avance); on("pDel", borrar);
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
      const r = await Sala.fnFetch("entrevista", { modo: "vender", pregunta_id: q.id, pregunta: q.en, texto, historia: opts.historia ?? null, level: Sala.level() });
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
      ${usa.length ? `<span class="muted small">Tomado de tu expediente, confírmalo: ${esc(usa.join("; "))}</span>` : ""}
      <button class="replay" id="rListen">Escuchar</button></div>
    ${v.ingles?.better ? `<div class="rc-ctx"><b>Tu inglés, corregido</b><span class="en">${esc(v.ingles.better)}</span>${v.ingles.tip_es ? `<span class="muted small">${esc(v.ingles.tip_es)}</span>` : ""}</div>` : ""}
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
    <div class="list">${hs.map((h, i) => `<button class="li lesson" data-h="${i}"><span>${esc(h.titulo)}</span><span class="meta">${completa(h) ? "Completa" : "Falta información"}</span></button>`).join("")}</div>`);
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
async function afterSim() {
  const hist = P.hist; P.hist = null;
  if (!hist || hist.filter((t) => t.role === "user").length < 3) return open();
  const g = scr("Informe del simulacro", "", open, BACK);
  paint(`<p class="muted">Revisando cómo te vendiste en cada respuesta…</p>`);
  try {
    const r = await Sala.fnFetch("entrevista", { modo: "informe", turnos: hist });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw j;
    if (g !== run) return;
    report(j.informe, j.puntaje);
  } catch (j) { if (g === run) paint(E()._err(failMsg(j)) + `<button class="ghost wide" id="iBack">Volver al expediente</button>`); on("iBack", open); }
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
function avance() {
  scr("Tu avance", "", hub, BACK);
  const filas = preguntas().map((q) => ({ q, r: respuestas(q.id) })).filter((x) => x.r.length);
  const vent = P.intentos.filter((x) => x.tipo === "simulacro");
  const ing = P.sims.map((s) => s.evaluacion?.puntaje).filter((n) => n != null);
  const par = (a) => (a.length > 1 ? `${a[0]} → ${a[a.length - 1]}` : a.length ? String(a[0]) : "Sin datos");
  paint(`<div class="kpis"><div><small>Simulacro: cómo te vendes</small><b>${par(vent.map((x) => x.puntaje))}</b></div><div><small>Simulacro: inglés y objetivo</small><b>${par(ing)}</b></div></div>
    <h2>Pregunta por pregunta</h2>
    ${filas.length ? `<div class="list">${filas.map(({ q, r }) => `<div class="li"><span>${esc(q.en)}</span><span class="meta">${r.length} ${r.length === 1 ? "intento" : "intentos"} · primero ${r[0].puntaje} · último ${r[r.length - 1].puntaje}</span></div>`).join("")}</div>` : `<p class="muted">Aún no has practicado ninguna pregunta.</p>`}`);
}

document.addEventListener("DOMContentLoaded", () => { on("prepBtn", open); });
window.Prep = { open, afterSim, setHist: (h) => { P.hist = h; } };
})();
