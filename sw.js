const cacheName="qigou-v9";
const assets=["./","./styles.css?v=9","./app.js?v=9","./embed.js","./icon.svg","./manifest.webmanifest"];
self.addEventListener("install",event=>event.waitUntil(Promise.all([caches.open(cacheName).then(cache=>cache.addAll(assets)),self.skipWaiting()])));
self.addEventListener("activate",event=>event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==cacheName).map(key=>caches.delete(key)))),self.clients.claim()])));
self.addEventListener("fetch",event=>{if(event.request.method!=="GET"||new URL(event.request.url).pathname.includes("/api/"))return;event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(cacheName).then(cache=>cache.put(event.request,copy));return response}).catch(()=>caches.match(event.request)))});
