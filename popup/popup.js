// ============================================================================
// FLOW Downloader Pro - Lógica da Interface Popup (Janela de Configurações)
// ============================================================================
// Este arquivo controla os botões, checkboxes, selects e estatísticas da janela
// popup que abre ao clicar no ícone da extensão na barra de ferramentas do Chrome.
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // ==========================================================================
  // 1. Mapeamento dos Elementos Visuais do DOM no popup.html
  // ==========================================================================
  const toggleAuto = document.getElementById('toggle-auto');                   // Checkbox de Download Automático
  const selectQuality = document.getElementById('select-quality');             // Dropdown de Resolução (1K, 2K, 4K)
  const inputFolder = document.getElementById('input-folder');                 // Campo de texto com o nome da subpasta de destino
  const togglePromptName = document.getElementById('toggle-prompt-name');       // Checkbox para incluir o prompt no nome do arquivo
  const toggleOverlayBtn = document.getElementById('toggle-overlay-btn');       // Checkbox para mostrar botões sobre os cards no FLOW
  const toggleHud = document.getElementById('toggle-hud');                     // Checkbox para exibir a barra flutuante de automação
  const btnDownloadTab = document.getElementById('btn-download-tab');           // Botão "Baixar Todas da Aba Ativa"
  const btnCancelDownloads = document.getElementById('btn-cancel-downloads');   // Botão para cancelar downloads em andamento
  const btnClearHistory = document.getElementById('btn-clear-history');         // Botão para resetar contador e histórico
  const statDownloaded = document.getElementById('stat-downloaded');           // Elemento de texto com o total de downloads
  const statusLabel = document.getElementById('status-label');                 // Texto de status da conexão com a aba
  const statusDot = document.getElementById('status-dot');                     // Ponto colorido de status (verde, azul, cinza)

  // ==========================================================================
  // 2. Carregamento das Configurações Salvas do chrome.storage.local
  // ==========================================================================
  chrome.storage.local.get(null, (data) => {
    if (chrome.runtime.lastError) {
      console.warn('[FLOW Downloader] Erro ao ler storage:', chrome.runtime.lastError.message);
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

    // Atualiza o visual do botão de download de acordo com o estado atual da fila
    updateDownloadButtonState(s.isDownloading, s.queueRemaining);
  });

  // ==========================================================================
  // 3. Monitoramento em Tempo Real das Alterações no Storage
  // ==========================================================================
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      // Atualiza o contador de imagens baixadas se ele mudar
      if (changes.totalDownloadedCount) {
        statDownloaded.innerText = (changes.totalDownloadedCount.newValue || 0).toString();
      }
      // Atualiza o botão de download se o status da fila mudar
      if (changes.isDownloading !== undefined || changes.queueRemaining !== undefined) {
        chrome.storage.local.get(['isDownloading', 'queueRemaining'], (d) => {
          updateDownloadButtonState(d.isDownloading, d.queueRemaining);
        });
      }
    }
  });

  /**
   * Atualiza visualmente o botão de download caso haja uma operação em andamento
   * @param {boolean} isDownloading - Se há downloads sendo executados
   * @param {number} queueRemaining - Quantidade de itens restantes na fila
   */
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

  // ==========================================================================
  // 4. Identificação da Aba Ativa e Detecção do Google FLOW
  // ==========================================================================
  let activeTab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0) {
      activeTab = tabs[0];
    }
  } catch (e) {
    console.warn('[FLOW Downloader] Erro ao consultar abas:', e);
  }

  /**
   * Verifica se uma URL pertence ao ambiente oficial do Google FLOW
   * Suporta flow.google.com, labs.google/fx/tools/flow e aitestkitchen
   * @param {string} url - URL da aba
   * @returns {boolean}
   */
  function isFlowUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const u = url.toLowerCase();
    if (u.startsWith('chrome://') || u.startsWith('edge://') || u.startsWith('brave://') || u.startsWith('about:')) {
      return false;
    }
    return (
      u.includes('flow.google') ||
      u.includes('labs.google') ||
      u.includes('aitestkitchen.withgoogle.com') ||
      (u.includes('google.com') && (u.includes('/flow') || u.includes('/fx/')))
    );
  }

  // Verifica a URL da aba ativa e atualiza o indicador de conexão
  if (activeTab && activeTab.url) {
    const url = activeTab.url.toLowerCase();
    if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('brave://') || url.startsWith('about:')) {
      statusLabel.innerText = 'Página do Sistema';
      statusDot.style.backgroundColor = '#94a3b8';
      statusDot.style.boxShadow = 'none';
    } else if (isFlowUrl(url)) {
      statusLabel.innerText = 'FLOW Conectado';
      statusDot.style.backgroundColor = '#10b981';
      statusDot.style.boxShadow = '0 0 8px #10b981';
    } else {
      statusLabel.innerText = 'Fora do FLOW';
      statusDot.style.backgroundColor = '#f59e0b';
      statusDot.style.boxShadow = '0 0 8px #f59e0b';
    }
  }

  // ==========================================================================
  // 5. Função de Salvamento Automático das Configurações
  // ==========================================================================
  function saveCurrentSettings() {
    const updated = {
      autoDownload: toggleAuto.checked,
      quality: selectQuality.value,
      downloadFolder: inputFolder.value.trim() || 'FLOW_Downloads',
      nameWithPrompt: togglePromptName.checked,
      showOverlayButtons: toggleOverlayBtn.checked,
      showFloatingHud: toggleHud.checked
    };

    // Grava no storage local
    chrome.storage.local.set(updated, () => {
      if (chrome.runtime.lastError) {
        console.warn('[FLOW Downloader] Erro ao salvar configurações:', chrome.runtime.lastError.message);
      }
    });

    // Envia mensagem ao Service Worker para propagar as alterações a todas as abas
    chrome.runtime.sendMessage({
      action: 'SAVE_SETTINGS',
      settings: updated
    }, () => {
      if (chrome.runtime.lastError) {
        // Ignora erros de canal fechado
      }
    });
  }

  // Registra os ouvintes de evento nos controles de configuração
  toggleAuto.addEventListener('change', saveCurrentSettings);
  selectQuality.addEventListener('change', saveCurrentSettings);
  inputFolder.addEventListener('input', saveCurrentSettings);
  togglePromptName.addEventListener('change', saveCurrentSettings);
  toggleOverlayBtn.addEventListener('change', saveCurrentSettings);
  toggleHud.addEventListener('change', saveCurrentSettings);

  // ==========================================================================
  // 6. Botão para Abrir o Macro Studio no FLOW
  // ==========================================================================
  const btnOpenMacroStudio = document.getElementById('btn-open-macro-studio');
  if (btnOpenMacroStudio) {
    btnOpenMacroStudio.addEventListener('click', async () => {
      const originalHtml = btnOpenMacroStudio.innerHTML;
      btnOpenMacroStudio.disabled = true;
      btnOpenMacroStudio.innerHTML = '<span>⏳ Conectando...</span>';

      try {
        let targetTab = null;

        // 1. Se a aba ativa atual já for do Google FLOW (flow.google.com ou labs.google), usa ela diretamente
        if (activeTab && isFlowUrl(activeTab.url)) {
          targetTab = activeTab;
        } else {
          // 2. Procura se já existe alguma aba do FLOW aberta em qualquer janela
          const allTabs = await chrome.tabs.query({});
          const flowTab = allTabs.find((t) => isFlowUrl(t.url));
          if (flowTab) {
            targetTab = flowTab;
            // Traz a aba do FLOW para primeiro plano e foca a janela
            await chrome.tabs.update(flowTab.id, { active: true });
            if (flowTab.windowId) {
              await chrome.windows.update(flowTab.windowId, { focused: true });
            }
          }
        }

        // 3. Se nenhuma aba do FLOW estiver aberta, cria uma nova aba diretamente em flow.google.com
        if (!targetTab) {
          btnOpenMacroStudio.innerHTML = '<span>🚀 Abrindo FLOW...</span>';
          targetTab = await chrome.tabs.create({
            url: 'https://flow.google.com/',
            active: true
          });
          // Aguarda a nova aba carregar para abrir o Macro Studio
          await new Promise((resolve) => {
            const updateListener = (tabId, changeInfo) => {
              if (tabId === targetTab.id && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(updateListener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(updateListener);
            setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(updateListener);
              resolve();
            }, 6000);
          });
        }

        // 4. Garante que os scripts de automação estão ativos e respondendo na aba
        const isReady = await ensureContentScriptInjected(targetTab.id);
        if (!isReady) {
          btnOpenMacroStudio.disabled = false;
          btnOpenMacroStudio.innerHTML = originalHtml;
          alert('Não foi possível conectar à aba do Google FLOW.\n\nPor favor:\n1. Acesse a aba do Google FLOW\n2. Atualize a página pressionando F5\n3. Abra a extensão e clique novamente em "Abrir Studio".');
          return;
        }

        // 5. Envia comando para abrir a janela do Macro Studio e aguarda confirmação
        btnOpenMacroStudio.innerHTML = '<span>✨ Abrindo Studio...</span>';
        await new Promise((resolve) => {
          chrome.tabs.sendMessage(targetTab.id, { action: 'OPEN_MACRO_STUDIO' }, (res) => {
            if (chrome.runtime.lastError) {
              console.warn('[FLOW Popup] Aviso ao enviar OPEN_MACRO_STUDIO:', chrome.runtime.lastError.message);
            }
            resolve(res);
          });
        });

        // 6. Fecha a janelinha do popup suavemente após confirmar a entrega
        setTimeout(() => {
          window.close();
        }, 150);

      } catch (err) {
        console.error('[FLOW Popup] Erro ao abrir Macro Studio:', err);
        btnOpenMacroStudio.disabled = false;
        btnOpenMacroStudio.innerHTML = originalHtml;
        alert('Erro ao abrir Macro Studio: ' + (err.message || err));
      }
    });
  }

  /**
   * Envia uma mensagem PING com timeout para testar se o Content Script está ativo
   * @param {number} tabId - ID da aba
   * @param {number} timeoutMs - Timeout em milissegundos
   * @returns {Promise<boolean>}
   */
  function pingTab(tabId, timeoutMs = 350) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve(false);
        }
      }, timeoutMs);

      try {
        chrome.tabs.sendMessage(tabId, { action: 'PING' }, (res) => {
          if (done) return;
          clearTimeout(timer);
          done = true;
          if (chrome.runtime.lastError || !res || !res.alive) {
            resolve(false);
          } else {
            resolve(true);
          }
        });
      } catch (e) {
        if (!done) {
          clearTimeout(timer);
          done = true;
          resolve(false);
        }
      }
    });
  }

  /**
   * Garante que os scripts de conteúdo (content.js, macro_engine.js, pdf_extractor.js, content.css)
   * estejam injetados e ativos na aba informada, com handshake de validação e retentativas
   * @param {number} tabId - ID da aba do navegador
   * @returns {Promise<boolean>}
   */
  async function ensureContentScriptInjected(tabId) {
    if (!tabId) return false;

    // 1. Testa se o script já está ativo e respondendo na aba
    const alreadyAlive = await pingTab(tabId, 300);
    if (alreadyAlive) return true;

    // 2. Não está respondendo: injeta os arquivos na aba
    try {
      if (!chrome.scripting) return false;

      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content.css']
      }).catch(() => {});

      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['pdf_extractor.js', 'macro_engine.js', 'content.js']
      });

      // 3. Handshake com retentativas: aguarda o script carregar e responder ao PING
      for (let attempt = 1; attempt <= 8; attempt++) {
        await new Promise((r) => setTimeout(r, 150));
        const ready = await pingTab(tabId, 300);
        if (ready) {
          return true;
        }
      }
      return false;
    } catch (err) {
      console.warn('[FLOW Downloader] Erro ao injetar scripts de conteúdo:', err);
      return false;
    }
  }

  // ==========================================================================
  // 7. Botão "Baixar Todas da Aba Ativa"
  // ==========================================================================
  btnDownloadTab.addEventListener('click', async () => {
    if (!activeTab || !activeTab.id || !isFlowUrl(activeTab.url)) {
      alert('Abra a página do FLOW (Google Labs) para realizar downloads.');
      return;
    }

    btnDownloadTab.disabled = true;
    btnDownloadTab.style.opacity = '0.7';
    btnDownloadTab.innerHTML = `<span>Iniciando...</span>`;
    btnCancelDownloads.style.display = 'flex';

    // Garante presença dos scripts com validação
    const ready = await ensureContentScriptInjected(activeTab.id);
    if (!ready) {
      alert('Por favor, atualize a página do FLOW (pressione F5) e tente novamente.');
      btnCancelDownloads.style.display = 'none';
      btnDownloadTab.disabled = false;
      btnDownloadTab.style.opacity = '1';
      return;
    }

    // Envia o comando de download em lote para o content script da aba
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

  // ==========================================================================
  // 8. Botão "Cancelar Downloads"
  // ==========================================================================
  btnCancelDownloads.addEventListener('click', () => {
    // Notifica o Background Script para cancelar a fila de downloads
    chrome.runtime.sendMessage({ action: 'CANCEL_DOWNLOADS' }, () => {
      if (chrome.runtime.lastError) { /* ignora */ }
    });

    // Notifica também o Content Script na aba
    if (activeTab && activeTab.id) {
      chrome.tabs.sendMessage(activeTab.id, { action: 'CANCEL_DOWNLOAD_TRIGGER' }, () => {
        if (chrome.runtime.lastError) { /* ignora */ }
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

  // ==========================================================================
  // 9. Botão "Limpar Histórico"
  // ==========================================================================
  btnClearHistory.addEventListener('click', () => {
    if (confirm('Deseja redefinir o contador e o cache de imagens baixadas?')) {
      chrome.storage.local.set({ downloadedIds: [], totalDownloadedCount: 0 }, () => {
        statDownloaded.innerText = '0';
      });
      chrome.runtime.sendMessage({ action: 'CLEAR_HISTORY' }, () => {
        if (chrome.runtime.lastError) {
          // Ignora
        }
      });
    }
  });
});
