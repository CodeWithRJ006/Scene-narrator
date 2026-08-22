const CACHE_NAME = 'insight-lens-v1';

self.addEventListener('install', (e) => {
    // Skip waiting to activate immediately
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll([
                '/',
                '/index.html',
                '/manifest.json'
            ]);
        })
    );
});

self.addEventListener('activate', (e) => {
    // Take control of all pages immediately
    e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
    // Exclude Gemini and HF API calls from being cached
    if (e.request.url.includes('generativelanguage.googleapis.com') || 
        e.request.url.includes('api-inference.huggingface.co')) {
        return;
    }

    e.respondWith(
        caches.match(e.request).then((response) => {
            if (response) return response;
            
            return fetch(e.request).then((res) => {
                // Dynamically cache TFJS models and app assets
                if (e.request.url.includes('tfjs-models') || 
                    e.request.url.includes('storage.googleapis.com') ||
                    e.request.url.includes('unpkg.com') ||
                    e.request.destination === 'script' ||
                    e.request.destination === 'style') {
                    
                    const resClone = res.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(e.request, resClone);
                    });
                }
                return res;
            }).catch(err => {
                console.warn('Network fetch failed, and not in cache:', e.request.url);
                throw err;
            });
        })
    );
});
