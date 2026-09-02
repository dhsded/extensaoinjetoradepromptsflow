// ============================================================================
// FLOW Downloader Pro - Service Worker (Script de Segundo Plano / Background)
// ============================================================================
// Este arquivo é o Service Worker da extensão (Manifest V3).
// Ele é responsável por:
// 1. Gerenciar as configurações salvas no armazenamento local do Chrome (chrome.storage.local).
// 2. Controlar a fila de downloads de imagens para evitar bloqueios do navegador.
// 3. Roteador de mensagens (chrome.runtime.onMessage) entre Content Script, Popup e Background.
// 4. Servir como proxy para chamadas de API de I.A (Gemini, Groq, OpenRouter) sem problemas de CORS.
// ============================================================================

// Configurações padrão iniciais da extensão
const DEFAULT_SETTINGS = {
  autoDownload: false,         // Download automático ao gerar novas imagens (true/false)
  quality: '1k',               // Resolução padrão do download ('1k', '2k', '4k', 'direct')
  downloadFolder: 'FLOW_Downloads', // Nome da subpasta dentro da pasta de downloads do usuário
  nameWithPrompt: true,        // Se verdadeiro, inclui o texto do prompt no nome do arquivo
  showOverlayButtons: true,    // Exibe botões flutuantes de download sobre cada card no FLOW
  showFloatingHud: true,       // Exibe o widget flutuante de controle do macro na tela
  downloadDelay: 400,          // Intervalo em milissegundos entre downloads em lote para evitar throttling
  totalDownloadedCount: 0,     // Contador acumulativo de downloads realizados
  downloadedIds: []            // Lista de IDs de imagens já baixadas para evitar duplicidade
};

// ============================================================================
// Evento de Instalação ou Atualização da Extensão
// ============================================================================
chrome.runtime.onInstalled.addListener(async () => {
  // Recupera todas as configurações já existentes no storage
  const existing = await chrome.storage.local.get(null);
  const toSet = {};

  // Para cada configuração padrão, define apenas se ela ainda não existir
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing[key] === undefined) {
      toSet[key] = value;
    }
  }

  // Se houver novos valores a serem gravados, salva no storage local
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }
  console.log('[FLOW Downloader] Extensão instalada/inicializada com sucesso.');
});

// ============================================================================
// Funções Utilitárias de Formatação e Sanitização de Nomes de Arquivos
// ============================================================================

/**
 * Sanitiza strings para que sejam nomes de arquivos válidos em qualquer sistema operacional (Windows, Linux, macOS)
 * @param {string} name - Nome original ou texto do prompt
 * @returns {string} - Nome limpo e seguro
 */
function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'flow_image';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') // Substitui caracteres proibidos por underscore (_)
    .replace(/\s+/g, '_')                   // Substitui múltiplos espaços por underscore
    .substring(0, 120);                     // Limita o tamanho máximo do nome para evitar erros de path longo
}

/**
 * Monta o caminho completo relativo de download incluindo a pasta de destino e extensão
 * @param {string} rawName - Nome base do arquivo
 * @param {string} folder - Pasta de destino
 * @param {string} ext - Extensão do arquivo ('png', 'jpg', 'webp')
 * @returns {string} - Caminho final formatado (ex: "FLOW_Downloads/meu_prompt.png")
 */
function formatFilename(rawName, folder, ext = 'png') {
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let cleanName = sanitizeFilename(rawName) || `flow_${dateStr}`;
  // Remove extensões duplicadas caso já venham no nome
  cleanName = cleanName.replace(/\.(png|jpg|jpeg|webp)$/i, '');
  const fileName = `${cleanName}.${ext}`;
  
  // Limpa o nome da pasta de destino
  const cleanFolder = sanitizeFilename(folder || 'FLOW_Downloads').replace(/^_+|_+$/g, '');
  return cleanFolder ? `${cleanFolder}/${fileName}` : fileName;
}

