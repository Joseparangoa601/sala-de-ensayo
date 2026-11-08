/* Capa de datos de la F2: cuaderno (tarjetas FSRS), repasos y sesiones.
   Todo se escribe primero en el teléfono (localStorage) y una cola lo sube a Supabase
   cuando hay conexión. Así no se pierde nada al cerrar la app o quedarse sin señal. */
(() => {
"use strict";
const F = window.FSRS;
const sched = F.fsrs(F.generatorParameters({ request_retention: 0.9, maximum_interval: 365, enable_fuzz: true }));
const K = { cards: "sala:tarjetas", queue: "sala:cola", syncedAt: "sala:sincronizado", owner: "sala:dueno" };
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => {
  const s = JSON.stringify(v);
  try { localStorage.setItem(k, s); return; } catch {}
  // Sin espacio: las copias de lecciones se pueden volver a bajar; la cola y el cuaderno no
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith("sala:lesson:")) localStorage.removeItem(key);
    localStorage.setItem(k, s);
  } catch (e) { console.warn("No se pudo guardar en el teléfono", k, e); }
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }));

let sb = null;
let cards = load(K.cards, []);
let queue = load(K.queue, []);
let syncing = null;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => { try { fn(); } catch {} });

const CARD_FIELDS = ["due", "stability", "difficulty", "elapsed_days", "scheduled_days", "learning_steps", "reps", "lapses", "state", "last_review"];
function toFsrs(row) {
  return {
    due: new Date(row.due), stability: row.stability, difficulty: row.difficulty,
    elapsed_days: row.elapsed_days, scheduled_days: row.scheduled_days, learning_steps: row.learning_steps || 0,
    reps: row.reps, lapses: row.lapses, state: row.state,
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  };
}
function fromFsrs(c) {
  return {
    due: c.due.toISOString(), stability: c.stability, difficulty: c.difficulty,
    elapsed_days: Math.round(c.elapsed_days || 0), scheduled_days: Math.round(c.scheduled_days || 0),
    learning_steps: c.learning_steps || 0, reps: c.reps, lapses: c.lapses, state: c.state,
    last_review: c.last_review ? new Date(c.last_review).toISOString() : null,
  };
}
const norm = (s) => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

function persist() { save(K.cards, cards); save(K.queue, queue); emit(); }
function enqueue(op) { queue.push(op); persist(); sync(); }
// Se quita por identidad: mientras una operación viaja, saveSession o patch pueden haber reordenado la cola
function drop(op) { const i = queue.indexOf(op); if (i >= 0) queue.splice(i, 1); }
// La sincronización reemplaza los objetos de «cards»; quien guardó una referencia vieja debe tocar la vigente
const live = (card) => cards.find((c) => c.id === card.id) || card;
let previewAt = null;   // momento del último preview: así el botón agenda exactamente lo que mostró

async function sync() {
  if (!sb || syncing) return syncing;
  syncing = (async () => {
    const { data: s } = await sb.auth.getSession();
    if (!s?.session) return;
    // Lo local es de quien lo creó: si entra otra cuenta sin haber cerrado sesión, no se sube a su nombre
    const uid = s.session.user.id, owner = load(K.owner, null);
    if (owner && owner !== uid) { console.warn("Otra cuenta en este teléfono: descarto la cola local", queue.length); queue = []; cards = []; persist(); }
    if (owner !== uid) save(K.owner, uid);
    // 1) subir la cola en orden; si algo falla, se reintenta luego
    while (queue.length) {
      const op = queue[0];
      let error = null;
      if (op.op === "upsert") ({ error } = await sb.from(op.table).upsert(op.row));
      else if (op.op === "update") {
        let q = sb.from(op.table).update(op.patch).eq("id", op.id);
        // Un teléfono que sube tarde no debe pisar un repaso más reciente hecho en otro
        if (op.table === "tarjetas" && op.patch.last_review) q = q.or(`last_review.is.null,last_review.lte."${op.patch.last_review}"`);
        ({ error } = await q);
      }
      if (error) {
        // Solo se descarta lo que el servidor rechaza por los datos mismos (clases 22 y 23 de Postgres).
        // Caídas, sesión vencida o esquema desactualizado se reintentan: esos errores no dicen que el dato sea malo.
        if (/^(22|23)/.test(error.code || "")) { console.warn("Descarto operación inválida", op, error); drop(op); persist(); continue; }
        // Si el servidor la sigue rechazando una semana después, no debe frenar para siempre todo lo que viene detrás
        if (error.code) {
          op.falla_desde = op.falla_desde || Date.now();
          if (Date.now() - op.falla_desde > 7 * 864e5) { console.warn("Descarto operación rechazada 7 días", op, error); drop(op); persist(); continue; }
          save(K.queue, queue);
        }
        return;
      }
      drop(op); save(K.queue, queue);
    }
    // 2) bajar las tarjetas (fuente de verdad: el servidor, más lo que esté pendiente)
    const { data, error } = await sb.from("tarjetas").select("*").eq("archivada", false).order("due", { ascending: true }).limit(2000);
    if (error) return;
    const pendingIds = new Set(queue.filter((o) => o.table === "tarjetas").map((o) => o.row?.id || o.id));
    const local = new Map(cards.map((c) => [c.id, c]));
    cards = data.map((r) => (pendingIds.has(r.id) ? local.get(r.id) || r : r));
    for (const c of local.values()) if (pendingIds.has(c.id) && !cards.find((x) => x.id === c.id)) cards.push(c);
    save(K.syncedAt, Date.now());
    persist();
  })().catch((e) => console.warn("sync", e)).finally(() => { syncing = null; });
  return syncing;
}

