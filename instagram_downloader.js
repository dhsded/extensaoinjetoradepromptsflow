// ============================================================================
// Instagram Downloader Pro - Script de Conteúdo Dedicado (Content Script)
// Download de Vídeos (Reels/Feed) e Fotos com Blindagem Anti-Bloqueio da Meta
// ============================================================================

(function () {
  'use strict';

  // Executa exclusivamente no domínio do Instagram
  if (!window.location.hostname.includes('instagram.com')) return;

  if (window.__INSTAGRAM_DOWNLOADER_INITIALIZED__) return;
  window.__INSTAGRAM_DOWNLOADER_INITIALIZED__ = true;

  console.log('[Instagram Downloader Pro] Módulo inicializado com proteção anti-bloqueio.');

  // =========================================================================
  // Configurações e Estado Local
  // =========================================================================
  const CONFIG = {
    downloadFolder: 'Instagram_Downloads',
    baseDelayMs: 3800,        // Atraso base entre mídias (3.8 segundos)
    jitterVarianceMs: 2800,   // Variação randômica (+0 a 2.8 segundos)
    cooldownEveryN: 6,        // Pausa estendida a cada 6 mídias baixadas
    cooldownSeconds: 20,      // Duração da pausa de resfriamento (20 segundos)
    scrollStepPx: 450         // Rolagem gradual humana
  };

  const processedMediaUrls = new Set();
  let isBatchRunning = false;
  let isPaused = false;
  let cancelRequested = false;
  let batchTotalCount = 0;
  let batchCompletedCount = 0;

  // =========================================================================
  // Comunicação Segura com o Background Worker
  // =========================================================================
  function safeSendMessage(message, callback) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        console.warn('[Instagram Downloader] Contexto descarregado. Atualize a página (F5).');
        return;
      }
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) return;
        if (typeof callback === 'function') callback(res);
      });
    } catch (e) {
      // Ignora desconexões transitórias
    }
  }

  // =========================================================================
  // Sistema de Notificações Toast
  // =========================================================================
  function showToast(message, type = 'info', duration = 3500) {
    const existing = document.querySelector('.insta-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `insta-toast ${type}`;
    toast.innerHTML = `
      <span style="font-size: 15px;">${type === 'success' ? '✅' : type === 'warning' ? '⚠️' : 'ℹ️'}</span>
      <span>${message}</span>
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(12px) scale(0.96)';
      toast.style.transition = 'all 0.25s ease';
      setTimeout(() => toast.remove(), 260);
    }, duration);
  }

  // =========================================================================
  // Utilitários de Extração Passiva do DOM (Zero Requisições a APIs da Meta)
  // =========================================================================

  /**
   * Extrai a URL com maior resolução a partir de um atributo srcset
   * @param {string} srcset 
   * @returns {string|null}
   */
  function getBestFromSrcset(srcset) {
    if (!srcset) return null;
    try {
      const candidates = srcset.split(',').map(item => {
        const parts = item.trim().split(/\s+/);
        const url = parts[0];
        const width = parts[1] ? parseInt(parts[1].replace('w', ''), 10) : 0;
        return { url, width };
      });
      candidates.sort((a, b) => b.width - a.width);
      return candidates[0] ? candidates[0].url : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Tenta extrair a URL de vídeo original via React Fiber / Props
   * caso a tag <video> use blob:
   * @param {HTMLElement} element 
   * @returns {string|null}
   */
  function extractVideoUrlFromReactProps(element) {
    if (!element) return null;
    try {
      // Busca chaves do React internas no elemento ou em pais próximos
      let curr = element;
      let depth = 0;
      while (curr && depth < 6) {
        const fiberKey = Object.keys(curr).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$') || k.startsWith('__reactInternalInstance$'));
        if (fiberKey && curr[fiberKey]) {
          const checkObj = (obj, d = 0) => {
            if (!obj || d > 4) return null;
            if (typeof obj.video_url === 'string' && obj.video_url.startsWith('http')) return obj.video_url;
            if (typeof obj.videoUrl === 'string' && obj.videoUrl.startsWith('http')) return obj.videoUrl;
            if (typeof obj.progressive_download_url === 'string') return obj.progressive_download_url;
            if (typeof obj.playback_url === 'string') return obj.playback_url;
            if (obj.memoizedProps) {
              const res = checkObj(obj.memoizedProps, d + 1);
              if (res) return res;
            }
            if (obj.props) {
              const res = checkObj(obj.props, d + 1);
              if (res) return res;
            }
            return null;
          };
          const found = checkObj(curr[fiberKey]);
          if (found) return found;
        }
        curr = curr.parentElement;
        depth++;
      }
    } catch (e) { /* ignora */ }
    return null;
  }

  /**
   * Extrai os metadados e a melhor URL de mídia (Vídeo ou Imagem) de um post/container
   * @param {HTMLElement} postContainer 
   * @returns {{ type: 'video'|'image', url: string, ext: 'mp4'|'jpg', filename: string } | null}
   */
  function extractMediaFromContainer(postContainer) {
    if (!postContainer) return null;

    // 1. Identificação do Autor ou Shortcode para nomenclatura limpa
    let author = 'instagram';
    const authorEl = postContainer.querySelector('header a, a[role="link"]:has(span), a[href*="/p/"]:not(:has(time))');
    if (authorEl) {
      const match = (authorEl.getAttribute('href') || '').match(/^\/([a-zA-Z0-9._]+)\/?$/);
      if (match && !['explore', 'reels', 'stories', 'direct', 'p'].includes(match[1])) {
        author = match[1];
      }
    }

    const shortcodeLink = postContainer.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    let shortcode = '';
    if (shortcodeLink) {
      const sm = (shortcodeLink.getAttribute('href') || '').match(/\/(p|reel)\/([a-zA-Z0-9_-]+)/);
      if (sm) shortcode = sm[2];
    }
    if (!shortcode) {
      shortcode = Date.now().toString().slice(-6);
    }

    // 2. Procura primeiro por elemento de Vídeo (<video>)
    const videoEl = postContainer.querySelector('video');
    if (videoEl) {
      let videoUrl = videoEl.getAttribute('src');
      if (videoUrl && videoUrl.startsWith('http')) {
        return {
          type: 'video',
          url: videoUrl,
          ext: 'mp4',
          filename: `insta_video_${author}_${shortcode}`
        };
      }

      // Se o src for blob:, verifica <source>
      const sourceEl = videoEl.querySelector('source');
      if (sourceEl && sourceEl.getAttribute('src') && sourceEl.getAttribute('src').startsWith('http')) {
        return {
          type: 'video',
          url: sourceEl.getAttribute('src'),
          ext: 'mp4',
          filename: `insta_video_${author}_${shortcode}`
        };
      }

      // Tenta recuperar do React Fiber
      const reactVideoUrl = extractVideoUrlFromReactProps(videoEl) || extractVideoUrlFromReactProps(postContainer);
      if (reactVideoUrl) {
        return {
          type: 'video',
          url: reactVideoUrl,
          ext: 'mp4',
          filename: `insta_video_${author}_${shortcode}`
        };
      }
    }

    // 3. Procura por Imagem (Fotos de Feed, Carrosséis ou capas em alta resolução)
    const imgEls = Array.from(postContainer.querySelectorAll('img[srcset], img[src*="cdninstagram.com"], img[src*="fbcdn.net"], img._aagt, img.x5yr21d')).filter(img => {
      // Ignora avatares de perfil pequenos
      const rect = img.getBoundingClientRect();
      return rect.width > 120 && rect.height > 120;
    });

    if (imgEls.length > 0) {
      const targetImg = imgEls[0];
      const bestUrl = getBestFromSrcset(targetImg.getAttribute('srcset')) || targetImg.getAttribute('src');
      if (bestUrl && bestUrl.startsWith('http')) {
        return {
          type: 'image',
          url: bestUrl,
          ext: 'jpg',
          filename: `insta_foto_${author}_${shortcode}`
        };
      }
    }

    return null;
  }

  // =========================================================================
  // Injeção de Botões Flutuantes (Download Único de 1 Clique)
  // =========================================================================

  function injectOverlayButtons() {
    // Localiza posts individuais no feed, carrosséis, reels ou em modais abertos
    const postCandidates = document.querySelectorAll([
      'article',
      'div[role="dialog"] article',
      'div[role="dialog"]:has(video)',
      'div[role="dialog"]:has(img[srcset])',
      'div[data-pressable-container="true"]',
      'div.x1lliihq:has(video)',
      'div._aagv'
    ].join(', '));

    postCandidates.forEach(card => {
      // Evita duplicatas no mesmo card
      if (card.dataset.instaDlInjected === 'true') return;

      // O card precisa conter uma mídia real com tamanho razoável
      const hasMedia = card.querySelector('video, img[srcset], img[src*="cdninstagram.com"]');
      if (!hasMedia) return;

      const rect = card.getBoundingClientRect();
      if (rect.width < 140 || rect.height < 140) return;

      // Garante posicionamento relativo para o botão absoluto
      const computedPos = window.getComputedStyle(card).position;
      if (computedPos === 'static') {
        card.style.position = 'relative';
      }

      const btn = document.createElement('button');
      btn.className = 'insta-dl-overlay-btn';
      btn.setAttribute('title', 'Baixar este vídeo ou foto (Instagram Downloader Pro)');
      btn.setAttribute('aria-label', 'Baixar mídia');

      const isVideo = card.querySelector('video') !== null;
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          ${isVideo 
            ? '<path d="M12 3v13m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke-linecap="round" stroke-linejoin="round"/>' 
            : '<path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" stroke-linecap="round" stroke-linejoin="round"/>'}
        </svg>
        <span>${isVideo ? 'Vídeo' : 'Foto'}</span>
      `;

      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const media = extractMediaFromContainer(card);
        if (!media || !media.url) {
          showToast('❌ Mídia ainda carregando ou protegida. Tente reproduzir o vídeo primeiro.', 'warning');
          return;
        }

        btn.classList.add('downloading');
        btn.innerHTML = `<div class="insta-dl-spinner"></div><span>Baixando...</span>`;

        safeSendMessage({
          action: 'DOWNLOAD_MEDIA',
          url: media.url,
          filename: media.filename,
          folder: CONFIG.downloadFolder,
          ext: media.ext,
          id: media.url
        }, (res) => {
          btn.classList.remove('downloading');
          if (res && res.success) {
            btn.classList.add('downloaded');
            btn.innerHTML = `
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span>Salvo!</span>
            `;
            showToast(`✅ ${media.type === 'video' ? 'Vídeo' : 'Foto'} enviado para download!`, 'success');

            setTimeout(() => {
              btn.classList.remove('downloaded');
              btn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M12 3v13m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span>${media.type === 'video' ? 'Vídeo' : 'Foto'}</span>
              `;
            }, 3000);
          } else {
            showToast('❌ Falha ao solicitar download ao navegador.', 'warning');
          }
        });
      });

      card.appendChild(btn);
      card.dataset.instaDlInjected = 'true';
    });
  }

  // =========================================================================
  // Motor de Download em Massa com Blindagem Anti-Bloqueio
  // =========================================================================

  /**
   * Executa uma pausa segura calculada com Jitter Humano estocástico
   * @param {number} baseMs - Atraso base em ms
   * @param {number} varianceMs - Variação aleatória em ms
   */
  async function humanJitterDelay(baseMs, varianceMs) {
    const randomExtra = Math.floor(Math.random() * varianceMs);
    const totalMs = baseMs + randomExtra;
    await new Promise(r => setTimeout(r, totalMs));
  }

  /**
   * Simula uma rolagem gradual humana para carregar novas mídias no feed/perfil
   */
  async function smoothScrollDown() {
    const scrollAmount = CONFIG.scrollStepPx + Math.floor(Math.random() * 200 - 100);
    window.scrollBy({
      top: scrollAmount,
      behavior: 'smooth'
    });
    // Aguarda a renderização natural do Instagram
    await humanJitterDelay(1800, 1200);
  }

  /**
   * Inicia o processo de download em massa seguro
   */
  async function startSafeBatchDownload() {
    if (isBatchRunning) return;

    isBatchRunning = true;
    isPaused = false;
    cancelRequested = false;
    batchCompletedCount = 0;

    updateHudUI();
    setHudStatus('🔍 Descobrindo mídias na tela...');

    let consecutiveNoNewMedia = 0;
    let itemsDownloadedInCurrentBlock = 0;

    while (isBatchRunning && !cancelRequested) {
      // 1. Verifica pausa solicitada pelo usuário
      while (isPaused && !cancelRequested) {
        setHudStatus('⏸️ Download em massa pausado pelo usuário.');
        await new Promise(r => setTimeout(r, 600));
      }
      if (cancelRequested) break;

      // 2. Coleta todos os cards disponíveis no DOM atualmente
      const allCards = Array.from(document.querySelectorAll('article, div[data-pressable-container="true"], div._aagv'));
      const pendingItems = [];

      for (const card of allCards) {
        const media = extractMediaFromContainer(card);
        if (media && media.url && !processedMediaUrls.has(media.url)) {
          pendingItems.push(media);
        }
      }

      batchTotalCount = processedMediaUrls.size + pendingItems.length;
      updateHudUI();

      // 3. Se não houver itens pendentes na tela, rola suavemente para carregar mais
      if (pendingItems.length === 0) {
        consecutiveNoNewMedia++;
        if (consecutiveNoNewMedia >= 4) {
          setHudStatus('🏁 Todas as mídias visíveis foram baixadas!');
          showToast('✅ Fim do feed atingido ou todas as mídias já foram baixadas.', 'success');
          break;
        }
        setHudStatus('📜 Rolando suavemente para carregar mais mídias...');
        await smoothScrollDown();
        continue;
      }

      consecutiveNoNewMedia = 0;

      // 4. Processa os itens pendentes um a um com Human Jitter
      for (const item of pendingItems) {
        if (!isBatchRunning || cancelRequested) break;

        while (isPaused && !cancelRequested) {
          setHudStatus('⏸️ Download em massa pausado.');
          await new Promise(r => setTimeout(r, 600));
        }
        if (cancelRequested) break;

        // ESTRATÉGIA ANTI-BLOQUEIO: Resfriamento por bloco (Cooldown)
        if (itemsDownloadedInCurrentBlock >= CONFIG.cooldownEveryN) {
          const cooldownTime = CONFIG.cooldownSeconds + Math.floor(Math.random() * 6);
          for (let c = cooldownTime; c > 0; c--) {
            if (!isBatchRunning || cancelRequested) break;
            setHudStatus(`🛡️ Pausa de resfriamento seguro (${c}s)... Protegendo perfil.`);
            await new Promise(r => setTimeout(r, 1000));
          }
          itemsDownloadedInCurrentBlock = 0;
        }

        if (!isBatchRunning || cancelRequested) break;

        // Dispara o download da mídia
        setHudStatus(`⬇️ Baixando (${batchCompletedCount + 1}): ${item.filename.slice(0, 24)}...`);
        safeSendMessage({
          action: 'DOWNLOAD_MEDIA',
          url: item.url,
          filename: item.filename,
          folder: CONFIG.downloadFolder,
          ext: item.ext,
          id: item.url
        });

        processedMediaUrls.add(item.url);
        batchCompletedCount++;
        itemsDownloadedInCurrentBlock++;
        updateHudUI();

        // ESTRATÉGIA ANTI-BLOQUEIO: Atraso humano estocástico (Jitter)
        const jitter = Math.floor(Math.random() * CONFIG.jitterVarianceMs);
        const waitSec = ((CONFIG.baseDelayMs + jitter) / 1000).toFixed(1);
        setHudStatus(`⏳ Intervalo anti-detecção: aguardando ${waitSec}s...`);
        await humanJitterDelay(CONFIG.baseDelayMs, CONFIG.jitterVarianceMs);
      }

      // Rola gradualmente para capturar o próximo grupo
      if (isBatchRunning && !cancelRequested) {
        await smoothScrollDown();
      }
    }

    isBatchRunning = false;
    isPaused = false;
    updateHudUI();
    if (cancelRequested) {
      setHudStatus('🛑 Download em massa cancelado.');
      showToast('🛑 Download em massa interrompido.', 'info');
    } else {
      setHudStatus(`✨ Concluído! ${batchCompletedCount} mídias salvas com sucesso.`);
      showToast(`🎉 Concluído! ${batchCompletedCount} mídias baixadas com segurança.`, 'success');
    }
  }

  // =========================================================================
  // Interface do Usuário: HUD Flutuante do Instagram
  // =========================================================================

  function createInstagramHud() {
    if (document.getElementById('insta-dl-hud')) return;

    // 1. Painel Principal
    const hud = document.createElement('div');
    hud.id = 'insta-dl-hud';
    hud.innerHTML = `
      <div class="insta-hud-header" id="insta-hud-drag">
        <div class="insta-hud-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="url(#insta-grad)" stroke-width="2.2">
            <defs>
              <linearGradient id="insta-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#f09433"/>
                <stop offset="50%" stop-color="#dc2743"/>
                <stop offset="100%" stop-color="#bc1888"/>
              </linearGradient>
            </defs>
            <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
            <path d="M16 11.37A4 4 0 1112.63 8 4 4 0 0116 11.37z"/>
            <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
          </svg>
          <span>Instagram Pro</span>
        </div>
        <div class="insta-hud-actions">
          <button class="insta-hud-btn-icon" id="insta-btn-min" title="Minimizar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <button class="insta-hud-btn-icon" id="insta-btn-close" title="Fechar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <div class="insta-hud-body">
        <div class="insta-hud-shield">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <span>Blindagem Anti-Bloqueio Ativa</span>
        </div>

        <div class="insta-hud-stats">
          <div class="insta-stat-box">
            <div class="insta-stat-num" id="insta-stat-completed">0</div>
            <div class="insta-stat-lbl">Baixados</div>
          </div>
          <div class="insta-stat-box">
            <div class="insta-stat-num" id="insta-stat-total">0</div>
            <div class="insta-stat-lbl">Detectados</div>
          </div>
        </div>

        <div class="insta-progress-wrap">
          <div class="insta-progress-bar" id="insta-hud-progress"></div>
        </div>

        <div class="insta-hud-msg" id="insta-hud-status">
          Pronto para baixar fotos e vídeos do perfil ou feed.
        </div>

        <button class="insta-hud-btn-primary" id="insta-btn-start">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <span>Baixar em Lote Seguro</span>
        </button>

        <button class="insta-hud-btn-cancel" id="insta-btn-cancel" style="display: none;">
          🛑 Interromper
        </button>
      </div>
    `;

    // 2. Bolha Minimizada
    const bubble = document.createElement('div');
    bubble.id = 'insta-dl-bubble';
    bubble.setAttribute('title', 'Abrir Instagram Downloader Pro');
    bubble.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2">
        <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
      </svg>
    `;

    document.body.appendChild(hud);
    document.body.appendChild(bubble);

    // Eventos de Minimizar / Restaurar
    document.getElementById('insta-btn-min').addEventListener('click', () => {
      hud.style.display = 'none';
      bubble.style.display = 'flex';
    });

    bubble.addEventListener('click', () => {
      bubble.style.display = 'none';
      hud.style.display = 'block';
    });

    document.getElementById('insta-btn-close').addEventListener('click', () => {
      hud.style.display = 'none';
      bubble.style.display = 'flex';
    });

    // Eventos de Início / Cancelamento
    const btnStart = document.getElementById('insta-btn-start');
    const btnCancel = document.getElementById('insta-btn-cancel');

    btnStart.addEventListener('click', () => {
      if (isBatchRunning) {
        isPaused = !isPaused;
        btnStart.innerHTML = isPaused ? `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span>Retomar Download</span>
        ` : `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
          <span>Pausar</span>
        `;
      } else {
        startSafeBatchDownload();
      }
    });

    btnCancel.addEventListener('click', () => {
      cancelRequested = true;
      isBatchRunning = false;
      isPaused = false;
    });

    // Arraste do HUD
    setupDraggable(hud, document.getElementById('insta-hud-drag'));
  }

  function setHudStatus(text) {
    const el = document.getElementById('insta-hud-status');
    if (el) el.innerText = text;
  }

  function updateHudUI() {
    const completedEl = document.getElementById('insta-stat-completed');
    const totalEl = document.getElementById('insta-stat-total');
    const progressEl = document.getElementById('insta-hud-progress');
    const btnStart = document.getElementById('insta-btn-start');
    const btnCancel = document.getElementById('insta-btn-cancel');

    if (completedEl) completedEl.innerText = batchCompletedCount;
    if (totalEl) totalEl.innerText = batchTotalCount;

    if (progressEl) {
      const pct = batchTotalCount > 0 ? Math.min(100, Math.round((batchCompletedCount / batchTotalCount) * 100)) : 0;
      progressEl.style.width = `${pct}%`;
    }

    if (btnStart && btnCancel) {
      if (isBatchRunning) {
        btnCancel.style.display = 'block';
        btnStart.innerHTML = isPaused ? `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span>Retomar</span>
        ` : `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
          <span>Pausar</span>
        `;
      } else {
        btnCancel.style.display = 'none';
        btnStart.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span>Baixar em Lote Seguro</span>
        `;
      }
    }
  }

  function setupDraggable(element, handle) {
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = element.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      element.style.bottom = 'auto';
      element.style.right = 'auto';
      element.style.left = `${initialLeft}px`;
      element.style.top = `${initialTop}px`;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      element.style.left = `${Math.max(10, Math.min(window.innerWidth - element.offsetWidth - 10, initialLeft + dx))}px`;
      element.style.top = `${Math.max(10, Math.min(window.innerHeight - element.offsetHeight - 10, initialTop + dy))}px`;
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  // =========================================================================
  // Inicialização e Observador de Mutações (Injeção Contínua em Feed Dinâmico)
  // =========================================================================
  function init() {
    createInstagramHud();
    injectOverlayButtons();

    // Monitora mutações no DOM do Instagram conforme novos posts aparecem na tela
    const observer = new MutationObserver(() => {
      injectOverlayButtons();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
