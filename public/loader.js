// Load the pinned module before the classic atlas client; keep text fallback on failure.
const atlasClientUrl = document.currentScript.dataset.app;
import('/vendor/maplibre-6.4.1/maplibre-gl.mjs')
  .then((library) => { window.maplibregl = library; })
  .catch((error) => { console.error('MapLibre module unavailable', error); })
  .finally(() => {
    const script = document.createElement('script');
    script.src = atlasClientUrl;
    document.body.appendChild(script);
  });