const Datos = {
  init(client) { sb = client; sync(); window.addEventListener("online", sync); setInterval(sync, 60_000); },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  sync,
  pendingWrites: () => queue.length,
  all: () => cards.filter((c) => !c.archivada),
  due(now = new Date()) { return cards.filter((c) => !c.archivada && new Date(c.due) <= now).sort((a, b) => new Date(a.due) - new Date(b.due)); },

  // Guarda una corrección de la conversación como tarjeta (sin duplicar la misma forma correcta)
  addFromCorrection({ escena, dijiste, correcta, nativo, tip, contexto }) {
    const target = correcta || nativo;
    if (!target) return null;
    if (cards.some((c) => !c.archivada && norm(c.correcta) === norm(target))) return null;
    const now = new Date();
    const row = {
      id: uuid(), origen: "correccion", escena: escena || null, dijiste: dijiste || null,
      correcta: target, nativo: correcta && nativo ? nativo : null, tip: tip || null, contexto: contexto || null,
      ...fromFsrs(F.createEmptyCard(now)), archivada: false, creado: now.toISOString(),
    };
    cards.push(row);
    enqueue({ op: "upsert", table: "tarjetas", row });
    return row;
  },

  // Registra un repaso: rating 1=Otra vez 2=Difícil 3=Bien 4=Fácil
  review(card0, rating, { dicho = null, similitud = null } = {}) {
    const card = live(card0);
    const now = new Date();
    // El azar de FSRS depende del momento: se usa el del preview para que coincida con lo que decía el botón
    const at = previewAt?.id === card.id && now - previewAt.now < 600_000 ? previewAt.now : now;
    const res = sched.next(toFsrs(card), at, rating);
    const patch = fromFsrs(res.card);
    Object.assign(card, patch);
    enqueue({ op: "update", table: "tarjetas", id: card.id, patch });
    enqueue({ op: "upsert", table: "repasos", row: { id: uuid(), tarjeta_id: card.id, rating, dicho, similitud, estado_prev: res.log.state, repasado: now.toISOString() } });
    return res.card;
  },
  // Próximo intervalo de cada botón, para mostrarlo («Bien · 3 d»)
  preview(card) {
    const now = new Date();
    previewAt = { id: card.id, now };
    const out = {};
    const all = sched.repeat(toFsrs(card), now);
    for (const r of [1, 2, 3, 4]) out[r] = all[r].card.due;
    return out;
  },
  archive(card0) {
    const card = live(card0);
    card.archivada = true;
    enqueue({ op: "update", table: "tarjetas", id: card.id, patch: { archivada: true } });
  },

  // Tarjeta de una expresión de video (u otra fuente): mismo FSRS, sin duplicados
  addCard({ origen = "video", escena = null, correcta, nativo = null, tip = null, contexto = null }) {
    if (!correcta || cards.some((c) => !c.archivada && norm(c.correcta) === norm(correcta))) return null;
    const now = new Date();
    const row = { id: uuid(), origen, escena, dijiste: null, correcta, nativo, tip, contexto,
      ...fromFsrs(F.createEmptyCard(now)), archivada: false, creado: now.toISOString() };
    cards.push(row);
    enqueue({ op: "upsert", table: "tarjetas", row });
    return row;
  },
  has: (texto) => cards.some((c) => !c.archivada && norm(c.correcta) === norm(texto)),
  // Escrituras genéricas con la misma cola offline (test, lecciones, pronunciación, perfil)
  put(table, row) { enqueue({ op: "upsert", table, row: { ...row } }); },
  patch(table, id, patch) {
    queue = queue.filter((o) => !(o.op === "update" && o.table === table && o.id === id && table !== "tarjetas"));
    enqueue({ op: "update", table, id, patch: { ...patch } });
  },
  uuid,

  // Sesión de conversación: se crea al empezar y se actualiza (upsert) varias veces
  newSession(escena) { return { id: uuid(), escena, inicio: new Date().toISOString(), turnos: 0, palabras_jose: 0, palabras_pers: 0, stt_segundos: 0, tts_caracteres: 0, tokens: {}, latencias: [], nivel_estimado: null }; },
  saveSession(row) {
    // reemplaza una actualización pendiente de la misma sesión en vez de acumularlas
    queue = queue.filter((o) => !(o.table === "sesiones" && o.row?.id === row.id));
    enqueue({ op: "upsert", table: "sesiones", row: { ...row } });
  },
};
window.Datos = Datos;
})();
