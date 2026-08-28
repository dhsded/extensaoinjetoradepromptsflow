/**
 * FLOW Macro Studio - Macro Automation Engine
 * Automates prompt insertion, aspect ratio, image quantity, character references, and batch generation on FLOW.
 */

class FlowMacroEngine {
  constructor() {
    this.prompts = [];
    this.carousels = [];
    this.selectedCarouselId = 'all'; // 'all' | 'carousel_1' | 'carousel_2' | etc.
    this.characters = [];
    this.currentIndex = -1;
    this.state = 'idle'; // 'idle' | 'running' | 'paused' | 'stopped'
    this.config = {
      mediaType: 'image', // 'image' | 'video'
      aspectRatio: '9:16', // '16:9' | '4:3' | '1:1' | '3:4' | '9:16'
      model: 'Nano Banana Pro',
      quantity: 4, // 1 | 2 | 3 | 4
      repeatPerPrompt: 1, // Number of times to insert/generate each prompt
      delaySeconds: 8,
      waitForCompletion: false,
      applyGlobalCharacters: true,
      reusePreviousCommand: true,
      autoCreateNewProjectPerCarousel: true,
      autoDownloadResults: false
    };
    this.listeners = new Set();
    this.timer = null;
    this.logs = [];

    this.loadState();
  }

