// ============================================================================
// FLOW Downloader & Macro Studio Pro - Script de Conteúdo (Content Script)
// Automação completa de download em lote e injeção de prompts no Google FLOW
// ============================================================================

(function () {
  'use strict';

  // =========================================================================
  // Proteção contra Falhas de Reconciliação do React 18 e Next.js
  // Impede o erro clássico: "Failed to execute 'removeChild' on 'Node'"
  // =========================================================================
  try {
    if (typeof Node !== 'undefined' && Node.prototype) {
      const origRemoveChild = Node.prototype.removeChild;
      Node.prototype.removeChild = function(child) {
        if (child && child.parentNode !== this) {
          return child;
        }
        return origRemoveChild.apply(this, arguments);
      };

      const origInsertBefore = Node.prototype.insertBefore;
      Node.prototype.insertBefore = function(newNode, referenceNode) {
        if (referenceNode && referenceNode.parentNode !== this) {
          return this.appendChild(newNode);
        }
        return origInsertBefore.apply(this, arguments);
      };
    }
  } catch (e) { /* ignora */ }

  // Proteção contra erros de manipulação de nós no Slate.js
  try {
    window.addEventListener('error', (e) => {
      if (e && e.message && (e.message.includes('Cannot resolve a Slate node') || e.message.includes('removeChild'))) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return true;
      }
    }, true);
    window.addEventListener('unhandledrejection', (e) => {
      if (e && e.reason && (String(e.reason).includes('Cannot resolve a Slate node') || String(e.reason).includes('removeChild'))) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return true;
      }
    }, true);
  } catch (e) { /* ignora */ }

  // Evita injeções múltiplas no mesmo frame da página
  if (window.__FLOW_DOWNLOADER_INITIALIZED__) return;
  window.__FLOW_DOWNLOADER_INITIALIZED__ = true;

  console.log('[FLOW Downloader Pro] Content Script inicializado com sucesso.');

  // =========================================================================
  // Estado Local da Extensão na Página
  // =========================================================================
  let settings = {
    autoDownload: false, // Download automático (padrão desligado para segurança)
    quality: '1k', // '1k', '2k', '4k', 'direct'
    downloadFolder: 'FLOW_Downloads',
    nameWithPrompt: true,
    showOverlayButtons: true,
    showFloatingHud: true,
    downloadDelay: 350
  };

  const processedImageIds = new Set();
  let hudElement = null;
  let isScrollingAndDownloading = false;
  let cancelRequested = false;

  /**
   * Função utilitária de debounce para evitar sobrecarga no DOM
   * @param {Function} fn - Função a executar
   * @param {number} wait - Tempo de espera em ms
   * @returns {Function}
   */
  function debounce(fn, wait = 300) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /**
   * Envia mensagem de forma segura para o background script
   * Protege contra "Extension context invalidated" se o usuário recarregar a extensão
   */
  function safeSendMessage(message, callback) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        return;
      }
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) {
          // Contexto descarregado ou erro transitório
          return;
        }
        if (typeof callback === 'function') {
          callback(res);
        }
      });
    } catch (e) {
      // Ignora erro de contexto invalidado após recarregar a extensão
    }
  }

  // Carrega configurações iniciais salvas no Chrome Storage
  safeSendMessage({ action: 'GET_SETTINGS' }, (response) => {
    if (response && response.settings) {
      settings = { ...settings, ...response.settings };
    }
    init();
  });

  // Ouvinte de mensagens enviadas pelo Popup ou pelo Background Worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'PING') {
      sendResponse({ success: true, alive: true });
      return true;
    }

    if (message.action === 'SETTINGS_UPDATED') {
      settings = { ...settings, ...message.settings };
      updateHudUI();
      if (hudElement) {
        hudElement.style.display = settings.showFloatingHud ? 'block' : 'none';
      }
      sendResponse({ success: true });
    } else if (message.action === 'DOWNLOAD_ALL_TRIGGER') {
      startScrollAndBatchDownload(message.folder || null);
      sendResponse({ success: true });
    } else if (message.action === 'CANCEL_DOWNLOAD_TRIGGER' || message.action === 'DOWNLOADS_CANCELLED') {
      handleCancelTrigger();
      sendResponse({ success: true, cancelled: true });
    } else if (message.action === 'OPEN_MACRO_STUDIO') {
      openMacroStudioModal();
      sendResponse({ success: true });
    }
    return true;
  });

  /**
   * Cancela o processo de download em lote e restaura os botões da interface
   */
  function handleCancelTrigger() {
    cancelRequested = true;
    isScrollingAndDownloading = false;
    resetHudButtons();
    showToast('🛑 Downloads cancelados pelo usuário.', 'info');
  }

  /**
   * Inicializa o HUD flutuante, escaneia imagens e configura o MutationObserver
   */
  function init() {
    createHud();
    scanAndInjectOverlayButtons();
    setupMutationObserver();

    // Intervalo de segurança (a cada 4s) para detectar carregamentos preguiçosos (lazy-load)
    setInterval(scanAndInjectOverlayButtons, 4000);
  }

  // ==========================================================================
  // Extração Inteligente de Título e Prompts do Projeto na Página
  // ==========================================================================

  /**
   * Extrai o prompt global do projeto a partir do título do cabeçalho ou do campo de texto
   * @param {string} fallback - Texto padrão caso não encontre
   * @returns {string} - Texto do prompt
   */
  function extractPagePrompt(fallback = 'flow_image') {
    // 1. Verifica o título no cabeçalho superior do FLOW
    const headerTitle = document.querySelector('header h1, header [role="heading"], [role="banner"] span, [aria-label*="Título"], [aria-label*="Title"]');
    if (headerTitle) {
      const text = headerTitle.textContent.trim();
      if (text.length > 3 && !text.toLowerCase().includes('google') && !text.toLowerCase().includes('flow')) {
        return text;
      }
    }

    // 2. Verifica links de navegação ou títulos de cards
    const titleCandidates = document.querySelectorAll('button span, div span, h1, h2');
    for (const el of titleCandidates) {
      const t = el.textContent.trim();
      if (t.length > 5 && t.length < 90 && !t.includes('©') && !t.includes('Google') && !t.includes('Downloads') && !t.includes('PRO')) {
        const parent = el.closest('header, nav, [role="banner"], main');
        if (parent) return t;
      }
    }

    // 3. Verifica o campo de prompt de texto
    const promptInput = document.querySelector('textarea, input[placeholder*="mudar"], input[placeholder*="prompt"], input[placeholder*="descrever"]');
    if (promptInput && promptInput.value && promptInput.value.trim().length > 3) {
      return promptInput.value.trim();
    }

    return fallback;
  }

  /**
   * Extrai o prompt associado a um card de imagem específico
   * @param {HTMLElement} cardOrElement - Elemento do card ou imagem
   * @param {string} fallback - Texto padrão
   * @returns {string}
   */
  function extractPromptText(cardOrElement, fallback = 'flow_image') {
    if (!cardOrElement) return extractPagePrompt(fallback);

    // 1. Verifica atributo alt da imagem
    const img = cardOrElement.tagName && cardOrElement.tagName.toLowerCase() === 'img'
      ? cardOrElement
      : (cardOrElement.querySelector ? cardOrElement.querySelector('img') : null);

    if (img && img.alt && img.alt.trim().length > 2) {
      return img.alt.trim();
    }

    // 2. Verifica aria-label do container
    if (cardOrElement.getAttribute) {
      const aria = (cardOrElement.getAttribute('aria-label') || '').trim();
      if (aria.length > 4 && !aria.toLowerCase().includes('download') && !aria.toLowerCase().includes('menu') && !aria.toLowerCase().includes('fechar')) {
        return aria;
      }
    }

    return extractPagePrompt(fallback);
  }

  // ==========================================================================
  // Extração e Normalização de URLs de Imagens em Alta Resolução (Google CDN)
  // ==========================================================================

  /**
   * Extrai a URL em resolução original (=s0) de um elemento ou card
   * @param {HTMLElement} cardOrImg - Elemento DOM
   * @returns {string|null} - URL normalizada
   */
  function extractImageUrl(cardOrImg) {
    if (!cardOrImg) return null;
    const img = cardOrImg.tagName && cardOrImg.tagName.toLowerCase() === 'img'
      ? cardOrImg
      : (cardOrImg.querySelector ? cardOrImg.querySelector('img') : null);

    if (!img) {
      const bg = cardOrImg.style ? cardOrImg.style.backgroundImage : '';
      if (bg && bg.includes('url(')) {
        const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (match && match[1]) return normalizeImageUrl(match[1]);
      }
      return null;
    }

    let src = img.currentSrc || img.src || img.dataset.src || img.getAttribute('data-original-src');
    if (!src || src.startsWith('data:image/svg')) return null;

    return normalizeImageUrl(src);
  }

  /**
   * Converte miniaturas do Google CDN na versão em resolução máxima original (=s0)
   * @param {string} src - URL bruta da imagem
   * @returns {string|null} - URL em alta resolução
   */
  function normalizeImageUrl(src) {
    if (!src) return null;

    // Filtra fotos de perfil e avatares de contas do Google
    if (
      src.includes('/a/ACg8oc') ||
      src.includes('/ogw/') ||
      src.includes('avatar') ||
      src.includes('profile') ||
      src.includes('favicon') ||
      src.includes('logo')
    ) {
      return null;
    }

    // Converte miniaturas do googleusercontent.com para a resolução nativa original (=s0)
    if (src.includes('googleusercontent.com')) {
      src = src.replace(/=w\d+-h\d+.*$/, '=s0')
               .replace(/=s\d+.*$/, '=s0')
               .replace(/=w\d+.*$/, '=s0')
               .replace(/=h\d+.*$/, '=s0');
      if (!src.includes('=s0') && !src.includes('=')) {
        src += '=s0';
      }
    }

    return src;
  }

  // ==========================================================================
  // Descoberta de Todas as Imagens Geradas Presentes na Página
  // ==========================================================================

  /**
   * Varre o documento e retorna todos os itens de imagens geradas válidas
   * @returns {Array<Object>} - Lista de objetos de imagem
   */
  function findFlowImages() {
    const images = Array.from(document.querySelectorAll('img'));
    const items = [];
    const seenUrls = new Set();
    const pagePrompt = extractPagePrompt('flow_image');

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const rawSrc = img.currentSrc || img.src || img.dataset.src || '';

      // Ignora SVGs, ícones pequenos e fotos de perfil
      if (
        !rawSrc ||
        rawSrc.startsWith('data:image/svg') ||
        rawSrc.includes('avatar') ||
        rawSrc.includes('logo') ||
        rawSrc.includes('icon') ||
        rawSrc.includes('profile') ||
        rawSrc.includes('/a/ACg8oc') ||
        (img.naturalWidth > 0 && img.naturalWidth < 45) ||
        (img.width > 0 && img.width < 45 && img.height > 0 && img.height < 45)
      ) {
        continue;
      }

      const fullUrl = normalizeImageUrl(rawSrc);
      if (!fullUrl || seenUrls.has(fullUrl)) continue;
      seenUrls.add(fullUrl);

      const card = img.closest('[role="article"], [role="group"], .card, button, [role="button"]') || img.parentElement || img;
      const prompt = extractPromptText(card, pagePrompt);

      items.push({
        img,
        card,
        url: fullUrl,
        prompt: prompt || pagePrompt,
        id: fullUrl
      });
    }

    return items;
  }

  // ==========================================================================
  // Localização dos Containers com Rolagem Ativa na Página
  // ==========================================================================

  /**
   * Encontra todos os containers roláveis (feed principal, janela, listas)
   * @returns {Array<Object>} - Lista de scrollers manipuláveis
   */
  function findScrollContainers() {
    const containers = [];
    const docElem = document.documentElement;
    const body = document.body;

    // Rolagem da janela/documento
    containers.push({
      element: window,
      isWindow: true,
      getScrollTop: () => window.scrollY || docElem.scrollTop || body.scrollTop,
      getScrollHeight: () => Math.max(docElem.scrollHeight, body.scrollHeight),
      getClientHeight: () => window.innerHeight,
      scrollBy: (val) => window.scrollBy({ top: val, behavior: 'smooth' }),
      scrollTo: (top) => window.scrollTo({ top, behavior: 'smooth' })
    });

    // Rolagem de divs e seções internas
    const allDivs = document.querySelectorAll('main, [role="main"], [role="feed"], #main-content, section, div');
    for (const el of allDivs) {
      if (el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 200) {
        const style = window.getComputedStyle(el);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          containers.push({
            element: el,
            isWindow: false,
            getScrollTop: () => el.scrollTop,
            getScrollHeight: () => el.scrollHeight,
            getClientHeight: () => el.clientHeight,
            scrollBy: (val) => el.scrollBy({ top: val, behavior: 'smooth' }),
            scrollTo: (top) => el.scrollTo({ top, behavior: 'smooth' })
          });
        }
      }
    }

    return containers;
  }

  // ==========================================================================
  // Função de Download Individual por Card (Botão de 1-Clique na Imagem)
  // ==========================================================================

  /**
   * Baixa a imagem de um card específico ao clicar no botão de overlay
   * @param {HTMLElement} card - Card que contém a imagem
   */
  function downloadCardImage(card) {
    if (!card) return;

    const promptText = extractPromptText(card, `flow_${Date.now()}`);
    const imageUrl = extractImageUrl(card);

    if (!imageUrl) {
      showToast('❌ Imagem ainda carregando ou não encontrada.', 'info');
      return;
    }

    const cleanPrompt = (promptText || 'flow_image').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 60);
    const filename = settings.nameWithPrompt
      ? `${cleanPrompt}_${Date.now().toString().slice(-4)}`
      : `flow_${Date.now()}`;

    safeSendMessage(
      {
        action: 'DOWNLOAD_IMAGE',
        url: imageUrl,
        filename: filename,
        folder: settings.downloadFolder,
        id: imageUrl
      },
      (res) => {
        if (res && res.success) {
          processedImageIds.add(imageUrl);
          markCardAsDownloaded(card);
          showToast(`✅ Imagem enviada para download!`, 'success');
        } else {
          showToast('❌ Falha ao baixar imagem.', 'info');
        }
      }
    );
  }

  /**
   * Marca o card visualmente como já baixado
   * @param {HTMLElement} card - Card da imagem
   */
  function markCardAsDownloaded(card) {
    if (!card) return;
    const btn = card.querySelector ? card.querySelector('.fd-card-overlay-btn') : null;
    if (btn) {
      btn.classList.add('downloaded');
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Salva
      `;
    }
  }

  // ==========================================================================
  // Diálogo Interativo para Nomear a Pasta de Download
  // ==========================================================================

  /**
   * Exibe um modal para o usuário digitar ou confirmar a pasta de destino
   * @param {string} defaultFolder - Nome padrão da pasta
   * @returns {Promise<string|null>} - Nome confirmado ou null se cancelado
   */
  function promptForFolderName(defaultFolder = 'FLOW_Downloads') {
    return new Promise((resolve) => {
      let modalOverlay = document.getElementById('fd-folder-modal');
      if (!modalOverlay) {
        modalOverlay = document.createElement('div');
        modalOverlay.id = 'fd-folder-modal';
        modalOverlay.className = 'fd-modal-overlay';
        modalOverlay.innerHTML = `
          <div class="fd-modal-card">
            <div class="fd-modal-header">
              <div class="fd-modal-title">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
                <span>Nomear Pasta de Download</span>
              </div>
            </div>
            <p class="fd-modal-desc">
              Digite o nome da subpasta dentro de <strong>Downloads</strong> onde todas as imagens serão salvas:
            </p>
            <div class="fd-modal-input-wrapper">
              <span class="fd-modal-prefix">Downloads /</span>
              <input type="text" id="fd-modal-folder-input" class="fd-modal-input" placeholder="FLOW_Downloads" spellcheck="false">
            </div>
            <div class="fd-modal-actions">
              <button class="fd-modal-btn-cancel" id="fd-modal-btn-cancel">Cancelar</button>
              <button class="fd-modal-btn-confirm" id="fd-modal-btn-confirm">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                <span>Confirmar e Baixar</span>
              </button>
            </div>
          </div>
        `;
        document.body.appendChild(modalOverlay);
      }

      const input = document.getElementById('fd-modal-folder-input');
      const btnConfirm = document.getElementById('fd-modal-btn-confirm');
      const btnCancel = document.getElementById('fd-modal-btn-cancel');

      input.value = defaultFolder || 'FLOW_Downloads';
      modalOverlay.style.display = 'flex';

      setTimeout(() => {
        input.focus();
        input.select();
      }, 50);

      function cleanup(result) {
        modalOverlay.style.display = 'none';
        btnConfirm.removeEventListener('click', onConfirm);
        btnCancel.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKeyDown);
        resolve(result);
      }

      function onConfirm() {
        const val = (input.value || '').trim();
        const clean = val ? val.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') : 'FLOW_Downloads';
        cleanup(clean);
      }

      function onCancel() {
        cleanup(null);
      }

      function onKeyDown(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          onConfirm();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }

      btnConfirm.addEventListener('click', onConfirm);
      btnCancel.addEventListener('click', onCancel);
      input.addEventListener('keydown', onKeyDown);
    });
  }

  // ==========================================================================
  // Rolagem Automática Inteligente e Download em Lote de TODAS as Imagens
  // ==========================================================================

  /**
   * Rola a página progressivamente até o fim e envia todas as imagens em lote
   * @param {string|null} customFolder - Pasta personalizada
   */
  async function startScrollAndBatchDownload(customFolder = null) {
    if (isScrollingAndDownloading) {
      showToast('⚠️ Processo de download já em andamento...', 'info');
      return;
    }

    // Solicita confirmação do nome da pasta antes de iniciar
    let targetFolder = customFolder;
    if (!targetFolder) {
      targetFolder = await promptForFolderName(settings.downloadFolder || 'FLOW_Downloads');
      if (!targetFolder) {
        return; // Cancelado pelo usuário
      }
      settings.downloadFolder = targetFolder;
      chrome.storage.local.set({ downloadFolder: targetFolder });
      safeSendMessage({
        action: 'SAVE_SETTINGS',
        settings: { downloadFolder: targetFolder }
      });
    }

    isScrollingAndDownloading = true;
    cancelRequested = false;

    const hudBtn = document.getElementById('fd-btn-download-all');
    const hudCancelBtn = document.getElementById('fd-btn-cancel');

    if (hudBtn) {
      hudBtn.disabled = true;
      hudBtn.innerHTML = `
        <svg class="fd-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="2" x2="12" y2="6"></line>
          <line x1="12" y1="18" x2="12" y2="22"></line>
          <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
          <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
          <line x1="2" y1="12" x2="6" y2="12"></line>
          <line x1="18" y1="12" x2="22" y2="12"></line>
          <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
          <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
        </svg>
        <span>Rolando e Carregando...</span>
      `;
    }

    if (hudCancelBtn) {
      hudCancelBtn.style.display = 'flex';
    }

    showToast(`📁 Pasta de destino: Downloads/${targetFolder}`, 'info');
    showToast('📜 Rolando até o fim da página para carregar todas as imagens...', 'info');

    const scrollers = findScrollContainers();
    const primaryScroller = scrollers[0];
    const initialTop = primaryScroller.getScrollTop();

    // Mapa para acumular imagens descobertas durante a rolagem (previne perdas em virtual lists)
    const collectedMap = new Map();

    function collectAllVisible() {
      const items = findFlowImages();
      for (const item of items) {
        if (!collectedMap.has(item.url)) {
          collectedMap.set(item.url, item);
        }
      }
      updateImageCountBadge(collectedMap.size);
    }

    // Coleta inicial
    collectAllVisible();

    // 1. Loop de rolagem progressiva com verificação de fim de página
    let lastHeight = 0;
    let lastImageCount = collectedMap.size;
    let bottomConfirmationCount = 0;
    const maxSteps = 45;

    for (let step = 1; step <= maxSteps; step++) {
      if (cancelRequested) {
        showToast('🛑 Rolagem cancelada pelo usuário.', 'info');
        resetHudButtons();
        isScrollingAndDownloading = false;
        return;
      }

      // Rola todos os containers ativos em 550px
      for (const scroller of scrollers) {
        scroller.scrollBy(550);
      }

      // Rola carrosséis horizontais se existirem
      const horizontalStrips = document.querySelectorAll('[style*="overflow-x"], div, section');
      for (const el of horizontalStrips) {
        if (el.scrollWidth > el.clientWidth + 50) {
          el.scrollBy({ left: 400, behavior: 'smooth' });
        }
      }

      // Aguarda 850ms por passo para o DOM e as requisições de rede renderizarem
      await new Promise(r => setTimeout(r, 850));

      if (cancelRequested) {
        resetHudButtons();
        isScrollingAndDownloading = false;
        return;
      }

      collectAllVisible();

      const currentHeight = primaryScroller.getScrollHeight();
      const currentCount = collectedMap.size;

      // Verifica se novos conteúdos foram carregados
      if (currentHeight > lastHeight + 10 || currentCount > lastImageCount) {
        bottomConfirmationCount = 0;
        lastHeight = currentHeight;
        lastImageCount = currentCount;
      } else {
        bottomConfirmationCount++;
        // Confirma 4 verificações consecutivas sem mudanças para decretar o fim da página
        if (bottomConfirmationCount >= 4) {
          console.log('[FLOW Downloader] Fim definitivo da página verificado com sucesso.');
          break;
        }
      }
    }

    if (cancelRequested) {
      resetHudButtons();
      isScrollingAndDownloading = false;
      return;
    }

    // Aguarda 600ms no fundo da página para carregamento das últimas imagens
    await new Promise(r => setTimeout(r, 600));
    collectAllVisible();

    // 2. Retorna a rolagem para a posição inicial de forma suave
    primaryScroller.scrollTo(initialTop);
    await new Promise(r => setTimeout(r, 300));

    // 3. Prepara a lista consolidada de todas as imagens encontradas
    const allDiscovered = Array.from(collectedMap.values());
    const totalFound = allDiscovered.length;

    if (totalFound === 0) {
      showToast('❌ Nenhuma imagem do FLOW encontrada para baixar.', 'info');
      resetHudButtons();
      isScrollingAndDownloading = false;
      return;
    }

    showToast(`⚡ Iniciando download de ${totalFound} imagens em resolução máxima...`, 'info');

    if (hudBtn) {
      hudBtn.innerHTML = `
        <svg class="fd-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="2" x2="12" y2="6"></line>
          <line x1="12" y1="18" x2="12" y2="22"></line>
          <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
          <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
          <line x1="2" y1="12" x2="6" y2="12"></line>
          <line x1="18" y1="12" x2="22" y2="12"></line>
          <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
          <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
        </svg>
        <span>Baixando ${totalFound} imagens...</span>
      `;
    }

    // 4. Monta os itens do lote com nomes de arquivo únicos e indexados
    const pagePrompt = extractPagePrompt('flow_image').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 50);
    const dateStamp = Date.now().toString().slice(-4);

    const batchItems = allDiscovered.map((item, idx) => {
      const cleanItemPrompt = (item.prompt || pagePrompt).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 50);
      const filename = settings.nameWithPrompt
        ? `${cleanItemPrompt}_${String(idx + 1).padStart(2, '0')}_${dateStamp}`
        : `flow_${String(idx + 1).padStart(2, '0')}_${dateStamp}`;

      return {
        url: item.url,
        filename: filename,
        id: item.url
      };
    });

    // 5. Envia o lote completo para a fila de download no background worker
    safeSendMessage(
      {
        action: 'DOWNLOAD_BATCH',
        items: batchItems,
        folder: targetFolder
      },
      (response) => {
        // Marca visualmente os cards presentes na tela como salvos
        for (const item of allDiscovered) {
          if (item.card) markCardAsDownloaded(item.card);
          processedImageIds.add(item.url);
        }

        showToast(`🎉 ${totalFound} imagens enviadas para Downloads/${targetFolder}!`, 'success');
        resetHudButtons();
        isScrollingAndDownloading = false;
      }
    );
  }

  /**
   * Restaura o estado e visual padrão dos botões do HUD após finalizar ou cancelar
   */
  function resetHudButtons() {
    const btn = document.getElementById('fd-btn-download-all');
    const cancelBtn = document.getElementById('fd-btn-cancel');

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <span>Baixar Todas da Página</span>
      `;
    }

    if (cancelBtn) {
      cancelBtn.style.display = 'none';
    }
  }

  // ==========================================================================
  // Injeção de Botões de Download nos Cards de Imagem (Overlay de 1-Clique)
  // ==========================================================================
  const debouncedScanAndInject = debounce(scanAndInjectOverlayButtons, 300);

  /**
   * Varre todos os cards de imagem do FLOW e injeta o botão de download direto
   */
  function scanAndInjectOverlayButtons() {
    if (isScrollingAndDownloading) return;

    const items = findFlowImages();
    updateImageCountBadge(items.length);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const card = item.card;

      if (card && !card.dataset.fdProcessed) {
        card.dataset.fdProcessed = 'true';

        // Cria o botão flutuante no canto do card se habilitado nas opções
        if (!card.querySelector('.fd-card-overlay-btn') && settings.showOverlayButtons) {
          const btn = document.createElement('button');
          btn.className = 'fd-card-overlay-btn';
          btn.title = 'Baixar esta imagem';
          btn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Baixar
          `;

          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            downloadCardImage(card);
          });

          card.appendChild(btn);
        }

        // Se download automático estiver ativo, dispara o salvamento
        if (settings.autoDownload) {
          const imgUrl = item.url;
          if (imgUrl && !processedImageIds.has(item.id)) {
            processedImageIds.add(item.id);
            setTimeout(() => downloadCardImage(card), 1000);
          }
        }
      }
    }
  }

  // ==========================================================================
  // MutationObserver em Tempo Real para Detectar Novas Gerações de Imagem
  // ==========================================================================

  /**
   * Observa alterações no DOM do FLOW para injetar botões automaticamente quando novas imagens são geradas
   */
  function setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (let i = 0; i < mutations.length; i++) {
        const mutation = mutations[i];
        if (mutation.addedNodes.length > 0) {
          const target = mutation.target;
          // Ignora mutações geradas pelos próprios componentes da extensão
          if (
            target &&
            target.closest &&
            target.closest('#flow-downloader-hud, .fd-toast-container, .fd-card-overlay-btn, #fd-folder-modal')
          ) {
            continue;
          }
          shouldScan = true;
          break;
        }
      }

      if (shouldScan) {
        debouncedScanAndInject();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // ==========================================================================
  // Floating HUD (Interface de Controle Flutuante na Página)
  // ==========================================================================

  /**
   * Cria o painel flutuante de controle na página do FLOW
   */
  function createHud() {
    if (document.getElementById('flow-downloader-hud')) return;

    hudElement = document.createElement('div');
    hudElement.id = 'flow-downloader-hud';
    hudElement.style.display = settings.showFloatingHud ? 'block' : 'none';

    hudElement.innerHTML = `
      <!-- HUD Expandido -->
      <div class="fd-hud-container" id="fd-main-hud">
        <div class="fd-hud-header" id="fd-drag-handle">
          <div class="fd-brand">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
            </svg>
            <span>FLOW Downloader Pro</span>
          </div>
          <div class="fd-header-actions">
            <button class="fd-btn-icon" id="fd-btn-minimize" title="Minimizar Painel">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </button>
          </div>
        </div>

        <div class="fd-hud-body">
          <div class="fd-status-bar">
            <div class="fd-counter-badge" id="fd-img-counter">
              ✨ 0 imagens detectadas
            </div>
            <div class="fd-auto-status">
              <span class="fd-pulse-dot ${settings.autoDownload ? 'active' : ''}" id="fd-status-dot"></span>
              <span id="fd-status-text" style="font-size: 11px; color: ${settings.autoDownload ? '#10b981' : '#94a3b8'};">
                ${settings.autoDownload ? 'Auto: ATIVO' : 'Auto: DESLIGADO'}
              </span>
            </div>
          </div>

          <!-- Alternador de Download Automático -->
          <div class="fd-row">
            <span class="fd-label">
              🔄 Baixar Automaticamente
            </span>
            <label class="fd-switch">
              <input type="checkbox" id="fd-toggle-auto" ${settings.autoDownload ? 'checked' : ''}>
              <span class="fd-slider"></span>
            </label>
          </div>

          <!-- Seletor de Resolução de Download -->
          <div class="fd-row">
            <span class="fd-label">
              🎯 Resolução
            </span>
            <select class="fd-select" id="fd-select-quality">
              <option value="1k" ${settings.quality === '1k' ? 'selected' : ''}>1K (Original Max)</option>
              <option value="2k" ${settings.quality === '2k' ? 'selected' : ''}>2K (Aumentada)</option>
              <option value="4k" ${settings.quality === '4k' ? 'selected' : ''}>4K (Aumentada)</option>
              <option value="direct" ${settings.quality === 'direct' ? 'selected' : ''}>Direto (Alta Definição)</option>
            </select>
          </div>

          <!-- Grupo de Botões de Ação do HUD -->
          <div class="fd-button-group">
            <button class="fd-btn-primary" id="fd-btn-open-macro" style="background: linear-gradient(135deg, #6366f1 0%, #06b6d4 100%); margin-bottom: 8px; box-shadow: 0 4px 14px rgba(99, 102, 241, 0.35);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
              </svg>
              <span>⚡ Macro Studio (PDF & Prompts)</span>
            </button>

            <button class="fd-btn-primary" id="fd-btn-download-all">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span>Baixar Todas da Página</span>
            </button>
            <button class="fd-btn-danger" id="fd-btn-cancel" style="display: none;" title="Interromper rolagem e downloads">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="15" y1="9" x2="9" y2="15"></line>
                <line x1="9" y1="9" x2="15" y2="15"></line>
              </svg>
              <span>Interromper Downloads</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Gatilho de Bolha Flutuante Minimizada -->
      <div class="fd-minimized-trigger" id="fd-minimized-bubble" style="display: none;" title="Abrir FLOW Studio">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
        </svg>
        <div class="fd-minimized-badge" id="fd-min-badge">0</div>
      </div>
    `;

    document.body.appendChild(hudElement);

    // Associação de Eventos dos Controles do HUD
    const mainHud = document.getElementById('fd-main-hud');
    const minBubble = document.getElementById('fd-minimized-bubble');
    const btnMin = document.getElementById('fd-btn-minimize');
    const btnOpenMacro = document.getElementById('fd-btn-open-macro');
    const toggleAuto = document.getElementById('fd-toggle-auto');
    const selectQuality = document.getElementById('fd-select-quality');
    const btnDownloadAll = document.getElementById('fd-btn-download-all');
    const btnCancel = document.getElementById('fd-btn-cancel');

    if (btnOpenMacro) {
      btnOpenMacro.addEventListener('click', () => {
        openMacroStudioModal();
      });
    }

    btnMin.addEventListener('click', () => {
      mainHud.style.display = 'none';
      minBubble.style.display = 'flex';
    });

    minBubble.addEventListener('click', () => {
      minBubble.style.display = 'none';
      mainHud.style.display = 'block';
    });

    toggleAuto.addEventListener('change', (e) => {
      const val = e.target.checked;
      settings.autoDownload = val;
      chrome.storage.local.set({ autoDownload: val });
      safeSendMessage({
        action: 'SAVE_SETTINGS',
        settings: { autoDownload: val }
      });
      updateHudUI();
      showToast(val ? '🟢 Download automático ativado!' : '⏸️ Download automático pausado.', val ? 'success' : 'info');
      if (val) scanAndInjectOverlayButtons();
    });

    selectQuality.addEventListener('change', (e) => {
      const val = e.target.value;
      settings.quality = val;
      chrome.storage.local.set({ quality: val });
      safeSendMessage({
        action: 'SAVE_SETTINGS',
        settings: { quality: val }
      });
      showToast(`🎯 Resolução alterada para: ${val.toUpperCase()}`, 'info');
    });

    btnDownloadAll.addEventListener('click', () => {
      startScrollAndBatchDownload();
    });

    btnCancel.addEventListener('click', () => {
      cancelRequested = true;
      isScrollingAndDownloading = false;
      safeSendMessage({ action: 'CANCEL_DOWNLOADS' });
      resetHudButtons();
      showToast('🛑 Downloads cancelados pelo usuário.', 'info');
    });

    // Torna o painel HUD arrastável pela tela
    setupDraggableHud(hudElement, document.getElementById('fd-drag-handle'));
  }

  /**
   * Atualiza os elementos visuais do HUD com as configurações atuais
   */
  function updateHudUI() {
    const toggle = document.getElementById('fd-toggle-auto');
    const dot = document.getElementById('fd-status-dot');
    const text = document.getElementById('fd-status-text');
    const quality = document.getElementById('fd-select-quality');

    if (toggle) toggle.checked = !!settings.autoDownload;
    if (dot) {
      if (settings.autoDownload) {
        dot.classList.add('active');
      } else {
        dot.classList.remove('active');
      }
    }
    if (text) {
      text.innerText = settings.autoDownload ? 'Auto: ATIVO' : 'Auto: DESLIGADO';
      text.style.color = settings.autoDownload ? '#10b981' : '#94a3b8';
    }
    if (quality) quality.value = settings.quality || '1k';
  }

  /**
   * Atualiza o contador de imagens detectadas na página
   * @param {number} count - Total de imagens
   */
  function updateImageCountBadge(count) {
    const badge = document.getElementById('fd-img-counter');
    const minBadge = document.getElementById('fd-min-badge');
    if (badge) {
      badge.innerText = `✨ ${count} ${count === 1 ? 'imagem detectada' : 'imagens detectadas'}`;
    }
    if (minBadge) minBadge.innerText = count.toString();
  }

  // ==========================================================================
  // Implementação de Painel Arrastável (Draggable HUD)
  // ==========================================================================

  /**
   * Permite que o usuário arraste e reposicione o HUD na tela
   * @param {HTMLElement} el - Container principal
   * @param {HTMLElement} handle - Alça de clique/arrasto
   */
  function setupDraggableHud(el, handle) {
    if (!el || !handle) return;
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = el.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      el.style.bottom = 'auto';
      el.style.right = 'auto';
      el.style.left = `${initialLeft}px`;
      el.style.top = `${initialTop}px`;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    function onMouseMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left = `${Math.max(10, Math.min(window.innerWidth - 340, initialLeft + dx))}px`;
      el.style.top = `${Math.max(10, Math.min(window.innerHeight - 200, initialTop + dy))}px`;
    }

    function onMouseUp() {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
  }

  // ==========================================================================
  // Notificações Toast Flutuantes na Tela
  // ==========================================================================

  let toastContainer = null;

  /**
   * Exibe uma notificação toast animada com mensagem e ícone
   * @param {string} message - Texto da mensagem
   * @param {string} type - Tipo visual ('info' | 'success' | 'warning' | 'error')
   */
  function showToast(message, type = 'info') {
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.className = 'fd-toast-container';
      document.body.appendChild(toastContainer);
    }

    const toast = document.createElement('div');
    toast.className = `fd-toast ${type}`;
    toast.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        ${
          type === 'success'
            ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>'
            : '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>'
        }
      </svg>
      <span>${message}</span>
    `;

    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'fdToastOut 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  // ==========================================================================
  // FLOW Macro Studio Pro - Interface Modal Completa e Orquestrador
  // ==========================================================================
  let macroModalElement = null;

  /**
   * Abre a janela modal do Macro Studio Pro na página do FLOW
   */
  function openMacroStudioModal() {
    if (document.getElementById('fd-macro-studio-modal')) {
      const existing = document.getElementById('fd-macro-studio-modal');
      existing.style.display = 'flex';
      return;
    }

    const engine = window.flowMacroInstance || new FlowMacroEngine();

    macroModalElement = document.createElement('div');
    macroModalElement.id = 'fd-macro-studio-modal';
    macroModalElement.className = 'fd-macro-studio-modal';

    let activeTab = 'prompts'; // 'prompts' | 'characters' | 'format' | 'execution'

    macroModalElement.innerHTML = `
      <div class="fd-resize-handle" id="fd-resize-handle"></div>
      <div class="fd-macro-window" id="fd-macro-window">
        <!-- Modal Header -->
        <div class="fd-macro-header" id="fd-macro-drag-handle" style="cursor: grab;">
          <div class="fd-macro-title-group">
            <div class="fd-macro-logo">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
              </svg>
            </div>
            <div class="fd-macro-title-text">
              <h2>FLOW Macro Studio Pro</h2>
              <span>Automação de Prompts por PDF & Personagens Pré-definidos</span>
            </div>
          </div>
          <div class="fd-macro-header-actions">
            <span class="fd-badge-status" id="fd-macro-header-status">Pronto</span>
            <button class="fd-btn-icon" id="fd-macro-btn-transparent" title="Alternar Modo Transparente (Ver FLOW atrás)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </button>
            <button class="fd-btn-icon" id="fd-macro-btn-pip" title="Minimizar para Barra Flutuante (Permite ver o FLOW 100%)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
                <line x1="7" y1="12" x2="17" y2="12"></line>
              </svg>
            </button>
            <button class="fd-btn-icon" id="fd-macro-btn-close" title="Fechar Studio">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>

        <!-- Tab Navigation -->
        <div class="fd-macro-nav">
          <button class="fd-macro-tab active" data-tab="prompts">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
            </svg>
            <span>Sequência & PDF</span>
          </button>
          <button class="fd-macro-tab" data-tab="characters">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
            <span>Personagens (${engine.characters.length})</span>
          </button>
          <button class="fd-macro-tab" data-tab="format">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
            <span>Formato & Geração</span>
          </button>
          <button class="fd-macro-tab" data-tab="execution">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            <span>Execução & Logs</span>
          </button>
          <button class="fd-macro-tab" data-tab="inspector">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <span>🔍 Espião FLOW</span>
          </button>
        </div>

        <!-- Body Area -->
        <div class="fd-macro-body">
          <!-- TAB 1: Prompts & PDF -->
          <div class="fd-tab-pane active" id="pane-prompts">
            <!-- PDF Upload Dropzone -->
            <div class="fd-dropzone" id="fd-dropzone">
              <input type="file" id="fd-file-input" name="fd_file_input" accept=".pdf,.txt,.json,.csv,.md" style="display: none;">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="17 8 12 3 7 8"></polyline>
                <line x1="12" y1="3" x2="12" y2="15"></line>
              </svg>
              <div class="fd-dropzone-title">Arraste seu arquivo PDF ou Roteiro aqui</div>
              <div class="fd-dropzone-sub">Suporta múltiplos carrosséis (Carrossel 1 a 11), slides e balões de diálogo</div>
            </div>

            <!-- Carousels Batch Filter / Selector -->
            <div id="fd-carousels-selector-container" style="display: none; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--fd-border); border-radius: 10px; padding: 10px 12px;">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; flex-wrap: wrap; gap: 6px;">
                <span style="font-size: 12px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 6px;">
                  <span>📚 Carrosséis Detectados no Roteiro:</span>
                  <span class="fd-badge-status" id="fd-carousels-count-badge" style="background: rgba(99, 102, 241, 0.2); color: #818cf8;">0 Carrosséis</span>
                </span>
                <span style="font-size: 11px; color: var(--fd-text-muted);">Clique para filtrar ou selecione "Todos" para gerar em lote com novos projetos</span>
              </div>
              <div class="fd-carousel-chips" id="fd-carousel-chips">
                <!-- Rendered dynamically -->
              </div>
            </div>

            <!-- Action Bar -->
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
              <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                <button class="fd-modal-btn-confirm" id="fd-btn-add-prompt" style="padding: 6px 14px; font-size: 12px;">
                  + Adicionar Prompt
                </button>
                <button class="fd-modal-btn-cancel" id="fd-btn-paste-script" style="padding: 6px 12px; font-size: 12px;">
                  📋 Colar Roteiro
                </button>
                <div style="display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.05); padding: 4px 10px; border-radius: 8px; border: 1px solid var(--fd-border);" title="Definir quantas vezes cada prompt será gerado">
                  <span style="font-size: 11px; color: var(--fd-text-muted);">🔁 Repetir cada:</span>
                  <input type="number" id="fd-input-global-repeat" min="1" max="50" value="${engine.config.repeatPerPrompt || 1}" style="width: 38px; text-align: center; background: rgba(0,0,0,0.4); border: 1px solid var(--fd-border); border-radius: 4px; color: #fff; font-weight: 700; font-size: 11px; padding: 2px;">
                  <span style="font-size: 11px; color: var(--fd-text-muted);">x</span>
                </div>
              </div>
              <div style="display: flex; gap: 8px;">
                <button class="fd-modal-btn-cancel" id="fd-btn-reset-status" style="padding: 6px 12px; font-size: 12px;" title="Redefinir todos os status para Pendente">
                  🔄 Redefinir Status
                </button>
                <button class="fd-modal-btn-cancel" id="fd-btn-clear-prompts" style="padding: 6px 12px; font-size: 12px; color: #f87171;" title="Limpar lista de prompts">
                  🗑️ Limpar
                </button>
              </div>
            </div>

            <!-- Prompts Table / List -->
            <div class="fd-prompt-table-wrapper" id="fd-prompts-list">
              <!-- Prompt rows rendered dynamically -->
            </div>
          </div>

          <!-- TAB 2: Characters -->
          <div class="fd-tab-pane" id="pane-characters">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; flex-wrap: wrap; gap: 8px;">
              <div>
                <h3 style="margin: 0; font-size: 14px; font-weight: 700; color: #fff;">Personagens Pré-definidos</h3>
                <span style="font-size: 12px; color: var(--fd-text-muted);">Defina avatares e descrições para manter a consistência visual. Salvos automaticamente na memória.</span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <input type="file" id="fd-input-import-chars-json" accept=".json" style="display: none;">
                <button class="fd-modal-btn-cancel" id="fd-btn-import-chars-json" title="Restaurar backup de personagens de um arquivo .json" style="padding: 6px 12px; font-size: 11px;">
                  📥 Importar JSON
                </button>
                <button class="fd-modal-btn-cancel" id="fd-btn-export-chars-json" title="Baixar backup de todos os personagens e fotos em arquivo .json" style="padding: 6px 12px; font-size: 11px;">
                  💾 Exportar Backup
                </button>
                <button class="fd-modal-btn-confirm" id="fd-btn-add-char" style="padding: 7px 14px; font-size: 12px;">
                  + Novo Personagem
                </button>
              </div>
            </div>

            <!-- Characters Grid -->
            <div class="fd-chars-grid" id="fd-chars-list">
              <!-- Rendered dynamically -->
            </div>
          </div>

          <!-- TAB 3: Format & Generation (Screenshot-Matched) -->
          <div class="fd-tab-pane" id="pane-format">
            <div class="fd-flow-controls-card">
              <!-- Media Switcher: Imagem / Vídeo -->
              <div class="fd-media-switcher">
                <button class="fd-media-btn ${engine.config.mediaType === 'image' ? 'active' : ''}" data-media="image">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <polyline points="21 15 16 10 5 21"></polyline>
                  </svg>
                  <span>Imagem</span>
                </button>
                <button class="fd-media-btn ${engine.config.mediaType === 'video' ? 'active' : ''}" data-media="video">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="23 7 16 12 23 17 23 7"></polygon>
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
                  </svg>
                  <span>Vídeo</span>
                </button>
              </div>

              <!-- Aspect Ratio Buttons (16:9, 4:3, 1:1, 3:4, 9:16) -->
              <div class="fd-aspect-group">
                <button class="fd-aspect-btn ${engine.config.aspectRatio === '16:9' ? 'active' : ''}" data-ratio="16:9">
                  <span class="fd-aspect-icon r-16-9"></span>
                  <span class="fd-aspect-label">16:9</span>
                </button>
                <button class="fd-aspect-btn ${engine.config.aspectRatio === '4:3' ? 'active' : ''}" data-ratio="4:3">
                  <span class="fd-aspect-icon r-4-3"></span>
                  <span class="fd-aspect-label">4:3</span>
                </button>
                <button class="fd-aspect-btn ${engine.config.aspectRatio === '1:1' ? 'active' : ''}" data-ratio="1:1">
                  <span class="fd-aspect-icon r-1-1"></span>
                  <span class="fd-aspect-label">1:1</span>
                </button>
                <button class="fd-aspect-btn ${engine.config.aspectRatio === '3:4' ? 'active' : ''}" data-ratio="3:4">
                  <span class="fd-aspect-icon r-3-4"></span>
                  <span class="fd-aspect-label">3:4</span>
                </button>
                <button class="fd-aspect-btn ${engine.config.aspectRatio === '9:16' ? 'active' : ''}" data-ratio="9:16">
                  <span class="fd-aspect-icon r-9-16"></span>
                  <span class="fd-aspect-label">9:16</span>
                </button>
              </div>

              <!-- Model Selector Dropdown -->
              <div class="fd-model-select-wrapper">
                <div class="fd-model-btn" id="fd-model-dropdown-trigger">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span>⚡</span>
                    <span id="fd-selected-model-text">${engine.config.model || 'Nano Banana Pro'}</span>
                  </div>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </div>
              </div>

              <!-- Quantity Selector (x1, x2, x3, x4) -->
              <div class="fd-quantity-group">
                <button class="fd-quantity-btn ${engine.config.quantity === 1 ? 'active' : ''}" data-qty="1">x1</button>
                <button class="fd-quantity-btn ${engine.config.quantity === 2 ? 'active' : ''}" data-qty="2">x2</button>
                <button class="fd-quantity-btn ${engine.config.quantity === 3 ? 'active' : ''}" data-qty="3">x3</button>
                <button class="fd-quantity-btn ${engine.config.quantity === 4 ? 'active' : ''}" data-qty="4">x4</button>
              </div>

              <!-- Delay, Repetitions and Extra Config -->
              <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 12px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 14px;">
                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <span style="font-size: 12px; color: var(--fd-text-muted);">🔁 Repetições por Prompt:</span>
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <input type="number" id="fd-config-repeat-per-prompt" min="1" max="50" value="${engine.config.repeatPerPrompt || 1}" class="fd-modal-input" style="width: 55px; text-align: center; background: rgba(0,0,0,0.3); border: 1px solid var(--fd-border); border-radius: 6px; padding: 4px;">
                    <span style="font-size: 12px; color: var(--fd-text-muted);">vez(es)</span>
                  </div>
                </div>

                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <div style="display: flex; flex-direction: column;">
                    <span style="font-size: 12px; font-weight: 600; color: #fff;">⏳ Intervalo entre Prompts / Slides:</span>
                    <span style="font-size: 10px; color: var(--fd-text-muted);">Pausa para geração no FLOW (Padrão: 15 segundos)</span>
                  </div>
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <input type="number" id="fd-config-delay" min="3" max="300" value="${engine.config.delaySeconds || 15}" class="fd-modal-input" style="width: 55px; text-align: center; background: rgba(0,0,0,0.3); border: 1px solid var(--fd-border); border-radius: 6px; padding: 4px; color: #38bdf8; font-weight: 700;">
                    <span style="font-size: 12px; color: var(--fd-text-muted);">seg</span>
                  </div>
                </div>

                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <div style="display: flex; flex-direction: column;">
                    <span style="font-size: 12px; font-weight: 600; color: #fff;">⏳ Intervalo entre Carrosséis:</span>
                    <span style="font-size: 10px; color: var(--fd-text-muted);">Pausa entre o fim de um carrossel e o próximo (Padrão: 25 segundos)</span>
                  </div>
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <input type="number" id="fd-config-carousel-delay" min="5" max="600" value="${engine.config.carouselDelaySeconds || 25}" class="fd-modal-input" style="width: 55px; text-align: center; background: rgba(0,0,0,0.3); border: 1px solid var(--fd-border); border-radius: 6px; padding: 4px; color: #38bdf8; font-weight: 700;">
                    <span style="font-size: 12px; color: var(--fd-text-muted);">seg</span>
                  </div>
                </div>

                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <div style="display: flex; flex-direction: column;">
                    <span style="font-size: 12px; color: var(--fd-text-muted);">⚡ Delay entre Micro-Ações:</span>
                    <span style="font-size: 10px; color: var(--fd-text-muted);">Tempo entre cliques e seleções no DOM (Padrão: 500ms)</span>
                  </div>
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <input type="number" id="fd-config-action-delay" min="100" max="3000" step="50" value="${engine.config.actionDelayMs || 500}" class="fd-modal-input" style="width: 55px; text-align: center; background: rgba(0,0,0,0.3); border: 1px solid var(--fd-border); border-radius: 6px; padding: 4px;">
                    <span style="font-size: 12px; color: var(--fd-text-muted);">ms</span>
                  </div>
                </div>

                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <span style="font-size: 12px; color: var(--fd-text-muted);">🎭 Aplicar Personagens Automaticamente:</span>
                  <label class="fd-switch">
                    <input type="checkbox" id="fd-toggle-apply-chars" name="fd_toggle_apply_chars" ${engine.config.applyGlobalCharacters !== false ? 'checked' : ''} autocomplete="off">
                    <span class="fd-slider"></span>
                  </label>
                </div>

                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <div style="display: flex; flex-direction: column;">
                    <span style="font-size: 12px; font-weight: 600; color: #fff;">🔁 Reutilizar Comando (Passo 7):</span>
                    <span style="font-size: 10px; color: var(--fd-text-muted);">Clica no botão ↪ do FLOW para reaproveitar personagens e trocar apenas o prompt</span>
                  </div>
                  <label class="fd-switch">
                    <input type="checkbox" id="fd-toggle-reuse-command" name="fd_toggle_reuse_command" ${engine.config.reusePreviousCommand !== false ? 'checked' : ''} autocomplete="off">
                    <span class="fd-slider"></span>
                  </label>
                </div>

                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <div style="display: flex; flex-direction: column;">
                    <span style="font-size: 12px; font-weight: 600; color: #fff;">📁 Novo Projeto a Cada Carrossel (Passo A):</span>
                    <span style="font-size: 10px; color: var(--fd-text-muted);">Clica em "+ Novo projeto" no FLOW automaticamente ao concluir cada carrossel</span>
                  </div>
                  <label class="fd-switch">
                    <input type="checkbox" id="fd-toggle-new-proj-per-carousel" name="fd_toggle_new_proj_per_carousel" ${engine.config.autoCreateNewProjectPerCarousel !== false ? 'checked' : ''} autocomplete="off">
                    <span class="fd-slider"></span>
                  </label>
                </div>

                <div style="display: flex; align-items: center; justify-content: space-between; padding-top: 10px; border-top: 1px dashed rgba(255,255,255,0.08); margin-top: 6px;">
                  <div style="display: flex; flex-direction: column;">
                    <span style="font-size: 12px; font-weight: 600; color: #fff;">🧭 Detecção de Página do FLOW:</span>
                    <span style="font-size: 11px; color: ${FlowMacroEngine.isFlowProjectPage() ? '#34d399' : '#38bdf8'}; font-weight: 600;">
                      ${FlowMacroEngine.isFlowProjectPage() ? '📍 Dentro de um Projeto (' + (FlowMacroEngine.getCurrentProjectId() || 'Ativo') + ')' : '🏠 Hub do FLOW (Página Inicial / Iniciar Novo Projeto)'}
                    </span>
                  </div>
                  <button type="button" id="fd-btn-manual-new-project" style="background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.4); color: #38bdf8; border-radius: 6px; padding: 6px 12px; font-size: 11px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: all 0.2s ease;">
                    <span>➕ Criar Novo Projeto</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- TAB 4: Execution & Logs -->
          <div class="fd-tab-pane" id="pane-execution">
            <!-- Action Controls -->
            <div class="fd-macro-action-bar">
              <button class="fd-btn-macro-play" id="fd-btn-run-macro">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                <span id="fd-run-btn-text">${engine.state === 'running' ? 'Executando...' : 'Iniciar Macro'}</span>
              </button>
              <button class="fd-btn-macro-pause" id="fd-btn-pause-macro">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <rect x="6" y="4" width="4" height="16"></rect>
                  <rect x="14" y="4" width="4" height="16"></rect>
                </svg>
                <span>Pausar</span>
              </button>
              <button class="fd-btn-macro-stop" id="fd-btn-stop-macro">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <rect x="4" y="4" width="16" height="16"></rect>
                </svg>
                <span>Parar</span>
              </button>
            </div>

            <!-- Real-Time Time Tracking & Status Card -->
            <div class="fd-timer-dashboard">
              <div class="fd-timer-tile">
                <span class="fd-timer-tile-title">⏱️ Tempo Decorrido</span>
                <span class="fd-timer-tile-value ${engine.state === 'running' ? 'active' : ''}" id="fd-timer-elapsed-val">
                  ${engine.elapsedFormatted || '00:00'}
                </span>
              </div>
              <div class="fd-timer-tile">
                <span class="fd-timer-tile-title">⏳ Status / Ação Atual</span>
                <span class="fd-timer-tile-value countdown" id="fd-timer-action-val" style="font-size: 13px; font-weight: 700;">
                  ${engine.currentAction || (engine.state === 'running' ? 'Executando...' : 'Pronto')}
                </span>
              </div>
            </div>

            <!-- Active Countdown Bar (shows during slide/carousel delays) -->
            <div class="fd-countdown-box" id="fd-countdown-container" style="display: ${engine.countdown.remaining > 0 ? 'flex' : 'none'};">
              <div class="fd-countdown-header">
                <span id="fd-countdown-label">⏳ ${engine.countdown.label || 'Aguardando próxima ação'}:</span>
                <span id="fd-countdown-seconds" style="color: #38bdf8; font-size: 13px; font-family: monospace;">${engine.countdown.remaining}s</span>
              </div>
              <div class="fd-countdown-track">
                <div class="fd-countdown-bar-fill" id="fd-countdown-bar-fill" style="width: ${engine.countdown.total > 0 ? Math.round((engine.countdown.remaining / engine.countdown.total) * 100) : 0}%;"></div>
              </div>
            </div>

            <!-- Progress Bar -->
            <div class="fd-progress-box">
              <div style="display: flex; align-items: center; justify-content: space-between; font-size: 12px;">
                <span id="fd-progress-label" style="font-weight: 600; color: #fff;">Progresso: 0 / 0</span>
                <span id="fd-progress-pct" style="color: var(--fd-primary); font-weight: 700;">0%</span>
              </div>
              <div class="fd-progress-bar-bg">
                <div class="fd-progress-bar-fill" id="fd-progress-fill" style="width: 0%;"></div>
              </div>
              <div id="fd-current-task-name" style="font-size: 11px; color: var(--fd-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                Aguardando início...
              </div>
            </div>

            <!-- Live Logs Console -->
            <div style="display: flex; flex-direction: column; gap: 6px;">
              <div style="display: flex; align-items: center; justify-content: space-between;">
                <span style="font-size: 12px; font-weight: 600; color: var(--fd-text-muted);">Console de Execução em Tempo Real:</span>
                <button class="fd-modal-btn-cancel" id="fd-btn-clear-logs" title="Limpar todos os registros do console" style="padding: 3px 10px; font-size: 11px; display: flex; align-items: center; gap: 4px;">
                  🧹 Limpar Console
                </button>
              </div>
              <div class="fd-logs-console" id="fd-logs-console">
                <!-- Log items rendered dynamically -->
              </div>
            </div>
          </div>

          <!-- TAB 5: FLOW Inspector / Espião de Elementos com I.A -->
          <div class="fd-tab-pane" id="pane-inspector">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; flex-wrap: wrap; gap: 8px;">
              <div>
                <h3 style="margin: 0; font-size: 14px; font-weight: 700; color: #fff;">🔍 Espião e Diagnóstico Inteligente com I.A</h3>
                <span style="font-size: 12px; color: var(--fd-text-muted);">Varredura de elementos em tempo real + Análise e Auto-Recuperação via Gemini, Groq ou OpenRouter.</span>
              </div>
              <div style="display: flex; gap: 6px;">
                <button class="fd-modal-btn-cancel" id="fd-btn-refresh-inspector" style="padding: 6px 12px; font-size: 12px;">
                  🔄 Varredura DOM
                </button>
                <button class="fd-modal-btn-confirm" id="fd-btn-run-ai-diag" style="padding: 6px 14px; font-size: 12px; background: linear-gradient(135deg, #6366f1, #8b5cf6);">
                  🤖 Analisar com I.A Agora
                </button>
              </div>
            </div>

            <!-- AI Configuration & Multi-Key Pool Card -->
            <div style="background: rgba(99, 102, 241, 0.07); border: 1px solid rgba(99, 102, 241, 0.25); border-radius: 10px; padding: 12px; margin-bottom: 12px;">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; flex-wrap: wrap; gap: 6px;">
                <div>
                  <span style="font-size: 12px; font-weight: 700; color: #c7d2fe; display: flex; align-items: center; gap: 6px;">
                    <span>🔑 Pool de Chaves de I.A com Rotação Automática</span>
                    <span class="fd-badge-status" id="fd-badge-keys-count" style="background: rgba(99, 102, 241, 0.2); color: #818cf8;">${engine.aiKeysPool.length} Chaves</span>
                  </span>
                  <div style="font-size: 11px; color: var(--fd-text-muted); margin-top: 2px;">
                    Carregue múltiplas chaves gratuitas (Gemini, Groq, OpenRouter). Quando uma esgotar a cota, a próxima assume instantaneamente.
                  </div>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px; color: var(--fd-text-muted);" title="Alterna para a próxima chave quando a cota acabar">
                    <input type="checkbox" id="fd-toggle-ai-autorotate" ${engine.config.aiAutoRotateKeys !== false ? 'checked' : ''} style="cursor: pointer;">
                    <span>Rotação Automática</span>
                  </label>
                  <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px; color: var(--fd-text-muted);">
                    <input type="checkbox" id="fd-toggle-ai-autoheal" ${engine.config.aiAutoHeal !== false ? 'checked' : ''} style="cursor: pointer;">
                    <span>Auto-Recuperação</span>
                  </label>
                </div>
              </div>

              <!-- Key Import Actions Bar -->
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; background: rgba(0,0,0,0.3); padding: 8px 10px; border-radius: 8px; border: 1px solid var(--fd-border);">
                <input type="file" id="fd-input-import-keys-file" accept=".pdf,.txt,.docx,.json,.md,.csv,.rtf" style="display: none;">
                <button type="button" class="fd-modal-btn-confirm" id="fd-btn-upload-keys-file" style="padding: 5px 12px; font-size: 11px; display: flex; align-items: center; gap: 4px;">
                  📂 Carregar Arquivo (PDF, TXT, DOCX, etc.)
                </button>
                <button type="button" class="fd-modal-btn-cancel" id="fd-btn-paste-keys-list" style="padding: 5px 10px; font-size: 11px;">
                  📋 Colar Lista
                </button>
                <button type="button" class="fd-modal-btn-cancel" id="fd-btn-reset-keys-status" style="padding: 5px 10px; font-size: 11px;" title="Redefinir status de todas as chaves para Ativa">
                  🔄 Resetar Cotas
                </button>
                <button type="button" class="fd-modal-btn-cancel" id="fd-btn-clear-keys-pool" style="padding: 5px 10px; font-size: 11px; color: #f87171;" title="Remover todas as chaves do pool">
                  🗑️ Limpar Pool
                </button>
              </div>

              <!-- Quick Single Key Add Inputs -->
              <div style="display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 8px; align-items: center; margin-bottom: 10px;">
                <div>
                  <select id="fd-select-ai-provider" style="width: 100%; background: rgba(0,0,0,0.5); border: 1px solid var(--fd-border); border-radius: 6px; color: #fff; padding: 5px 8px; font-size: 11px;">
                    <option value="gemini" ${engine.config.aiProvider === 'gemini' ? 'selected' : ''}>🟢 Google Gemini (Grátis)</option>
                    <option value="groq" ${engine.config.aiProvider === 'groq' ? 'selected' : ''}>⚡ Groq (Ultrarrápido)</option>
                    <option value="openrouter" ${engine.config.aiProvider === 'openrouter' ? 'selected' : ''}>🌐 OpenRouter</option>
                  </select>
                </div>
                <div>
                  <input type="password" id="fd-input-ai-key" value="${engine.config.aiApiKey || ''}" placeholder="Adicionar chave individual..." style="width: 100%; background: rgba(0,0,0,0.5); border: 1px solid var(--fd-border); border-radius: 6px; color: #fff; padding: 5px 8px; font-size: 11px; box-sizing: border-box;">
                </div>
                <div style="display: flex; gap: 4px;">
                  <button type="button" id="fd-btn-add-single-key" style="flex: 1; padding: 5px 8px; background: rgba(99, 102, 241, 0.3); border: 1px solid rgba(99, 102, 241, 0.5); border-radius: 6px; color: #fff; font-size: 11px; cursor: pointer; font-weight: 600;">
                    + Adicionar
                  </button>
                  <button type="button" id="fd-btn-test-ai-key" style="padding: 5px 8px; background: rgba(255,255,255,0.08); border: 1px solid var(--fd-border); border-radius: 6px; color: #fff; font-size: 11px; cursor: pointer;">
                    🧪 Testar
                  </button>
                </div>
              </div>

              <!-- Keys Pool List Table -->
              <div id="fd-ai-keys-pool-container" style="background: rgba(0,0,0,0.4); border: 1px solid var(--fd-border); border-radius: 8px; max-height: 140px; overflow-y: auto; padding: 4px 6px;">
                <!-- Rendered dynamically -->
              </div>

              <!-- AI Real-Time Result Box -->
              <div id="fd-ai-result-box" style="display: none; margin-top: 10px; background: rgba(0,0,0,0.6); border: 1px solid rgba(139, 92, 246, 0.3); border-radius: 8px; padding: 10px 12px; font-size: 11px; color: #e2e8f0; line-height: 1.5; max-height: 150px; overflow-y: auto;">
                <!-- AI Output Rendered Dynamically -->
              </div>
            </div>

            <!-- Inspector DOM Grid -->
            <div class="fd-inspector-grid" id="fd-inspector-grid">
              <!-- Rendered dynamically -->
            </div>

            <!-- Real-Time Telemetry & Event Recorder Panel -->
            <div class="fd-telemetry-panel">
              <div class="fd-telemetry-header">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span class="fd-live-indicator ${engine.isRecordingTelemetry ? '' : 'paused'}" id="fd-telemetry-live-badge">
                    <span class="fd-live-dot"></span>
                    <span id="fd-telemetry-live-text">${engine.isRecordingTelemetry ? 'GRAVAÇÃO ATIVA' : 'GRAVAÇÃO PAUSADA'}</span>
                  </span>
                  <span style="font-size: 11px; color: var(--fd-text-muted);" id="fd-telemetry-count-text">
                    ${engine.telemetryEvents.length} eventos | ${Object.keys(engine.learnedSelectors).length} seletores aprendidos
                  </span>
                </div>
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                  <button type="button" class="fd-modal-btn-confirm" id="fd-btn-inspect-element-click" style="padding: 5px 10px; font-size: 11px; background: linear-gradient(135deg, #0284c7, #0369a1);" title="Clique em qualquer botão ou input do FLOW para capturar o seletor exato">
                    🎯 Inspecionar Elemento
                  </button>
                  <button type="button" class="fd-modal-btn-cancel" id="fd-btn-toggle-recording" style="padding: 5px 10px; font-size: 11px;">
                    ${engine.isRecordingTelemetry ? '⏸️ Pausar' : '🔴 Gravar'}
                  </button>
                  <button type="button" class="fd-modal-btn-cancel" id="fd-btn-export-telemetry" style="padding: 5px 10px; font-size: 11px;" title="Exportar histórico de telemetria, cliques e seletores em JSON">
                    📥 Exportar (.json)
                  </button>
                  <button type="button" class="fd-modal-btn-cancel" id="fd-btn-clear-telemetry" style="padding: 5px 10px; font-size: 11px; color: #f87171;" title="Limpar lista de eventos em tempo real">
                    🗑️ Limpar
                  </button>
                  <button type="button" class="fd-modal-btn-cancel" id="fd-btn-reset-learned-selectors" style="padding: 5px 10px; font-size: 11px;" title="Redefinir memória de seletores aprendidos">
                    🧠 Resetar Cache
                  </button>
                </div>
              </div>

              <!-- Filter chips -->
              <div class="fd-telemetry-filters" id="fd-telemetry-filters">
                <span class="fd-telemetry-chip active" data-filter="all">Todos</span>
                <span class="fd-telemetry-chip" data-filter="CLICK">Cliques</span>
                <span class="fd-telemetry-chip" data-filter="MACRO">Macro</span>
                <span class="fd-telemetry-chip" data-filter="INPUT">Inputs</span>
                <span class="fd-telemetry-chip" data-filter="NAVIGATION">Navegação</span>
                <span class="fd-telemetry-chip" data-filter="DOM_MUTATION">Mutações</span>
                <span class="fd-telemetry-chip" data-filter="LEARNED_SELECTOR">Aprendizado</span>
              </div>

              <!-- Live Event Stream Feed -->
              <div class="fd-telemetry-feed" id="fd-telemetry-live-feed">
                <!-- Rendered dynamically -->
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(macroModalElement);

    // =========================================================================
    // Vinculação de Eventos da Interface do Usuário (UI)
    // =========================================================================
    
    // Ações do cabeçalho: Fechar, Modo Transparente e Modo PIP (Picture-in-Picture)
    const btnClose = macroModalElement.querySelector('#fd-macro-btn-close');
    const btnTransparent = macroModalElement.querySelector('#fd-macro-btn-transparent');
    const btnPip = macroModalElement.querySelector('#fd-macro-btn-pip');
    const windowEl = macroModalElement.querySelector('#fd-macro-window');
    const dragHandle = macroModalElement.querySelector('#fd-macro-drag-handle');

    // Botão de fechar a janela do Studio
    btnClose.addEventListener('click', () => {
      macroModalElement.style.display = 'none';
    });

    // Alterna o modo transparente para permitir ao usuário enxergar o FLOW através do painel
    btnTransparent.addEventListener('click', () => {
      macroModalElement.classList.toggle('transparent-mode');
      const isTrans = macroModalElement.classList.contains('transparent-mode');
      showToast(isTrans ? '👁️ Modo Transparente ativado (Você pode ver o FLOW atrás)' : 'Modo Padrão restaurado', 'info');
    });

    // Minimiza o Studio para a barra flutuante compacta (Mini Runner)
    btnPip.addEventListener('click', () => {
      enableMiniRunnerMode(true);
    });

    // Configura o painel do Studio para ser arrastável
    setupDraggableModal(windowEl, dragHandle);

    // Alça de redimensionamento na borda esquerda do painel
    const resizeHandle = macroModalElement.querySelector('#fd-resize-handle');
    if (resizeHandle) {
      let isResizing = false;
      let startX = 0;
      let startWidth = 0;

      resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = macroModalElement.offsetWidth;
        resizeHandle.classList.add('active');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();

        const onMove = (evt) => {
          if (!isResizing) return;
          const dx = startX - evt.clientX;
          const newWidth = Math.max(280, Math.min(window.innerWidth * 0.7, startWidth + dx));
          macroModalElement.style.width = `${newWidth}px`;
        };

        const onUp = () => {
          isResizing = false;
          resizeHandle.classList.remove('active');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    // Alternância entre as abas do Studio (Sequência, Personagens, Formato, Execução, Espião)
    const tabButtons = macroModalElement.querySelectorAll('.fd-macro-tab');
    const panes = macroModalElement.querySelectorAll('.fd-tab-pane');

    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        tabButtons.forEach(b => b.classList.remove('active'));
        panes.forEach(p => p.classList.remove('active'));

        btn.classList.add('active');
        const targetPane = macroModalElement.querySelector(`#pane-${targetTab}`);
        if (targetPane) targetPane.classList.add('active');
        activeTab = targetTab;
      });
    });

    // Área de upload por Drag & Drop para PDFs e arquivos de texto/roteiro
    const dropzone = macroModalElement.querySelector('#fd-dropzone');
    const fileInput = macroModalElement.querySelector('#fd-file-input');

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await processUploadedFile(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', async (e) => {
      if (e.target.files && e.target.files.length > 0) {
        await processUploadedFile(e.target.files[0]);
      }
    });

    /**
     * Processa o arquivo carregado (PDF ou texto) e extrai os carrosséis e slides
     * @param {File} file - Arquivo recebido
     */
    async function processUploadedFile(file) {
      showToast(`📄 Lendo arquivo: ${file.name}...`, 'info');
      try {
        let extractedText = '';
        let extractedPages = [];
        if (file.name.toLowerCase().endsWith('.pdf')) {
          const res = await FlowPdfExtractor.extractText(file);
          extractedText = res.text;
          extractedPages = res.pages || [];
        } else {
          extractedText = await file.text();
        }

        if (!extractedText || extractedText.trim().length === 0) {
          showToast('⚠️ Nenhum texto extraído do arquivo.', 'warning');
          return;
        }

        const carousels = FlowPdfExtractor.parseCarouselsFromScript(extractedText, extractedPages);
        if (carousels.length > 0) {
          engine.setCarousels(carousels);
          showToast(`🎉 ${carousels.length} Carrosséis (${engine.prompts.length} slides) identificados com sucesso!`, 'success');
          renderCarouselsSelector();
          renderPromptsList();
        } else {
          showToast('⚠️ Não foi possível identificar prompts no texto.', 'warning');
        }
      } catch (err) {
        console.error('[FLOW Macro Studio] Erro no arquivo:', err);
        showToast(`❌ Erro ao ler arquivo: ${err.message}`, 'info');
      }
    }

    // Botão para colar roteiro diretamente em formato de texto
    const btnPasteScript = macroModalElement.querySelector('#fd-btn-paste-script');
    btnPasteScript.addEventListener('click', () => {
      const rawText = prompt('Cole aqui o texto do roteiro ou lista de prompts:');
      if (rawText && rawText.trim()) {
        const carousels = FlowPdfExtractor.parseCarouselsFromScript(rawText);
        if (carousels.length > 0) {
          engine.setCarousels(carousels);
          showToast(`🎉 ${carousels.length} Carrosséis (${engine.prompts.length} slides) carregados!`, 'success');
          renderCarouselsSelector();
          renderPromptsList();
        }
      }
    });

    // Botão para adicionar um prompt manual individual
    const btnAddPrompt = macroModalElement.querySelector('#fd-btn-add-prompt');
    btnAddPrompt.addEventListener('click', () => {
      const text = prompt('Digite o novo Prompt de Imagem:');
      if (text && text.trim()) {
        engine.addPrompt({
          title: `Prompt #${engine.prompts.length + 1}`,
          fullText: text.trim(),
          imagePrompt: text.trim()
        });
        renderPromptsList();
        showToast('✅ Prompt adicionado à sequência!', 'success');
      }
    });

    // Campo de repetição global na Aba 1
    const inputGlobalRepeat = macroModalElement.querySelector('#fd-input-global-repeat');
    if (inputGlobalRepeat) {
      inputGlobalRepeat.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10) || 1;
        engine.setGlobalRepeatCount(val);
        const configRepeatInput = macroModalElement.querySelector('#fd-config-repeat-per-prompt');
        if (configRepeatInput) configRepeatInput.value = val;
        renderPromptsList();
        showToast(`🔁 Todos os prompts definidos para ${val}x repetições.`, 'info');
      });
    }

    // Botão de redefinição de status para "Pendente"
    const btnResetStatus = macroModalElement.querySelector('#fd-btn-reset-status');
    btnResetStatus.addEventListener('click', () => {
      engine.resetPromptStatuses();
      renderPromptsList();
      showToast('🔄 Status e repetições redefinidos para Pendente.', 'info');
    });

    // Botão para limpar a lista completa de prompts
    const btnClearPrompts = macroModalElement.querySelector('#fd-btn-clear-prompts');
    btnClearPrompts.addEventListener('click', () => {
      if (confirm('Deseja realmente limpar todos os prompts da lista?')) {
        engine.clearPrompts();
        renderPromptsList();
      }
    });

    // =========================================================================
    // Controles da Aba de Formato e Geração (Configurações do Nano Banana Pro)
    // =========================================================================
    
    // Botões de tipo de mídia (Imagem / Vídeo)
    const mediaBtns = macroModalElement.querySelectorAll('.fd-media-btn');
    mediaBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        mediaBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const media = btn.getAttribute('data-media');
        engine.updateConfig({ mediaType: media });
      });
    });

    // Botões de proporção (16:9, 4:3, 1:1, 3:4, 9:16)
    const aspectBtns = macroModalElement.querySelectorAll('.fd-aspect-btn');
    aspectBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        aspectBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const ratio = btn.getAttribute('data-ratio');
        engine.updateConfig({ aspectRatio: ratio });
        showToast(`📐 Proporção selecionada: ${ratio}`, 'info');
      });
    });

    // Botões de quantidade por prompt (x1, x2, x3, x4)
    const qtyBtns = macroModalElement.querySelectorAll('.fd-quantity-btn');
    qtyBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        qtyBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const qty = parseInt(btn.getAttribute('data-qty'), 10);
        engine.updateConfig({ quantity: qty });
        showToast(`🔢 Quantidade por prompt: x${qty}`, 'info');
      });
    });

    // Intervalo entre slides (padrão: 15s)
    const inputDelay = macroModalElement.querySelector('#fd-config-delay');
    if (inputDelay) {
      inputDelay.addEventListener('change', (e) => {
        const val = Math.max(3, parseInt(e.target.value, 10) || 15);
        engine.updateConfig({ delaySeconds: val });
        showToast(`⏳ Intervalo entre slides: ${val}s`, 'info');
      });
    }

    // Intervalo entre carrosséis (padrão: 25s)
    const inputCarouselDelay = macroModalElement.querySelector('#fd-config-carousel-delay');
    if (inputCarouselDelay) {
      inputCarouselDelay.addEventListener('change', (e) => {
        const val = Math.max(5, parseInt(e.target.value, 10) || 25);
        engine.updateConfig({ carouselDelaySeconds: val });
        showToast(`⏳ Intervalo entre carrosséis: ${val}s`, 'info');
      });
    }

    // Micro-delay entre ações no DOM (padrão: 500ms)
    const inputActionDelay = macroModalElement.querySelector('#fd-config-action-delay');
    if (inputActionDelay) {
      inputActionDelay.addEventListener('change', (e) => {
        const val = Math.max(100, parseInt(e.target.value, 10) || 500);
        engine.updateConfig({ actionDelayMs: val });
        showToast(`⚡ Micro-delay entre ações: ${val}ms`, 'info');
      });
    }

    // Repetições padrão por prompt
    const inputConfigRepeat = macroModalElement.querySelector('#fd-config-repeat-per-prompt');
    if (inputConfigRepeat) {
      inputConfigRepeat.addEventListener('change', (e) => {
        const val = parseInt(e.target.value, 10) || 1;
        engine.setGlobalRepeatCount(val);
        if (inputGlobalRepeat) inputGlobalRepeat.value = val;
        renderPromptsList();
        showToast(`🔁 Repetições padrão ajustadas para: ${val}x`, 'info');
      });
    }

    // Toggle de aplicação automática de personagens
    const toggleApplyChars = macroModalElement.querySelector('#fd-toggle-apply-chars');
    if (toggleApplyChars) {
      toggleApplyChars.addEventListener('change', (e) => {
        engine.updateConfig({ applyGlobalCharacters: e.target.checked });
      });
    }

    // Toggle de reaproveitamento de comando (Passo 7)
    const toggleReuseCmd = macroModalElement.querySelector('#fd-toggle-reuse-command');
    if (toggleReuseCmd) {
      toggleReuseCmd.addEventListener('change', (e) => {
        engine.updateConfig({ reusePreviousCommand: e.target.checked });
        showToast(e.target.checked ? '🔁 Modo Reutilizar Comando ativado!' : 'Manual: Personagens injetados do zero a cada slide.', 'info');
      });
    }

    // Toggle de criação automática de novo projeto por carrossel (Passo A)
    const toggleNewProj = macroModalElement.querySelector('#fd-toggle-new-proj-per-carousel');
    if (toggleNewProj) {
      toggleNewProj.addEventListener('change', (e) => {
        engine.updateConfig({ autoCreateNewProjectPerCarousel: e.target.checked });
        showToast(e.target.checked ? '📁 Criação de novo projeto por carrossel ativada!' : 'Projetos mantidos no mesmo espaço.', 'info');
      });
    }

    // =========================================================================
    // Gerenciamento de Personagens com Upload de Imagens e Backup JSON
    // =========================================================================
    const btnAddChar = macroModalElement.querySelector('#fd-btn-add-char');
    if (btnAddChar) {
      btnAddChar.addEventListener('click', (e) => {
        e.preventDefault();
        openAddCharacterDialog();
      });
    }

    // Exportar personagens para backup em arquivo .JSON
    const btnExportChars = macroModalElement.querySelector('#fd-btn-export-chars-json');
    if (btnExportChars) {
      btnExportChars.addEventListener('click', (e) => {
        e.preventDefault();
        if (engine.characters.length === 0) {
          showToast('⚠️ Nenhum personagem cadastrado para exportar.', 'warning');
          return;
        }
        const ok = engine.exportCharactersToJson();
        if (ok) showToast('💾 Backup de personagens exportado com sucesso!', 'success');
      });
    }

    // Importar personagens a partir de um backup .JSON
    const btnImportChars = macroModalElement.querySelector('#fd-btn-import-chars-json');
    const inputImportChars = macroModalElement.querySelector('#fd-input-import-chars-json');
    if (btnImportChars && inputImportChars) {
      btnImportChars.addEventListener('click', (e) => {
        e.preventDefault();
        inputImportChars.click();
      });

      inputImportChars.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          const file = e.target.files[0];
          const reader = new FileReader();
          reader.onload = (ev) => {
            const ok = engine.importCharactersFromJson(ev.target.result);
            if (ok) {
              renderCharactersList();
              showToast(`📥 Personagens importados com sucesso! Total: ${engine.characters.length}`, 'success');
            } else {
              showToast('❌ Arquivo de backup inválido.', 'error');
            }
          };
          reader.readAsText(file);
          inputImportChars.value = '';
        }
      });
    }

    /**
     * Abre a janela modal para cadastrar novo personagem com nome, foto e tag
     */
    function openAddCharacterDialog() {
      const existing = document.getElementById('fd-char-creator-modal');
      if (existing) existing.remove();

      const dialog = document.createElement('div');
      dialog.className = 'fd-char-creator-modal';
      dialog.id = 'fd-char-creator-modal';
      dialog.innerHTML = `
        <div class="fd-modal-card" style="max-width: 480px; z-index: 10000021;">
          <div class="fd-modal-header">
            <div class="fd-modal-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
              <span>Novo Personagem</span>
            </div>
            <button class="fd-btn-icon" id="fd-btn-close-char-dialog" title="Fechar">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>

          <div style="display: flex; flex-direction: column; gap: 14px;">
            <div>
              <label style="font-size: 12px; font-weight: 600; color: var(--fd-text-muted);">Nome do Personagem:</label>
              <input type="text" id="fd-input-char-name" name="fd_character_name" autocomplete="off" data-lpignore="true" class="fd-modal-input" placeholder="Ex: Personagem 1 - Robô Cérebro" style="background: rgba(0,0,0,0.3); border: 1px solid var(--fd-border); border-radius: 8px; padding: 8px 12px; margin-top: 4px;">
            </div>

            <!-- Área de Upload de Foto do Personagem -->
            <div>
              <label style="font-size: 12px; font-weight: 600; color: var(--fd-text-muted);">Foto / Imagem de Referência do Personagem:</label>
              <div class="fd-dropzone" id="fd-char-img-dropzone" style="padding: 18px; margin-top: 4px; cursor: pointer; border: 2px dashed rgba(99, 102, 241, 0.4); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;">
                <input type="file" id="fd-char-file-input" name="fd_character_photo" accept="image/png,image/jpeg,image/webp,image/jpg,image/svg+xml" style="display: none;">
                <img id="fd-char-preview-img" style="display: none; width: 80px; height: 80px; border-radius: 14px; object-fit: cover; border: 2px solid #10b981; box-shadow: 0 0 14px rgba(16,185,129,0.3);">
                <div id="fd-char-drop-prompt" style="display: flex; flex-direction: column; align-items: center; gap: 4px; pointer-events: none;">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--fd-primary);">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <polyline points="21 15 16 10 5 21"></polyline>
                  </svg>
                  <span style="font-size: 13px; font-weight: 600; color: #fff;">Clique ou arraste a imagem do personagem aqui</span>
                  <span style="font-size: 11px; color: var(--fd-text-muted);">PNG, JPG, WEBP (Será salva na memória e enviada ao FLOW)</span>
                </div>
                <button type="button" class="fd-modal-btn-cancel" id="fd-btn-select-char-file" style="padding: 5px 12px; font-size: 11px; margin-top: 4px;">
                  📁 Escolher Arquivo do PC
                </button>
              </div>
            </div>

            <div>
              <label style="font-size: 12px; font-weight: 600; color: var(--fd-text-muted);">Prompt / Descrição do Personagem (opcional):</label>
              <textarea id="fd-input-char-tag" name="fd_character_prompt_tag" autocomplete="off" data-lpignore="true" class="fd-modal-input" rows="2" placeholder="Ex: Brain cyborg green character with circuit patterns..." style="background: rgba(0,0,0,0.3); border: 1px solid var(--fd-border); border-radius: 8px; padding: 8px 12px; margin-top: 4px; resize: vertical;"></textarea>
            </div>
          </div>

          <div class="fd-modal-actions">
            <button class="fd-modal-btn-cancel" id="fd-btn-cancel-char">Cancelar</button>
            <button class="fd-modal-btn-confirm" id="fd-btn-save-char">Salvar Personagem</button>
          </div>
        </div>
      `;

      document.body.appendChild(dialog);

      let selectedAvatarDataUrl = '';
      const dropzone = dialog.querySelector('#fd-char-img-dropzone');
      const fileInput = dialog.querySelector('#fd-char-file-input');
      const previewImg = dialog.querySelector('#fd-char-preview-img');
      const dropPrompt = dialog.querySelector('#fd-char-drop-prompt');
      const btnPickFile = dialog.querySelector('#fd-btn-select-char-file');

      dropzone.addEventListener('click', (e) => {
        if (e.target !== fileInput) {
          fileInput.click();
        }
      });

      if (btnPickFile) {
        btnPickFile.addEventListener('click', (e) => {
          e.stopPropagation();
          fileInput.click();
        });
      }

      fileInput.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
        dropzone.style.borderColor = '#10b981';
      });

      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
        dropzone.style.borderColor = 'rgba(99, 102, 241, 0.4)';
      });

      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        dropzone.style.borderColor = 'rgba(99, 102, 241, 0.4)';
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          handleImageFile(e.dataTransfer.files[0]);
        }
      });

      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          handleImageFile(e.target.files[0]);
        }
      });

      /**
       * Otimiza a imagem do personagem usando Canvas para salvar no Chrome Storage e injetar no FLOW
       * @param {File} file - Arquivo de imagem
       */
      function handleImageFile(file) {
        if (!file.type.startsWith('image/')) {
          showToast('⚠️ Por favor selecione um arquivo de imagem válido (PNG, JPG, WEBP).', 'warning');
          return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
          const rawDataUrl = ev.target.result;

          const img = new Image();
          img.onload = () => {
            try {
              const maxDim = 640;
              let w = img.width;
              let h = img.height;
              if (w > maxDim || h > maxDim) {
                if (w > h) {
                  h = Math.round((h * maxDim) / w);
                  w = maxDim;
                } else {
                  w = Math.round((w * maxDim) / h);
                  h = maxDim;
                }
              }
              const canvas = document.createElement('canvas');
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0, w, h);
              selectedAvatarDataUrl = canvas.toDataURL('image/png');
            } catch (err) {
              selectedAvatarDataUrl = rawDataUrl;
            }

            previewImg.src = selectedAvatarDataUrl;
            previewImg.style.display = 'block';
            dropPrompt.querySelector('span').innerText = `✅ ${file.name}`;
            showToast('📸 Foto do personagem otimizada e pronta para persistência!', 'success');
          };
          img.onerror = () => {
            selectedAvatarDataUrl = rawDataUrl;
            previewImg.src = selectedAvatarDataUrl;
            previewImg.style.display = 'block';
            dropPrompt.querySelector('span').innerText = `✅ ${file.name}`;
          };
          img.src = rawDataUrl;
        };
        reader.readAsDataURL(file);
      }

      dialog.querySelector('#fd-btn-close-char-dialog').addEventListener('click', () => dialog.remove());
      dialog.querySelector('#fd-btn-cancel-char').addEventListener('click', () => dialog.remove());

      dialog.querySelector('#fd-btn-save-char').addEventListener('click', () => {
        const name = dialog.querySelector('#fd-input-char-name').value.trim() || 'Personagem';
        const tag = dialog.querySelector('#fd-input-char-tag').value.trim();
        engine.addCharacter(name, selectedAvatarDataUrl, tag);
        renderCharactersList();
        showToast(`🎭 Personagem "${name}" salvo com sucesso na memória!`, 'success');
        dialog.remove();
      });

      const nameInput = dialog.querySelector('#fd-input-char-name');
      if (nameInput) setTimeout(() => nameInput.focus(), 100);
    }

    // =========================================================================
    // Controles da Aba de Execução (Iniciar, Pausar, Parar e Novo Projeto)
    // =========================================================================
    const btnRunMacro = macroModalElement.querySelector('#fd-btn-run-macro');
    const btnPauseMacro = macroModalElement.querySelector('#fd-btn-pause-macro');
    const btnStopMacro = macroModalElement.querySelector('#fd-btn-stop-macro');

    // Botão Principal: Iniciar / Retomar Execução do Macro
    btnRunMacro.addEventListener('click', () => {
      // Sincroniza todos os slides dos carrosséis habilitados
      if (engine.carousels && engine.carousels.length > 0) {
        const activeCarousels = engine.carousels.filter(c => c.enabled !== false);
        const allSlides = [];
        activeCarousels.forEach(c => {
          if (c.slides && Array.isArray(c.slides)) {
            c.slides.filter(s => s.enabled !== false).forEach(s => allSlides.push(s));
          }
        });
        if (allSlides.length > 0) {
          engine.prompts = allSlides;
        }
      }

      if (engine.prompts.length === 0) {
        showToast('⚠️ Adicione ao menos um prompt ou carregue um PDF antes de iniciar.', 'warning');
        return;
      }

      if (engine.state === 'running') {
        engine.pause();
      } else {
        engine.start();
        enableMiniRunnerMode(true);
      }
    });

    // Botão de Pausar o Macro
    btnPauseMacro.addEventListener('click', () => engine.pause());

    // Botão de Parar totalmente o Macro e resetar o progresso
    btnStopMacro.addEventListener('click', () => {
      engine.stop();
      enableMiniRunnerMode(false);
      showToast('⏹️ Macro totalmente encerrada e progresso resetado!', 'info');
    });

    // Botão para limpar console de logs ao vivo
    const btnClearLogs = macroModalElement.querySelector('#fd-btn-clear-logs');
    if (btnClearLogs) {
      btnClearLogs.addEventListener('click', () => {
        engine.clearLogs();
        renderLogs();
        showToast('🧹 Console de logs limpo com sucesso!', 'info');
      });
    }

    // Botão para disparar criação manual de um novo projeto no FLOW
    const btnManualNewProject = macroModalElement.querySelector('#fd-btn-manual-new-project');
    if (btnManualNewProject) {
      btnManualNewProject.addEventListener('click', async () => {
        btnManualNewProject.disabled = true;
        btnManualNewProject.innerHTML = '<span>⏳ Abrindo...</span>';
        showToast('📁 Abrindo novo projeto no FLOW...', 'info');
        await engine.createNewFlowProject();
        btnManualNewProject.disabled = false;
        btnManualNewProject.innerHTML = '<span>➕ Criar Novo Projeto</span>';
      });
    }

    // =========================================================================
    // Espião FLOW: Diagnóstico DOM, Pool de Chaves de I.A e Rotação
    // =========================================================================
    const selectAiProvider = macroModalElement.querySelector('#fd-select-ai-provider');
    const inputAiKey = macroModalElement.querySelector('#fd-input-ai-key');
    const toggleAiAutoheal = macroModalElement.querySelector('#fd-toggle-ai-autoheal');
    const toggleAiAutorotate = macroModalElement.querySelector('#fd-toggle-ai-autorotate');
    const btnAddSingleKey = macroModalElement.querySelector('#fd-btn-add-single-key');
    const btnTestAiKey = macroModalElement.querySelector('#fd-btn-test-ai-key');
    const btnRunAiDiag = macroModalElement.querySelector('#fd-btn-run-ai-diag');
    const btnUploadKeysFile = macroModalElement.querySelector('#fd-btn-upload-keys-file');
    const inputImportKeysFile = macroModalElement.querySelector('#fd-input-import-keys-file');
    const btnPasteKeysList = macroModalElement.querySelector('#fd-btn-paste-keys-list');
    const btnResetKeysStatus = macroModalElement.querySelector('#fd-btn-reset-keys-status');
    const btnClearKeysPool = macroModalElement.querySelector('#fd-btn-clear-keys-pool');
    const aiKeysContainer = macroModalElement.querySelector('#fd-ai-keys-pool-container');
    const badgeKeysCount = macroModalElement.querySelector('#fd-badge-keys-count');
    const aiResultBox = macroModalElement.querySelector('#fd-ai-result-box');

    /**
     * Renderiza a tabela de chaves de IA cadastradas no Pool
     */
    function renderAIKeysPool() {
      if (badgeKeysCount) {
        badgeKeysCount.innerText = `${engine.aiKeysPool.length} Chaves`;
      }
      if (!aiKeysContainer) return;

      if (engine.aiKeysPool.length === 0) {
        aiKeysContainer.innerHTML = `
          <div style="padding: 10px; text-align: center; color: var(--fd-text-muted); font-size: 11px;">
            Nenhuma chave carregada no Pool. Carregue um <strong>PDF, TXT, DOCX</strong> ou adicione acima.
          </div>
        `;
        return;
      }

      aiKeysContainer.innerHTML = engine.aiKeysPool.map((k, idx) => {
        let providerBadge = '<span style="background: rgba(16,185,129,0.2); color: #34d399; padding: 2px 6px; border-radius: 4px; font-weight:700; font-size: 10px;">🟢 Gemini</span>';
        if (k.provider === 'groq') {
          providerBadge = '<span style="background: rgba(245,158,11,0.2); color: #fbbf24; padding: 2px 6px; border-radius: 4px; font-weight:700; font-size: 10px;">⚡ Groq</span>';
        } else if (k.provider === 'openrouter') {
          providerBadge = '<span style="background: rgba(99,102,241,0.2); color: #818cf8; padding: 2px 6px; border-radius: 4px; font-weight:700; font-size: 10px;">🌐 OpenRouter</span>';
        }

        let statusBadge = '<span class="fd-badge-status" style="background: rgba(16,185,129,0.15); color: #10b981;">Ativa</span>';
        if (k.status === 'exhausted') {
          statusBadge = '<span class="fd-badge-status" style="background: rgba(239,68,68,0.2); color: #f87171;">⏳ Cota Esgotada</span>';
        } else if (k.status === 'valid') {
          statusBadge = '<span class="fd-badge-status" style="background: rgba(59,130,246,0.2); color: #60a5fa;">✓ Validada</span>';
        } else if (k.status === 'error') {
          statusBadge = '<span class="fd-badge-status" style="background: rgba(239,68,68,0.2); color: #f87171;">Erro</span>';
        }

        const maskedKey = `${k.key.substring(0, 8)}...${k.key.slice(-4)}`;

        return `
          <div style="display: flex; align-items: center; justify-content: space-between; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 11px; gap: 6px;">
            <div style="display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              <span style="color: var(--fd-text-muted); font-size: 10px; width: 14px;">#${idx + 1}</span>
              ${providerBadge}
              <code style="color: #cbd5e1; font-family: monospace; font-size: 10px;">${maskedKey}</code>
              ${statusBadge}
            </div>
            <div style="display: flex; align-items: center; gap: 4px;">
              <button class="fd-btn-test-single-pool-key" data-id="${k.id}" style="padding: 2px 6px; background: rgba(255,255,255,0.08); border: 1px solid var(--fd-border); border-radius: 4px; color: #fff; font-size: 10px; cursor: pointer;" title="Testar esta chave">
                🧪
              </button>
              <button class="fd-btn-remove-pool-key" data-id="${k.id}" style="padding: 2px 6px; background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); border-radius: 4px; color: #f87171; font-size: 10px; cursor: pointer;" title="Remover chave">
                🗑️
              </button>
            </div>
          </div>
        `;
      }).join('');

      // Associa botões de teste individual por chave
      aiKeysContainer.querySelectorAll('.fd-btn-test-single-pool-key').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-id');
          const targetKey = engine.aiKeysPool.find(k => k.id === id);
          if (!targetKey) return;
          btn.textContent = '⏳';
          showToast(`🧪 Testando chave [${targetKey.provider.toUpperCase()}]...`, 'info');

          // Testa a chave individual diretamente via motor
          const prevKey = engine.config.aiApiKey;
          const prevProv = engine.config.aiProvider;
          engine.config.aiApiKey = targetKey.key;
          engine.config.aiProvider = targetKey.provider;

          const res = await engine.callAIDiagnostics('Responda apenas: Chave operacional!');
          engine.config.aiApiKey = prevKey;
          engine.config.aiProvider = prevProv;

          btn.textContent = '🧪';
          if (res.success) {
            targetKey.status = 'valid';
            showToast(`✅ Chave [${targetKey.provider.toUpperCase()}] válida e pronta!`, 'success');
          } else {
            targetKey.status = 'exhausted';
            showToast(`❌ Falha: ${res.error}`, 'error');
          }
          engine.saveState();
          renderAIKeysPool();
        });
      });

      // Associa botões de exclusão de chave
      aiKeysContainer.querySelectorAll('.fd-btn-remove-pool-key').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.getAttribute('data-id');
          engine.removeAIKey(id);
          renderAIKeysPool();
          showToast('Chave removida do pool.', 'info');
        });
      });
    }

    // Renderização inicial do Pool de Chaves
    renderAIKeysPool();

    // 1. Upload de Arquivo com Chaves (PDF, TXT, DOCX, etc.)
    if (btnUploadKeysFile && inputImportKeysFile) {
      btnUploadKeysFile.addEventListener('click', () => {
        inputImportKeysFile.click();
      });

      inputImportKeysFile.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        showToast('⏳ Extraindo chaves de I.A do documento...', 'info');
        try {
          const text = await FlowPdfExtractor.extractTextFromAnyDocument(file);
          const keys = FlowPdfExtractor.parseAIKeysFromText(text);
          if (keys.length > 0) {
            const count = engine.importAIKeys(keys);
            showToast(`🎉 ${count} nova(s) chave(s) de I.A adicionada(s) ao Pool!`, 'success');
            renderAIKeysPool();
          } else {
            showToast('⚠️ Nenhuma chave de API reconhecida no documento.', 'warning');
          }
        } catch (err) {
          showToast(`❌ Erro ao ler documento: ${err.message}`, 'error');
        }
        inputImportKeysFile.value = '';
      });
    }

    // 2. Colar Lista de Chaves
    if (btnPasteKeysList) {
      btnPasteKeysList.addEventListener('click', () => {
        const pasted = prompt('📋 Cole sua lista de chaves de I.A (uma por linha):\nFormatos aceitos: AIzaSy..., gsk_..., sk-or-..., ou gemini: AIza...');
        if (pasted && pasted.trim()) {
          const keys = FlowPdfExtractor.parseAIKeysFromText(pasted);
          if (keys.length > 0) {
            const count = engine.importAIKeys(keys);
            showToast(`🎉 ${count} chave(s) adicionada(s) ao Pool!`, 'success');
            renderAIKeysPool();
          } else {
            showToast('⚠️ Nenhuma chave válida detectada no texto colado.', 'warning');
          }
        }
      });
    }

    // 3. Resetar Cotas de Todas as Chaves
    if (btnResetKeysStatus) {
      btnResetKeysStatus.addEventListener('click', () => {
        engine.resetAIKeysStatus();
        renderAIKeysPool();
        showToast('🔄 Status e cotas de todas as chaves redefinidos para Ativa!', 'success');
      });
    }

    // 4. Limpar Todo o Pool de Chaves
    if (btnClearKeysPool) {
      btnClearKeysPool.addEventListener('click', () => {
        if (confirm('Deseja realmente limpar todo o pool de chaves?')) {
          engine.clearAIKeysPool();
          renderAIKeysPool();
          showToast('🗑️ Pool de chaves limpo.', 'info');
        }
      });
    }

    // 5. Adicionar Chave Individual Manual
    if (btnAddSingleKey) {
      btnAddSingleKey.addEventListener('click', () => {
        const key = inputAiKey ? inputAiKey.value.trim() : '';
        const provider = selectAiProvider ? selectAiProvider.value : 'gemini';
        if (!key) {
          showToast('⚠️ Por favor, insira a chave no campo.', 'warning');
          return;
        }
        const added = engine.addAIKey(key, provider);
        if (added) {
          showToast(`✅ Chave [${added.provider.toUpperCase()}] adicionada ao Pool!`, 'success');
          inputAiKey.value = '';
          renderAIKeysPool();
        } else {
          showToast('⚠️ Chave inválida.', 'warning');
        }
      });
    }

    if (selectAiProvider) {
      selectAiProvider.addEventListener('change', (e) => {
        engine.updateConfig({ aiProvider: e.target.value });
      });
    }

    if (inputAiKey) {
      inputAiKey.addEventListener('input', (e) => {
        engine.updateConfig({ aiApiKey: e.target.value.trim() });
      });
    }

    if (toggleAiAutoheal) {
      toggleAiAutoheal.addEventListener('change', (e) => {
        engine.updateConfig({ aiAutoHeal: e.target.checked });
        showToast(e.target.checked ? '🛡️ Auto-Recuperação Inteligente ativada.' : 'Auto-Recuperação desativada.', 'info');
      });
    }

    if (toggleAiAutorotate) {
      toggleAiAutorotate.addEventListener('change', (e) => {
        engine.updateConfig({ aiAutoRotateKeys: e.target.checked });
        showToast(e.target.checked ? '🔄 Rotação Automática de Chaves ativada.' : 'Rotação Automática desativada.', 'info');
      });
    }

    if (btnTestAiKey) {
      btnTestAiKey.addEventListener('click', async () => {
        btnTestAiKey.disabled = true;
        btnTestAiKey.textContent = '⏳...';
        showToast('🤖 Testando conexão com a I.A do Pool...', 'info');

        const res = await engine.callAIDiagnostics('Responda em uma linha: Conexão com o FLOW Macro Studio realizada com sucesso!');
        btnTestAiKey.disabled = false;
        btnTestAiKey.textContent = '🧪 Testar';

        if (res.success) {
          showToast(`✅ I.A (${res.provider.toUpperCase()}) conectada com sucesso!`, 'success');
          if (aiResultBox) {
            aiResultBox.style.display = 'block';
            aiResultBox.innerHTML = `<strong>✅ Conexão Bem-Sucedida [${res.provider.toUpperCase()} - ${res.keyUsed}]:</strong><br>${res.analysis}`;
          }
          renderAIKeysPool();
        } else {
          showToast(`❌ Falha: ${res.error}`, 'error');
          if (aiResultBox) {
            aiResultBox.style.display = 'block';
            aiResultBox.innerHTML = `<strong>❌ Erro na Conexão:</strong><br>${res.error}`;
          }
          renderAIKeysPool();
        }
      });
    }

    if (btnRunAiDiag) {
      btnRunAiDiag.addEventListener('click', async () => {
        btnRunAiDiag.disabled = true;
        btnRunAiDiag.textContent = '🤖 Analisando...';
        if (aiResultBox) {
          aiResultBox.style.display = 'block';
          aiResultBox.innerHTML = '<em>🔍 Capturando snapshot do DOM e analisando em tempo real com I.A...</em>';
        }

        const res = await engine.callAIDiagnostics('Faça um diagnóstico completo do estado atual do FLOW, dos seletores, botões e do progresso.');
        btnRunAiDiag.disabled = false;
        btnRunAiDiag.textContent = '🤖 Analisar com I.A Agora';

        if (res.success) {
          showToast('💡 Diagnóstico com I.A concluído!', 'success');
          if (aiResultBox) {
            aiResultBox.style.display = 'block';
            aiResultBox.innerHTML = `<strong>🤖 Diagnóstico Inteligente (${res.provider.toUpperCase()} - ${res.keyUsed}):</strong><br><div style="margin-top: 6px; white-space: pre-wrap;">${res.analysis}</div>`;
          }
          renderAIKeysPool();
        } else {
          showToast(`❌ Erro: ${res.error}`, 'error');
          if (aiResultBox) {
            aiResultBox.style.display = 'block';
            aiResultBox.innerHTML = `<strong>❌ Falha no Diagnóstico:</strong><br>${res.error}`;
          }
          renderAIKeysPool();
        }
      });
    }

    const btnRefreshInspector = macroModalElement.querySelector('#fd-btn-refresh-inspector');
    if (btnRefreshInspector) {
      btnRefreshInspector.addEventListener('click', () => {
        renderInspectorTab();
        renderAIKeysPool();
        showToast('🔍 Varredura do FLOW atualizada!', 'info');
      });
    }

    /**
     * Renderiza o grid de diagnóstico dos elementos do DOM do FLOW
     */
    function renderInspectorTab() {
      const grid = macroModalElement.querySelector('#fd-inspector-grid');
      if (!grid || grid.offsetParent === null) return;

      const diag = engine.diagnoseFlowDOM();

      grid.innerHTML = `
        <!-- Diagnóstico do Campo de Prompt -->
        <div class="fd-inspector-card ${diag.promptInput.found ? 'found' : 'missing'}">
          <div class="fd-inspector-header">
            <span class="fd-inspector-name">📝 Campo de Prompt</span>
            <span class="fd-inspector-badge ${diag.promptInput.found ? 'ok' : 'warn'}">
              ${diag.promptInput.found ? 'ENCONTRADO' : 'NÃO DETECTADO'}
            </span>
          </div>
          <div class="fd-inspector-selector">${diag.promptInput.tag} (${diag.promptInput.selector})</div>
          <div style="font-size: 11px; color: var(--fd-text-muted);">
            Texto atual: "${diag.promptInput.value || '(Vazio)'}"
          </div>
          ${diag.promptInput.found ? '<button class="fd-modal-btn-cancel fd-btn-highlight-prompt" style="padding: 4px 10px; font-size: 11px; margin-top: 4px;">🎯 Destacar no FLOW</button>' : ''}
        </div>

        <!-- Diagnóstico do Botão Enviar -->
        <div class="fd-inspector-card ${diag.submitButton.found ? 'found' : 'missing'}">
          <div class="fd-inspector-header">
            <span class="fd-inspector-name">🚀 Botão de Enviar (➔)</span>
            <span class="fd-inspector-badge ${diag.submitButton.found ? 'ok' : 'warn'}">
              ${diag.submitButton.found ? 'ENCONTRADO' : 'NÃO DETECTADO'}
            </span>
          </div>
          <div class="fd-inspector-selector">${diag.submitButton.tag} (${diag.submitButton.text})</div>
          <div style="font-size: 11px; color: var(--fd-text-muted);">
            Estado: ${diag.submitButton.disabled ? 'Desabilitado' : 'Pronto para Clique'}
          </div>
          ${diag.submitButton.found ? '<button class="fd-modal-btn-cancel fd-btn-highlight-submit" style="padding: 4px 10px; font-size: 11px; margin-top: 4px;">🎯 Destacar no FLOW</button>' : ''}
        </div>

        <!-- Diagnóstico de Reutilizar Comando (Passo 7) -->
        <div class="fd-inspector-card ${diag.reuseCommand && diag.reuseCommand.found ? 'found' : 'missing'}">
          <div class="fd-inspector-header">
            <span class="fd-inspector-name">🔁 Reutilizar Comando (↪)</span>
            <span class="fd-inspector-badge ${diag.reuseCommand && diag.reuseCommand.found ? 'ok' : 'warn'}">
              ${diag.reuseCommand && diag.reuseCommand.found ? 'DETECTADO' : 'NENHUM CARD'}
            </span>
          </div>
          <div class="fd-inspector-selector">${diag.reuseCommand ? diag.reuseCommand.label : 'Varredura'}</div>
          <div style="font-size: 11px; color: var(--fd-text-muted);">
            Permite manter personagens fixos no prompt sem recarregar arquivos.
          </div>
          ${diag.reuseCommand && diag.reuseCommand.found ? '<button class="fd-modal-btn-confirm fd-btn-test-reuse" style="padding: 4px 10px; font-size: 11px; margin-top: 4px; background: #6366f1;">🧪 Testar Reutilizar Comando</button>' : ''}
        </div>

        <!-- Diagnóstico de Proporção -->
        <div class="fd-inspector-card found">
          <div class="fd-inspector-header">
            <span class="fd-inspector-name">📐 Seletores de Proporção</span>
            <span class="fd-inspector-badge ok">DETECTADOS</span>
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;">
            ${diag.aspectRatioButtons.map(r => `
              <span style="font-size: 11px; padding: 2px 8px; border-radius: 6px; background: ${r.found ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.05)'}; color: ${r.found ? '#10b981' : '#94a3b8'}; border: 1px solid ${r.found ? 'rgba(16,185,129,0.3)' : 'var(--fd-border)'};">
                ${r.label} ${r.found ? '✓' : '✗'}
              </span>
            `).join('')}
          </div>
        </div>

        <!-- Diagnóstico de Quantidade -->
        <div class="fd-inspector-card found">
          <div class="fd-inspector-header">
            <span class="fd-inspector-name">🔢 Seletores de Quantidade</span>
            <span class="fd-inspector-badge ok">DETECTADOS</span>
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;">
            ${diag.quantityButtons.map(q => `
              <span style="font-size: 11px; padding: 2px 8px; border-radius: 6px; background: ${q.found ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.05)'}; color: ${q.found ? '#10b981' : '#94a3b8'}; border: 1px solid ${q.found ? 'rgba(16,185,129,0.3)' : 'var(--fd-border)'};">
                ${q.label} ${q.found ? '✓' : '✗'}
              </span>
            `).join('')}
          </div>
        </div>

        <!-- Diagnóstico de Anexo de Personagens / Botão "+" -->
        <div class="fd-inspector-card ${diag.plusButton && diag.plusButton.found ? 'found' : (diag.characterUploadSlot.found ? 'found' : 'missing')}">
          <div class="fd-inspector-header">
            <span class="fd-inspector-name">🎭 Botão "+" / Recursos da Biblioteca</span>
            <span class="fd-inspector-badge ${diag.plusButton && diag.plusButton.found ? 'ok' : (diag.characterUploadSlot.found ? 'ok' : 'warn')}">
              ${diag.plusButton && diag.plusButton.found ? 'ENCONTRADO' : 'NÃO DETECTADO'}
            </span>
          </div>
          <div class="fd-inspector-selector">${diag.plusButton ? diag.plusButton.text : diag.characterUploadSlot.type}</div>
          <div style="font-size: 11px; color: var(--fd-text-muted);">
            Permite abrir a biblioteca do FLOW e anexar personagens/elementos como referência.
          </div>
          ${diag.plusButton && diag.plusButton.found ? '<button class="fd-modal-btn-cancel fd-btn-highlight-plus" style="padding: 4px 10px; font-size: 11px; margin-top: 4px;">🎯 Destacar no FLOW</button>' : ''}
        </div>

        <!-- Diagnóstico de Chips de Personagem Ativos no Prompt -->
        <div class="fd-inspector-card ${diag.attachedChips && diag.attachedChips.found ? 'found' : 'missing'}">
          <div class="fd-inspector-header">
            <span class="fd-inspector-name">🏷️ Personagens Ativos no Prompt</span>
            <span class="fd-inspector-badge ${diag.attachedChips && diag.attachedChips.found ? 'ok' : 'warn'}">
              ${diag.attachedChips && diag.attachedChips.found ? 'CHIPS ANEXADOS' : 'NENHUM CHIP'}
            </span>
          </div>
          <div class="fd-inspector-selector">${diag.attachedChips ? diag.attachedChips.label : 'Status de Chips'}</div>
          <div style="font-size: 11px; color: var(--fd-text-muted);">
            Indica se os personagens já estão presentes na barra de comando para os próximos slides.
          </div>
        </div>
      `;

      // Destacar campo de prompt na tela
      const btnHlPrompt = grid.querySelector('.fd-btn-highlight-prompt');
      if (btnHlPrompt) {
        btnHlPrompt.addEventListener('click', () => {
          const input = engine.findPromptInput();
          highlightElementOnPage(input);
        });
      }

      // Destacar botão enviar na tela
      const btnHlSubmit = grid.querySelector('.fd-btn-highlight-submit');
      if (btnHlSubmit) {
        btnHlSubmit.addEventListener('click', () => {
          const btn = engine.findSubmitButton();
          highlightElementOnPage(btn);
        });
      }

      // Destacar botão mais na tela
      const btnHlPlus = grid.querySelector('.fd-btn-highlight-plus');
      if (btnHlPlus) {
        btnHlPlus.addEventListener('click', () => {
          const btn = engine.findPlusButton();
          highlightElementOnPage(btn);
        });
      }

      // Testar reaproveitamento de comando
      const btnTestReuse = grid.querySelector('.fd-btn-test-reuse');
      if (btnTestReuse) {
        btnTestReuse.addEventListener('click', async () => {
          const ok = await engine.reuseLatestCommand();
          if (ok) {
            showToast('🔁 Comando anterior reutilizado no FLOW!', 'success');
          } else {
            showToast('⚠️ Nenhum botão de reutilizar comando disponível no momento.', 'warning');
          }
        });
      }

      renderTelemetryFeed();
    }

    // =========================================================================
    // Painel de Telemetria e Gravador de Ações em Tempo Real
    // =========================================================================

    /**
     * Renderiza o feed de eventos capturados pela telemetria
     */
    function renderTelemetryFeed() {
      const feed = macroModalElement ? macroModalElement.querySelector('#fd-telemetry-live-feed') : null;
      if (!feed) return;

      const badge = macroModalElement.querySelector('#fd-telemetry-live-badge');
      const badgeText = macroModalElement.querySelector('#fd-telemetry-live-text');
      const countText = macroModalElement.querySelector('#fd-telemetry-count-text');

      if (badge && badgeText) {
        if (engine.isRecordingTelemetry) {
          badge.classList.remove('paused');
          badgeText.innerText = 'GRAVAÇÃO ATIVA';
        } else {
          badge.classList.add('paused');
          badgeText.innerText = 'GRAVAÇÃO PAUSADA';
        }
      }

      if (countText) {
        countText.innerText = `${engine.telemetryEvents.length} eventos | ${Object.keys(engine.learnedSelectors).length} seletores aprendidos`;
      }

      const activeFilter = engine.telemetryFilter || 'all';
      const eventsToDisplay = activeFilter === 'all'
        ? engine.telemetryEvents
        : engine.telemetryEvents.filter(e => e.type === activeFilter);

      if (eventsToDisplay.length === 0) {
        feed.innerHTML = `
          <div style="padding: 16px; text-align: center; color: var(--fd-text-muted); font-size: 11px;">
            ${engine.isRecordingTelemetry ? '📡 Aguardando interações no FLOW... Clique ou digite algo na página para gravar em tempo real!' : '⏸️ Gravação pausada. Clique em "🔴 Gravar" para retomar a detecção.'}
          </div>
        `;
        return;
      }

      feed.innerHTML = eventsToDisplay.slice(0, 50).map((item, idx) => {
        let typeClass = 'click';
        if (item.type === 'MACRO') typeClass = 'macro';
        else if (item.type === 'INPUT') typeClass = 'input';
        else if (item.type === 'NAVIGATION') typeClass = 'navigation';
        else if (item.type === 'DOM_MUTATION') typeClass = 'mutation';
        else if (item.type === 'ERROR') typeClass = 'error';

        return `
          <div class="fd-telemetry-item" data-id="${item.id}">
            <div class="fd-telemetry-item-top">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span class="fd-telemetry-type ${typeClass}">${item.type}</span>
                <span style="font-weight: 700; color: #f1f5f9;">${item.action || item.tag || 'Evento'}</span>
              </div>
              <span class="fd-telemetry-time">${item.time}</span>
            </div>
            ${item.selector ? `<div class="fd-telemetry-selector">${item.selector}</div>` : ''}
            ${item.text ? `<div class="fd-telemetry-text">"${item.text}"</div>` : ''}
            <div style="display: flex; justify-content: flex-end; gap: 4px; margin-top: 2px;">
              ${item.selector ? `<button type="button" class="fd-btn-hl-telemetry" data-idx="${idx}" style="background: rgba(56,189,248,0.15); border: 1px solid rgba(56,189,248,0.3); color: #38bdf8; border-radius: 4px; padding: 2px 6px; font-size: 10px; cursor: pointer;">🎯 Destacar</button>` : ''}
              ${item.selector ? `<button type="button" class="fd-btn-copy-selector" data-idx="${idx}" style="background: rgba(255,255,255,0.05); border: 1px solid var(--fd-border); color: #94a3b8; border-radius: 4px; padding: 2px 6px; font-size: 10px; cursor: pointer;">📋 Copiar</button>` : ''}
            </div>
          </div>
        `;
      }).join('');

      // Destacar elemento a partir do log de telemetria
      feed.querySelectorAll('.fd-btn-hl-telemetry').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.getAttribute('data-idx'), 10);
          const item = eventsToDisplay[idx];
          if (item && item.selector) {
            try {
              const el = document.querySelector(item.selector);
              if (el) highlightElementOnPage(el);
              else showToast('⚠️ Elemento não encontrado no DOM atual.', 'warning');
            } catch (err) {
              showToast('⚠️ Seletor inválido no DOM.', 'warning');
            }
          }
        });
      });

      // Copiar seletor capturado para a área de transferência
      feed.querySelectorAll('.fd-btn-copy-selector').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.getAttribute('data-idx'), 10);
          const item = eventsToDisplay[idx];
          if (item && item.selector && navigator.clipboard) {
            navigator.clipboard.writeText(item.selector);
            showToast('📋 Seletor copiado para a área de transferência!', 'success');
          }
        });
      });
    }

    // Controles de telemetria: Gravar/Pausar, Exportar, Limpar, Resetar Seletores
    const btnToggleRecording = macroModalElement.querySelector('#fd-btn-toggle-recording');
    if (btnToggleRecording) {
      btnToggleRecording.addEventListener('click', () => {
        engine.isRecordingTelemetry = !engine.isRecordingTelemetry;
        btnToggleRecording.innerText = engine.isRecordingTelemetry ? '⏸️ Pausar' : '🔴 Gravar';
        renderTelemetryFeed();
        showToast(engine.isRecordingTelemetry ? '🔴 Gravação de telemetria ativada!' : '⏸️ Gravação de telemetria pausada.', 'info');
      });
    }

    const btnExportTelemetry = macroModalElement.querySelector('#fd-btn-export-telemetry');
    if (btnExportTelemetry) {
      btnExportTelemetry.addEventListener('click', () => {
        engine.exportTelemetryReport();
      });
    }

    const btnClearTelemetry = macroModalElement.querySelector('#fd-btn-clear-telemetry');
    if (btnClearTelemetry) {
      btnClearTelemetry.addEventListener('click', () => {
        engine.clearTelemetry();
        renderTelemetryFeed();
        showToast('🗑️ Eventos de telemetria limpos.', 'info');
      });
    }

    const btnResetLearned = macroModalElement.querySelector('#fd-btn-reset-learned-selectors');
    if (btnResetLearned) {
      btnResetLearned.addEventListener('click', () => {
        engine.clearLearnedSelectors();
        renderInspectorTab();
        showToast('🧹 Cache de seletores aprendidos foi redefinido.', 'info');
      });
    }

    // Filtros de tipo de evento da telemetria
    const filterContainer = macroModalElement.querySelector('#fd-telemetry-filters');
    if (filterContainer) {
      filterContainer.querySelectorAll('.fd-telemetry-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          filterContainer.querySelectorAll('.fd-telemetry-chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          engine.telemetryFilter = chip.getAttribute('data-filter') || 'all';
          renderTelemetryFeed();
        });
      });
    }

    // Modo Inspetor Interativo (Clique para Capturar Elemento do FLOW)
    const btnInspectElement = macroModalElement.querySelector('#fd-btn-inspect-element-click');
    if (btnInspectElement) {
      btnInspectElement.addEventListener('click', () => {
        startInteractiveInspector();
      });
    }

    let isInspectorModeActive = false;
    let hoverBox = null;
    let hoverTooltip = null;

    /**
     * Inicia o modo de inspeção interativo que permite clicar em qualquer elemento da página
     */
    function startInteractiveInspector() {
      if (isInspectorModeActive) return;
      isInspectorModeActive = true;

      // Torna a janela do Studio temporariamente transparente
      macroModalElement.classList.add('transparent-mode');
      showToast('🎯 Modo Inspetor Ativo! Mova o mouse sobre qualquer elemento no FLOW e clique para capturar.', 'info');

      if (!hoverBox) {
        hoverBox = document.createElement('div');
        hoverBox.className = 'fd-hover-inspector-highlight';
        hoverBox.style.position = 'fixed';
        hoverBox.style.pointerEvents = 'none';
        hoverBox.style.zIndex = '999998';
        hoverBox.style.display = 'none';
        document.body.appendChild(hoverBox);
      }

      if (!hoverTooltip) {
        hoverTooltip = document.createElement('div');
        hoverTooltip.className = 'fd-hover-inspector-tooltip';
        hoverTooltip.style.display = 'none';
        document.body.appendChild(hoverTooltip);
      }

      const onMouseMove = (e) => {
        if (!isInspectorModeActive) return;
        const target = document.elementFromPoint(e.clientX, e.clientY);
        if (!target || (target.closest && target.closest('[id*="fd-"], [class*="fd-"]'))) {
          hoverBox.style.display = 'none';
          hoverTooltip.style.display = 'none';
          return;
        }

        const rect = target.getBoundingClientRect();
        hoverBox.style.display = 'block';
        hoverBox.style.left = rect.left + 'px';
        hoverBox.style.top = rect.top + 'px';
        hoverBox.style.width = rect.width + 'px';
        hoverBox.style.height = rect.height + 'px';

        const tag = target.tagName.toLowerCase();
        const cls = (target.className || '').toString().slice(0, 30);
        const aria = target.getAttribute('aria-label') || '';
        hoverTooltip.style.display = 'block';
        hoverTooltip.style.left = Math.min(window.innerWidth - 240, Math.max(10, rect.left)) + 'px';
        hoverTooltip.style.top = Math.max(10, rect.top - 30) + 'px';
        hoverTooltip.innerHTML = `<strong>&lt;${tag}&gt;</strong> ${aria ? `[${aria}]` : (cls ? `.${cls}` : '')} <span style="color:#10b981;">(Clique para vincular)</span>`;
      };

      const onClick = (e) => {
        if (!isInspectorModeActive) return;
        const target = e.target;
        if (!target || (target.closest && target.closest('[id*="fd-"], [class*="fd-"]'))) return;

        e.preventDefault();
        e.stopPropagation();

        stopInteractiveInspector();

        const fp = engine.captureElementFingerprint(target);
        engine.recordTelemetry('CLICK', {
          action: 'inspector_manual_capture',
          tag: fp.tag,
          selector: fp.selector,
          xpath: fp.xpath,
          text: fp.text,
          aria: fp.ariaLabel || fp.title || '',
          reactProps: fp.reactPropsSummary
        });

        // Exibe o diálogo para vincular papel funcional ao elemento capturado
        showBindActionModal(target, fp);
      };

      const onKeyDown = (e) => {
        if (e.key === 'Escape') {
          stopInteractiveInspector();
          showToast('Inspetor cancelado.', 'info');
        }
      };

      function stopInteractiveInspector() {
        isInspectorModeActive = false;
        macroModalElement.classList.remove('transparent-mode');
        if (hoverBox) hoverBox.style.display = 'none';
        if (hoverTooltip) hoverTooltip.style.display = 'none';
        window.removeEventListener('mousemove', onMouseMove, true);
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('keydown', onKeyDown, true);
      }

      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('click', onClick, true);
      window.addEventListener('keydown', onKeyDown, true);
    }

    /**
     * Exibe o diálogo modal para vincular um papel funcional ao elemento inspecionado
     * @param {HTMLElement} target - Elemento clicado no DOM
     * @param {Object} fp - Fingerprint estrutural do elemento
     */
    function showBindActionModal(target, fp) {
      const modal = document.createElement('div');
      modal.className = 'fd-modal-overlay';
      modal.style.zIndex = '9999999';
      modal.innerHTML = `
        <div class="fd-modal-content" style="max-width: 480px;">
          <div class="fd-modal-header">
            <h3>🎯 Elemento Capturado no FLOW</h3>
            <button class="fd-modal-close" id="fd-btn-close-bind-modal">&times;</button>
          </div>
          <div class="fd-modal-body" style="display: flex; flex-direction: column; gap: 10px;">
            <div style="background: rgba(0,0,0,0.4); padding: 8px 12px; border-radius: 8px; border: 1px solid var(--fd-border); font-size: 11px;">
              <div><strong>Tag:</strong> &lt;${fp.tag.toLowerCase()}&gt;</div>
              <div><strong>Seletor:</strong> <code style="color: #38bdf8;">${fp.selector}</code></div>
              ${fp.text ? `<div><strong>Texto:</strong> "${fp.text}"</div>` : ''}
              ${fp.ariaLabel ? `<div><strong>Aria:</strong> "${fp.ariaLabel}"</div>` : ''}
            </div>

            <label style="font-size: 12px; font-weight: 700; color: #fff;">Vincular como seletor mestre do Macro:</label>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <button class="fd-modal-btn-cancel fd-btn-bind-role" data-role="promptInput" style="padding: 8px; text-align: left; font-size: 11px;">
                📝 Campo de Prompt
              </button>
              <button class="fd-modal-btn-cancel fd-btn-bind-role" data-role="submitButton" style="padding: 8px; text-align: left; font-size: 11px;">
                🚀 Botão Enviar / Gerar
              </button>
              <button class="fd-modal-btn-cancel fd-btn-bind-role" data-role="plusButton" style="padding: 8px; text-align: left; font-size: 11px;">
                🎭 Botão "+" (Elementos)
              </button>
              <button class="fd-modal-btn-cancel fd-btn-bind-role" data-role="reuseButton" style="padding: 8px; text-align: left; font-size: 11px;">
                🔁 Reutilizar Comando
              </button>
              <button class="fd-modal-btn-cancel fd-btn-bind-role" data-role="newProjectButton" style="padding: 8px; text-align: left; font-size: 11px;">
                📁 Novo Projeto (Hub)
              </button>
              <button class="fd-modal-btn-cancel fd-btn-bind-role" data-role="telemetryOnly" style="padding: 8px; text-align: left; font-size: 11px; color: var(--fd-text-muted);">
                📡 Apenas Gravar Telemetria
              </button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      modal.querySelector('#fd-btn-close-bind-modal').addEventListener('click', () => {
        modal.remove();
      });

      modal.querySelectorAll('.fd-btn-bind-role').forEach(btn => {
        btn.addEventListener('click', () => {
          const role = btn.getAttribute('data-role');
          if (role && role !== 'telemetryOnly') {
            engine.learnSelector(role, target);
            showToast(`✨ Elemento vinculado com sucesso como: ${role}!`, 'success');
          } else {
            showToast('📡 Elemento gravado na telemetria.', 'info');
          }
          modal.remove();
          renderInspectorTab();
        });
      });
    }

    /**
     * Rola e destaca visualmente um elemento na página com contorno e brilho
     * @param {HTMLElement} el - Elemento alvo
     */
    function highlightElementOnPage(el) {
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const origOutline = el.style.outline;
      const origBoxShadow = el.style.boxShadow;
      el.style.outline = '3px solid #10b981';
      el.style.boxShadow = '0 0 20px #10b981';
      el.style.transition = 'all 0.3s ease';

      setTimeout(() => {
        el.style.outline = origOutline;
        el.style.boxShadow = origBoxShadow;
      }, 3000);
      showToast('🎯 Elemento destacado no FLOW por 3 segundos!', 'success');
    }

    // =========================================================================
    // Barra Flutuante Compacta (Mini Runner / Modo PIP)
    // Permite acompanhar o progresso em tempo real sem cobrir a tela do FLOW
    // =========================================================================
    let miniRunnerElement = null;

    /**
     * Alterna entre a janela completa do Studio e a barra flutuante compacta (PIP)
     * @param {boolean} enable - Ativar modo compacto
     */
    function enableMiniRunnerMode(enable) {
      if (enable) {
        macroModalElement.style.display = 'none';
        if (!miniRunnerElement) {
          miniRunnerElement = document.createElement('div');
          miniRunnerElement.id = 'fd-macro-mini-runner';
          miniRunnerElement.className = 'fd-macro-mini-runner';
          document.body.appendChild(miniRunnerElement);
          setupDraggableMiniRunner(miniRunnerElement);
        }
        miniRunnerElement.style.display = 'flex';
        updateMiniRunnerUI(engine.getState());
        showToast('🪟 Modo PIP ativado: Você pode ver a tela do FLOW livremente!', 'info');
      } else {
        if (miniRunnerElement) miniRunnerElement.style.display = 'none';
        macroModalElement.style.display = 'flex';
      }
    }

    /**
     * Atualiza os indicadores de progresso, contador regressivo e botões da barra PIP
     * @param {Object} state - Estado do motor
     */
    function updateMiniRunnerUI(state) {
      if (!miniRunnerElement || miniRunnerElement.style.display === 'none') return;

      const totalGens = state.totalGenerations || state.totalPrompts;
      const compGens = state.completedGenerations || state.completedCount;
      const pct = totalGens > 0 ? Math.round((compGens / totalGens) * 100) : 0;
      const curPrompt = (state.currentIndex >= 0 && state.prompts[state.currentIndex]) ? state.prompts[state.currentIndex] : null;

      const title = curPrompt ? `${curPrompt.title} (Rep ${(curPrompt.completedRepeats || 0) + 1}/${curPrompt.repeatCount || 1})` : (state.currentAction || 'Macro Aguardando...');
      const timerStr = state.elapsedFormatted || '00:00';
      const countdownStr = (state.countdown && state.countdown.remaining > 0) ? ` • ⏳ ${state.countdown.remaining}s` : '';

      miniRunnerElement.innerHTML = `
        <div class="fd-mini-pulse ${state.state === 'paused' ? 'paused' : ''}"></div>
        <div class="fd-mini-info">
          <div class="fd-mini-title-row">
            <span class="fd-mini-task-title" title="${title}">${title}</span>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-family: monospace; font-size: 10px; color: #38bdf8; font-weight: 700;">⏱️ ${timerStr}${countdownStr}</span>
              <span class="fd-mini-progress-pct">${pct}% (${compGens}/${totalGens})</span>
            </div>
          </div>
          <div class="fd-mini-progress-bar-bg">
            <div class="fd-mini-progress-bar-fill" style="width: ${pct}%;"></div>
          </div>
        </div>
        <div class="fd-mini-actions">
          <button class="fd-btn-icon" id="fd-mini-btn-play" title="${state.state === 'running' ? 'Pausar' : 'Iniciar'}">
            ${state.state === 'running'
              ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>'
              : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>'
            }
          </button>
          <button class="fd-btn-icon" id="fd-mini-btn-stop" title="Parar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="4" y="4" width="16" height="16"></rect></svg>
          </button>
          <button class="fd-btn-icon" id="fd-mini-btn-expand" title="Expandir Studio Completo">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
          </button>
        </div>
      `;

      miniRunnerElement.querySelector('#fd-mini-btn-play').addEventListener('click', () => {
        if (engine.state === 'running') engine.pause();
        else engine.start();
      });

      miniRunnerElement.querySelector('#fd-mini-btn-stop').addEventListener('click', () => {
        engine.stop();
        enableMiniRunnerMode(false);
        showToast('⏹️ Macro totalmente encerrada e progresso resetado!', 'info');
      });

      miniRunnerElement.querySelector('#fd-mini-btn-expand').addEventListener('click', () => {
        enableMiniRunnerMode(false);
      });
    }

    /**
     * Configura o comportamento de arrasto para a barra Mini Runner PIP
     * @param {HTMLElement} el - Elemento da barra PIP
     */
    function setupDraggableMiniRunner(el) {
      let isDragging = false;
      let startX, startY, initialLeft, initialTop;

      el.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const rect = el.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        el.style.bottom = 'auto';
        el.style.right = 'auto';
        el.style.left = `${initialLeft}px`;
        el.style.top = `${initialTop}px`;

        const onMove = (evt) => {
          if (!isDragging) return;
          const dx = evt.clientX - startX;
          const dy = evt.clientY - startY;
          el.style.left = `${Math.max(10, Math.min(window.innerWidth - el.offsetWidth - 10, initialLeft + dx))}px`;
          el.style.top = `${Math.max(10, Math.min(window.innerHeight - el.offsetHeight - 10, initialTop + dy))}px`;
        };

        const onUp = () => {
          isDragging = false;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    /**
     * Configura o comportamento de arrasto da janela modal principal
     * @param {HTMLElement} windowEl - Janela do Studio
     * @param {HTMLElement} handle - Alça de arrasto
     */
    function setupDraggableModal(windowEl, handle) {
      if (!windowEl || !handle) return;
      let isDragging = false;
      let startX, startY, initialLeft, initialTop;

      handle.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const rect = windowEl.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        windowEl.style.position = 'fixed';
        windowEl.style.margin = '0';
        windowEl.style.left = `${initialLeft}px`;
        windowEl.style.top = `${initialTop}px`;

        const onMove = (evt) => {
          if (!isDragging) return;
          const dx = evt.clientX - startX;
          const dy = evt.clientY - startY;
          windowEl.style.left = `${Math.max(10, Math.min(window.innerWidth - 300, initialLeft + dx))}px`;
          windowEl.style.top = `${Math.max(10, Math.min(window.innerHeight - 200, initialTop + dy))}px`;
        };

        const onUp = () => {
          isDragging = false;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    // =========================================================================
    // Renderizadores Dinâmicos de Conteúdo da Interface (DOM Binding)
    // =========================================================================
    
    /**
     * Renderiza a barra seletora de carrosséis (Carrossel 1 a 11 e filtro "Todos")
     */
    function renderCarouselsSelector() {
      const container = macroModalElement.querySelector('#fd-carousels-selector-container');
      const badge = macroModalElement.querySelector('#fd-carousels-count-badge');
      const chipsContainer = macroModalElement.querySelector('#fd-carousel-chips');
      if (!container || !chipsContainer) return;

      if (!engine.carousels || engine.carousels.length <= 1) {
        container.style.display = 'none';
        return;
      }

      container.style.display = 'block';
      if (badge) badge.innerText = `${engine.carousels.length} Carrosséis (${engine.prompts.length} Slides)`;

      const allActive = engine.selectedCarouselId === 'all';

      chipsContainer.innerHTML = `
        <button class="fd-carousel-chip ${allActive ? 'active' : ''}" data-id="all">
          🌟 Todos os Carrosséis (${engine.carousels.length})
        </button>
        ${engine.carousels.map(c => `
          <button class="fd-carousel-chip ${engine.selectedCarouselId === c.id ? 'active' : ''}" data-id="${c.id}">
            ${c.title.split(':')[0]} (${c.slides.length} slides)
          </button>
        `).join('')}
      `;

      chipsContainer.querySelectorAll('.fd-carousel-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-id');
          engine.selectCarouselFilter(id);
          renderCarouselsSelector();
          renderPromptsList();
          showToast(id === 'all' ? `🌟 Executando todos os ${engine.carousels.length} carrosséis em lote.` : `🎯 Selecionado: ${btn.innerText}`, 'info');
        });
      });
    }

    /**
     * Renderiza a lista de prompts e slides com títulos, balões e botões de repetição
     */
    function renderPromptsList() {
      const container = macroModalElement.querySelector('#fd-prompts-list');
      if (!container) return;

      if (engine.prompts.length === 0) {
        container.innerHTML = `
          <div style="padding: 30px; text-align: center; color: var(--fd-text-muted); font-size: 13px;">
            Nenhum prompt carregado. Faça upload de um PDF ou cole um roteiro acima.
          </div>
        `;
        return;
      }

      // Filtra prompts se um carrossel individual estiver selecionado
      const displayPrompts = engine.selectedCarouselId === 'all'
        ? engine.prompts
        : engine.prompts.filter(p => p.carouselIndex === parseInt(engine.selectedCarouselId.replace('carousel_', ''), 10) || p.enabled !== false);

      let html = '';
      let currentCarouselHeader = '';

      displayPrompts.forEach((p) => {
        const repeats = p.repeatCount || 1;
        const comp = p.completedRepeats || 0;
        let statusBadgeText = p.status;
        if (p.status === 'running') {
          statusBadgeText = `Gerando (${comp + 1}/${repeats})`;
        } else if (p.status === 'completed') {
          statusBadgeText = `Concluído (${repeats}x)`;
        }

        // Renderiza divisores agrupadores quando houver múltiplos carrosséis
        if (p.carouselTitle && p.carouselTitle !== currentCarouselHeader && engine.carousels && engine.carousels.length > 1) {
          currentCarouselHeader = p.carouselTitle;
          html += `
            <div class="fd-carousel-group-header">
              <span>📚 ${currentCarouselHeader}</span>
              <span style="font-size: 11px; opacity: 0.85; font-weight: 600;">5 Slides</span>
            </div>
          `;
        }

        html += `
          <div class="fd-prompt-row ${p.status}" data-id="${p.id}">
            <input type="checkbox" class="fd-prompt-toggle" name="fd_chk_prompt_${p.id}" ${p.enabled !== false ? 'checked' : ''} style="cursor: pointer;" autocomplete="off">
            <span class="fd-prompt-index">#${p.globalIndex || p.index}</span>
            <div class="fd-prompt-preview">
              <div class="fd-prompt-preview-title">${p.title}</div>
              ${p.ptDialogue ? `<div style="font-size: 11px; color: #38bdf8; margin: 2px 0;">💬 <strong>Balão:</strong> "${p.ptDialogue}"</div>` : ''}
              <div class="fd-prompt-preview-text">${p.fullText || p.imagePrompt}</div>
            </div>
            <div class="fd-repeat-control" title="Quantas vezes este prompt específico será inserido">
              <span>🔁</span>
              <input type="number" min="1" max="50" value="${repeats}" class="fd-repeat-input" name="fd_rep_prompt_${p.id}" data-id="${p.id}" autocomplete="off">
              <span>x</span>
            </div>
            <span class="fd-prompt-status-badge ${p.status}">${statusBadgeText}</span>
            <button class="fd-btn-icon fd-btn-run-single" title="Executar este prompt agora" style="color: #10b981;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            </button>
            <button class="fd-btn-icon fd-btn-delete-single" title="Remover" style="color: #f87171;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        `;
      });

      container.innerHTML = html;

      // Associa eventos de clique e inputs nas linhas de prompt
      container.querySelectorAll('.fd-prompt-row').forEach(row => {
        const id = row.getAttribute('data-id');
        const chk = row.querySelector('.fd-prompt-toggle');
        const repeatInp = row.querySelector('.fd-repeat-input');
        const btnRun = row.querySelector('.fd-btn-run-single');
        const btnDel = row.querySelector('.fd-btn-delete-single');

        chk.addEventListener('change', (e) => engine.updatePrompt(id, { enabled: e.target.checked }));
        if (repeatInp) {
          repeatInp.addEventListener('change', (e) => {
            const count = Math.max(1, parseInt(e.target.value, 10) || 1);
            engine.updatePrompt(id, { repeatCount: count });
          });
        }
        btnRun.addEventListener('click', () => engine.runSinglePrompt(id));
        btnDel.addEventListener('click', () => {
          engine.removePrompt(id);
          renderPromptsList();
        });
      });
    }

    /**
     * Renderiza a grade de cards de personagens cadastrados
     */
    function renderCharactersList() {
      const charTabSpan = macroModalElement ? macroModalElement.querySelector('.fd-macro-tab[data-tab="characters"] span') : null;
      if (charTabSpan) {
        charTabSpan.innerText = `Personagens (${engine.characters.length})`;
      }

      const container = macroModalElement.querySelector('#fd-chars-list');
      if (!container) return;

      if (engine.characters.length === 0) {
        container.innerHTML = `
          <div style="grid-column: 1 / -1; padding: 30px; text-align: center; color: var(--fd-text-muted); font-size: 13px; background: rgba(255,255,255,0.02); border: 1px dashed var(--fd-border); border-radius: 12px; display: flex; flex-direction: column; align-items: center; gap: 12px;">
            <span>Nenhum personagem pré-definido cadastrado.</span>
            <button class="fd-modal-btn-confirm" id="fd-btn-empty-add-char" style="padding: 8px 18px; font-size: 13px;">
              + Adicionar Personagem (com Foto)
            </button>
          </div>
        `;
        const btnEmptyAdd = container.querySelector('#fd-btn-empty-add-char');
        if (btnEmptyAdd) {
          btnEmptyAdd.addEventListener('click', (e) => {
            e.preventDefault();
            openAddCharacterDialog();
          });
        }
        return;
      }

      container.innerHTML = engine.characters.map(c => `
        <div class="fd-char-card" data-id="${c.id}">
          <img class="fd-char-avatar" src="${c.avatarUrl || 'data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'50\' height=\'50\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%236366f1\' stroke-width=\'2\'><path d=\'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2\'></path><circle cx=\'12\' cy=\'7\' r=\'4\'></circle></svg>'}" alt="${c.name}">
          <div class="fd-char-info">
            <span class="fd-char-name">${c.name}</span>
            <span class="fd-char-tag" title="${c.promptTag}">${c.promptTag || 'Sem descrição'}</span>
            <span style="font-size: 10px; color: ${c.avatarUrl ? '#10b981' : '#94a3b8'};">
              ${c.avatarUrl ? '✓ Foto anexada (Carrega no FLOW)' : '⚠ Sem foto (apenas texto)'}
            </span>
          </div>
          <label class="fd-switch" style="transform: scale(0.85);" title="Ativar/Desativar personagem">
            <input type="checkbox" class="fd-char-toggle" name="fd_char_chk_${c.id}" ${c.enabled !== false ? 'checked' : ''} autocomplete="off">
            <span class="fd-slider"></span>
          </label>
          <button class="fd-btn-icon fd-btn-delete-char" title="Excluir Personagem" style="color: #f87171;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      `).join('');

      container.querySelectorAll('.fd-char-card').forEach(card => {
        const id = card.getAttribute('data-id');
        const chk = card.querySelector('.fd-char-toggle');
        const btnDel = card.querySelector('.fd-btn-delete-char');

        chk.addEventListener('change', (e) => engine.updateCharacter(id, { enabled: e.target.checked }));
        btnDel.addEventListener('click', () => {
          engine.removeCharacter(id);
          renderCharactersList();
        });
      });
    }

    /**
     * Renderiza as mensagens no console de logs ao vivo
     */
    function renderLogs() {
      const consoleEl = macroModalElement.querySelector('#fd-logs-console');
      if (!consoleEl) return;

      consoleEl.innerHTML = engine.logs.map(l => `
        <div class="fd-log-entry ${l.type}">
          <span class="fd-log-time" style="font-family: monospace; font-size: 10px; color: #64748b;">${l.timeDisplay || `[${l.time}]`}</span>
          <span>${l.message}</span>
        </div>
      `).join('');
    }

    /**
     * Atualiza o estado global da interface visual (badges, botões, cronômetros, barras de progresso)
     * @param {Object} state - Estado fornecido pelo FlowMacroEngine
     */
    function updateMacroStateUI(state) {
      // Atualiza o badge do cabeçalho
      const headerStatus = macroModalElement.querySelector('#fd-macro-header-status');
      const totalGens = state.totalGenerations || state.totalPrompts;
      const compGens = state.completedGenerations || state.completedCount;

      if (headerStatus) {
        headerStatus.className = `fd-badge-status ${state.state}`;
        headerStatus.innerText = state.state === 'running'
          ? `Executando (${compGens}/${totalGens} gerações)`
          : (state.state === 'paused' ? 'Pausado' : 'Pronto');
      }

      // Atualiza texto do botão iniciar/pausar
      const runBtnText = macroModalElement.querySelector('#fd-run-btn-text');
      if (runBtnText) {
        runBtnText.innerText = state.state === 'running' ? 'Pausar' : 'Iniciar Macro';
      }

      // Atualiza tiles do cronômetro em tempo real
      const elapsedValEl = macroModalElement.querySelector('#fd-timer-elapsed-val');
      if (elapsedValEl) {
        elapsedValEl.innerText = state.elapsedFormatted || '00:00';
        if (state.state === 'running') elapsedValEl.classList.add('active');
        else elapsedValEl.classList.remove('active');
      }

      const actionValEl = macroModalElement.querySelector('#fd-timer-action-val');
      if (actionValEl) {
        actionValEl.innerText = state.currentAction || (state.state === 'running' ? 'Executando...' : 'Pronto');
      }

      // Atualiza a barra de contagem regressiva ativa (delay entre slides / carrosséis)
      const countdownBox = macroModalElement.querySelector('#fd-countdown-container');
      const countdownLabel = macroModalElement.querySelector('#fd-countdown-label');
      const countdownSeconds = macroModalElement.querySelector('#fd-countdown-seconds');
      const countdownFill = macroModalElement.querySelector('#fd-countdown-bar-fill');

      if (countdownBox && state.countdown && state.countdown.remaining > 0) {
        countdownBox.style.display = 'flex';
        if (countdownLabel) countdownLabel.innerText = `⏳ ${state.countdown.label || 'Aguardando'}:`;
        if (countdownSeconds) countdownSeconds.innerText = `${state.countdown.remaining}s`;
        if (countdownFill) {
          const total = Math.max(1, state.countdown.total || state.countdown.remaining);
          const pct = Math.round((state.countdown.remaining / total) * 100);
          countdownFill.style.width = `${pct}%`;
        }
      } else if (countdownBox) {
        countdownBox.style.display = 'none';
      }

      // Atualiza a barra de progresso global
      const progressLabel = macroModalElement.querySelector('#fd-progress-label');
      const progressPct = macroModalElement.querySelector('#fd-progress-pct');
      const progressFill = macroModalElement.querySelector('#fd-progress-fill');
      const currentTask = macroModalElement.querySelector('#fd-current-task-name');

      const isExecuting = state.state === 'running' || state.state === 'paused';
      const pct = (isExecuting && totalGens > 0) ? Math.round((compGens / totalGens) * 100) : 0;

      if (progressLabel) {
        progressLabel.innerText = isExecuting
          ? `Progresso: ${compGens} / ${totalGens} gerações (${state.completedCount}/${state.totalPrompts} prompts)`
          : 'Aguardando início...';
      }
      if (progressPct) progressPct.innerText = `${pct}%`;
      if (progressFill) progressFill.style.width = `${pct}%`;

      if (currentTask) {
        if (isExecuting && state.currentIndex >= 0 && state.prompts[state.currentIndex]) {
          const curItem = state.prompts[state.currentIndex];
          currentTask.innerText = `Prompt atual: ${curItem.title} (Repetição ${(curItem.completedRepeats || 0) + 1}/${curItem.repeatCount || 1})`;
        } else {
          currentTask.innerText = 'Nenhuma execução em andamento.';
        }
      }

      renderPromptsList();
      renderLogs();
      renderInspectorTab();
      updateMiniRunnerUI(state);
    }

    // Inscreve o observador de atualizações de estado do motor
    engine.subscribe(updateMacroStateUI);

    // Renderização inicial dos componentes da interface
    renderCarouselsSelector();
    renderPromptsList();
    renderCharactersList();
    renderLogs();
    renderInspectorTab();
    updateMacroStateUI(engine.getState());

    // Explicitly reload from dual storage to guarantee characters and state are fully restored
    engine.loadState().then(() => {
      renderCarouselsSelector();
      renderPromptsList();
      renderCharactersList();
      renderLogs();
      renderInspectorTab();
    });
  }
})();

