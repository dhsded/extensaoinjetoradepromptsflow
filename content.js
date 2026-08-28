// FLOW Downloader Pro - Content Script
// Automates high-resolution batch downloading and smart scrolling on FLOW (Google Labs / ImageFX)

(function () {
  'use strict';

  // Prevent multiple injections in the same frame
  if (window.__FLOW_DOWNLOADER_INITIALIZED__) return;
  window.__FLOW_DOWNLOADER_INITIALIZED__ = true;

  console.log('[FLOW Downloader Pro] Script inicializado com sucesso.');

  // Extension State
  let settings = {
    autoDownload: false, // Default to FALSE as requested
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

  // Simple Debounce Helper to prevent CPU thrashing
  function debounce(fn, wait = 300) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  // Load initial settings
  chrome.runtime.sendMessage({ action: 'GET_SETTINGS' }, (response) => {
    if (chrome.runtime.lastError) {
      chrome.storage.local.get(null, (data) => {
        if (data) settings = { ...settings, ...data };
        init();
      });
      return;
    }
    if (response && response.settings) {
      settings = { ...settings, ...response.settings };
    }
    init();
  });

  // Listen for settings changes or commands from popup / background
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

  function handleCancelTrigger() {
    cancelRequested = true;
    isScrollingAndDownloading = false;
    resetHudButtons();
    showToast('🛑 Downloads cancelados pelo usuário.', 'info');
  }

  // Initialize UI & Observers
  function init() {
    createHud();
    scanAndInjectOverlayButtons();
    setupMutationObserver();

    // Lightweight fallback interval (every 4s) to catch lazy dynamic inserts
    setInterval(scanAndInjectOverlayButtons, 4000);
  }

  // ==========================================================================
  // Helper: Find Project / Generation Prompt Text from Page
  // ==========================================================================
  function extractPagePrompt(fallback = 'flow_image') {
    // 1. Check title in top bar (e.g. "Characters embracing looking at...")
    const headerTitle = document.querySelector('header h1, header [role="heading"], [role="banner"] span, [aria-label*="Título"], [aria-label*="Title"]');
    if (headerTitle) {
      const text = headerTitle.textContent.trim();
      if (text.length > 3 && !text.toLowerCase().includes('google') && !text.toLowerCase().includes('flow')) {
        return text;
      }
    }

    // 2. Check title / navigation links
    const titleCandidates = document.querySelectorAll('button span, div span, h1, h2');
    for (const el of titleCandidates) {
      const t = el.textContent.trim();
      if (t.length > 5 && t.length < 90 && !t.includes('©') && !t.includes('Google') && !t.includes('Downloads') && !t.includes('PRO')) {
        const parent = el.closest('header, nav, [role="banner"], main');
        if (parent) return t;
      }
    }

    // 3. Check prompt input textarea / placeholder
    const promptInput = document.querySelector('textarea, input[placeholder*="mudar"], input[placeholder*="prompt"], input[placeholder*="descrever"]');
    if (promptInput && promptInput.value && promptInput.value.trim().length > 3) {
      return promptInput.value.trim();
    }

    return fallback;
  }

  function extractPromptText(cardOrElement, fallback = 'flow_image') {
    if (!cardOrElement) return extractPagePrompt(fallback);

    // 1. Check image alt attribute
    const img = cardOrElement.tagName && cardOrElement.tagName.toLowerCase() === 'img'
      ? cardOrElement
      : (cardOrElement.querySelector ? cardOrElement.querySelector('img') : null);

    if (img && img.alt && img.alt.trim().length > 2) {
      return img.alt.trim();
    }

    // 2. Check aria-label of element or container
    if (cardOrElement.getAttribute) {
      const aria = (cardOrElement.getAttribute('aria-label') || '').trim();
      if (aria.length > 4 && !aria.toLowerCase().includes('download') && !aria.toLowerCase().includes('menu') && !aria.toLowerCase().includes('fechar')) {
        return aria;
      }
    }

    return extractPagePrompt(fallback);
  }

  // ==========================================================================
  // Helper: Extract High-Resolution Image URL (Optimized for Google CDN / Labs)
  // ==========================================================================
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

  function normalizeImageUrl(src) {
    if (!src) return null;

    // Filter out Google Account avatars and profile pictures
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

    // Upgrade Googleusercontent / Labs thumbnail URL to maximum raw resolution (=s0)
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
  // Accurate Discovery of All Generated Image Items on Page
  // ==========================================================================
  function findFlowImages() {
    const images = Array.from(document.querySelectorAll('img'));
    const items = [];
    const seenUrls = new Set();
    const pagePrompt = extractPagePrompt('flow_image');

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const rawSrc = img.currentSrc || img.src || img.dataset.src || '';

      // Skip invalid, svg, avatar, logo or tiny icon images
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
  // Find All Main Scrollable Containers on the Page
  // ==========================================================================
  function findScrollContainers() {
    const containers = [];
    const docElem = document.documentElement;
    const body = document.body;

    // Window / Document scroller
    containers.push({
      element: window,
      isWindow: true,
      getScrollTop: () => window.scrollY || docElem.scrollTop || body.scrollTop,
      getScrollHeight: () => Math.max(docElem.scrollHeight, body.scrollHeight),
      getClientHeight: () => window.innerHeight,
      scrollBy: (val) => window.scrollBy({ top: val, behavior: 'smooth' }),
      scrollTo: (top) => window.scrollTo({ top, behavior: 'smooth' })
    });

    // Check all inner scrollable divs/sections/feeds
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
  // Single Card Download Function (1-Click Overlay Button)
  // ==========================================================================
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

    chrome.runtime.sendMessage(
      {
        action: 'DOWNLOAD_IMAGE',
        url: imageUrl,
        filename: filename,
        folder: settings.downloadFolder,
        id: imageUrl
      },
      (res) => {
        if (chrome.runtime.lastError) {
          console.warn('[FLOW Downloader] Download send error:', chrome.runtime.lastError.message);
          return;
        }
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
  // Folder Name Prompt Dialog (Modal Interativo para Nomear Pasta)
  // ==========================================================================
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
  // Auto-Scroll to Bottom & Direct Batch Download of ALL Discovered Images
  // ==========================================================================
  async function startScrollAndBatchDownload(customFolder = null) {
    if (isScrollingAndDownloading) {
      showToast('⚠️ Processo de download já em andamento...', 'info');
      return;
    }

    // Let user name or confirm the destination folder before proceeding
    let targetFolder = customFolder;
    if (!targetFolder) {
      targetFolder = await promptForFolderName(settings.downloadFolder || 'FLOW_Downloads');
      if (!targetFolder) {
        // Cancelled by user
        return;
      }
      settings.downloadFolder = targetFolder;
      chrome.storage.local.set({ downloadFolder: targetFolder });
      chrome.runtime.sendMessage({
        action: 'SAVE_SETTINGS',
        settings: { downloadFolder: targetFolder }
      }, () => {
        if (chrome.runtime.lastError) {}
      });
    }

    isScrollingAndDownloading = true;
    cancelRequested = false;

    // Show cancel button in HUD and update download button
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

    // Map to accumulate discovered images during scrolling (ensures virtual lists don't drop items)
    const collectedMap = new Map(); // Key: url, Value: { url, prompt, card }

    function collectAllVisible() {
      const items = findFlowImages();
      for (const item of items) {
        if (!collectedMap.has(item.url)) {
          collectedMap.set(item.url, item);
        }
      }
      updateImageCountBadge(collectedMap.size);
    }

    // Initial collection
    collectAllVisible();

    // 1. Thorough, Progressive Scrolling Loop with Verification
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

      // Scroll all active containers by 550px
      for (const scroller of scrollers) {
        scroller.scrollBy(550);
      }

      // Scroll horizontal carousels/filmstrips if present
      const horizontalStrips = document.querySelectorAll('[style*="overflow-x"], div, section');
      for (const el of horizontalStrips) {
        if (el.scrollWidth > el.clientWidth + 50) {
          el.scrollBy({ left: 400, behavior: 'smooth' });
        }
      }

      // Wait 850ms per step to ensure network fetches and DOM insertions complete
      await new Promise(r => setTimeout(r, 850));

      if (cancelRequested) {
        resetHudButtons();
        isScrollingAndDownloading = false;
        return;
      }

      collectAllVisible();

      const currentHeight = primaryScroller.getScrollHeight();
      const currentCount = collectedMap.size;

      // Check if new images or new height were added
      if (currentHeight > lastHeight + 10 || currentCount > lastImageCount) {
        // Content is still expanding, reset confirmation counter
        bottomConfirmationCount = 0;
        lastHeight = currentHeight;
        lastImageCount = currentCount;
      } else {
        // No new content added in this step
        bottomConfirmationCount++;
        // Verify 4 consecutive checks (4 * 850ms = 3.4 seconds of stable bottom)
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

    // Final wait at the bottom for any last image render
    await new Promise(r => setTimeout(r, 600));
    collectAllVisible();

    // 2. Smoothly restore initial scroll position
    primaryScroller.scrollTo(initialTop);
    await new Promise(r => setTimeout(r, 300));

    // 3. Prepare full batch array
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

    // 4. Build batch items with unique indexed filenames
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

    // 5. Send complete batch to background download queue
    chrome.runtime.sendMessage(
      {
        action: 'DOWNLOAD_BATCH',
        items: batchItems,
        folder: targetFolder
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[FLOW Downloader] Batch error:', chrome.runtime.lastError.message);
        }

        // Mark visible cards as downloaded
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
  // Optimized Overlay Button Injection (No Reflow Thrashing)
  // ==========================================================================
  const debouncedScanAndInject = debounce(scanAndInjectOverlayButtons, 300);

  function scanAndInjectOverlayButtons() {
    if (isScrollingAndDownloading) return;

    const items = findFlowImages();
    updateImageCountBadge(items.length);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const card = item.card;

      if (card && !card.dataset.fdProcessed) {
        card.dataset.fdProcessed = 'true';

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
  // Real-time Mutation Observer (With Debounce & Self-Mutation Filter)
  // ==========================================================================
  function setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (let i = 0; i < mutations.length; i++) {
        const mutation = mutations[i];
        if (mutation.addedNodes.length > 0) {
          const target = mutation.target;
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
  // Floating HUD (Interface Flutuante na Página)
  // ==========================================================================
  function createHud() {
    if (document.getElementById('flow-downloader-hud')) return;

    hudElement = document.createElement('div');
    hudElement.id = 'flow-downloader-hud';
    hudElement.style.display = settings.showFloatingHud ? 'block' : 'none';

    hudElement.innerHTML = `
      <!-- Expanded HUD -->
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

          <!-- Auto-Download Toggle -->
          <div class="fd-row">
            <span class="fd-label">
              🔄 Baixar Automaticamente
            </span>
            <label class="fd-switch">
              <input type="checkbox" id="fd-toggle-auto" ${settings.autoDownload ? 'checked' : ''}>
              <span class="fd-slider"></span>
            </label>
          </div>

          <!-- Quality Selector -->
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

          <!-- Batch Download & Macro Studio Button Group -->
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

      <!-- Minimized Bubble Trigger -->
      <div class="fd-minimized-trigger" id="fd-minimized-bubble" style="display: none;" title="Abrir FLOW Studio">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
        </svg>
        <div class="fd-minimized-badge" id="fd-min-badge">0</div>
      </div>
    `;

    document.body.appendChild(hudElement);

    // Event Bindings for HUD
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
      chrome.runtime.sendMessage({
        action: 'SAVE_SETTINGS',
        settings: { autoDownload: val }
      }, () => {
        if (chrome.runtime.lastError) {
          // Safe consume
        }
      });
      updateHudUI();
      showToast(val ? '🟢 Download automático ativado!' : '⏸️ Download automático pausado.', val ? 'success' : 'info');
      if (val) scanAndInjectOverlayButtons();
    });

    selectQuality.addEventListener('change', (e) => {
      const val = e.target.value;
      settings.quality = val;
      chrome.storage.local.set({ quality: val });
      chrome.runtime.sendMessage({
        action: 'SAVE_SETTINGS',
        settings: { quality: val }
      }, () => {
        if (chrome.runtime.lastError) {
          // Safe consume
        }
      });
      showToast(`🎯 Resolução alterada para: ${val.toUpperCase()}`, 'info');
    });

    btnDownloadAll.addEventListener('click', () => {
      startScrollAndBatchDownload();
    });

    btnCancel.addEventListener('click', () => {
      cancelRequested = true;
      isScrollingAndDownloading = false;
      chrome.runtime.sendMessage({ action: 'CANCEL_DOWNLOADS' }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
      resetHudButtons();
      showToast('🛑 Downloads cancelados pelo usuário.', 'info');
    });

    // Make HUD Draggable
    setupDraggableHud(hudElement, document.getElementById('fd-drag-handle'));
  }

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

  function updateImageCountBadge(count) {
    const badge = document.getElementById('fd-img-counter');
    const minBadge = document.getElementById('fd-min-badge');
    if (badge) {
      badge.innerText = `✨ ${count} ${count === 1 ? 'imagem detectada' : 'imagens detectadas'}`;
    }
    if (minBadge) minBadge.innerText = count.toString();
  }

  // ==========================================================================
  // Draggable HUD Implementation
  // ==========================================================================
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
  // Toast Notifications
  // ==========================================================================
  let toastContainer = null;
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
  // FLOW Macro Studio Pro - Modal UI & Orchestrator
  // ==========================================================================
  let macroModalElement = null;

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
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
              <div>
                <h3 style="margin: 0; font-size: 14px; font-weight: 700; color: #fff;">Personagens Pré-definidos</h3>
                <span style="font-size: 12px; color: var(--fd-text-muted);">Defina avatares e descrições para manter a consistência visual em cada geração.</span>
              </div>
              <button class="fd-modal-btn-confirm" id="fd-btn-add-char" style="padding: 7px 14px; font-size: 12px;">
                + Novo Personagem
              </button>
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
                  <span style="font-size: 12px; color: var(--fd-text-muted);">🔁 Repetições Padrão por Prompt:</span>
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <input type="number" id="fd-config-repeat-per-prompt" min="1" max="50" value="${engine.config.repeatPerPrompt || 1}" class="fd-modal-input" style="width: 55px; text-align: center; background: rgba(0,0,0,0.3); border: 1px solid var(--fd-border); border-radius: 6px; padding: 4px;">
                    <span style="font-size: 12px; color: var(--fd-text-muted);">vez(es)</span>
                  </div>
                </div>

                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <span style="font-size: 12px; color: var(--fd-text-muted);">⏳ Intervalo entre Envios:</span>
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <input type="number" id="fd-config-delay" min="3" max="120" value="${engine.config.delaySeconds || 8}" class="fd-modal-input" style="width: 55px; text-align: center; background: rgba(0,0,0,0.3); border: 1px solid var(--fd-border); border-radius: 6px; padding: 4px;">
                    <span style="font-size: 12px; color: var(--fd-text-muted);">seg</span>
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
                    <span style="font-size: 12px; font-weight: 600; color: #fff;">🔁 Reutilizar Comando (Manter Personagens):</span>
                    <span style="font-size: 10px; color: var(--fd-text-muted);">Clica no botão ↪ do FLOW para reaproveitar personagens e trocar apenas o prompt</span>
                  </div>
                  <label class="fd-switch">
                    <input type="checkbox" id="fd-toggle-reuse-command" name="fd_toggle_reuse_command" ${engine.config.reusePreviousCommand !== false ? 'checked' : ''} autocomplete="off">
                    <span class="fd-slider"></span>
                  </label>
                </div>

                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <div style="display: flex; flex-direction: column;">
                    <span style="font-size: 12px; font-weight: 600; color: #fff;">📁 Novo Projeto a Cada Carrossel:</span>
                    <span style="font-size: 10px; color: var(--fd-text-muted);">Clica em "+ Novo projeto" no FLOW automaticamente ao concluir cada carrossel</span>
                  </div>
                  <label class="fd-switch">
                    <input type="checkbox" id="fd-toggle-new-proj-per-carousel" name="fd_toggle_new_proj_per_carousel" ${engine.config.autoCreateNewProjectPerCarousel !== false ? 'checked' : ''} autocomplete="off">
                    <span class="fd-slider"></span>
                  </label>
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
              <span style="font-size: 12px; font-weight: 600; color: var(--fd-text-muted);">Console de Execução em Tempo Real:</span>
              <div class="fd-logs-console" id="fd-logs-console">
                <!-- Log items rendered dynamically -->
              </div>
            </div>
          </div>

          <!-- TAB 5: FLOW Inspector / Espião de Elementos -->
          <div class="fd-tab-pane" id="pane-inspector">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
              <div>
                <h3 style="margin: 0; font-size: 14px; font-weight: 700; color: #fff;">🔍 Espião e Diagnóstico de Elementos do FLOW</h3>
                <span style="font-size: 12px; color: var(--fd-text-muted);">Varredura em tempo real dos seletores e componentes encontrados no site do FLOW.</span>
              </div>
              <button class="fd-modal-btn-confirm" id="fd-btn-refresh-inspector" style="padding: 6px 14px; font-size: 12px;">
                🔄 Atualizar Varredura
              </button>
            </div>

            <!-- Inspector Grid -->
            <div class="fd-inspector-grid" id="fd-inspector-grid">
              <!-- Rendered dynamically -->
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(macroModalElement);

    // =========================================================================
    // UI Event Wiring & Interactions
    // =========================================================================
    
    // Header actions: Close, Transparent Mode, PIP Mode
    const btnClose = macroModalElement.querySelector('#fd-macro-btn-close');
    const btnTransparent = macroModalElement.querySelector('#fd-macro-btn-transparent');
    const btnPip = macroModalElement.querySelector('#fd-macro-btn-pip');
    const windowEl = macroModalElement.querySelector('#fd-macro-window');
    const dragHandle = macroModalElement.querySelector('#fd-macro-drag-handle');

    btnClose.addEventListener('click', () => {
      macroModalElement.style.display = 'none';
    });

    btnTransparent.addEventListener('click', () => {
      macroModalElement.classList.toggle('transparent-mode');
      const isTrans = macroModalElement.classList.contains('transparent-mode');
      showToast(isTrans ? '👁️ Modo Transparente ativado (Você pode ver o FLOW atrás)' : 'Modo Padrão restaurado', 'info');
    });

    btnPip.addEventListener('click', () => {
      enableMiniRunnerMode(true);
    });

    // Make Studio Window Draggable
    setupDraggableModal(windowEl, dragHandle);

    // Tab switching
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

    // Dropzone & File Upload
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
        console.error('[FLOW Macro Studio] File error:', err);
        showToast(`❌ Erro ao ler arquivo: ${err.message}`, 'info');
      }
    }

    // Paste Script / Text Modal Trigger
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

    // Add Prompt Manual Button
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

    // Global Repeat Input in Tab 1
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

    // Reset Statuses Button
    const btnResetStatus = macroModalElement.querySelector('#fd-btn-reset-status');
    btnResetStatus.addEventListener('click', () => {
      engine.resetPromptStatuses();
      renderPromptsList();
      showToast('🔄 Status e repetições redefinidos para Pendente.', 'info');
    });

    // Clear Prompts Button
    const btnClearPrompts = macroModalElement.querySelector('#fd-btn-clear-prompts');
    btnClearPrompts.addEventListener('click', () => {
      if (confirm('Deseja realmente limpar todos os prompts da lista?')) {
        engine.clearPrompts();
        renderPromptsList();
      }
    });

    // =========================================================================
    // Format Tab Controls (Screenshot-Matched 1:1)
    // =========================================================================
    
    // Media buttons
    const mediaBtns = macroModalElement.querySelectorAll('.fd-media-btn');
    mediaBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        mediaBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const media = btn.getAttribute('data-media');
        engine.updateConfig({ mediaType: media });
      });
    });

    // Aspect ratio buttons
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

    // Quantity buttons
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

    // Delay, Repeat per prompt & Toggle
    const inputDelay = macroModalElement.querySelector('#fd-config-delay');
    inputDelay.addEventListener('change', (e) => {
      const val = parseInt(e.target.value, 10) || 8;
      engine.updateConfig({ delaySeconds: val });
    });

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

    const toggleApplyChars = macroModalElement.querySelector('#fd-toggle-apply-chars');
    if (toggleApplyChars) {
      toggleApplyChars.addEventListener('change', (e) => {
        engine.updateConfig({ applyGlobalCharacters: e.target.checked });
      });
    }

    const toggleReuseCmd = macroModalElement.querySelector('#fd-toggle-reuse-command');
    if (toggleReuseCmd) {
      toggleReuseCmd.addEventListener('change', (e) => {
        engine.updateConfig({ reusePreviousCommand: e.target.checked });
        showToast(e.target.checked ? '🔁 Modo Reutilizar Comando ativado!' : 'Manual: Personagens injetados do zero a cada slide.', 'info');
      });
    }

    const toggleNewProj = macroModalElement.querySelector('#fd-toggle-new-proj-per-carousel');
    if (toggleNewProj) {
      toggleNewProj.addEventListener('change', (e) => {
        engine.updateConfig({ autoCreateNewProjectPerCarousel: e.target.checked });
        showToast(e.target.checked ? '📁 Criação de novo projeto por carrossel ativada!' : 'Projetos mantidos no mesmo espaço.', 'info');
      });
    }

    // =========================================================================
    // Character Management Tab Controls (Com Upload de Imagens Reais)
    // =========================================================================
    const btnAddChar = macroModalElement.querySelector('#fd-btn-add-char');
    if (btnAddChar) {
      btnAddChar.addEventListener('click', (e) => {
        e.preventDefault();
        openAddCharacterDialog();
      });
    }

    function openAddCharacterDialog() {
      // Remove any previously opened character dialog
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

            <!-- Image File Upload Dropzone -->
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
                  <span style="font-size: 11px; color: var(--fd-text-muted);">PNG, JPG, WEBP (Será enviada aos slots do FLOW)</span>
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

      // Dropzone click triggers file input safely
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

      function handleImageFile(file) {
        if (!file.type.startsWith('image/')) {
          showToast('⚠️ Por favor selecione um arquivo de imagem válido (PNG, JPG, WEBP).', 'warning');
          return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
          selectedAvatarDataUrl = ev.target.result;
          previewImg.src = selectedAvatarDataUrl;
          previewImg.style.display = 'block';
          dropPrompt.querySelector('span').innerText = `✅ ${file.name}`;
          showToast('📸 Foto do personagem carregada!', 'success');
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
        showToast(`🎭 Personagem "${name}" salvo com sucesso!`, 'success');
        dialog.remove();
      });

      // Auto focus name input
      const nameInput = dialog.querySelector('#fd-input-char-name');
      if (nameInput) setTimeout(() => nameInput.focus(), 100);
    }

    // =========================================================================
    // Execution Tab Controls
    // =========================================================================
    const btnRunMacro = macroModalElement.querySelector('#fd-btn-run-macro');
    const btnPauseMacro = macroModalElement.querySelector('#fd-btn-pause-macro');
    const btnStopMacro = macroModalElement.querySelector('#fd-btn-stop-macro');

    btnRunMacro.addEventListener('click', () => {
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

    btnPauseMacro.addEventListener('click', () => engine.pause());
    btnStopMacro.addEventListener('click', () => engine.stop());

    // =========================================================================
    // FLOW Inspector / Espião de Elementos Tab
    // =========================================================================
    const btnRefreshInspector = macroModalElement.querySelector('#fd-btn-refresh-inspector');
    if (btnRefreshInspector) {
      btnRefreshInspector.addEventListener('click', () => {
        renderInspectorTab();
        showToast('🔍 Varredura do FLOW atualizada!', 'info');
      });
    }

    function renderInspectorTab() {
      const grid = macroModalElement.querySelector('#fd-inspector-grid');
      if (!grid) return;

      const diag = engine.diagnoseFlowDOM();

      grid.innerHTML = `
        <!-- Prompt Input Diagnosis -->
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

        <!-- Submit Button Diagnosis -->
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

        <!-- Reuse Command Diagnosis (Botão ↪) -->
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

        <!-- Aspect Ratio Diagnosis -->
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

        <!-- Quantity Diagnosis -->
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

        <!-- Character Attachment Slot Diagnosis -->
        <div class="fd-inspector-card ${diag.characterUploadSlot.found ? 'found' : 'missing'}">
          <div class="fd-inspector-header">
            <span class="fd-inspector-name">🎭 Entrada de Personagens</span>
            <span class="fd-inspector-badge ${diag.characterUploadSlot.found ? 'ok' : 'warn'}">
              ${diag.characterUploadSlot.found ? 'INPUT PRONTO' : 'VIA DRAG & DROP'}
            </span>
          </div>
          <div class="fd-inspector-selector">${diag.characterUploadSlot.type}</div>
          <div style="font-size: 11px; color: var(--fd-text-muted);">
            Injeta imagens dos personagens com simulação de drag-and-drop e upload nativo.
          </div>
        </div>
      `;

      // Highlight prompt button
      const btnHlPrompt = grid.querySelector('.fd-btn-highlight-prompt');
      if (btnHlPrompt) {
        btnHlPrompt.addEventListener('click', () => {
          const input = engine.findPromptInput();
          highlightElementOnPage(input);
        });
      }

      // Highlight submit button
      const btnHlSubmit = grid.querySelector('.fd-btn-highlight-submit');
      if (btnHlSubmit) {
        btnHlSubmit.addEventListener('click', () => {
          const btn = engine.findSubmitButton();
          highlightElementOnPage(btn);
        });
      }

      // Test Reuse Command button
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
    }

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
    // Mini Runner Bar (PIP Mode - Permite ver o FLOW 100% livre)
    // =========================================================================
    let miniRunnerElement = null;

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

    function updateMiniRunnerUI(state) {
      if (!miniRunnerElement || miniRunnerElement.style.display === 'none') return;

      const totalGens = state.totalGenerations || state.totalPrompts;
      const compGens = state.completedGenerations || state.completedCount;
      const pct = totalGens > 0 ? Math.round((compGens / totalGens) * 100) : 0;
      const curPrompt = (state.currentIndex >= 0 && state.prompts[state.currentIndex]) ? state.prompts[state.currentIndex] : null;

      const title = curPrompt ? `${curPrompt.title} (Rep ${(curPrompt.completedRepeats || 0) + 1}/${curPrompt.repeatCount || 1})` : 'Macro Aguardando...';

      miniRunnerElement.innerHTML = `
        <div class="fd-mini-pulse ${state.state === 'paused' ? 'paused' : ''}"></div>
        <div class="fd-mini-info">
          <div class="fd-mini-title-row">
            <span class="fd-mini-task-title" title="${title}">${title}</span>
            <span class="fd-mini-progress-pct">${pct}% (${compGens}/${totalGens})</span>
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
      });

      miniRunnerElement.querySelector('#fd-mini-btn-expand').addEventListener('click', () => {
        enableMiniRunnerMode(false);
      });
    }

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
    // Dynamic Renderers for Lists & State
    // =========================================================================
    
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

      // Filter prompts if a specific carousel is selected
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

        // Render Carousel Header group divider if there are multiple carousels
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

      // Bind row events
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

    function renderCharactersList() {
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

    function renderLogs() {
      const consoleEl = macroModalElement.querySelector('#fd-logs-console');
      if (!consoleEl) return;

      consoleEl.innerHTML = engine.logs.map(l => `
        <div class="fd-log-entry ${l.type}">
          <span class="fd-log-time">[${l.time}]</span>
          <span>${l.message}</span>
        </div>
      `).join('');
    }

    function updateMacroStateUI(state) {
      // Update header badge
      const headerStatus = macroModalElement.querySelector('#fd-macro-header-status');
      const totalGens = state.totalGenerations || state.totalPrompts;
      const compGens = state.completedGenerations || state.completedCount;

      if (headerStatus) {
        headerStatus.className = `fd-badge-status ${state.state}`;
        headerStatus.innerText = state.state === 'running'
          ? `Executando (${compGens}/${totalGens} gerações)`
          : (state.state === 'paused' ? 'Pausado' : 'Pronto');
      }

      // Update button text
      const runBtnText = macroModalElement.querySelector('#fd-run-btn-text');
      if (runBtnText) {
        runBtnText.innerText = state.state === 'running' ? 'Pausar' : 'Iniciar Macro';
      }

      // Update progress
      const progressLabel = macroModalElement.querySelector('#fd-progress-label');
      const progressPct = macroModalElement.querySelector('#fd-progress-pct');
      const progressFill = macroModalElement.querySelector('#fd-progress-fill');
      const currentTask = macroModalElement.querySelector('#fd-current-task-name');

      const pct = totalGens > 0 ? Math.round((compGens / totalGens) * 100) : 0;
      if (progressLabel) progressLabel.innerText = `Progresso: ${compGens} / ${totalGens} gerações (${state.completedCount}/${state.totalPrompts} prompts)`;
      if (progressPct) progressPct.innerText = `${pct}%`;
      if (progressFill) progressFill.style.width = `${pct}%`;

      if (currentTask && state.currentIndex >= 0 && state.prompts[state.currentIndex]) {
        const curItem = state.prompts[state.currentIndex];
        currentTask.innerText = `Prompt atual: ${curItem.title} (Repetição ${(curItem.completedRepeats || 0) + 1}/${curItem.repeatCount || 1})`;
      }

      renderPromptsList();
      renderLogs();
      renderInspectorTab();
      updateMiniRunnerUI(state);
    }

    // Subscribe to engine state updates
    engine.subscribe(updateMacroStateUI);

    // Initial render
    renderCarouselsSelector();
    renderPromptsList();
    renderCharactersList();
    renderLogs();
    renderInspectorTab();
    updateMacroStateUI(engine.getState());
  }
})();