// ============================================================================
// Gerenciador da Fila de Downloads (Evita Sobrecarga no Navegador)
// ============================================================================
const downloadQueue = [];            // Fila contendo os itens pendentes para download
let isProcessingQueue = false;       // Flag indicando se a fila está sendo processada no momento
let cancelRequested = false;         // Flag que sinaliza pedido de cancelamento imediato
let currentActiveDownloadId = null;  // ID do download atualmente em execução pelo Chrome

/**
 * Processa os itens da fila de download sequencialmente respeitando o intervalo configurado
 */
async function processQueue() {
  if (isProcessingQueue || downloadQueue.length === 0) return;
  isProcessingQueue = true;
  cancelRequested = false;

  // Carrega configurações de delay do usuário
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const delay = settings.downloadDelay || 400;

  // Atualiza o estado no storage informando que o download está em andamento
  await chrome.storage.local.set({ isDownloading: true, queueRemaining: downloadQueue.length });

  // Loop sequencial enquanto houver itens na fila
  while (downloadQueue.length > 0) {
    // Se o usuário solicitou cancelamento, esvazia a fila e encerra
    if (cancelRequested) {
      downloadQueue.length = 0;
      console.log('[FLOW Downloader] Fila de downloads interrompida pelo usuário.');
      break;
    }

    // Retira o primeiro item da fila
    const item = downloadQueue.shift();
    await chrome.storage.local.set({ queueRemaining: downloadQueue.length });

    try {
      // Executa o download no Chrome
      await executeDownload(item.url, item.filename, item.id);
    } catch (err) {
      console.error('[FLOW Downloader] Erro ao baixar item da fila:', err);
    }

    // Aguarda o delay configurado entre um download e outro
    if (downloadQueue.length > 0 && !cancelRequested) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Finaliza o processamento da fila
  isProcessingQueue = false;
  currentActiveDownloadId = null;
  await chrome.storage.local.set({ isDownloading: false, queueRemaining: 0 });
}

/**
 * Dispara o download nativo do arquivo através da API chrome.downloads
 * @param {string} url - URL direta da imagem
 * @param {string} fullPath - Caminho e nome do arquivo no disco
 * @param {string} imageId - Identificador único da imagem no FLOW
 */
async function executeDownload(url, fullPath, imageId) {
  if (cancelRequested) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: url,
        filename: fullPath,
        saveAs: false,               // Salva direto sem abrir diálogo do Windows
        conflictAction: 'uniquify'   // Se arquivo já existir, adiciona (1), (2) automaticamente
      },
      async (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          console.error('[FLOW Downloader] Falha no download:', chrome.runtime.lastError);
          reject(chrome.runtime.lastError || new Error('ID de download inválido'));
          return;
        }

        currentActiveDownloadId = downloadId;

        // Se o cancelamento foi solicitado imediatamente após o disparo
        if (cancelRequested) {
          chrome.downloads.cancel(downloadId, () => {});
          resolve(downloadId);
          return;
        }

        // Atualiza estatísticas e histórico de imagens baixadas
        const data = await chrome.storage.local.get(['totalDownloadedCount', 'downloadedIds']);
        const count = (data.totalDownloadedCount || 0) + 1;
        const ids = data.downloadedIds || [];
        
        if (imageId && !ids.includes(imageId)) {
          ids.push(imageId);
          if (ids.length > 1000) ids.shift(); // Mantém no máximo 1000 IDs no histórico
        }

        await chrome.storage.local.set({
          totalDownloadedCount: count,
          downloadedIds: ids
        });

        console.log(`[FLOW Downloader] Imagem salva com sucesso: ${fullPath} (ID: ${downloadId})`);
        resolve(downloadId);
      }
    );
  });
}

