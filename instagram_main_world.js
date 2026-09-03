// ============================================================================
// Instagram Downloader Pro - Main World Script
// Executado no contexto MAIN da página para acesso direto ao React Fiber e Cache de Mídia
// ============================================================================

(function () {
  'use strict';

  if (window.__INSTA_MAIN_WORLD_INJECTED__) return;
  window.__INSTA_MAIN_WORLD_INJECTED__ = true;

  // Cache de mídias extraídas (chave: shortcode ou URL parcial)
  const mediaCache = new Map();
  let latestVideoUrl = null;

  /**
   * Varre recursivamente um objeto JSON para extrair URLs de vídeo e fotos
   */
  function harvestMediaFromObject(obj, depth = 0) {
    if (!obj || depth > 12) return;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        harvestMediaFromObject(item, depth + 1);
      }
      return;
    }

    if (typeof obj !== 'object') return;

    // Detecta shortcode do post
    const code = obj.code || obj.shortcode || null;

    // Detecta URLs de vídeo
    let videoUrl = null;
    if (typeof obj.video_url === 'string' && obj.video_url.startsWith('http')) {
      videoUrl = obj.video_url;
    } else if (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) {
      // Pega a versão de maior largura
      const sorted = [...obj.video_versions].sort((a, b) => (b.width || 0) - (a.width || 0));
      if (sorted[0] && sorted[0].url) {
        videoUrl = sorted[0].url;
      }
    } else if (typeof obj.progressive_download_url === 'string' && obj.progressive_download_url.startsWith('http')) {
      videoUrl = obj.progressive_download_url;
    } else if (typeof obj.browser_native_hd_url === 'string' && obj.browser_native_hd_url.startsWith('http')) {
      videoUrl = obj.browser_native_hd_url;
    } else if (typeof obj.browser_native_sd_url === 'string' && obj.browser_native_sd_url.startsWith('http')) {
      videoUrl = obj.browser_native_sd_url;
    }

    if (videoUrl) {
      latestVideoUrl = videoUrl;
      if (code) {
        mediaCache.set(code, { type: 'video', url: videoUrl, ext: 'mp4' });
      }
    }

    // Detecta URLs de imagem de alta resolução
    if (Array.isArray(obj.candidates) && obj.candidates.length > 0 && code) {
      const sortedImgs = [...obj.candidates].sort((a, b) => (b.width || 0) - (a.width || 0));
      if (sortedImgs[0] && sortedImgs[0].url) {
        if (!mediaCache.has(code)) {
          mediaCache.set(code, { type: 'image', url: sortedImgs[0].url, ext: 'jpg' });
        }
      }
    }

    // Continua varrendo propriedades
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        harvestMediaFromObject(obj[key], depth + 1);
      }
    }
  }

  // =========================================================================
  // Interceptação Passiva de Respostas do Fetch (Sem disparar novas requisições)
  // =========================================================================
  try {
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (
          url.includes('/graphql') ||
          url.includes('/api/v1/') ||
          url.includes('xdt_api') ||
          url.includes('/feed/') ||
          url.includes('/reel/') ||
          url.includes('instagram.com')
        ) {
          const clone = response.clone();
          clone.text().then(txt => {
            try {
              const data = JSON.parse(txt);
              harvestMediaFromObject(data);
            } catch (e) {}
          }).catch(() => {});
        }
      } catch (e) {}
      return response;
    };
  } catch (e) {}

  // =========================================================================
  // Extração via Árvore Interna do React Fiber
  // =========================================================================
  function extractFromFiberTree(el) {
    if (!el) return null;
    try {
      const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (!fiberKey) return null;

      let curr = el[fiberKey];
      let depth = 0;

      while (curr && depth < 35) {
        const props = curr.memoizedProps;
        if (props) {
          if (typeof props.video_url === 'string' && props.video_url.startsWith('http')) {
            return { type: 'video', url: props.video_url, ext: 'mp4' };
          }
          if (Array.isArray(props.video_versions) && props.video_versions[0]?.url) {
            return { type: 'video', url: props.video_versions[0].url, ext: 'mp4' };
          }
          if (props.video && Array.isArray(props.video.video_versions) && props.video.video_versions[0]?.url) {
            return { type: 'video', url: props.video.video_versions[0].url, ext: 'mp4' };
          }
          if (props.item && Array.isArray(props.item.video_versions) && props.item.video_versions[0]?.url) {
            return { type: 'video', url: props.item.video_versions[0].url, ext: 'mp4' };
          }
          if (props.post && Array.isArray(props.post.video_versions) && props.post.video_versions[0]?.url) {
            return { type: 'video', url: props.post.video_versions[0].url, ext: 'mp4' };
          }
          if (typeof props.src === 'string' && props.src.startsWith('http') && !props.src.startsWith('blob:')) {
            const isVideo = props.src.includes('.mp4') || props.src.includes('/v/');
            return { type: isVideo ? 'video' : 'image', url: props.src, ext: isVideo ? 'mp4' : 'jpg' };
          }
        }
        curr = curr.return;
        depth++;
      }
    } catch (e) {}
    return null;
  }

  // =========================================================================
  // Ouvinte de Mensagens do Content Script (Mundo Isolado)
  // =========================================================================
  window.addEventListener('INSTA_EXTRACT_REQUEST', (event) => {
    const detail = event.detail || {};
    const requestId = detail.requestId;
    const shortcode = detail.shortcode;
    const elementId = detail.elementId;

    let result = null;

    // 1. Tenta buscar no cache por shortcode
    if (shortcode && mediaCache.has(shortcode)) {
      result = mediaCache.get(shortcode);
    }

    // 2. Tenta extrair via React Fiber do elemento indicado
    if (!result && elementId) {
      const el = document.querySelector(`[data-insta-id="${elementId}"]`);
      if (el) {
        result = extractFromFiberTree(el);
        if (!result) {
          const video = el.querySelector('video');
          if (video) result = extractFromFiberTree(video);
        }
      }
    }

    // 3. Fallback: Se for vídeo ativo e tivermos o último vídeo interceptado
    if (!result && latestVideoUrl) {
      result = { type: 'video', url: latestVideoUrl, ext: 'mp4' };
    }

    // Devolve o resultado ao script de conteúdo isolado
    window.dispatchEvent(new CustomEvent('INSTA_EXTRACT_RESPONSE', {
      detail: {
        requestId: requestId,
        result: result
      }
    }));
  });

  console.log('[Instagram Downloader] Main World interceptor ativo.');
})();
