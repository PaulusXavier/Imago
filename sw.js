// "remote-cache-v7": alem de mudar o SW/app.js/index.html, o numero da
// versao do cache foi incrementado de proposito, pra forcar quem ja tinha
// instalado o app a baixar os arquivos novos (inclui o botao de instalar).
// Da proxima vez que o app mudar de verdade, o proprio "fetch" abaixo ja
// atualiza o cache sozinho quando online -- so precisa bumpar esse numero
// se quiser forcar uma atualizacao imediata pra quem esta offline ha muito
// tempo com uma versao bem antiga em cache.
const CACHE_NAME = 'remote-cache-v13';
const ASSETS = ['./', './index.html', './app.js', './capacitor.js', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'];

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
  const req = event.request;
  // So mexe em GET do proprio site (WebSocket nem passa por aqui). Outros
  // metodos/origens seguem direto para a rede, sem tentar cachear.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // A chave do cache ignora a query string: o link do QR traz ?ip=&token=...
  // diferente a cada vez, o que criava uma entrada nova a cada leitura (e
  // deixava o codigo de seguranca guardado no cache sem necessidade).
  const key = new Request(url.origin + url.pathname);

  event.respondWith(
    fetch(req)
      .then((response) => {
        // So guarda respostas completas e bem-sucedidas (nada de 404/206).
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(key, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches
          .match(key)
          .then((cached) => cached || caches.match('./index.html'))
          .then((cached) => cached || Response.error())
      )
  );
});
