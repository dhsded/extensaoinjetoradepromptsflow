// FLOW Downloader Pro - Popup Logic

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const toggleAuto = document.getElementById('toggle-auto');
  const selectQuality = document.getElementById('select-quality');
  const inputFolder = document.getElementById('input-folder');
  const togglePromptName = document.getElementById('toggle-prompt-name');
  const toggleOverlayBtn = document.getElementById('toggle-overlay-btn');
  const toggleHud = document.getElementById('toggle-hud');
  const btnDownloadTab = document.getElementById('btn-download-tab');
  const btnCancelDownloads = document.getElementById('btn-cancel-downloads');
  const btnClearHistory = document.getElementById('btn-clear-history');
  const statDownloaded = document.getElementById('stat-downloaded');
  const statusLabel = document.getElementById('status-label');
  const statusDot = document.getElementById('status-dot');

  // Load Settings and download state
  chrome.storage.local.get(null, (data) => {
    if (chrome.runtime.lastError) {
      console.warn('[FLOW Downloader] Storage read:', chrome.runtime.lastError.message);
      return;
    }
    const s = data || {};
    toggleAuto.checked = s.autoDownload !== undefined ? !!s.autoDownload : false;
    selectQuality.value = s.quality || '1k';
    inputFolder.value = s.downloadFolder || 'FLOW_Downloads';
    togglePromptName.checked = s.nameWithPrompt !== false;
    toggleOverlayBtn.checked = s.showOverlayButtons !== false;
    toggleHud.checked = s.showFloatingHud !== false;
    statDownloaded.innerText = (s.totalDownloadedCount || 0).toString();

    updateDownloadButtonState(s.isDownloading, s.queueRemaining);
  });

  // Listen for storage changes in real-time
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.totalDownloadedCount) {
        statDownloaded.innerText = (changes.totalDownloadedCount.newValue || 0).toString();
      }
      if (changes.isDownloading !== undefined || changes.queueRemaining !== undefined) {
        chrome.storage.local.get(['isDownloading', 'queueRemaining'], (d) => {
          updateDownloadButtonState(d.isDownloading, d.queueRemaining);
        });
      }
    }
  });

  function updateDownloadButtonState(isDownloading, queueRemaining) {
    if (isDownloading) {
      btnCancelDownloads.style.display = 'flex';
      btnDownloadTab.disabled = true;
      btnDownloadTab.style.opacity = '0.75';
      btnDownloadTab.innerHTML = `<span>Baixando (${queueRemaining || '...'} restantes)</span>`;
    } else {
      btnCancelDownloads.style.display = 'none';
      btnDownloadTab.disabled = false;
      btnDownloadTab.style.opacity = '1';
      btnDownloadTab.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <span>Baixar Todas da Aba Ativa</span>
      `;
    }
  }

  // Query Active Tab
  let activeTab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0) {
      activeTab = tabs[0];
    }
  } catch (e) {
    console.warn('[FLOW Downloader] Tab query error:', e);
  }

  // Check and update tab status
  if (activeTab && activeTab.url) {
    const url = activeTab.url.toLowerCase();
    if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('brave://') || url.startsWith('about:')) {
      statusLabel.innerText = 'Página do Sistema';
      statusDot.style.backgroundColor = '#94a3b8';
      statusDot.style.boxShadow = 'none';
    } else if (url.includes('google') || url.includes('flow') || url.includes('labs')) {
      statusLabel.innerText = 'FLOW Conectado';
      statusDot.style.backgroundColor = '#10b981';
      statusDot.style.boxShadow = '0 0 8px #10b981';
    } else {
      statusLabel.innerText = 'Pronto';
      statusDot.style.backgroundColor = '#6366f1';
      statusDot.style.boxShadow = '0 0 8px #6366f1';
    }
  }

  // Save Settings Helper
  function saveCurrentSettings() {
    const updated = {
      autoDownload: toggleAuto.checked,
      quality: selectQuality.value,
      downloadFolder: inputFolder.value.trim() || 'FLOW_Downloads',
      nameWithPrompt: togglePromptName.checked,
      showOverlayButtons: toggleOverlayBtn.checked,
      showFloatingHud: toggleHud.checked
    };

    chrome.storage.local.set(updated, () => {
      if (chrome.runtime.lastError) {
        console.warn('[FLOW Downloader] Error saving settings:', chrome.runtime.lastError.message);
      }
    });

    // Notify service worker safely
    chrome.runtime.sendMessage({
      action: 'SAVE_SETTINGS',
      settings: updated
    }, () => {
      if (chrome.runtime.lastError) {
        // No-op
      }
    });
  }

  // Event Listeners for Controls
  toggleAuto.addEventListener('change', saveCurrentSettings);
  selectQuality.addEventListener('change', saveCurrentSettings);
  inputFolder.addEventListener('input', saveCurrentSettings);
  togglePromptName.addEventListener('change', saveCurrentSettings);
  toggleOverlayBtn.addEventListener('change', saveCurrentSettings);
  toggleHud.addEventListener('change', saveCurrentSettings);

  const btnOpenMacroStudio = document.getElementById('btn-open-macro-studio');
  if (btnOpenMacroStudio) {
    btnOpenMacroStudio.addEventListener('click', async () => {
      if (!activeTab || !activeTab.id) {
        alert('Abra a página do FLOW para usar o Macro Studio.');
        return;
      }
      await ensureContentScriptInjected(activeTab.id);
      chrome.tabs.sendMessage(activeTab.id, { action: 'OPEN_MACRO_STUDIO' }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[FLOW Popup] Could not message active tab directly:', chrome.runtime.lastError.message);
        }
      });
      window.close();
    });
  }

  // Helper to ensure content script is injected in the active tab
  async function ensureContentScriptInjected(tabId) {
    if (!tabId) return false;
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'PING' }, async (response) => {
        if (chrome.runtime.lastError || !response) {
          try {
            if (chrome.scripting) {
              await chrome.scripting.insertCSS({
                target: { tabId },
                files: ['content.css']
              }).catch(() => {});
              
              await chrome.scripting.executeScript({
                target: { tabId },
                files: ['pdf_extractor.js', 'macro_engine.js', 'content.js']
              });
              resolve(true);
            } else {
              resolve(false);
            }
          } catch (err) {
            console.warn('[FLOW Downloader] Injection error:', err);
            resolve(false);
          }
        } else {
          resolve(true);
        }
      });
    });
  }

  // Download All Button
  btnDownloadTab.addEventListener('click', async () => {
    if (!activeTab || !activeTab.id) {
      alert('Nenhuma aba ativa encontrada.');
      return;
    }

    const url = (activeTab.url || '').toLowerCase();
    if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('brave://') || url.startsWith('about:')) {
      alert('Abra a página do FLOW (Google Labs) para realizar downloads.');
      return;
    }

    btnDownloadTab.disabled = true;
    btnDownloadTab.style.opacity = '0.7';
    btnDownloadTab.innerHTML = `<span>Iniciando...</span>`;
    btnCancelDownloads.style.display = 'flex';

    // Ensure content script is present
    await ensureContentScriptInjected(activeTab.id);

    // Send download command to tab with folder name
    const folderName = inputFolder.value.trim() || 'FLOW_Downloads';
    chrome.tabs.sendMessage(activeTab.id, { action: 'DOWNLOAD_ALL_TRIGGER', folder: folderName }, (res) => {
      if (chrome.runtime.lastError) {
        console.warn('[FLOW Downloader] Mensagem para aba:', chrome.runtime.lastError.message);
        alert('Por favor, atualize a página do FLOW (pressione F5) e tente novamente.');
        btnCancelDownloads.style.display = 'none';
        btnDownloadTab.disabled = false;
        btnDownloadTab.style.opacity = '1';
      }
    });
  });

  // Cancel Downloads Button
  btnCancelDownloads.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CANCEL_DOWNLOADS' }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });

    if (activeTab && activeTab.id) {
      chrome.tabs.sendMessage(activeTab.id, { action: 'CANCEL_DOWNLOAD_TRIGGER' }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    }

    btnCancelDownloads.style.display = 'none';
    btnDownloadTab.disabled = false;
    btnDownloadTab.style.opacity = '1';
    btnDownloadTab.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      <span>Baixar Todas da Aba Ativa</span>
    `;
  });

  // Clear History / Cache
  btnClearHistory.addEventListener('click', () => {
    if (confirm('Deseja redefinir o contador e o cache de imagens baixadas?')) {
      chrome.storage.local.set({ downloadedIds: [], totalDownloadedCount: 0 }, () => {
        statDownloaded.innerText = '0';
      });
      chrome.runtime.sendMessage({ action: 'CLEAR_HISTORY' }, () => {
        if (chrome.runtime.lastError) {
          // Consume safely
        }
      });
    }
  });
});
