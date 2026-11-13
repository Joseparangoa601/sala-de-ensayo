// Registro de fallos: anota en la base lo que falló (errores del navegador, funciones que no respondieron, avisos de fallo).
// Carga antes que todo para ver también si una librería no cargó. No guarda lo que la persona dijo ni escribió.
(() => {
  const TOPE = 30, cola = [], vistos = new Map();
  const visita = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  const movil = /Mobi|Android|iPhone/i.test(navigator.userAgent);
  let sb = null, enviados = 0, version = null;
  // La versión publicada sale del nombre de la caché del service worker (sala-vNN): no hay que actualizarla a mano
  if (window.caches) caches.keys().then((ks) => { const k = ks.find((x) => /^sala-v\d+/.test(x)); if (k) version = k.slice(5); }).catch(() => {});
  const enLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // Quita direcciones con parámetros y correos del texto técnico
  const limpio = (t) => String(t ?? "").replace(/https?:\/\/[^\s)"']+/g, (u) => u.split(/[?#]/)[0]).replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, "[correo]").slice(0, 300);
  const pantalla = () => document.querySelector(".screen:not([hidden])")?.id || null;

  function registrar(origen, donde, codigo, detalle) {
    if (enviados + cola.length >= TOPE) return;
    const clave = `${origen}|${donde}|${codigo}`, ahora = Date.now();
    if (ahora - (vistos.get(clave) || 0) < 60_000) return;   // el mismo fallo repetido en un minuto cuenta una vez
    vistos.set(clave, ahora);
    cola.push({ visita, origen, donde: String(donde || "?").slice(0, 60), codigo: codigo == null ? null : String(codigo).slice(0, 60), detalle: limpio(detalle) || null, pantalla: pantalla(), movil });
    if (enLocal) console.info("[fallo]", cola[cola.length - 1]);
    setTimeout(enviar, 1500);
  }
  async function enviar() {
    if (!sb || !cola.length || enLocal) return;
    let uid = null;
    try { uid = (await sb.auth.getSession()).data?.session?.user?.id ?? null; } catch {}
    const lote = cola.splice(0).map((f) => ({ ...f, user_id: uid, version }));
    enviados += lote.length;
    try { await sb.from("fallos").insert(lote); } catch {}   // si falla anotar el fallo, no se insiste
  }

  // Errores de código y promesas sin atender
  addEventListener("error", (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) return registrar("recurso", limpio(t.src || t.href).split("/").pop() || t.tagName, "no_cargo", t.src || t.href);
    registrar("navegador", (e.filename || "").split("/").pop() || "?", e.message?.slice(0, 60), `${e.message} @${e.lineno}:${e.colno}`);
  }, true);
  addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    if (r?.name === "AbortError") return;
    registrar("navegador", "promesa", r?.code || r?.name || "rechazo", r?.message || (typeof r === "object" ? JSON.stringify(r) : r));
  });

  // Solo los avisos que cuentan un fallo (no los de «elige una fecha» o «te quedan 10 minutos»)
  const ES_FALLO = /^(No pude|No se pudo|No hubo respuesta|No escuché|No diste permiso|La lección se creó, pero|Está tardando|La voz (no|del personaje)|El personaje no respondió|El audio del teléfono)/;
  window.Fallos = {
    registrar,
    aviso(msg) { const t = String(msg || "").trim(); if (ES_FALLO.test(t)) registrar("aviso", pantalla() || "?", t.slice(0, 40), t); },
    conectar(cliente) { sb = cliente; enviar(); },
  };
})();
