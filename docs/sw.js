// Caché de la app: los archivos propios van primero a la red (siempre la última versión) y caen a caché sin conexión.
const CACHE = "sala-v48";
const SHELL = ["./", "index.html", "styles.css", "app.js", "config.js", "scenes.js", "datos.js", "repaso.js", "estudio.js", "preparacion.js", "banco.json", "manifest.webmanifest", "icon-180.png", "icon-512.png"];
// Librerías con versión fija: caché aparte, sin versión, que no se borra al publicar (sin ellas la app no arranca offline)
const LIBS = "sala-libs";
const CDN = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js",
  "https://cdn.jsdelivr.net/npm/microsoft-cognitiveservices-speech-sdk@1.40.0/distrib/browser/microsoft.cognitiveservices.speech.sdk.bundle-min.js",
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort.js",
  "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.22/dist/bundle.min.js",
  "https://cdn.jsdelivr.net/npm/ts-fsrs@5.4.2/dist/index.umd.js",
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Nunca hace fallar la instalación: lo que no baje ahora se guarda la primera vez que la página lo pida
const precacheLibs = () => caches.open(LIBS).then((c) => Promise.race([
  Promise.allSettled(CDN.map((u) => c.match(u).then((hit) => hit || c.add(new Request(u, { mode: "cors" }))))),
  wait(20000),
])).catch(() => {});

self.addEventListener("install", (e) => {
  // cache: "reload" salta la caché HTTP de GitHub Pages (10 min) para instalar siempre la versión nueva
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(precacheLibs).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== LIBS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === location.origin) {
    if (url.pathname.includes("/entrevista")) return;   // la página pública la sirve el navegador directamente
    const nav = e.request.mode === "navigate";
    // Abrir desde una notificación trae ?leccion=…: sin conexión sirve la misma app
    const fromCache = () => caches.match(e.request, nav ? { ignoreSearch: true } : undefined).then((hit) => hit || (nav ? caches.match("index.html") : undefined));
    // por URL: una petición de navegación no admite opciones nuevas; no-cache = siempre revalida con el servidor
    const net = fetch(e.request.url, { cache: "no-cache" }).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    });
    e.waitUntil(net.catch(() => {}));
    // Con señal débil no se espera indefinidamente: a los 3 s sirve la copia, y si no hay copia sigue esperando la red
    const late = wait(3000).then(fromCache).then((hit) => hit || net);
    e.respondWith(Promise.race([net.catch(fromCache), late]));
  } else if (url.hostname === "cdn.jsdelivr.net") {
    // Librerías con versión fija: caché primero.
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request.url, { mode: "cors" }).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(LIBS).then((c) => c.put(e.request.url, copy)); }
      return r;
    })));
  }
});

// Notificaciones: «tu lección está lista». Al tocarla se abre la app en esa lección.
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Sala de Ensayo", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Sala de Ensayo", {
    body: d.body || "", icon: "icon-180.png", badge: "icon-180.png", tag: d.leccion || "sala", data: { leccion: d.leccion || null },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = e.notification.data?.leccion;
  const url = new URL(id ? `./?leccion=${encodeURIComponent(id)}` : "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if ("focus" in c) { if (id) c.postMessage({ abrirLeccion: id }); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
