/* =====================================================================
   Cuentas Claras - Service Worker
   v3: cache + alarmas que funcionan con la app CERRADA
   ===================================================================== */
const CACHE_NAME  = "cuentas-claras-v4";
const ALARM_CACHE = "cuentas-claras-alarmas";
const ALARM_KEY   = "/__cc_alarmas__";
const PERIODIC_TAG = "cc-revisar-alarmas";

const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png",
  "./icons/breb-logo.png"
];

/* ------------------------- INSTALL / ACTIVATE ------------------------ */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_NAME && k !== ALARM_CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
    // al despertar el SW, revisa si quedó algún recordatorio pendiente
    await revisarAlarmas("activate");
  })());
});

/* ------------------------ ALMACEN DE ALARMAS ------------------------- */
async function leerDatos(){
  try{
    const c = await caches.open(ALARM_CACHE);
    const r = await c.match(ALARM_KEY);
    if(!r) return { alarmas: [], ultimos: {} };
    const d = await r.json();
    return { alarmas: Array.isArray(d.alarmas) ? d.alarmas : [], ultimos: d.ultimos || {} };
  }catch(e){ return { alarmas: [], ultimos: {} }; }
}
async function guardarDatos(d){
  try{
    const c = await caches.open(ALARM_CACHE);
    await c.put(ALARM_KEY, new Response(JSON.stringify(d), {
      headers: { "Content-Type": "application/json" }
    }));
  }catch(e){}
}

/* --------------------- CALCULO DE OCURRENCIAS ------------------------ */
function diasDelMes(y, m){ return new Date(y, m + 1, 0).getDate(); }
function horaDe(a){
  const p = String(a.hora || "20:00").split(":");
  return { hh: parseInt(p[0]) || 0, mm: parseInt(p[1]) || 0 };
}

/* La siguiente vez que DEBE sonar (posterior a "desde") */
function proximaOcurrencia(a, desde){
  if(!a || !a.activa) return null;
  const { hh, mm } = horaDe(a);
  const base = new Date(desde.getTime());
  let d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm, 0, 0);

  if(a.frecuencia === "semanal"){
    const objetivo = Number(a.diaSemana) || 0;
    d.setDate(d.getDate() + ((objetivo - d.getDay() + 7) % 7));
    if(d <= base) d.setDate(d.getDate() + 7);
    return d;
  }
  if(a.frecuencia === "mensual"){
    const pedido = Number(a.diaMes) || 1;
    d.setDate(Math.min(pedido, diasDelMes(d.getFullYear(), d.getMonth())));
    if(d <= base){
      const y = d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear();
      const m = (d.getMonth() + 1) % 12;
      d = new Date(y, m, Math.min(pedido, diasDelMes(y, m)), hh, mm, 0, 0);
    }
    return d;
  }
  if(d <= base) d.setDate(d.getDate() + 1);
  return d;
}

/* La ULTIMA vez que debio sonar (anterior o igual a "ahora").
   Sirve para detectar recordatorios que se perdieron. */
function ocurrenciaAnterior(a, ahora){
  if(!a || !a.activa) return null;
  const { hh, mm } = horaDe(a);
  let d = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), hh, mm, 0, 0);

  if(a.frecuencia === "semanal"){
    const objetivo = Number(a.diaSemana) || 0;
    d.setDate(d.getDate() - ((d.getDay() - objetivo + 7) % 7));
    if(d > ahora) d.setDate(d.getDate() - 7);
    return d;
  }
  if(a.frecuencia === "mensual"){
    const pedido = Number(a.diaMes) || 1;
    d.setDate(Math.min(pedido, diasDelMes(d.getFullYear(), d.getMonth())));
    if(d > ahora){
      const y = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
      const m = (d.getMonth() + 11) % 12;
      d = new Date(y, m, Math.min(pedido, diasDelMes(y, m)), hh, mm, 0, 0);
    }
    return d;
  }
  if(d > ahora) d.setDate(d.getDate() - 1);
  return d;
}

/* ------------------------- MOSTRAR AVISOS ---------------------------- */
function opcionesAviso(a, extra){
  return Object.assign({
    body: a.mensaje || "Registra tus gastos de hoy en Cuentas Claras.",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: "cc-alarma-" + a.id,
    renotify: true,
    requireInteraction: false,
    data: { alarmaId: a.id, url: "./index.html" }
  }, extra || {});
}

async function avisar(a){
  try{
    await self.registration.showNotification("💚 " + (a.nombre || "Cuentas Claras"), opcionesAviso(a));
    return true;
  }catch(e){ return false; }
}

/* ------- PROGRAMAR CON ANTICIPACION (Notification Triggers) ---------- */
/* Si el navegador soporta showTrigger, dejamos las proximas ocurrencias
   ya "cargadas" en el sistema: suenan aunque la app este cerrada y
   aunque el telefono este sin internet. */
function soportaTriggers(){
  try{ return typeof TimestampTrigger !== "undefined" && "showTrigger" in Notification.prototype; }
  catch(e){ return false; }
}

