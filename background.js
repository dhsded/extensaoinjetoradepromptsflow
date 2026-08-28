// FLOW Downloader Pro - Service Worker (Background Script)

const DEFAULT_SETTINGS = {
  autoDownload: false,
  quality: '1k', // '1k', '2k', '4k', 'direct'
  downloadFolder: 'FLOW_Downloads',
  nameWithPrompt: true,
  showOverlayButtons: true,
  showFloatingHud: true,
  downloadDelay: 400,
  totalDownloadedCount: 0,
  downloadedIds: []
};

// Initialize settings on install
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);
  const toSet = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing[key] === undefined) {
      toSet[key] = value;
    }
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }
  console.log('[FLOW Downloader] Extensão instalada com sucesso.');
});

// Sanitize filename to avoid invalid OS characters
function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'flow_image';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 120);
}

// Format download filename
function formatFilename(rawName, folder, ext = 'png') {
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let cleanName = sanitizeFilename(rawName) || `flow_${dateStr}`;
  // Remove existing extension if present
  cleanName = cleanName.replace(/\.(png|jpg|jpeg|webp)$/i, '');
  const fileName = `${cleanName}.${ext}`;
  
  const cleanFolder = sanitizeFilename(folder || 'FLOW_Downloads').replace(/^_+|_+$/g, '');
  return cleanFolder ? `${cleanFolder}/${fileName}` : fileName;
}

// Download queue manager to prevent browser throttling
const downloadQueue = [];
let isProcessingQueue = false;
let cancelRequested = false;
let currentActiveDownloadId = null;

async function processQueue() {
  if (isProcessingQueue || downloadQueue.length === 0) return;
  isProcessingQueue = true;
  cancelRequested = false;

  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const delay = settings.downloadDelay || 400;

  await chrome.storage.local.set({ isDownloading: true, queueRemaining: downloadQueue.length });

  while (downloadQueue.length > 0) {
    if (cancelRequested) {
      downloadQueue.length = 0;
      console.log('[FLOW Downloader] Fila de downloads interrompida.');
      break;
    }

    const item = downloadQueue.shift();
    await chrome.storage.local.set({ queueRemaining: downloadQueue.length });

    try {
      await executeDownload(item.url, item.filename, item.id);
    } catch (err) {
      console.error('[FLOW Downloader] Erro ao baixar item da fila:', err);
    }

    if (downloadQueue.length > 0 && !cancelRequested) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  isProcessingQueue = false;
  currentActiveDownloadId = null;
  await chrome.storage.local.set({ isDownloading: false, queueRemaining: 0 });
}

async function executeDownload(url, fullPath, imageId) {
  if (cancelRequested) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: url,
        filename: fullPath,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      async (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          console.error('[FLOW Downloader] Falha no download:', chrome.runtime.lastError);
          reject(chrome.runtime.lastError || new Error('ID de download inválido'));
          return;
        }

        currentActiveDownloadId = downloadId;

        // If cancellation requested immediately after dispatch
        if (cancelRequested) {
          chrome.downloads.cancel(downloadId, () => {});
          resolve(downloadId);
          return;
        }

        // Update statistics and history
        const data = await chrome.storage.local.get(['totalDownloadedCount', 'downloadedIds']);
        const count = (data.totalDownloadedCount || 0) + 1;
        const ids = data.downloadedIds || [];
        
        if (imageId && !ids.includes(imageId)) {
          ids.push(imageId);
          if (ids.length > 1000) ids.shift();
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

// Message Router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
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

        case 'GET_SETTINGS': {
          const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
          sendResponse({ settings });
          break;
        }

        case 'SAVE_SETTINGS': {
          await chrome.storage.local.set(message.settings);
          // Broadcast update to all active tabs safely
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (tab && tab.id) {
              chrome.tabs.sendMessage(tab.id, {
                action: 'SETTINGS_UPDATED',
                settings: message.settings
              }, () => {
                if (chrome.runtime.lastError) {
                  // Safely ignore tabs that don't have the content script loaded (e.g. system tabs)
                }
              });
            }
          }
          sendResponse({ success: true });
          break;
        }

        case 'CLEAR_HISTORY': {
          await chrome.storage.local.set({ downloadedIds: [], totalDownloadedCount: 0 });
          sendResponse({ success: true });
          break;
        }

        case 'CHECK_DOWNLOADED': {
          const data = await chrome.storage.local.get(['downloadedIds']);
          const downloaded = (data.downloadedIds || []).includes(message.id);
          sendResponse({ downloaded });
          break;
        }

        case 'CANCEL_DOWNLOADS': {
          cancelRequested = true;
          downloadQueue.length = 0;
          if (currentActiveDownloadId) {
            chrome.downloads.cancel(currentActiveDownloadId, () => {
              if (chrome.runtime.lastError) { /* ignore */ }
            });
            currentActiveDownloadId = null;
          }
          isProcessingQueue = false;
          await chrome.storage.local.set({ isDownloading: false, queueRemaining: 0 });

          // Broadcast cancellation to all tabs
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (tab && tab.id) {
              chrome.tabs.sendMessage(tab.id, { action: 'DOWNLOADS_CANCELLED' }, () => {
                if (chrome.runtime.lastError) { /* ignore */ }
              });
            }
          }
          sendResponse({ success: true, cancelled: true });
          break;
        }

        case 'GET_DOWNLOAD_STATE': {
          sendResponse({
            isDownloading: isProcessingQueue,
            queueRemaining: downloadQueue.length
          });
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

  return true; // Keep message channel open for async response
});