// ============================================================================
// Roteador de Mensagens (Comunicação com Content Scripts e Popup)
// ============================================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        // Ação: Baixar uma única imagem
        case 'DOWNLOAD_IMAGE': {
          const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
          const fullPath = formatFilename(
            message.filename,
            message.folder || settings.downloadFolder,
            message.ext || 'png'
          );

          downloadQueue.push({
            url: message.url,
            filename: fullPath,
            id: message.id
          });
          processQueue();
          sendResponse({ success: true, queued: true, filename: fullPath });
          break;
        }

        // Ação: Baixar lote de imagens
        case 'DOWNLOAD_BATCH': {
          const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
          const folder = message.folder || settings.downloadFolder;
          
          for (const item of message.items) {
            const fullPath = formatFilename(item.filename, folder, item.ext || 'png');
            downloadQueue.push({
              url: item.url,
              filename: fullPath,
              id: item.id
            });
          }
          processQueue();
          sendResponse({ success: true, count: message.items.length });
          break;
        }

        // Ação: Obter configurações atuais
        case 'GET_SETTINGS': {
          const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
          sendResponse({ settings });
          break;
        }

        // Ação: Salvar configurações e notificar abas abertas
        case 'SAVE_SETTINGS': {
          await chrome.storage.local.set(message.settings);
          // Notifica todas as abas sobre a alteração das configurações
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (tab && tab.id) {
              chrome.tabs.sendMessage(tab.id, {
                action: 'SETTINGS_UPDATED',
                settings: message.settings
              }, () => {
                if (chrome.runtime.lastError) {
                  // Ignora abas que não contêm o content script (ex: chrome://extensions)
                }
              });
            }
          }
          sendResponse({ success: true });
          break;
        }

        // Ação: Limpar histórico de downloads
        case 'CLEAR_HISTORY': {
          await chrome.storage.local.set({ downloadedIds: [], totalDownloadedCount: 0 });
          sendResponse({ success: true });
          break;
        }

        // Ação: Verificar se uma imagem já foi baixada anteriormente
        case 'CHECK_DOWNLOADED': {
          const data = await chrome.storage.local.get(['downloadedIds']);
          const downloaded = (data.downloadedIds || []).includes(message.id);
          sendResponse({ downloaded });
          break;
        }

        // Ação: Cancelar todos os downloads da fila e o download ativo
        case 'CANCEL_DOWNLOADS': {
          cancelRequested = true;
          downloadQueue.length = 0;
          if (currentActiveDownloadId) {
            chrome.downloads.cancel(currentActiveDownloadId, () => {
              if (chrome.runtime.lastError) { /* ignora */ }
            });
            currentActiveDownloadId = null;
          }
          isProcessingQueue = false;
          await chrome.storage.local.set({ isDownloading: false, queueRemaining: 0 });

          // Notifica todas as abas sobre o cancelamento
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (tab && tab.id) {
              chrome.tabs.sendMessage(tab.id, { action: 'DOWNLOADS_CANCELLED' }, () => {
                if (chrome.runtime.lastError) { /* ignora */ }
              });
            }
          }
          sendResponse({ success: true, cancelled: true });
          break;
        }

        // Ação: Obter o estado atual da fila de download
        case 'GET_DOWNLOAD_STATE': {
          sendResponse({
            isDownloading: isProcessingQueue,
            queueRemaining: downloadQueue.length
          });
          break;
        }

        // Ação: Proxy de requisições de I.A (Gemini, Groq, OpenRouter) para evitar erros de CORS no navegador
        case 'CALL_AI_PROXY': {
          try {
            const { url, options } = message;
            const res = await fetch(url, options);
            const text = await res.text();
            let json = null;
            try {
              json = JSON.parse(text);
            } catch (e) {
              json = { rawText: text };
            }
            sendResponse({
              status: res.status,
              ok: res.ok,
              data: json
            });
          } catch (err) {
            sendResponse({
              status: 500,
              ok: false,
              error: err.message
            });
          }
          break;
        }

        default:
          sendResponse({ error: 'Ação desconhecida' });
      }
    } catch (err) {
      console.error('[FLOW Downloader] Erro no roteador de mensagens:', err);
      sendResponse({ error: err.message });
    }
  })();

  return true; // Mantém o canal de mensagens aberto para resposta assíncrona
});