async function reprogramarTriggers(alarmas){
  if(!soportaTriggers()) return false;
  // limpia lo ya programado
  try{
    const previas = await self.registration.getNotifications({ includeTriggered: true });
    previas.forEach(n => { if(n.tag && n.tag.indexOf("cc-trigger-") === 0) n.close(); });
  }catch(e){}

  const ahora = new Date();
  for(const a of alarmas){
    if(!a.activa) continue;
    let cursor = new Date(ahora.getTime());
    // programa las proximas 8 ocurrencias de cada alarma
    for(let i = 0; i < 8; i++){
      const p = proximaOcurrencia(a, cursor);
      if(!p) break;
      try{
        await self.registration.showNotification(
          "💚 " + (a.nombre || "Cuentas Claras"),
          opcionesAviso(a, {
            tag: "cc-trigger-" + a.id + "-" + p.getTime(),
            showTrigger: new TimestampTrigger(p.getTime())
          })
        );
      }catch(e){ return false; }
      cursor = new Date(p.getTime() + 1000);
    }
  }
  return true;
}

/* ----------------- REVISION (respaldo sin triggers) ------------------ */
const TOLERANCIA_MS = 26 * 60 * 60 * 1000; // no avisa cosas de hace mas de ~1 dia

async function revisarAlarmas(motivo){
  const datos = await leerDatos();
  if(!datos.alarmas.length) return;

  const ahora = new Date();
  let cambio = false;

  for(const a of datos.alarmas){
    if(!a.activa) continue;
    const debio = ocurrenciaAnterior(a, ahora);
    if(!debio) continue;
    const t = debio.getTime();
    const yaAvisado = Number(datos.ultimos[a.id] || 0);
    if(t > yaAvisado && (ahora.getTime() - t) <= TOLERANCIA_MS){
      const ok = await avisar(a);
      if(ok){ datos.ultimos[a.id] = t; cambio = true; }
    } else if(t > yaAvisado){
      // demasiado viejo: solo lo marca para no acumular avisos rancios
      datos.ultimos[a.id] = t; cambio = true;
    }
  }
  if(cambio) await guardarDatos(datos);
  await reprogramarTriggers(datos.alarmas);
}

/* --------------------------- EVENTOS --------------------------------- */
self.addEventListener("periodicsync", (event) => {
  if(event.tag === PERIODIC_TAG) event.waitUntil(revisarAlarmas("periodicsync"));
});

self.addEventListener("sync", (event) => {
  if(event.tag === PERIODIC_TAG) event.waitUntil(revisarAlarmas("sync"));
});

/* La app manda su lista de alarmas cada vez que cambia */
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if(msg.tipo === "CC_ALARMAS"){
    event.waitUntil((async () => {
      const previo = await leerDatos();
      const nuevos = {};
      (msg.alarmas || []).forEach(a => {
        // conserva el "ya avisado" de las alarmas que siguen existiendo
        if(previo.ultimos[a.id]) nuevos[a.id] = previo.ultimos[a.id];
      });
      await guardarDatos({ alarmas: msg.alarmas || [], ultimos: nuevos });
      await revisarAlarmas("mensaje");
    })());
  }
  if(msg.tipo === "CC_REVISAR"){
    event.waitUntil(revisarAlarmas("mensaje-revisar"));
  }
  if(msg.tipo === "CC_PING"){
    event.waitUntil((async () => {
      const cs = await self.clients.matchAll({ includeUncontrolled: true });
      cs.forEach(c => c.postMessage({ tipo: "CC_PONG", triggers: soportaTriggers() }));
    })());
  }
});

/* Si llegara a haber push en el futuro, ya queda listo */
self.addEventListener("push", (event) => {
  let d = {};
  try{ d = event.data ? event.data.json() : {}; }catch(e){}
  event.waitUntil(self.registration.showNotification(
    d.titulo || "💚 Cuentas Claras",
    { body: d.cuerpo || "Registra tus gastos de hoy.", icon: "icons/icon-192.png", badge: "icons/icon-192.png" }
  ));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((lista) => {
      for(const c of lista){ if("focus" in c) return c.focus(); }
      if(clients.openWindow) return clients.openWindow("./index.html");
    })
  );
});

/* ---------------------------- FETCH ---------------------------------- */
/* Navegacion: red primero (asi SI recibes las actualizaciones que subas
   a Netlify), con el cache como respaldo si no hay internet.
   Resto: cache primero. */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if(req.method !== "GET") return;

  const esNavegacion = req.mode === "navigate" ||
    (req.destination === "document") ||
    (req.headers.get("accept") || "").includes("text/html");

  if(esNavegacion){
    event.respondWith(
      fetch(req).then((res) => {
        const copia = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copia)).catch(()=>{});
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      return cached || fetch(req).then((res) => {
        const copia = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copia)).catch(()=>{});
        return res;
      }).catch(() => cached);
    })
  );
});