  // =========================================================================
  // Persistence & State Management
  // =========================================================================
  async loadState() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const data = await chrome.storage.local.get(['flow_macro_prompts', 'flow_macro_carousels', 'flow_macro_characters', 'flow_macro_config', 'flow_macro_selected_carousel']);
        if (data.flow_macro_carousels && Array.isArray(data.flow_macro_carousels)) {
          this.carousels = data.flow_macro_carousels;
        }
        if (data.flow_macro_prompts && Array.isArray(data.flow_macro_prompts)) {
          this.prompts = data.flow_macro_prompts;
        }
        if (data.flow_macro_selected_carousel) {
          this.selectedCarouselId = data.flow_macro_selected_carousel;
        }
        if (data.flow_macro_characters && Array.isArray(data.flow_macro_characters)) {
          this.characters = data.flow_macro_characters;
        }
        if (data.flow_macro_config) {
          this.config = { ...this.config, ...data.flow_macro_config };
        }
      }
    } catch (e) {
      console.warn('[FLOW Macro Engine] Error loading state:', e);
    }
    this.notify();
  }

  async saveState() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({
          flow_macro_prompts: this.prompts,
          flow_macro_carousels: this.carousels,
          flow_macro_selected_carousel: this.selectedCarouselId,
          flow_macro_characters: this.characters,
          flow_macro_config: this.config
        });
      }
    } catch (e) {
      console.warn('[FLOW Macro Engine] Error saving state:', e);
    }
    this.notify();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.getState());
      } catch (e) {
        console.error('[FLOW Macro Engine] Listener error:', e);
      }
    }
  }

  getState() {
    const totalPrompts = this.prompts.length;
    const completedCount = this.prompts.filter(p => p.status === 'completed').length;
    const totalGenerations = this.prompts.reduce((acc, p) => acc + (p.enabled !== false ? (parseInt(p.repeatCount, 10) || 1) : 0), 0);
    const completedGenerations = this.prompts.reduce((acc, p) => acc + (parseInt(p.completedRepeats, 10) || 0), 0);

    return {
      state: this.state,
      currentIndex: this.currentIndex,
      totalPrompts,
      completedCount,
      totalGenerations,
      completedGenerations,
      prompts: [...this.prompts],
      characters: [...this.characters],
      config: { ...this.config },
      logs: [...this.logs]
    };
  }

  addLog(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const entry = { time, message, type, id: `log_${Date.now()}_${Math.random()}` };
    this.logs.unshift(entry);
    if (this.logs.length > 100) this.logs.pop();
    this.notify();
  }

  // =========================================================================
  // Prompt List Operations
  // =========================================================================
  setPrompts(prompts) {
    this.prompts = prompts.map((p, idx) => ({
      ...p,
      index: idx + 1,
      repeatCount: parseInt(p.repeatCount, 10) || parseInt(this.config.repeatPerPrompt, 10) || 1,
      completedRepeats: 0,
      status: p.status || 'pending',
      enabled: p.enabled !== false
    }));
    this.currentIndex = -1;
    this.addLog(`Carregados ${this.prompts.length} prompts na sequência.`, 'info');
    this.saveState();
  }

  addPrompt(item) {
    const newItem = {
      id: `prompt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      index: this.prompts.length + 1,
      title: item.title || `Prompt #${this.prompts.length + 1}`,
      fullText: item.fullText || '',
      balloonText: item.balloonText || '',
      imagePrompt: item.imagePrompt || item.fullText || '',
      repeatCount: parseInt(item.repeatCount, 10) || parseInt(this.config.repeatPerPrompt, 10) || 1,
      completedRepeats: 0,
      enabled: true,
      status: 'pending',
      characters: item.characters || []
    };
    this.prompts.push(newItem);
    this.saveState();
  }

  setGlobalRepeatCount(count) {
    const num = Math.max(1, Math.min(100, parseInt(count, 10) || 1));
    this.config.repeatPerPrompt = num;
    this.prompts.forEach(p => {
      p.repeatCount = num;
    });
    this.addLog(`Repetições globais ajustadas para: ${num}x por prompt.`, 'info');
    this.saveState();
  }

  updatePrompt(id, updates) {
    const idx = this.prompts.findIndex(p => p.id === id);
    if (idx !== -1) {
      this.prompts[idx] = { ...this.prompts[idx], ...updates };
      this.saveState();
    }
  }

  removePrompt(id) {
    this.prompts = this.prompts.filter(p => p.id !== id);
    this.prompts.forEach((p, idx) => p.index = idx + 1);
    this.saveState();
  }

  clearPrompts() {
    this.prompts = [];
    this.currentIndex = -1;
    this.state = 'idle';
    this.addLog('Fila de prompts limpa.', 'info');
    this.saveState();
  }

  resetPromptStatuses() {
    this.prompts.forEach(p => {
      p.status = 'pending';
      p.completedRepeats = 0;
      p.errorMsg = '';
    });
    this.currentIndex = -1;
    this.state = 'idle';
    this.addLog('Status dos prompts e repetições redefinidos para Pendente.', 'info');
    this.saveState();
  }

  // =========================================================================
  // Predefined Characters Operations
  // =========================================================================
  addCharacter(name, avatarUrl = '', promptTag = '') {
    const char = {
      id: `char_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: name || 'Novo Personagem',
      avatarUrl: avatarUrl || '',
      promptTag: promptTag || '',
      enabled: true
    };
    this.characters.push(char);
    this.addLog(`Personagem adicionado: ${char.name}`, 'info');
    this.saveState();
    return char;
  }

  updateCharacter(id, updates) {
    const idx = this.characters.findIndex(c => c.id === id);
    if (idx !== -1) {
      this.characters[idx] = { ...this.characters[idx], ...updates };
      this.saveState();
    }
  }

  removeCharacter(id) {
    this.characters = this.characters.filter(c => c.id !== id);
    this.saveState();
  }

  // =========================================================================
  // Configuration Settings
  // =========================================================================
  updateConfig(updates) {
    this.config = { ...this.config, ...updates };
    this.saveState();
  }

  // =========================================================================
  // Flow DOM Automation & Injection Helpers
  // =========================================================================
  
  /**
   * Finds the active prompt input field in Flow
   */
  findPromptInput() {
    // 1. Textarea with prompt/placeholder
    const textarea = document.querySelector('textarea, [role="textbox"], input[type="text"][placeholder*="prompt" i], input[type="text"][placeholder*="descrever" i]');
    if (textarea) return textarea;

    // 2. Contenteditable div
    const contentEditable = document.querySelector('[contenteditable="true"], div.ProseMirror, div[role="combobox"]');
    if (contentEditable) return contentEditable;

    // 3. Fallback: Any visible textarea on page
    const allTextareas = Array.from(document.querySelectorAll('textarea'));
    const visibleTextarea = allTextareas.find(el => el.offsetParent !== null);
    if (visibleTextarea) return visibleTextarea;

    return null;
  }

  /**
   * Injects text into a prompt field and fires realistic input events
   * Safe for Slate.js, React Rich Text, and standard Textarea
   */
  async setPromptInputValue(element, text) {
    if (!element) return false;

    try {
      element.focus();
      await new Promise(r => setTimeout(r, 60));

      if (element.tagName.toLowerCase() === 'textarea' || element.tagName.toLowerCase() === 'input') {
        // React 16+ value tracker bypass
        const prototype = Object.getPrototypeOf(element);
        const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value') ? Object.getOwnPropertyDescriptor(prototype, 'value').set : null;
        if (valueSetter) {
          valueSetter.call(element, text);
        } else {
          element.value = text;
        }

        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // ContentEditable / Slate.js Editor in Google FLOW
        element.focus();

        // 1. Select all content natively (preserves Slate.js internal range & leaves)
        try {
          document.execCommand('selectAll', false, null);
        } catch (e) { /* ignore */ }

        // 2. Native rich-text replacement
        let inserted = false;
        try {
          inserted = document.execCommand('insertText', false, text);
        } catch (err) { /* ignore */ }

        // 3. Fallback: Dispatch BeforeInput (intercepted natively by Slate.js onDOMBeforeInput)
        if (!inserted || !(element.textContent || '').includes(text.substring(0, Math.min(10, text.length)))) {
          try {
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            const beforeInput = new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertFromPaste',
              data: text,
              dataTransfer: dt
            });
            element.dispatchEvent(beforeInput);
          } catch (e) { /* ignore */ }
        }

        // 4. Fire standard input events
        element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }

      await new Promise(r => setTimeout(r, 100));
      return true;
    } catch (err) {
      console.warn('[FLOW Macro] setPromptInputValue safe warning:', err);
      return false;
    }
  }

  /**
   * Finds and clicks the submit / generate button in Flow with multi-stage traversal
   * Matches Google Flow's exact button structure:
   * <button aria-disabled="false" ...><i class="... google-symbols ...">arrow_forward</i><span>Criar</span></button>
   */
  findSubmitButton() {
    const promptInput = this.findPromptInput();

    // Strategy 1: Find by Google Symbols icon ("arrow_forward", "send", "play_arrow", "arrow_right_alt")
    const symbolElements = Array.from(document.querySelectorAll('i.google-symbols, span.google-symbols, .google-symbols, i, span')).filter(el => {
      const symText = (el.innerText || el.textContent || '').trim().toLowerCase();
      return (symText === 'arrow_forward' || symText === 'send' || symText === 'play_arrow' || symText === 'arrow_right_alt');
    });

    for (const sym of symbolElements) {
      const btn = sym.closest('button, [role="button"], div[tabindex="0"]');
      if (btn && btn.offsetParent !== null && btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled) {
        return btn;
      }
    }

    // Strategy 2: Find by Screen-reader text ("Criar", "Gerar", "Create", "Generate", "Enviar")
    const srElements = Array.from(document.querySelectorAll('span, p, div, button')).filter(el => {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      return (t === 'criar' || t === 'gerar' || t === 'create' || t === 'generate' || t === 'enviar');
    });

    for (const sr of srElements) {
      const btn = sr.tagName.toLowerCase() === 'button' ? sr : sr.closest('button, [role="button"]');
      if (btn && btn.offsetParent !== null && btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled) {
        return btn;
      }
    }

    // Strategy 3: Traverse up from promptInput to find toolbar buttons
    if (promptInput) {
      let current = promptInput.parentElement;
      for (let depth = 0; depth < 8 && current && current !== document.body; depth++) {
        const buttons = Array.from(current.querySelectorAll('button, [role="button"], div[tabindex="0"]'));
        if (buttons.length > 0) {
          for (let i = buttons.length - 1; i >= 0; i--) {
            const btn = buttons[i];
            if (btn === promptInput || btn.contains(promptInput)) continue;
            if (btn.offsetParent === null) continue;

            const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            const title = (btn.getAttribute('title') || '').toLowerCase();

            if (text.includes('agente') || text.includes('banana') || text.includes('x1') || text.includes('x2') || text.includes('x3') || text.includes('x4')) {
              continue;
            }

            const hasIcon = btn.querySelector('.google-symbols, i, svg') || text.includes('arrow_forward') || text.includes('criar') || text.includes('gerar') || text.includes('enviar') || text === '➔';
            if (hasIcon && btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled) {
              return btn;
            }
          }
        }
        current = current.parentElement;
      }
    }

    // Strategy 4: Fallback scan all visible buttons
    const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of allButtons) {
      if (btn.offsetParent === null) continue;
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;

      const fullText = (btn.innerText || btn.textContent || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const title = (btn.getAttribute('title') || '').toLowerCase();

      if (
        fullText.includes('arrow_forward') || fullText.includes('criar') || fullText.includes('gerar') ||
        fullText.includes('create') || fullText.includes('generate') ||
        aria.includes('gerar') || aria.includes('criar') || aria.includes('enviar') || aria.includes('generate') ||
        title.includes('gerar') || title.includes('criar') || title.includes('enviar')
      ) {
        return btn;
      }
    }

    return null;
  }

  /**
   * Finds all "Reutilizar comando" buttons and dropdown menu items on generation cards in FLOW
   */
  findReuseCommandButtons() {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], div, li, span'));
    const matches = [];

    for (const el of candidates) {
      if (el.offsetParent === null) continue; // Skip hidden
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      const text = (el.innerText || '').trim().toLowerCase();

      if (
        aria.includes('reutilizar') || aria.includes('reuse') ||
        title.includes('reutilizar') || title.includes('reuse') ||
        text === 'reutilizar comando' || text.includes('reutilizar comando') || text.includes('reuse prompt')
      ) {
        matches.push(el);
      }
    }

    return matches;
  }

  /**
   * Reuses the latest generation command to preserve character references & settings
   */
  async reuseLatestCommand() {
    // 1. Check if direct button or open menu item is visible
    let reuseBtns = this.findReuseCommandButtons();
    if (reuseBtns.length > 0) {
      const latestBtn = reuseBtns[reuseBtns.length - 1];
      latestBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      latestBtn.click();
      this.addLog('🔁 [Reutilizar Comando] Imagens dos personagens reaproveitadas do FLOW.', 'success');
      await new Promise(r => setTimeout(r, 450));
      return true;
    }

    // 2. Try opening the 3-dots card menu on the latest generation card
    const allMenuBtns = Array.from(document.querySelectorAll('button, [role="button"], div')).filter(el => {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      const hasSvg = el.querySelector && el.querySelector('svg');
      return (aria.includes('mais') || aria.includes('opç') || aria.includes('options') || title.includes('opç') || hasSvg) && el.offsetParent !== null;
    });

    if (allMenuBtns.length > 0) {
      const lastMenuBtn = allMenuBtns[allMenuBtns.length - 1];
      lastMenuBtn.click();
      await new Promise(r => setTimeout(r, 200));

      reuseBtns = this.findReuseCommandButtons();
      if (reuseBtns.length > 0) {
        const menuItem = reuseBtns[reuseBtns.length - 1];
        menuItem.click();
        this.addLog('🔁 [Reutilizar Comando] Item acionado no menu: personagens mantidos.', 'success');
        await new Promise(r => setTimeout(r, 450));
        return true;
      }
    }

    return false;
  }

  /**
   * Adjusts Flow Aspect Ratio and Quantity settings safely
   */
  async applyFlowSettings() {
    try {
      const targetRatio = this.config.aspectRatio; // '16:9', '4:3', '1:1', '3:4', '9:16'
      const targetQuantity = `x${this.config.quantity}`; // 'x1', 'x2', 'x3', 'x4'

      const promptInput = this.findPromptInput();
      const toolbar = promptInput ? (promptInput.closest('form, section, div') || promptInput.parentElement) : document.body;

      // 1. Ratio buttons (16:9, 4:3, 1:1, 3:4, 9:16)
      const ratioBtns = Array.from(toolbar.querySelectorAll('button, [role="button"], div[role="radio"]'));
      for (const btn of ratioBtns) {
        if (btn.offsetParent === null) continue;
        const text = (btn.innerText || '').trim();
        if (text === targetRatio || text.startsWith(targetRatio)) {
          btn.click();
          this.addLog(`Proporção ajustada para: ${targetRatio}`, 'info');
          await new Promise(r => setTimeout(r, 120));
          break;
        }
      }

      // 2. Quantity buttons (x1, x2, x3, x4)
      for (const btn of ratioBtns) {
        if (btn.offsetParent === null) continue;
        const text = (btn.innerText || '').trim();
        if (text === targetQuantity || text === `${this.config.quantity}` || text === `×${this.config.quantity}`) {
          btn.click();
          this.addLog(`Quantidade ajustada para: ${targetQuantity}`, 'info');
          await new Promise(r => setTimeout(r, 120));
          break;
        }
      }
    } catch (e) {
      console.warn('[FLOW Macro] applyFlowSettings safe warning:', e);
    }
  }

  /**
   * Helper: Convert DataURL to File object for real upload into FLOW
   */
  static dataURLtoFile(dataurl, filename = 'character_reference.png') {
    if (!dataurl || typeof dataurl !== 'string' || !dataurl.startsWith('data:')) return null;
    try {
      const arr = dataurl.split(',');
      const match = arr[0].match(/:(.*?);/);
      const mime = match ? match[1] : 'image/png';
      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      return new File([u8arr], filename, { type: mime });
    } catch (e) {
      console.warn('[FLOW Macro Engine] Error converting DataURL to File:', e);
      return null;
    }
  }

  /**
   * Attaches Character reference images into FLOW's image dropzone / upload slot
   */
  async attachCharacterImagesToFlow(characterList) {
    const charsWithImages = (characterList || this.characters).filter(c => c.enabled && c.avatarUrl && c.avatarUrl.startsWith('data:image'));
    if (charsWithImages.length === 0) return false;

    this.addLog(`🎭 Anexando ${charsWithImages.length} imagem(ns) de personagens no FLOW...`, 'info');

    // 1. Convert DataURLs to File objects
    const files = [];
    charsWithImages.forEach((c, idx) => {
      const safeName = (c.name || `char_${idx + 1}`).replace(/[^\w\d-_]/g, '_');
      const file = FlowMacroEngine.dataURLtoFile(c.avatarUrl, `char_${safeName}.png`);
      if (file) files.push(file);
    });

    if (files.length === 0) return false;

    // 2. Find target dropzone or file input in FLOW
    const promptInput = this.findPromptInput();
    const promptContainer = promptInput ? (promptInput.closest('div, form, section') || promptInput.parentElement) : document.body;

    // Method A: Native File Input
    const fileInput = promptContainer.querySelector('input[type="file"]') || document.querySelector('input[type="file"]');
    if (fileInput) {
      try {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        this.addLog(`✅ Personagens carregados via File Input do FLOW.`, 'success');
        await new Promise(r => setTimeout(r, 250));
        return true;
      } catch (err) {
        console.warn('[FLOW Macro] File input injection failed:', err);
      }
    }

    // Method B: Drag and Drop Simulation on Prompt Input
    if (promptContainer) {
      try {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));

        const dropTarget = promptInput || promptContainer;
        dropTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        dropTarget.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        this.addLog(`✅ Personagens injetados via Drag & Drop no campo do FLOW.`, 'success');
        await new Promise(r => setTimeout(r, 250));
        return true;
      } catch (err) {
        console.warn('[FLOW Macro] Drag & Drop injection failed:', err);
      }
    }

    // Method C: Clipboard Paste Simulation
    if (promptInput) {
      try {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        promptInput.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        this.addLog(`✅ Personagens enviados via Paste Event no FLOW.`, 'success');
        await new Promise(r => setTimeout(r, 250));
        return true;
      } catch (err) {
        console.warn('[FLOW Macro] Clipboard paste injection failed:', err);
      }
    }

    return false;
  }

  /**
   * Diagnoses FLOW DOM elements in real-time
   */
  diagnoseFlowDOM() {
    const promptInput = this.findPromptInput();
    const submitBtn = this.findSubmitButton();

    const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16'].map(ratio => {
      const btn = Array.from(document.querySelectorAll('button, [role="button"], div[role="radio"], span'))
        .find(el => el.innerText.trim() === ratio || el.innerText.trim().includes(ratio));
      return {
        label: ratio,
        found: !!btn,
        active: btn ? (btn.classList.contains('active') || btn.getAttribute('aria-checked') === 'true' || btn.getAttribute('aria-selected') === 'true') : false
      };
    });

    const quantities = [1, 2, 3, 4].map(q => {
      const btn = Array.from(document.querySelectorAll('button, [role="button"], div[role="radio"], span'))
        .find(el => el.innerText.trim() === `x${q}` || el.innerText.trim() === `${q}`);
      return {
        label: `x${q}`,
        found: !!btn,
        active: btn ? (btn.classList.contains('active') || btn.getAttribute('aria-checked') === 'true' || btn.getAttribute('aria-selected') === 'true') : false
      };
    });

    const fileInput = document.querySelector('input[type="file"]');
    const images = Array.from(document.querySelectorAll('img')).filter(img => (img.naturalWidth > 50 || img.width > 50) && !img.src.includes('avatar'));
    const reuseBtns = this.findReuseCommandButtons();

    return {
      promptInput: {
        found: !!promptInput,
        tag: promptInput ? promptInput.tagName.toLowerCase() : 'Não encontrado',
        selector: promptInput ? (promptInput.id ? `#${promptInput.id}` : promptInput.className || 'textarea') : 'Nenhum',
        value: promptInput ? (promptInput.value || promptInput.innerText || '').substring(0, 50) : ''
      },
      submitButton: {
        found: !!submitBtn,
        tag: submitBtn ? submitBtn.tagName.toLowerCase() : 'Não encontrado',
        disabled: submitBtn ? !!submitBtn.disabled : false,
        text: submitBtn ? (submitBtn.innerText || submitBtn.getAttribute('aria-label') || 'Ícone de Envio (➔)') : 'Nenhum'
      },
      reuseCommand: {
        found: reuseBtns.length > 0,
        count: reuseBtns.length,
        label: reuseBtns.length > 0 ? `${reuseBtns.length} botão(ões) "Reutilizar comando" detectado(s)` : 'Nenhum card detectado ainda'
      },
      aspectRatioButtons: ratios,
      quantityButtons: quantities,
      characterUploadSlot: {
        found: !!fileInput,
        type: fileInput ? 'Input File Nativo' : 'Dropzone / Container de Imagens'
      },
      detectedImagesCount: images.length
    };
  }

  /**
   * Composes full prompt text with characters tags/prefixes
   */
  composePromptText(promptItem) {
    let text = promptItem.fullText || promptItem.imagePrompt || '';

    // Append / prepend active characters
    const activeChars = this.characters.filter(c => c.enabled);
    if (activeChars.length > 0 && this.config.applyGlobalCharacters) {
      const charTags = activeChars
        .map(c => c.promptTag || c.name)
        .filter(Boolean)
        .join(', ');

      if (charTags && !text.includes(charTags)) {
        // If prompt already contains structured sections, inject into image prompt
        if (text.includes('Prompt de Imagem:')) {
          text = text.replace('Prompt de Imagem:', `Prompt de Imagem: [${charTags}],`);
        } else {
          text = `[${charTags}] ${text}`;
        }
      }
    }

    return text;
  }

  // =========================================================================
  // Automation Execution Runner (Play, Pause, Stop, Step)
  // =========================================================================
  
  async start() {
    if (this.prompts.length === 0) {
      this.addLog('Nenhum prompt disponível para executar.', 'warning');
      return;
    }

    if (this.state === 'running') return;

    this.state = 'running';
    this.addLog('▶️ Macro iniciada.', 'success');
    this.notify();

    // Start from first pending item if not resuming
    if (this.currentIndex === -1 || this.currentIndex >= this.prompts.length) {
      const firstPending = this.prompts.findIndex(p => p.enabled && p.status !== 'completed');
      this.currentIndex = firstPending !== -1 ? firstPending : 0;
    }

    this.runLoop();
  }

  pause() {
    this.state = 'paused';
    if (this.timer) clearTimeout(this.timer);
    this.addLog('⏸️ Macro pausada.', 'warning');
    this.notify();
  }

  resume() {
    if (this.state === 'paused') {
      this.start();
    }
  }

  stop() {
    this.state = 'stopped';
    if (this.timer) clearTimeout(this.timer);
    this.addLog('⏹️ Macro interrompida.', 'info');
    this.notify();
  }

  // =========================================================================
  // Multi-Carousel Batch Management & Project Switching
  // =========================================================================
  setCarousels(carousels) {
    this.carousels = carousels || [];
    this.prompts = [];
    this.carousels.forEach(c => {
      c.slides.forEach(s => this.prompts.push(s));
    });
    this.saveState();
  }

  selectCarouselFilter(filterId) {
    this.selectedCarouselId = filterId || 'all';
    this.carousels.forEach(c => {
      const match = filterId === 'all' || c.id === filterId;
      c.enabled = match;
      c.slides.forEach(s => {
        s.enabled = match;
      });
    });
    this.saveState();
  }

  /**
   * Finds the "+ Novo projeto" button in Google Flow
   */
  findNewProjectButton() {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
    for (const el of candidates) {
      if (el.offsetParent === null) continue;
      const text = (el.innerText || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();

      if (
        text.includes('novo projeto') || text.includes('new project') ||
        aria.includes('novo projeto') || aria.includes('new project') ||
        title.includes('novo projeto') || title.includes('new project')
      ) {
        return el;
      }
    }
    return null;
  }

  /**
   * Automatically starts a clean New Project for the next carousel in FLOW
   */
  async createNewFlowProject() {
    this.addLog('📁 [Novo Projeto] Preparando novo projeto no FLOW para o próximo carrossel...', 'info');

    // 1. Check if "+ Novo projeto" button is directly visible
    let newProjBtn = this.findNewProjectButton();

    if (!newProjBtn) {
      // 2. If inside a project editor, find back/home button
      const backBtns = Array.from(document.querySelectorAll('button, [role="button"], a, div')).filter(el => {
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const title = (el.getAttribute('title') || '').toLowerCase();
        const href = (el.getAttribute('href') || '').toLowerCase();
        return (aria.includes('voltar') || aria.includes('back') || aria.includes('home') || title.includes('voltar') || href.includes('/flow')) && el.offsetParent !== null;
      });

      if (backBtns.length > 0) {
        backBtns[0].click();
        await new Promise(r => setTimeout(r, 1400));
        newProjBtn = this.findNewProjectButton();
      } else {
        // Direct SPA navigation fallback
        try {
          if (window.location.pathname !== '/fx/pt/tools/flow') {
            window.location.href = 'https://labs.google/fx/pt/tools/flow';
            return true;
          }
        } catch (e) { /* ignore */ }
      }
    }

    if (newProjBtn) {
      newProjBtn.click();
      this.addLog('✨ Botão "+ Novo projeto" acionado no FLOW!', 'success');
      await new Promise(r => setTimeout(r, 1800));

      // Wait until the new project's prompt input is ready
      for (let i = 0; i < 20; i++) {
        if (this.findPromptInput()) break;
        await new Promise(r => setTimeout(r, 400));
      }
      return true;
    } else {
      this.addLog('ℹ️ Projeto pronto para inserção de prompts.', 'info');
      return false;
    }
  }

  async runSinglePrompt(id) {
    const item = this.prompts.find(p => p.id === id);
    if (!item) return;

    const prevIndex = this.currentIndex;
    this.currentIndex = this.prompts.indexOf(item);
    await this.executeSlide(item, false, item.index, 1, item.carouselTitle || 'Carrossel');
    this.currentIndex = prevIndex;
    this.notify();
  }

  async runLoop() {
    // Determine active carousels to run
    const activeCarousels = this.carousels.filter(c => c.enabled !== false);
    const carouselsToRun = activeCarousels.length > 0 ? activeCarousels : [{ id: 'carousel_1', title: 'Carrossel Principal', slides: this.prompts.filter(p => p.enabled !== false) }];

    this.addLog(`🎬 Iniciando execução em lote: ${carouselsToRun.length} carrossel(is) na fila.`, 'info');

    for (let cIdx = 0; cIdx < carouselsToRun.length; cIdx++) {
      if (this.state !== 'running') break;
      const carousel = carouselsToRun[cIdx];
      carousel.status = 'running';

      this.addLog(`\n========================================\n🌟 [Carrossel ${cIdx + 1}/${carouselsToRun.length}] Iniciando: ${carousel.title}\n========================================`, 'info');
      this.notify();

      // 1. If starting a subsequent carousel, create a clean new project in FLOW
      if (cIdx > 0 && this.config.autoCreateNewProjectPerCarousel !== false) {
        await this.createNewFlowProject();
      }

      const activeSlides = carousel.slides.filter(s => s.enabled !== false);

      for (let sIdx = 0; sIdx < activeSlides.length; sIdx++) {
        if (this.state !== 'running') break;
        const slide = activeSlides[sIdx];

        // First slide of this carousel in a new project needs initial character injection
        const isFirstSlideOfCarousel = (sIdx === 0);

        await this.executeSlide(slide, isFirstSlideOfCarousel, sIdx + 1, activeSlides.length, carousel.title);

        if (this.state !== 'running') break;

        // Delay between slides
        if (sIdx + 1 < activeSlides.length) {
          const delay = (this.config.delaySeconds || 8) * 1000;
          this.addLog(`⏳ Aguardando ${this.config.delaySeconds}s antes do próximo slide...`, 'info');
          await new Promise(resolve => {
            this.timer = setTimeout(resolve, delay);
          });
        }
      }

      carousel.status = 'completed';
      this.addLog(`✅ [Carrossel ${cIdx + 1}/${carouselsToRun.length}] Concluído com sucesso!`, 'success');
      this.saveState();

      if (cIdx + 1 < carouselsToRun.length && this.state === 'running') {
        this.addLog(`⏳ Aguardando 4s antes de abrir o próximo projeto do carrossel...`, 'info');
        await new Promise(r => setTimeout(r, 4000));
      }
    }

    if (this.state === 'running') {
      this.state = 'idle';
      this.addLog('🎉 Todos os carrosséis e slides foram gerados com sucesso!', 'success');
      this.saveState();
    }
  }

  async executeSlide(item, isFirstSlideOfCarousel, slideNum, totalSlides, carouselTitle) {
    item.status = 'running';
    const targetRepeats = Math.max(1, parseInt(item.repeatCount, 10) || parseInt(this.config.repeatPerPrompt, 10) || 1);
    const startRep = parseInt(item.completedRepeats, 10) || 0;

    for (let rep = startRep; rep < targetRepeats; rep++) {
      if (this.state !== 'running' && this.state !== 'idle') break;

      this.addLog(`🚀 [Slide ${slideNum}/${totalSlides}] ${carouselTitle} • ${item.slideTitle || item.title} (Inserção ${rep + 1}/${targetRepeats})`, 'info');
      this.notify();

      try {
        let reused = false;

        // If it's NOT the first slide of the carousel, click 'Reutilizar comando' to keep characters attached!
        if (!isFirstSlideOfCarousel && this.config.reusePreviousCommand !== false) {
          reused = await this.reuseLatestCommand();
        }

        // If it IS the first slide of a project (or reuse was not available), apply settings & attach character images
        if (!reused) {
          await this.applyFlowSettings();
          await this.attachCharacterImagesToFlow();
        }

        // Find prompt input
        const inputEl = this.findPromptInput();
        if (!inputEl) {
          throw new Error('Campo de prompt do Flow não encontrado na página.');
        }

        // Compose text and inject (replacing previous prompt text while leaving characters intact)
        const composedText = this.composePromptText(item);
        await this.setPromptInputValue(inputEl, composedText);

        // Find submit button and trigger
        await new Promise(r => setTimeout(r, 400));
        const submitBtn = this.findSubmitButton();

        if (submitBtn) {
          submitBtn.click();
          this.addLog(`✅ Inserção ${rep + 1}/${targetRepeats} enviada via Botão: ${item.slideTitle || item.title}`, 'success');
        } else {
          // Fallback: Dispatch Enter key on the input
          inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          this.addLog(`✅ Inserção ${rep + 1}/${targetRepeats} enviada via Enter: ${item.slideTitle || item.title}`, 'success');
        }

        item.completedRepeats = rep + 1;
        this.saveState();

        // If there are more repetitions for this same slide, delay between them
        if (rep + 1 < targetRepeats && (this.state === 'running' || this.state === 'idle')) {
          const delay = (this.config.delaySeconds || 8) * 1000;
          this.addLog(`⏳ Aguardando ${this.config.delaySeconds}s antes da repetição ${rep + 2}/${targetRepeats}...`, 'info');
          await new Promise(resolve => {
            this.timer = setTimeout(resolve, delay);
          });
        }
      } catch (err) {
        item.status = 'error';
        item.errorMsg = err.message || 'Erro ao executar prompt';
        this.addLog(`❌ Falha no ${item.title} (rep ${rep + 1}): ${item.errorMsg}`, 'error');
        this.saveState();
        return;
      }
    }

    if (item.completedRepeats >= targetRepeats) {
      item.status = 'completed';
      item.errorMsg = '';
      this.saveState();
    }
  }
}

// Global instance
if (typeof window !== 'undefined') {
  window.FlowMacroEngine = FlowMacroEngine;
  window.flowMacroInstance = new FlowMacroEngine();
}
