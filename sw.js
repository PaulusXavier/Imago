// "remote-cache-v7": alem de mudar o SW/app.js/index.html, o numero da
// versao do cache foi incrementado de proposito, pra forcar quem ja tinha
// instalado o app a baixar os arquivos novos (inclui o botao de instalar).
// Da proxima vez que o app mudar de verdade, o proprio "fetch" abaixo ja
// atualiza o cache sozinho quando online -- so precisa bumpar esse numero
// se quiser forcar uma atualizacao imediata pra quem esta offline ha muito
// tempo com uma versao bem antiga em cache.
const CACHE_NAME = 'remote-cache-v7';
const ASSETS = ['./', './index.html', './app.js', './capacitor.js', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estrategia "rede primeiro, cache como reserva": enquanto tiver internet,
// sempre busca a versao mais nova (e atualiza o cache com ela sozinho, sem
// precisar mudar CACHE_NAME toda vez) -- e so cai pro cache quando a rede
// falhar de verdade (uso offline, que este app precisa suportar).
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});
