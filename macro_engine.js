// ============================================================================
// FLOW Macro Studio - Motor Principal de Automação do Google FLOW
// ============================================================================
// Este motor é o cérebro que automatiza a criação em lote de imagens no FLOW:
// - Gerencia a sequência de carrosséis e slides (prompts).
// - Executa os Passos 1 a 7 do fluxograma oficial do Google FLOW.
// - Aplica configurações de imagem (proporção 9:16/16:9, modelo, quantidade de imagens).
// - Anexa personagens de referência via upload ou biblioteca.
// - Reutiliza comandos anteriores para manter consistência de estilo/personagens.
// - Controla os intervalos de tempo (delays) entre slides e carrosséis com contador regressivo.
// - Monitora em tempo real a conclusão da geração das imagens no Canvas.
// - Inclui sistema de auto-recuperação e diagnóstico por I.A (Gemini, Groq, OpenRouter).
// ============================================================================

// Proteção contra conflitos de reconciliação do React 18 / Next.js na página do FLOW
// Evita o erro nativo do DOM: "Failed to execute 'removeChild' on 'Node'" quando a extensão injeta elementos
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
} catch (e) { /* ignora se já estiver protegido */ }

class FlowMacroEngine {
  constructor() {
    // ------------------------------------------------------------------------
    // Estruturas de Dados Principais
    // ------------------------------------------------------------------------
    this.prompts = [];                 // Lista plana de todos os slides/prompts prontos para execução
    this.carousels = [];               // Lista estruturada de carrosséis (lotes) e seus slides filhos
    this.selectedCarouselId = 'all';   // Filtro de execução: 'all' (todos) ou ID específico ('carousel_1', etc.)
    this.characters = [];              // Lista de personagens de referência (nome, avatar, enabled)
    this.aiKeysPool = [];              // Pool de chaves de I.A com rotação automática em caso de cota esgotada
    this.currentIndex = -1;            // Índice do slide atualmente em execução (-1 = nenhum)
    this.state = 'idle';               // Estado atual do motor: 'idle' | 'running' | 'paused' | 'stopped'
    
    // ------------------------------------------------------------------------
    // Controle de Tempo, Ação Atual e Contagem Regressiva
    // ------------------------------------------------------------------------
    this.startTime = 0;                // Timestamp de início da execução do macro
    this.elapsedSeconds = 0;           // Segundos totais decorridos desde o início
    this.tickerInterval = null;        // Intervalo do cronômetro (1 segundo)
    this.currentAction = '';           // Descrição textual da ação em andamento (ex: "⏳ FLOW gerando imagem...")
    this.countdown = { remaining: 0, total: 0, label: '' }; // Objeto da contagem regressiva ao vivo
    this.settingsConfiguredForProject = false; // Flag de controle: configurações do Passo 1 rodam apenas 1x por projeto
    this.lastConfiguredProjectId = null;       // ID do último projeto onde as configurações de formato foram aplicadas

    // ------------------------------------------------------------------------
    // Configurações Globais de Automação (Parâmetros que o usuário pode alterar)
    // ------------------------------------------------------------------------
    this.config = {
      mediaType: 'image',              // Tipo de mídia a ser gerada: 'image' (imagem) ou 'video' (vídeo)
      aspectRatio: '9:16',             // Proporção: '16:9' | '4:3' | '1:1' | '3:4' | '9:16'
      model: 'Nano Banana Pro',        // Modelo de I.A no FLOW
      quantity: 4,                     // Quantidade de variações geradas por prompt: 1 | 2 | 3 | 4
      repeatPerPrompt: 1,              // Número de repetições para o mesmo prompt
      delaySeconds: 15,                // Intervalo em segundos entre um slide e outro (padrão: 15s)
      carouselDelaySeconds: 25,        // Intervalo em segundos entre um carrossel e outro (padrão: 25s)
      actionDelayMs: 500,              // Micro-intervalo em milissegundos entre ações para o FLOW processar
      waitForCompletion: false,        // Aguardar conclusão explícita
      applyGlobalCharacters: true,     // Se verdadeiro, anexa os personagens de referência configurados
      reusePreviousCommand: true,      // Se verdadeiro, usa o Passo 7 (reutilizar comando anterior) nos slides 2+
      autoCreateNewProjectPerCarousel: false, // Cria novo projeto automaticamente a cada carrossel
      autoDownloadResults: false,      // Baixa as imagens automaticamente após a geração
      // Integração com Inteligência Artificial para Auto-Diagnóstico em Tempo Real
      aiProvider: 'gemini',            // Provedor de I.A: 'gemini' | 'groq' | 'openrouter'
      aiApiKey: '',                    // Chave ativa de I.A
      aiModel: 'gemini-1.5-flash',     // Modelo de I.A para análise de erros
      aiAutoHeal: true,                // Tenta corrigir erros automaticamente em tempo real
      aiAutoRotateKeys: true           // Alterna para a próxima chave quando o limite de requisições expirar
    };
    this.listeners = new Set();        // Ouvintes registrados para receber notificações de mudanças de estado
    this.timer = null;                 // Referência para timers assíncronos
    this.logs = [];                    // Histórico de logs de execução com timestamp

    // ------------------------------------------------------------------------
    // Telemetria em Tempo Real e Aprendizado Adaptativo de Seletores do FLOW
    // ------------------------------------------------------------------------
    this.learnedSelectors = {};        // Seletores aprendidos pelo gravador: { promptInput, submitButton, plusButton }
    this.telemetryEvents = [];         // Buffer circular com os últimos eventos capturados no DOM do FLOW
    this.isRecordingTelemetry = true;  // Flag que ativa a gravação contínua de cliques e teclas
    this.isInspectorActive = false;    // Modo de inspeção visual ativado/desativado
    this.telemetryFilter = 'all';      // Filtro de exibição da telemetria ('all', 'input', 'click', 'error')

    // Carrega o estado salvo e inicia o gravador de telemetria
    this.loadState();
    this.initRealtimeRecorder();
  }

  // =========================================================================
  // Persistência de Estado (Duplo Armazenamento: chrome.storage + localStorage)
  // =========================================================================
  
  /**
   * Carrega o estado anterior salvo no storage local da extensão e no localStorage
   */
  async loadState() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local) {
        const data = await chrome.storage.local.get([
          'flow_macro_prompts',
          'flow_macro_carousels',
          'flow_macro_characters',
          'flow_macro_config',
          'flow_macro_selected_carousel',
          'flow_macro_ai_keys_pool',
          'flow_macro_learned_selectors'
        ]);

        if (data.flow_macro_carousels && Array.isArray(data.flow_macro_carousels)) {
          this.carousels = data.flow_macro_carousels;
        }
        if (data.flow_macro_prompts && Array.isArray(data.flow_macro_prompts)) {
          this.prompts = data.flow_macro_prompts;
        }
        if (data.flow_macro_selected_carousel) {
          this.selectedCarouselId = data.flow_macro_selected_carousel;
        }
        if (data.flow_macro_characters && Array.isArray(data.flow_macro_characters) && data.flow_macro_characters.length > 0) {
          this.characters = data.flow_macro_characters;
        }
        if (data.flow_macro_ai_keys_pool && Array.isArray(data.flow_macro_ai_keys_pool)) {
          this.aiKeysPool = data.flow_macro_ai_keys_pool;
        }
        if (data.flow_macro_learned_selectors && typeof data.flow_macro_learned_selectors === 'object') {
          this.learnedSelectors = data.flow_macro_learned_selectors;
          delete this.learnedSelectors.newProjectButton;
        }
        if (data.flow_macro_config) {
          this.config = { ...this.config, ...data.flow_macro_config };
        }
      }
    } catch (e) {
      console.warn('[FLOW Macro] Aviso ao ler chrome.storage.local:', e);
    }

    // Fallback de Segurança: Backup no localStorage
    try {
      if ((!this.characters || this.characters.length === 0) && typeof localStorage !== 'undefined') {
        const backupChars = localStorage.getItem('flow_macro_characters_backup');
        if (backupChars) {
          const parsed = JSON.parse(backupChars);
          if (Array.isArray(parsed) && parsed.length > 0) {
            this.characters = parsed;
          }
        }
      }
      if ((!this.aiKeysPool || this.aiKeysPool.length === 0) && typeof localStorage !== 'undefined') {
        const backupKeys = localStorage.getItem('flow_macro_ai_keys_pool_backup');
        if (backupKeys) {
          const parsed = JSON.parse(backupKeys);
          if (Array.isArray(parsed) && parsed.length > 0) {
            this.aiKeysPool = parsed;
          }
        }
      }
      if ((!this.learnedSelectors || Object.keys(this.learnedSelectors).length === 0) && typeof localStorage !== 'undefined') {
        const backupSel = localStorage.getItem('flow_macro_learned_selectors_backup');
        if (backupSel) {
          const parsed = JSON.parse(backupSel);
          if (parsed && typeof parsed === 'object') {
            this.learnedSelectors = parsed;
          }
        }
      }
    } catch (e) {
      console.warn('[FLOW Macro] localStorage read fallback warning:', e);
    }

    this.notify();
  }

  scheduleSaveState() {
    if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
    this._saveStateTimer = setTimeout(() => {
      this.saveState();
    }, 500);
  }

  async saveState() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({
          flow_macro_prompts: this.prompts,
          flow_macro_carousels: this.carousels,
          flow_macro_selected_carousel: this.selectedCarouselId,
          flow_macro_characters: this.characters,
          flow_macro_ai_keys_pool: this.aiKeysPool,
          flow_macro_learned_selectors: this.learnedSelectors,
          flow_macro_config: this.config
        });
      }
    } catch (e) {
      console.warn('[FLOW Macro] chrome.storage.local save warning:', e);
    }

    // Dual Storage Fallback: Mirror essential items to localStorage
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('flow_macro_characters_backup', JSON.stringify(this.characters || []));
        localStorage.setItem('flow_macro_ai_keys_pool_backup', JSON.stringify(this.aiKeysPool || []));
        localStorage.setItem('flow_macro_learned_selectors_backup', JSON.stringify(this.learnedSelectors || {}));
        localStorage.setItem('flow_macro_config_backup', JSON.stringify(this.config || {}));
      }
    } catch (e) {
      console.warn('[FLOW Macro] localStorage save fallback warning:', e);
    }
  }

  // =========================================================================
  // Telemetria em Tempo Real, Gravador de Eventos e Aprendizado de Seletores
  // =========================================================================

  /**
   * Inicializa o gravador contínuo de eventos do DOM (Cliques do usuário e mudanças de rota)
   * Permite que a extensão aprenda automaticamente os seletores dos botões do FLOW
   */
  initRealtimeRecorder() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (this._recorderInitialized) return;
    this._recorderInitialized = true;

    // 1. Captura passiva de cliques do usuário no FLOW (para aprendizado de seletores)
    window.addEventListener('click', (e) => {
      if (!this.isRecordingTelemetry) return;
      const target = e.target;
      // Ignora cliques que ocorram dentro da própria janela da extensão (prefixo fd-)
      if (!target || (target.closest && target.closest('[id*="fd-"], [class*="fd-"]'))) return;

      const fp = this.captureElementFingerprint(target);
      this.recordTelemetry('CLICK', {
        action: 'user_click',
        tag: fp.tag,
        selector: fp.selector,
        xpath: fp.xpath,
        text: fp.text,
        aria: fp.ariaLabel || fp.title || '',
        reactProps: fp.reactPropsSummary,
        rect: fp.rect,
        url: window.location.href
      });

      // Classifica e aprende automaticamente o botão clicado caso seja um elemento do FLOW
      this.autoClassifyAndLearnElement(target, fp);
    }, true);

    // 2. Captura mudanças de URL e rotas da SPA (Single Page Application) do FLOW
    const recordNav = () => {
      if (!this.isRecordingTelemetry) return;
      this.recordTelemetry('NAVIGATION', {
        action: 'route_change',
        url: window.location.href,
        projectId: FlowMacroEngine.getCurrentProjectId() || null,
        isCanvas: FlowMacroEngine.isFlowProjectPage(),
        isCharacters: FlowMacroEngine.isFlowCharactersPage(),
        isHub: FlowMacroEngine.isFlowHubPage()
      });
    };

    window.addEventListener('popstate', recordNav);
    window.addEventListener('hashchange', recordNav);
  }

  /**
   * Registra um evento no buffer circular de telemetria (máximo 150 registros)
   * @param {string} type - Tipo do evento ('CLICK', 'NAVIGATION', 'ERROR', 'MACRO')
   * @param {Object} data - Dados adicionais do evento
   */
  recordTelemetry(type, data = {}) {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');

    const entry = {
      id: 'tel_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      timestamp: now.toISOString(),
      time: timeStr,
      type: type,
      ...data
    };

    this.telemetryEvents.unshift(entry);
    if (this.telemetryEvents.length > 150) {
      this.telemetryEvents.length = 150;
    }
  }

  /**
   * Gera um seletor CSS único e altamente preciso para qualquer elemento do DOM
   * @param {HTMLElement} el - Elemento alvo
   * @returns {string} - Caminho seletor CSS
   */
  getUniqueSelector(el) {
    if (!el || el.nodeType !== 1) return '';

    // Prioridade 1: ID próprio do elemento
    if (el.id && !el.id.startsWith('fd-') && !el.id.match(/\d{5,}/)) {
      return `#${CSS.escape(el.id)}`;
    }

    // Prioridade 2: Atributos de teste (data-testid / data-component)
    const testid = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-component');
    if (testid) {
      return `[data-testid="${CSS.escape(testid)}"]`;
    }

    // Prioridade 3: Atributo aria-label acessível
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 50) {
      return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
    }

    // Prioridade 4: Role do elemento
    const role = el.getAttribute('role');
    if (role) {
      const sameRole = document.querySelectorAll(`${el.tagName.toLowerCase()}[role="${role}"]`);
      if (sameRole.length === 1) {
        return `${el.tagName.toLowerCase()}[role="${role}"]`;
      }
    }

    // Prioridade 5: Subida hierárquica na árvore DOM (nth-of-type)
    const path = [];
    let curr = el;
    while (curr && curr.nodeType === 1 && curr.tagName !== 'BODY' && curr.tagName !== 'HTML') {
      let selector = curr.tagName.toLowerCase();
      if (curr.id && !curr.id.startsWith('fd-')) {
        selector = `#${CSS.escape(curr.id)}`;
        path.unshift(selector);
        break;
      } else {
        let siblingIndex = 1;
        let sib = curr.previousElementSibling;
        while (sib) {
          if (sib.tagName === curr.tagName) siblingIndex++;
          sib = sib.previousElementSibling;
        }
        selector += `:nth-of-type(${siblingIndex})`;
      }
      path.unshift(selector);
      curr = curr.parentElement;
    }
    return path.join(' > ');
  }

  /**
   * Calcula o caminho XPath absoluto de um elemento no DOM
   * @param {HTMLElement} el - Elemento alvo
   * @returns {string} - Expressão XPath
   */
  getElementXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && !el.id.startsWith('fd-')) return `//*[@id="${el.id}"]`;

    const parts = [];
    let curr = el;
    while (curr && curr.nodeType === 1) {
      let index = 1;
      let sib = curr.previousSibling;
      while (sib) {
        if (sib.nodeType === 1 && sib.tagName === curr.tagName) {
          index++;
        }
        sib = sib.previousSibling;
      }
      const tag = curr.tagName.toLowerCase();
      parts.unshift(`${tag}[${index}]`);
      curr = curr.parentNode;
    }
    return '/' + parts.join('/');
  }

  /**
   * Inspeciona as propriedades sintéticas e internas do React (Fiber) anexadas ao elemento DOM
   * @param {HTMLElement} el - Elemento alvo
   * @returns {Object} - Propriedades e manipuladores React encontrados
   */
  getElementReactInfo(el) {
    if (!el) return { propsKeys: [], componentName: null, handlers: [] };
    const info = { propsKeys: [], componentName: null, handlers: [] };
    try {
      const propKey = Object.keys(el).find(k => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
      if (propKey && el[propKey]) {
        const p = el[propKey];
        info.propsKeys = Object.keys(p).slice(0, 10);
        ['onClick', 'onMouseDown', 'onChange', 'onInput', 'onKeyDown', 'onSubmit'].forEach(h => {
          if (typeof p[h] === 'function') info.handlers.push(h);
        });
      }
      const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (fiberKey && el[fiberKey]) {
        let fiber = el[fiberKey];
        while (fiber) {
          if (fiber.type && typeof fiber.type === 'function' && fiber.type.name) {
            info.componentName = fiber.type.name;
            break;
          }
          fiber = fiber.return;
        }
      }
    } catch (e) { /* ignora */ }
    return info;
  }

  /**
   * Captura uma impressão digital rica (fingerprint) do elemento para identificação resiliente
   * @param {HTMLElement} el - Elemento alvo
   * @returns {Object} - Fingerprint contendo tags, classes, atributos, texto e dimensões
   */
  captureElementFingerprint(el) {
    if (!el || el.nodeType !== 1) return {};
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    const reactInfo = this.getElementReactInfo(el);

    return {
      tag: el.tagName || '',
      id: el.id || '',
      classes: (el.className || '').toString().trim(),
      ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
      title: el.getAttribute ? (el.getAttribute('title') || '') : '',
      dataTestId: el.getAttribute ? (el.getAttribute('data-testid') || '') : '',
      role: el.getAttribute ? (el.getAttribute('role') || '') : '',
      selector: this.getUniqueSelector(el),
      xpath: this.getElementXPath(el),
      text: ((el.innerText || el.textContent || '') + '').trim().replace(/\s+/g, ' ').substring(0, 60),
      reactComponentName: reactInfo.componentName,
      reactHandlers: reactInfo.handlers,
      reactPropsSummary: reactInfo.propsKeys.join(', '),
      rect: {
        x: Math.round(rect.x || 0),
        y: Math.round(rect.y || 0),
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0)
      }
    };
  }

  /**
   * Classifica automaticamente se o elemento clicado corresponde a um controle central do FLOW
   * @param {HTMLElement} el - Elemento clicado
   * @param {Object} fp - Fingerprint do elemento
   */
  autoClassifyAndLearnElement(el, fp) {
    if (!el || !fp) return;
    const lowerText = (fp.text || '').toLowerCase();
    const lowerAria = (fp.ariaLabel || '').toLowerCase();

    // 1. Campo de inserção de prompt (Passo 1)
    if (el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true' || fp.classes.includes('prompt')) {
      this.learnSelector('promptInput', el);
    }
    // 2. Botão de submissão/criação do FLOW (Passo 6)
    else if (lowerAria.includes('criar') || lowerAria.includes('gerar') || lowerAria.includes('send') || lowerText === 'arrow_forward' || lowerText.includes('gerar')) {
      this.learnSelector('submitButton', el);
    }
    // 3. Botão "+" de anexar mídia/personagens (Passo 3)
    else if ((fp.rect.y > window.innerHeight - 350) && (fp.rect.x > 150) && (lowerText === '+' || lowerText.includes('adicionar') || lowerAria.includes('adicionar') || lowerAria.includes('recurso'))) {
      this.learnSelector('plusButton', el);
    }
    // 4. Botão "Reutilizar comando" (Passo 7)
    else if (lowerAria.includes('reutilizar') || lowerText.includes('replay') || lowerText.includes('edit_note')) {
      this.learnSelector('reuseButton', el);
    }
    // 5. Botão "+ Novo projeto" no Hub inicial (somente botão real, nunca cards de projeto)
    else if (FlowMacroEngine.isFlowHubPage() && el.tagName === 'BUTTON' && !el.querySelector('img') && !el.closest('[class*="card" i]') && (lowerText.includes('add_2') || lowerText.includes('add')) && lowerText.includes('novo projeto')) {
      this.learnSelector('newProjectButton', el);
    }
  }

  /**
   * Salva o seletor aprendido na memória e persiste no storage local
   * @param {string} actionKey - Chave da ação ('promptInput', 'submitButton', 'plusButton', etc.)
   * @param {HTMLElement} el - Elemento identificado
   */
  learnSelector(actionKey, el) {
    if (!el || el.nodeType !== 1) return;
    const fp = this.captureElementFingerprint(el);
    this.learnedSelectors[actionKey] = fp;
    this.scheduleSaveState();
  }

  /**
   * Localiza um elemento na página usando os seletores previamente aprendidos
   * @param {string} actionKey - Chave da ação
   * @returns {HTMLElement|null} - Elemento encontrado ou null
   */
  resolveLearnedSelector(actionKey) {
    const fp = this.learnedSelectors[actionKey];
    if (!fp) return null;

    // Tenta primeiro o seletor CSS
    if (fp.selector) {
      try {
        const el = document.querySelector(fp.selector);
        if (el && el.offsetParent !== null && !el.closest('[id*="fd-"], [class*="fd-"]')) {
          return el;
        }
      } catch (e) { /* ignora */ }
    }

    // Fallback: Tenta XPath
    if (fp.xpath) {
      try {
        const res = document.evaluate(fp.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (res.singleNodeValue && res.singleNodeValue.offsetParent !== null && !res.singleNodeValue.closest('[id*="fd-"], [class*="fd-"]')) {
          return res.singleNodeValue;
        }
      } catch (e) { /* ignora */ }
    }

    return null;
  }

  /**
   * Exporta um relatório completo de telemetria e diagnóstico do DOM em formato JSON
   * @returns {boolean}
   */
  exportTelemetryReport() {
    try {
      const seen = new WeakSet();
      const safeReplacer = (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        if (typeof value === 'function') return undefined;
        if (typeof value === 'string' && value.length > 500000) {
          return value.substring(0, 100) + '... [TRUNCATED]';
        }
        return value;
      };

      const data = {
        title: 'FLOW Macro Studio - Relatório de Telemetria e Diagnóstico DOM',
        exportedAt: new Date().toISOString(),
        url: window.location.href,
        projectId: FlowMacroEngine.getCurrentProjectId(),
        pageType: {
          isProjectPage: FlowMacroEngine.isFlowProjectPage(),
          isCharactersPage: FlowMacroEngine.isFlowCharactersPage(),
          isHubPage: FlowMacroEngine.isFlowHubPage()
        },
        config: this.config,
        charactersCount: (this.characters || []).length,
        learnedSelectors: this.learnedSelectors,
        domDiagnostics: this.diagnoseFlowDOM(),
        recentLogs: this.logs.slice(-50),
        telemetryEvents: (this.telemetryEvents || []).slice(0, 150)
      };

      const jsonString = JSON.stringify(data, safeReplacer, 2);
      const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `flow_telemetria_diagnostico_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        try {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (e) { /* ignora */ }
      }, 1000);

      this.addLog('📥 Relatório de telemetria exportado com sucesso!', 'success');
      return true;
    } catch (e) {
      console.error('[FLOW Macro] Erro ao exportar telemetria:', e);
      this.addLog(`❌ Erro ao exportar telemetria: ${e.message}`, 'error');
      return false;
    }
  }

  /**
   * Limpa o buffer de eventos de telemetria
   */
  clearTelemetry() {
    this.telemetryEvents = [];
    this.notify();
  }

  /**
   * Redefine o mapa de seletores aprendidos
   */
  clearLearnedSelectors() {
    this.learnedSelectors = {};
    this.saveState();
    this.notify();
    this.addLog('🧹 Seletores aprendidos foram redefinidos.', 'info');
  }

  /**
   * Exporta toda a biblioteca de personagens para um arquivo JSON baixável
   * @returns {boolean}
   */
  exportCharactersToJson() {
    try {
      const jsonString = JSON.stringify(this.characters || [], null, 2);
      const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      const dlAnchorElem = document.createElement('a');
      dlAnchorElem.setAttribute("href", url);
      dlAnchorElem.setAttribute("download", `flow_personagens_backup_${new Date().toISOString().slice(0, 10)}.json`);
      document.body.appendChild(dlAnchorElem);
      dlAnchorElem.click();

      setTimeout(() => {
        try {
          document.body.removeChild(dlAnchorElem);
          URL.revokeObjectURL(url);
        } catch (e) { /* ignora */ }
      }, 1000);

      return true;
    } catch (err) {
      console.error('[FLOW Macro] Erro ao exportar personagens:', err);
      return false;
    }
  }

  /**
   * Importa uma biblioteca de personagens a partir de um JSON
   * @param {string|Array} jsonData - String JSON ou Array de personagens
   * @returns {boolean}
   */
  importCharactersFromJson(jsonData) {
    try {
      const list = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      if (!Array.isArray(list)) return false;

      // Valida itens obrigatórios
      const valid = list.filter(c => c && typeof c === 'object' && c.name);
      if (valid.length === 0) return false;

      // Mescla evitando duplicados por ID ou nome
      valid.forEach(c => {
        const existingIdx = this.characters.findIndex(item => item.id === c.id || item.name.toLowerCase() === c.name.toLowerCase());
        if (existingIdx !== -1) {
          this.characters[existingIdx] = { ...this.characters[existingIdx], ...c };
        } else {
          this.characters.push({
            id: c.id || `char_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            name: c.name,
            avatarUrl: c.avatarUrl || '',
            promptTag: c.promptTag || '',
            enabled: c.enabled !== false
          });
        }
      });

      this.saveState();
      return true;
    } catch (err) {
      console.error('[FLOW Macro] Erro ao importar personagens:', err);
      return false;
    }
  }

  // =========================================================================
  // Gerenciamento de Ouvintes (Observers) e Notificações de UI
  // =========================================================================

  /**
   * Inscreve um componente de interface para receber atualizações em tempo real do motor
   * @param {Function} listener - Callback que recebe o estado completo (getState)
   * @returns {Function} - Função de desinscrição (unsubscribe)
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Notifica todos os ouvintes inscritos sobre mudanças no estado do motor
   */
  notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.getState());
      } catch (e) {
        console.error('[FLOW Macro Engine] Erro no ouvinte de notificação:', e);
      }
    }
  }

  // =========================================================================
  // Funções Utilitárias de Tempo, Cronômetro e Delays Parametrizados
  // =========================================================================

  /**
   * Formata segundos totais no padrão HH:MM:SS ou MM:SS
   * @param {number} totalSec - Total de segundos
   * @returns {string} - String formatada (ex: "01:15" ou "01:02:40")
   */
  static formatDuration(totalSec) {
    const s = Math.max(0, parseInt(totalSec, 10) || 0);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) {
      return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  /**
   * Inicia o cronômetro ativo da macro (atualiza a cada 1 segundo)
   */
  startTicker() {
    if (this.tickerInterval) clearInterval(this.tickerInterval);
    this.tickerInterval = setInterval(() => {
      if (this.state === 'running' && this.startTime > 0) {
        this.elapsedSeconds = Math.floor((Date.now() - this.startTime) / 1000);
        this.notify();
      }
    }, 1000);
  }

  /**
   * Para o cronômetro da macro
   */
  stopTicker() {
    if (this.tickerInterval) {
      clearInterval(this.tickerInterval);
      this.tickerInterval = null;
    }
  }

  /**
   * Micro-delay de segurança entre ações atômicas dentro do FLOW
   * Permite que o DOM e os hooks do React processem as mudanças visuais
   * @param {number|null} customMs - Milissegundos customizados (opcional, padrão: actionDelayMs)
   * @param {string} actionName - Descrição da ação atual para atualizar a interface
   */
  async stepDelay(customMs = null, actionName = '') {
    const ms = customMs !== null ? customMs : (parseInt(this.config.actionDelayMs, 10) || 500);
    if (actionName) {
      this.currentAction = actionName;
      this.notify();
    }
    await new Promise(r => setTimeout(r, ms));
  }

  /**
   * Contador regressivo ao vivo em tempo real entre um slide e outro ou entre carrosséis
   * Exibe mensagens no log e na barra de progresso (ex: "⏳ Próximo Slide em 15s...")
   * @param {number} seconds - Segundos a aguardar
   * @param {string} label - Rótulo da contagem (ex: "Próximo Slide (2/5)")
   */
  async waitWithCountdown(seconds, label = 'Próxima ação') {
    const total = Math.max(1, parseInt(seconds, 10) || 1);
    this.countdown = { remaining: total, total, label };
    this.currentAction = `⏳ ${label} em ${total}s...`;
    this.notify();

    for (let rem = total; rem > 0; rem--) {
      if (this.state !== 'running') break;
      this.countdown = { remaining: rem, total, label };
      this.currentAction = `⏳ ${label} em ${rem}s...`;
      this.notify();

      // Registra no log no início, a cada 10s e nos segundos finais (5s, 3s)
      if (rem === total || rem % 10 === 0 || rem === 5 || rem === 3) {
        this.addLog(`⏳ ${label} em ${rem}s...`, 'info');
      }

      await new Promise(r => { this.timer = setTimeout(r, 1000); });
    }

    this.countdown = { remaining: 0, total: 0, label: '' };
    this.currentAction = '';
    this.notify();
  }

  /**
   * Retorna uma cópia do estado completo do motor para a interface
   * @returns {Object} - Estado consolidado
   */
  getState() {
    // Filtra apenas os slides que serão realmente executados (dos carrosséis ativos)
    let activeSlides = [];
    const activeCarousels = this.carousels.filter(c => c.enabled !== false);
    if (activeCarousels.length > 0) {
      activeCarousels.forEach(c => {
        const slides = (c.slides || []).filter(s => s.enabled !== false);
        activeSlides.push(...slides);
      });
    } else {
      activeSlides = this.prompts.filter(p => p.enabled !== false);
    }

    const totalPrompts = activeSlides.length;
    const completedCount = activeSlides.filter(p => p.status === 'completed').length;
    const totalGenerations = activeSlides.reduce((acc, p) => acc + (parseInt(p.repeatCount, 10) || 1), 0);
    const completedGenerations = activeSlides.reduce((acc, p) => acc + (parseInt(p.completedRepeats, 10) || 0), 0);

    const elapsed = this.startTime > 0 ? Math.floor((Date.now() - this.startTime) / 1000) : this.elapsedSeconds;

    return {
      state: this.state,
      currentIndex: this.currentIndex,
      startTime: this.startTime,
      elapsedSeconds: elapsed,
      elapsedFormatted: FlowMacroEngine.formatDuration(elapsed),
      currentAction: this.currentAction,
      countdown: { ...this.countdown },
      totalPrompts,
      completedCount,
      totalGenerations,
      completedGenerations,
      prompts: [...this.prompts],
      characters: [...this.characters],
      config: { ...this.config },
      logs: [...this.logs],
      carousels: [...this.carousels]
    };
  }

  /**
   * Adiciona uma mensagem ao log de execução da extensão com timestamp e tempo decorrido
   * @param {string} message - Mensagem do log
   * @param {string} type - Tipo: 'info' | 'success' | 'warning' | 'error'
   */
  addLog(message, type = 'info') {
    const now = new Date();
    const time = now.toLocaleTimeString();
    const elapsedSec = this.startTime > 0 ? Math.floor((Date.now() - this.startTime) / 1000) : this.elapsedSeconds;
    const elapsedStr = FlowMacroEngine.formatDuration(elapsedSec);
    const timeDisplay = this.startTime > 0 ? `[${time} • +${elapsedStr}]` : `[${time}]`;

    const entry = { 
      time, 
      elapsed: elapsedStr,
      timeDisplay,
      message, 
      type, 
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 6)}` 
    };
    
    this.logs.unshift(entry);
    if (this.logs.length > 150) this.logs.pop(); // Mantém no máximo 150 logs na memória
    this.notify();
  }

  // =========================================================================
  // Operações na Lista de Prompts e Slides
  // =========================================================================
  
  /**
   * Define a lista de prompts a serem executados
   * @param {Array<Object>} prompts - Lista de prompts
   */
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
  // Operações com Personagens de Referência Predefinidos
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
  // Configurações Globais
  // =========================================================================
  
  updateConfig(updates) {
    this.config = { ...this.config, ...updates };
    this.saveState();
  }

  // =========================================================================
  // Localizadores de Elementos do DOM do Google FLOW (Resilientes a Atualizações)
  // =========================================================================
  
  /**
   * Localiza o campo de prompt de texto ativo na página do FLOW (Passo 1)
   * Suporta Slate.js, ContentEditable e Textarea
   * @returns {HTMLElement|null}
   */
  findPromptInput() {
    // 0. Verifica primeiro se há um seletor aprendido pelo gravador
    const learned = this.resolveLearnedSelector('promptInput');
    if (learned && learned.offsetParent !== null && !learned.closest('[id*="fd-"], [class*="fd-"]')) {
      const inner = learned.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
      return inner || learned;
    }

    // Prioridade 1: Container exato do editor Slate.js do FLOW gravado no DevTools
    const exactSlate = document.querySelector('div.sc-5c3af813-3 [contenteditable="true"], div.sc-5c3af813-3 textarea, div.sc-5c3af813-3 > div, [data-slate-editor="true"]');
    if (exactSlate && exactSlate.offsetParent !== null && !exactSlate.closest('[id*="fd-"], [class*="fd-"]')) {
      const inner = exactSlate.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
      return inner || exactSlate;
    }

    // Prioridade 2: Textarea com placeholder de prompt
    const textarea = document.querySelector('textarea, [role="textbox"], input[type="text"][placeholder*="prompt" i], input[type="text"][placeholder*="descrever" i]');
    if (textarea) {
      return textarea;
    }

    // Prioridade 3: Div ContentEditable genérica
    const contentEditable = document.querySelector('[contenteditable="true"], div.ProseMirror, div[role="combobox"]');
    if (contentEditable) {
      return contentEditable;
    }

    // Fallback: Qualquer textarea visível na página fora da extensão
    const allTextareas = Array.from(document.querySelectorAll('textarea'));
    const visibleTextarea = allTextareas.find(el => el.offsetParent !== null && !el.closest('[id*="fd-"], [class*="fd-"]'));
    if (visibleTextarea) {
      return visibleTextarea;
    }

    return null;
  }

  /**
   * Limpa e normaliza strings de prompt para o FLOW (preserva quebras de parágrafo)
   * @param {string} text - Texto bruto do prompt
   * @returns {string} - Texto normalizado
   */
  static normalizePromptText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .split('\n')
      .map(line => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Recupera com segurança a instância interna do Slate Editor do React Fiber
   * @param {HTMLElement} element - Elemento DOM do editor
   * @returns {Object|null} - Instância do Slate Editor
   */
  getSlateEditor(element) {
    if (!element) return null;
    try {
      const fiberKey = Object.keys(element).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (fiberKey && element[fiberKey]) {
        let fiber = element[fiberKey];
        for (let i = 0; i < 20 && fiber; i++) {
          if (fiber.memoizedProps && fiber.memoizedProps.editor) {
            return fiber.memoizedProps.editor;
          }
          if (fiber.stateNode && fiber.stateNode.editor) {
            return fiber.stateNode.editor;
          }
          fiber = fiber.return;
        }
      }
      const propsKey = Object.keys(element).find(k => k.startsWith('__reactProps$'));
      if (propsKey && element[propsKey] && element[propsKey].editor) {
        return element[propsKey].editor;
      }
    } catch (e) { /* ignora */ }
    return null;
  }

  /**
   * Insere o texto no campo de prompt do FLOW de forma segura sem quebrar o Slate.js do React
   * (Passo 1 do fluxograma)
   * @param {HTMLElement} element - Campo de prompt
   * @param {string} text - Texto do prompt
   * @returns {Promise<boolean>}
   */
  async setPromptInputValue(element, text) {
    if (!element) return false;

    const cleanText = FlowMacroEngine.normalizePromptText(text);

    try {
      const targetEditable = (element.getAttribute && element.getAttribute('contenteditable') === 'true')
        ? element
        : (element.querySelector('[contenteditable="true"]') || element);

      targetEditable.focus();
      await new Promise(r => setTimeout(r, 60));

      if (targetEditable.tagName.toLowerCase() === 'textarea' || targetEditable.tagName.toLowerCase() === 'input') {
        const prototype = Object.getPrototypeOf(targetEditable);
        const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value') ? Object.getOwnPropertyDescriptor(prototype, 'value').set : null;
        if (valueSetter) {
          valueSetter.call(targetEditable, cleanText);
        } else {
          targetEditable.value = cleanText;
        }

        targetEditable.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        targetEditable.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } else {
        // Slate.js / ContentEditable no Google FLOW
        targetEditable.focus();
        await new Promise(r => setTimeout(r, 40));

        // 1. Cria seleção limpa dentro do editor Slate
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(targetEditable);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (e) { /* ignora */ }

        // 2. Atualização direta no Fiber do Slate Editor se disponível
        let fiberUpdated = false;
        try {
          const editor = this.getSlateEditor(targetEditable);
          if (editor && editor.children && Array.isArray(editor.children)) {
            for (const node of editor.children) {
              if (node && node.children && Array.isArray(node.children)) {
                for (const child of node.children) {
                  if (typeof child.text === 'string') {
                    child.text = cleanText;
                    fiberUpdated = true;
                  }
                }
              }
            }
            if (fiberUpdated && typeof editor.onChange === 'function') {
              editor.onChange();
            }
          }
        } catch (e) { /* ignora */ }

        // 3. Dispara evento nativo BeforeInput (pipeline padrão do Slate no DOM)
        const dt = new DataTransfer();
        dt.setData('text/plain', cleanText);
        dt.setData('text/html', `<div>${cleanText}</div>`);

        try {
          const beforeInput = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            composed: true,
            inputType: 'insertText',
            data: cleanText,
            dataTransfer: dt
          });
          targetEditable.dispatchEvent(beforeInput);
        } catch (e) { /* ignora */ }

        // 4. Dispatch Paste event as backup
        try {
          const pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            composed: true,
            clipboardData: dt
          });
          targetEditable.dispatchEvent(pasteEvent);
        } catch (e) { /* ignore */ }

        // 5. Fire standard input & change events
        targetEditable.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        targetEditable.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }

      await new Promise(r => setTimeout(r, 150));
      return true;
    } catch (err) {
      console.warn('[FLOW Macro] setPromptInputValue safe warning:', err);
      return false;
    }
  }

  /**
   * Limpa a lista de logs da interface
   */
  clearLogs() {
    this.logs = [];
    this.notify();
  }

  /**
   * Localiza o botão circular de envio/criação ("Criar", "arrow_forward", "→") no FLOW (Passo 6)
   * @returns {HTMLElement|null}
   */
  findSubmitButton() {
    // 0. Verifica se há um seletor aprendido previamente
    const learned = this.resolveLearnedSelector('submitButton');
    if (learned && learned.offsetParent !== null && !learned.closest('[id*="fd-"], [class*="fd-"]')) {
      return learned;
    }

    // Prioridade 1: Seletor exato gravado do botão Criar do FLOW no DevTools
    const exactSubmit = document.querySelector('div.sc-5c3af813-10 > button.sc-e8425ea6-0, div.sc-5c3af813-10 button, button[aria-label*="arrow_forward Criar" i], button[aria-label*="arrow_forward" i]');
    if (exactSubmit && exactSubmit.offsetParent !== null && !exactSubmit.closest('[id*="fd-"], [class*="fd-"]')) {
      return exactSubmit;
    }

    // Estratégia 1: Localiza botão contendo ícones Google Symbols (arrow_forward, send, play_arrow)
    const symbolElements = Array.from(document.querySelectorAll('i.google-symbols, span.google-symbols, .google-symbols, i, span')).filter(el => {
      const symText = (el.textContent || el.innerText || '').trim().toLowerCase();
      return (symText === 'arrow_forward' || symText === 'send' || symText === 'play_arrow' || symText === 'arrow_right_alt' || symText === 'arrow_forward_ios');
    });

    for (const sym of symbolElements) {
      const btn = sym.closest('button, [role="button"], div[tabindex="0"]');
      if (btn && btn.offsetParent !== null && !btn.closest('[id*="fd-"], [class*="fd-"]')) {
        return btn;
      }
    }

    // Estratégia 2: Botão contendo o texto ou aria-label "Criar", "Gerar", "Create"
    const srElements = Array.from(document.querySelectorAll('button, [role="button"]')).filter(btn => {
      if (btn.offsetParent === null || btn.closest('[id*="fd-"], [class*="fd-"]')) return false;
      const t = (btn.textContent || btn.innerText || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      return (
        t === 'criar' || t.includes('criar') || t.includes('gerar') || t.includes('create') ||
        aria.includes('criar') || aria.includes('gerar') || aria.includes('enviar') || aria.includes('create')
      );
    });

    if (srElements.length > 0) {
      return srElements[0];
    }

    // Estratégia 3: Botão de ação à direita na barra de prompt
    const promptInput = this.findPromptInput();
    if (promptInput) {
      const promptContainer = this.getPromptContainer();
      if (promptContainer) {
        const buttons = Array.from(promptContainer.querySelectorAll('button, [role="button"], div[tabindex="0"]'));
        for (let i = buttons.length - 1; i >= 0; i--) {
          const btn = buttons[i];
          if (btn.offsetParent === null || btn === promptInput || btn.contains(promptInput)) continue;
          if (btn.closest('[id*="fd-"], [class*="fd-"]')) continue;
          const text = (btn.textContent || btn.innerText || '').trim().toLowerCase();
          if (text.includes('agente') || text.includes('banana') || text.includes('x1') || text.includes('x2') || text.includes('x3') || text.includes('x4') || text === '+') {
            continue;
          }
          return btn;
        }
      }
    }

    return null;
  }

  /**
   * Dispara o envio completo e confiável do prompt no FLOW (Passo 6)
   * Usa envio duplo: clique no botão "Criar" + tecla Enter no editor Slate
   * @param {HTMLElement|null} submitBtn - Botão de submissão
   * @param {HTMLElement|null} inputEl - Campo de prompt
   * @returns {Promise<boolean>}
   */
  async simulateSubmit(submitBtn, inputEl) {
    if (!submitBtn) {
      submitBtn = this.findSubmitButton();
    }
    if (!inputEl) {
      inputEl = this.findPromptInput();
    }

    // Aguarda até 1.2s caso o botão esteja temporariamente desabilitado pelo React
    if (submitBtn) {
      for (let wait = 0; wait < 12; wait++) {
        if (submitBtn.getAttribute('aria-disabled') !== 'true' && !submitBtn.disabled) {
          break;
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }

    let triggered = false;

    if (submitBtn) {
      submitBtn.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      submitBtn.focus();

      try {
        submitBtn.removeAttribute('disabled');
        submitBtn.setAttribute('aria-disabled', 'false');
      } catch (e) { /* ignora */ }

      const rect = submitBtn.getBoundingClientRect();
      const clientX = rect.left + (rect.width > 0 ? rect.width / 2 : 10);
      const clientY = rect.top + (rect.height > 0 ? rect.height / 2 : 10);

      const eventOpts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: clientX,
        clientY: clientY,
        button: 0,
        buttons: 1
      };

      // Dispara manipuladores sintéticos do React (onClick / onMouseDown)
      try {
        const propKey = Object.keys(submitBtn).find(k => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
        if (propKey && submitBtn[propKey]) {
          if (typeof submitBtn[propKey].onClick === 'function') {
            submitBtn[propKey].onClick({ preventDefault: () => {}, stopPropagation: () => {}, target: submitBtn, currentTarget: submitBtn, nativeEvent: new MouseEvent('click', eventOpts) });
          }
          if (typeof submitBtn[propKey].onMouseDown === 'function') {
            submitBtn[propKey].onMouseDown({ preventDefault: () => {}, stopPropagation: () => {}, target: submitBtn, currentTarget: submitBtn, nativeEvent: new MouseEvent('mousedown', eventOpts) });
          }
        }
      } catch (e) { /* ignora */ }

      // Dispara sequência completa de eventos nativos: pointerdown -> mousedown -> pointerup -> mouseup -> click
      if (typeof PointerEvent !== 'undefined') {
        submitBtn.dispatchEvent(new PointerEvent('pointerdown', { ...eventOpts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      }
      submitBtn.dispatchEvent(new MouseEvent('mousedown', eventOpts));

      if (typeof PointerEvent !== 'undefined') {
        submitBtn.dispatchEvent(new PointerEvent('pointerup', { ...eventOpts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      }
      submitBtn.dispatchEvent(new MouseEvent('mouseup', eventOpts));

      try {
        submitBtn.click();
      } catch (e) { /* ignora */ }

      triggered = true;
    }

    // Disparo redundante da tecla Enter no editor Slate para garantir a submissão
    if (inputEl) {
      try {
        inputEl.focus();
        inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        inputEl.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        triggered = true;
      } catch (e) { /* ignora */ }
    }

    return triggered;
  }

  /**
   * Localiza o container global que engloba a barra de prompt e os botões inferiores no FLOW
   * @returns {HTMLElement|null}
   */
  getPromptContainer() {
    const promptInput = this.findPromptInput();
    if (!promptInput) return null;

    // 1. Procura por seletores padrão de barra inferior
    const container = promptInput.closest([
      'form',
      'footer',
      '[class*="prompt" i]',
      '[class*="composer" i]',
      '[class*="dock" i]',
      '[class*="bottom" i]',
      '[class*="toolbar" i]',
      '[class*="card" i]',
      '[class*="input" i]',
      '[data-testid*="prompt" i]',
      '[data-testid*="composer" i]',
      '[data-testid*="bottom" i]'
    ].join(', '));

    if (container && container !== document.body && !container.closest('[id*="fd-"], [class*="fd-"]')) {
      const btns = container.querySelectorAll('button, [role="button"]');
      if (btns.length >= 1) return container;
    }

    // 2. Sobe na árvore de pais procurando o container pai mais adequado
    let curr = promptInput.parentElement;
    let bestContainer = curr;
    let depth = 0;

    while (curr && curr !== document.body && depth < 10) {
      if (curr.closest && curr.closest('[id*="fd-"], [class*="fd-"]')) {
        break; // Ignora o modal da extensão
      }
      const btns = curr.querySelectorAll('button, [role="button"], div[tabindex="0"]');
      if (btns.length >= 2) {
        bestContainer = curr;
        const rect = curr.getBoundingClientRect();
        if (rect.width > 280) {
          return curr;
        }
      }
      curr = curr.parentElement;
      depth++;
    }

    return bestContainer;
  }

  /**
   * Verifica com precisão se os chips/miniaturas dos personagens já estão anexados à barra de comando
   * (Escopo estrito à barra de prompt, nunca confundindo com imagens do Canvas)
   * @returns {boolean}
   */
  hasCharacterChipsAttached() {
    const promptContainer = this.getPromptContainer();
    if (!promptContainer || promptContainer === document.body) return false;

    const activeChars = (this.characters && this.characters.length > 0)
      ? this.characters.filter(c => c.enabled !== false)
      : [];
    if (activeChars.length === 0) return true;
    const expectedCount = activeChars.length;

    // Busca apenas chips contendo imagens dentro do container do prompt
    const chips = Array.from(promptContainer.querySelectorAll([
      '[data-slate-node="element"]:has(img)',
      '[data-type*="ingredient" i]',
      '[data-type*="mention" i]',
      'div[class*="chip" i]:has(img)',
      'div[class*="pill" i]:has(img)',
      'div[class*="ingredient" i]',
      'div[class*="asset" i]:has(img)',
      'span[class*="chip" i]:has(img)',
      'span[class*="ingredient" i]'
    ].join(', '))).filter(el => {
      if (el.offsetParent === null) return false;
      if (el.closest('[id*="fd-"], [class*="fd-"]')) return false;
      // Nunca conta botões como chips
      if (el.closest('button[aria-label*="Criar" i]') || el.closest('button[aria-label*="add" i]')) return false;
      return true;
    });

    return chips.length >= expectedCount;
  }

  /**
   * Localiza o botão "+" (adicionar recursos/personagens) na barra de prompt (Passo 3)
   * @returns {HTMLElement|null}
   */
  findPlusButton() {
    // 0. Verifica seletor aprendido
    const learned = this.resolveLearnedSelector('plusButton');
    if (learned && learned.offsetParent !== null && !learned.closest('nav, aside, header, [role="navigation"], [class*="sidebar" i]')) {
      return learned;
    }

    // Prioridade 1: Botão "+" exato do FLOW gravado no DevTools
    const exactPlus = document.querySelector('div.sc-5c3af813-2 > button.sc-e8425ea6-0, div.sc-5c3af813-2 button, button[aria-label*="add_2 Criar" i], button[aria-label*="add_2" i]');
    if (exactPlus && exactPlus.offsetParent !== null && !exactPlus.closest('nav, aside, header')) {
      return exactPlus;
    }

    const promptContainer = this.getPromptContainer();
    const promptInput = this.findPromptInput();

    const isMatch = (btn) => {
      if (!btn || btn.offsetParent === null) return false;
      if (btn === promptInput || (promptInput && btn.contains(promptInput))) return false;
      if (btn.closest('[id*="fd-"], [class*="fd-"]')) return false;

      // REJEITA estritamente qualquer link ou botão de navegação da barra lateral ou cabeçalho
      if (btn.tagName === 'A' || btn.closest('a') || btn.closest('nav, aside, header, [role="navigation"], [class*="sidebar" i], [class*="navbar" i]')) {
        return false;
      }
      const href = (btn.getAttribute('href') || btn.getAttribute('data-href') || '').toLowerCase();
      if (href) return false;

      const text = (btn.textContent || btn.innerText || '').trim();
      const lowerText = text.toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const title = (btn.getAttribute('title') || '').toLowerCase();
      const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
      const testid = (btn.getAttribute('data-testid') || '').toLowerCase();

      // Evita termos de navegação de projetos
      if (
        lowerText.includes('personagens') || lowerText.includes('characters') || lowerText.includes('projetos') || lowerText.includes('projects') ||
        aria.includes('personagens') || aria.includes('characters') || aria.includes('navegar') || aria.includes('menu') || aria.includes('voltar') ||
        title.includes('personagens') || title.includes('characters') || tooltip.includes('personagens') || tooltip.includes('characters')
      ) {
        return false;
      }

      // Evita botões de configurações (Banana / Proporção)
      if (lowerText.includes('vídeo') || lowerText.includes('video') || lowerText.includes('banana') || lowerText.includes('720p') || lowerText.includes('16:9') || lowerText.includes('9:16') || lowerText.includes('1:1') || lowerText.includes('x4') || lowerText.includes('x1')) {
        return false;
      }
      if (aria.includes('arrow_forward') || lowerText.includes('arrow_forward')) {
        return false;
      }

      // Verifica ícones do Google Symbols / Material Symbols
      const symbolEl = btn.querySelector('.google-symbols, .material-symbols-outlined, i, span');
      const symText = symbolEl ? (symbolEl.textContent || symbolEl.innerText || '').trim().toLowerCase() : '';

      if (symText === 'arrow_forward' || symText === 'send' || symText === 'arrow_back' || symText === 'close') {
        return false;
      }

      const addSymbols = [
        'add', 'add_2', 'add_box', 'add_circle', 'add_photo_alternate', 'add_to_photos',
        'library_add', 'post_add', 'control_point', 'attachment', 'attach_file',
        'image', 'photo', 'collections', 'face', 'person_add', 'upload',
        'smart_toy', 'widgets', 'folder_special'
      ];

      const isSymbolMatch = addSymbols.includes(symText);

      // Verifica SVG contendo o ícone "+"
      const svg = btn.querySelector('svg');
      const hasPlusSvg = svg && (
        svg.getAttribute('aria-label') === 'Add' ||
        (svg.innerHTML && (svg.innerHTML.includes('19 13') || svg.innerHTML.includes('12 4v16') || svg.innerHTML.includes('11 11V5')))
      );

      const isTextMatch = (
        text === '+' || text.startsWith('+') || lowerText === '+ adicionar' || lowerText === '+ add' ||
        lowerText === 'adicionar' || lowerText === 'add' || lowerText === 'anexar' || lowerText === 'attach' ||
        lowerText === 'recurso' || lowerText === 'resource' || lowerText === 'ingrediente' || lowerText === 'ingredient' ||
        lowerText === 'elemento' || lowerText === 'element' || lowerText === 'mídia' || lowerText === 'media' ||
        lowerText.includes('adicionar recurso') || lowerText.includes('add asset') || lowerText.includes('add ingredient')
      );

      const isAttrMatch = (
        aria.includes('adicionar') || aria.includes('add') || aria.includes('recurso') || aria.includes('resource') ||
        aria.includes('ingrediente') || aria.includes('ingredient') || aria.includes('elemento') || aria.includes('element') ||
        aria.includes('mídia') || aria.includes('media') || aria.includes('imagem') || aria.includes('image') ||
        aria.includes('referência') || aria.includes('reference') || aria.includes('asset') || aria.includes('anexar') ||
        aria.includes('attach') || aria.includes('upload') ||
        title.includes('adicionar') || title.includes('add') || title.includes('recurso') || title.includes('ingrediente') ||
        tooltip.includes('adicionar') || tooltip.includes('add') || tooltip.includes('recurso') || tooltip.includes('ingrediente') ||
        testid.includes('add') || testid.includes('asset') || testid.includes('ingredient') || testid.includes('resource')
      );

      return isSymbolMatch || hasPlusSvg || isTextMatch || isAttrMatch;
    };

    // 1. Procura dentro do container do prompt
    const containerButtons = Array.from(promptContainer.querySelectorAll('button, [role="button"], div[tabindex="0"], div[role="button"]'));
    for (const btn of containerButtons) {
      if (isMatch(btn)) {
        return btn;
      }
    }

    // 2. Procura na região inferior da tela (últimos 35% de altura)
    if (promptInput) {
      const inputRect = promptInput.getBoundingClientRect();
      const nearbyButtons = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex="0"]')).filter(btn => {
        if (!isMatch(btn)) return false;
        const rect = btn.getBoundingClientRect();
        return rect.bottom >= window.innerHeight - 350 && rect.left > 150 && Math.abs(rect.top - inputRect.top) < 200;
      });

      if (nearbyButtons.length > 0) {
        return nearbyButtons[0];
      }
    }

    // Fallback: Primeiro botão válido no container
    if (promptInput) {
      const candidates = containerButtons.filter(b => isMatch(b) && b !== promptInput && !b.contains(promptInput));
      if (candidates.length > 0) {
        return candidates[0];
      }
    }

    return null;
  }

  /**
   * Fecha automaticamente banners de onboarding, tutoriais ou avisos que possam obstruir a tela
   */
  dismissFlowOnboardingBanners() {
    try {
      const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of candidates) {
        if (btn.offsetParent === null) continue;
        if (btn.tagName === 'A' || btn.closest('a') || btn.getAttribute('href')) continue;
        if (btn.closest('[id*="fd-"], [class*="fd-"]')) continue;

        const text = (btn.textContent || btn.innerText || '').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (
          text.includes('entendi') || text.includes('got it') || text.includes('dispensar') ||
          text.includes('fechar') || text.includes('dismiss') || aria.includes('fechar') ||
          aria.includes('close') || aria.includes('dispensar')
        ) {
          const parentText = (btn.parentElement ? (btn.parentElement.textContent || '') : '').toLowerCase();
          if (text.includes('entendi') || text.includes('got it') || parentText.includes('agente') || parentText.includes('flow')) {
            try { btn.click(); } catch (e) {}
          }
        }
      }
    } catch (e) { /* ignora */ }
  }

  /**
   * Converte uma string Base64 em um objeto File para envio ao input de arquivos
   * @param {string} base64Data - Dados em Base64
   * @param {string} filename - Nome do arquivo
   * @returns {File|null}
   */
  static base64ToFile(base64Data, filename = 'character.png') {
    try {
      const arr = base64Data.split(',');
      const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/png';
      const bstr = atob(arr[1] || arr[0]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      return new File([u8arr], filename, { type: mime });
    } catch (e) {
      return null;
    }
  }

  /**
   * Anexa imagens de personagens de referência no FLOW via modal de biblioteca/upload
   * Executa os Passos 2, 3 e 4 do fluxograma oficial:
   * - Passo 2: Clica no botão "+" na barra de prompt para anexar imagens.
   * - Passo 3: Busca na biblioteca do FLOW ou clica em "Enviar Mídia" para fazer upload.
   * - Passo 4: Seleciona o card do personagem baseado no nome, clica em "Incluir no comando" e valida o chip.
   * - Loop: Se existir mais de um personagem ativo, retorna ao Passo 2.
   * @returns {Promise<boolean>}
   */
  async attachCharactersFromFlowLibrary() {
    // 0. Garante que estamos na tela de Canvas do projeto e não em /characters
    if (FlowMacroEngine.isFlowCharactersPage()) {
      await FlowMacroEngine.ensureOnFlowCanvas();
    }

    // 0. Fecha qualquer banner de onboarding ou tutorial
    this.dismissFlowOnboardingBanners();

    // Se as imagens já estiverem anexadas à barra de comando, não precisa reenviar
    if (this.hasCharacterChipsAttached()) {
      this.addLog('ℹ️ Personagens já anexados na barra de prompt.', 'info');
      return true;
    }

    const activeChars = (this.characters && this.characters.length > 0)
      ? this.characters.filter(c => c.enabled !== false)
      : [];

    if (activeChars.length === 0) {
      return true; // Nenhum personagem configurado, avança imediatamente
    }

    this.addLog(`🎭 [Passos 2, 3 e 4] Anexando ${activeChars.length} personagem(ns) de referência no FLOW...`, 'info');

    // Itera sequencialmente sobre cada personagem ativo (Passos 2 -> 3 -> 4, retornando ao 2 se > 1)
    for (let cIdx = 0; cIdx < activeChars.length; cIdx++) {
      const char = activeChars[cIdx];
      const rawName = (char.name || char.tag || '').trim();
      const cleanName = rawName.replace(/^char_/i, '').replace(/\.(png|jpg|jpeg|webp)$/i, '').replace(/_/g, ' ').trim();
      const charNameQuery = (char.tag || cleanName || rawName).toLowerCase();
      const avatarData = char.avatarUrl || char.avatar;

      this.currentAction = `🎭 Anexando personagem: ${char.name} (${cIdx + 1}/${activeChars.length})...`;
      this.notify();

      // =========================================================================
      // RETRY LOOP: Tenta até 3 vezes o ciclo completo (Passos 2→3→4) para cada
      // personagem, garantindo que o chip seja de fato anexado à barra de prompt.
      // =========================================================================
      let chipConfirmedForChar = false;

      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          this.addLog(`🔄 [Tentativa ${attempt + 1}/3] Re-tentando anexar [${char.name}]...`, 'warning');
          // Aguarda antes de re-tentar para o FLOW estabilizar
          await new Promise(r => setTimeout(r, 1000));
        }

        // =========================================================================
        // Passo 2: Clicar no botão "+" na barra de prompt do FLOW
        // =========================================================================
        this.dismissFlowOnboardingBanners();
        const plusBtn = this.findPlusButton();
        if (!plusBtn) {
          this.addLog('⚠️ [Passo 2] Botão "+" da barra de prompt não encontrado.', 'warning');
          if (attempt < 2) continue; // Tenta novamente
          return false;
        }

        this.addLog(`➕ [Passo 2] Clicando no botão "+" para anexar [${char.name}] (${cIdx + 1}/${activeChars.length})...`, 'info');
        this.simulateClick(plusBtn);

        // Aguarda o modal de recursos abrir e estabilizar no DOM
        let dialogContainer = null;
        for (let w = 0; w < 20; w++) {
          dialogContainer = Array.from(document.querySelectorAll([
            '[role="dialog"]',
            '[role="menu"]',
            '[role="listbox"]',
            '[class*="modal" i]',
            '[class*="popover" i]',
            '[class*="picker" i]',
            '[class*="drawer" i]',
            '[class*="sheet" i]',
            '[class*="panel" i]',
            '[data-radix-popper-content-wrapper]',
            'div:has(input[placeholder*="Pesquisar" i])',
            'div:has(input[placeholder*="Search" i])',
            'div:has(input[placeholder*="Buscar" i])'
          ].join(', '))).find(el => el.offsetParent !== null && !el.closest('[id*="fd-"], [class*="fd-"]'));

          if (dialogContainer) break;
          await new Promise(r => setTimeout(r, 250));
        }

        if (!dialogContainer) {
          this.addLog('⚠️ Modal de recursos do FLOW não abriu após clicar em "+".', 'warning');
          if (attempt < 2) continue;
          return false;
        }

        await this.stepDelay(null, 'Modal aberto. Buscando personagem na biblioteca...');

        // =========================================================================
        // Passo 3: SEMPRE buscar PRIMEIRO na biblioteca do FLOW pelo nome do
        // personagem. Somente se NÃO encontrar, fazer upload via "Enviar Mídia".
        // =========================================================================

        // 3.0: Alternar para aba "Meus recursos" / "Upload" / "Enviar mídia" se existir
        const tabs = Array.from(dialogContainer.querySelectorAll('button.sc-559b4cd2-4, button, [role="tab"], div[tabindex="0"]')).filter(b => b.offsetParent !== null);
        const assetsTab = tabs.find(b => {
          const t = (b.textContent || b.innerText || '').toLowerCase();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          return aria.includes('upload') || aria.includes('enviar') || t.includes('enviar') || t.includes('meus recursos') || t.includes('my assets') || t.includes('elementos') || t.includes('ingredientes') || t.includes('uploads') || t.includes('biblioteca');
        });
        if (assetsTab && !this.isButtonSelected(assetsTab)) {
          this.simulateClick(assetsTab);
          await new Promise(r => setTimeout(r, 500));
        }

        // 3.1: BUSCAR PRIMEIRO na biblioteca pelo nome do personagem
        let foundInLibrary = false;
        const searchInput = dialogContainer.querySelector('input[placeholder*="Pesquisar" i], input[type="search"], input[placeholder*="Search" i], input[placeholder*="Buscar" i], input');
        if (searchInput && charNameQuery) {
          this.addLog(`🔍 [Passo 3] Buscando personagem "${charNameQuery}" na biblioteca do FLOW...`, 'info');
          searchInput.focus();
          // Limpa campo de busca antes de digitar
          const prototype = Object.getPrototypeOf(searchInput);
          const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value') ? Object.getOwnPropertyDescriptor(prototype, 'value').set : null;
          if (valueSetter) valueSetter.call(searchInput, charNameQuery);
          else searchInput.value = charNameQuery;
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          searchInput.dispatchEvent(new Event('change', { bubbles: true }));
          searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

          // Aguarda o FLOW filtrar a lista de resultados (tempo generoso)
          await new Promise(r => setTimeout(r, 1200));

          // Verifica se algum card com imagem apareceu nos resultados da busca
          const searchResults = Array.from(dialogContainer.querySelectorAll('button:has(img), [role="listitem"]:has(img), div[tabindex="0"]:has(img), div:has(img)')).filter(el => {
            if (el.offsetParent === null || el === dialogContainer) return false;
            if (el.closest('[id*="fd-"], [class*="fd-"]')) return false;
            // Verifica se o card contém texto/label relacionado ao personagem
            const t = (el.innerText || el.textContent || '').toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            const imgAlt = (el.querySelector('img') ? (el.querySelector('img').getAttribute('alt') || '') : '').toLowerCase();
            return (
              (charNameQuery && (t.includes(charNameQuery) || aria.includes(charNameQuery) || title.includes(charNameQuery) || imgAlt.includes(charNameQuery))) ||
              (cleanName && (t.includes(cleanName.toLowerCase()) || aria.includes(cleanName.toLowerCase()))) ||
              (rawName && (t.includes(rawName.toLowerCase()) || aria.includes(rawName.toLowerCase())))
            );
          });

          if (searchResults.length > 0) {
            foundInLibrary = true;
            this.addLog(`✅ [Passo 3] Personagem "${charNameQuery}" ENCONTRADO na biblioteca do FLOW!`, 'success');
          } else {
            this.addLog(`ℹ️ [Passo 3] Personagem "${charNameQuery}" não encontrado por nome. Verificando cards visíveis...`, 'info');
          }
        }

        // 3.2: Se NÃO encontrou na biblioteca E tiver avatar em Base64, clica em "Enviar Mídia" e faz upload
        if (!foundInLibrary && avatarData && avatarData.startsWith('data:')) {
          try {
            // Procura botão "Enviar mídia" / "Upload" dentro do modal
            const uploadBtn = Array.from(dialogContainer.querySelectorAll('button, [role="button"]')).find(b => {
              if (b.offsetParent === null) return false;
              const t = (b.textContent || b.innerText || '').toLowerCase();
              const aria = (b.getAttribute('aria-label') || '').toLowerCase();
              return t.includes('enviar mídia') || t.includes('enviar media') || t.includes('upload') || aria.includes('upload') || aria.includes('enviar');
            });
            if (uploadBtn) {
              this.simulateClick(uploadBtn);
              await new Promise(r => setTimeout(r, 500));
            }

            const fileInput = dialogContainer.querySelector('input[type="file"]') || document.querySelector('body > input[type="file"], input[type="file"]');
            if (fileInput) {
              this.addLog(`📤 [Passo 3] Enviando imagem de [${char.name}] para o FLOW via "Enviar Mídia"...`, 'info');
              const blob = await fetch(avatarData).then(r => r.blob());
              const file = new File([blob], `${char.name || 'char'}_${cIdx + 1}.jpeg`, { type: blob.type || 'image/jpeg' });
              const dt = new DataTransfer();
              dt.items.add(file);
              fileInput.files = dt.files;
              fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

              // Aguarda o FLOW processar e exibir a miniatura da imagem enviada no grid
              this.addLog('⏳ [Passo 3] Aguardando o FLOW processar e carregar a imagem na galeria...', 'info');
              for (let upWait = 0; upWait < 15; upWait++) {
                await new Promise(r => setTimeout(r, 600));
                const newCards = Array.from(dialogContainer.querySelectorAll('button:has(img), [role="listitem"]:has(img), div[tabindex="0"]:has(img)')).filter(el => el.offsetParent !== null);
                if (newCards.length > 0) {
                  this.addLog('✅ [Passo 3] Imagem carregada com sucesso na galeria do FLOW!', 'success');
                  break;
                }
              }
            }
          } catch (err) {
            console.warn('[FLOW Macro] Aviso no upload de avatar:', err);
          }
        }

        // =========================================================================
        // Passo 4: Localizar o card baseado no nome (referência básica), SELECIONAR
        //          com confirmação visual, e clicar em "Incluir no comando".
        //          Validar que o chip apareceu na barra de prompt.
        // =========================================================================

        // 4.1: Localizar o card do personagem pelo nome/tag ou primeira imagem disponível
        let targetItem = null;

        for (let sWait = 0; sWait < 12; sWait++) {
          // Busca cards que correspondam ao nome do personagem
          const resourceItems = Array.from(dialogContainer.querySelectorAll('div, li, button, [role="listitem"], [role="option"], [role="gridcell"]')).filter(el => {
            if (!FlowMacroEngine.isElementVisible(el) || el === dialogContainer) return false;
            if (el.closest('[id*="fd-"], [class*="fd-"]')) return false;
            // Precisa ter uma imagem visível (é um card de recurso, não um botão de ação)
            const hasImg = el.querySelector('img') !== null;
            if (!hasImg) return false;
            const t = (el.innerText || el.textContent || '').toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            const imgAlt = (el.querySelector('img') ? (el.querySelector('img').getAttribute('alt') || '') : '').toLowerCase();

            return (
              (charNameQuery && (t.includes(charNameQuery) || aria.includes(charNameQuery) || title.includes(charNameQuery) || imgAlt.includes(charNameQuery))) ||
              (cleanName && (t.includes(cleanName.toLowerCase()) || aria.includes(cleanName.toLowerCase()))) ||
              (rawName && (t.includes(rawName.toLowerCase()) || aria.includes(rawName.toLowerCase()))) ||
              (cIdx === 0 && (t.includes('cerebro') || t.includes('char_cerebro') || imgAlt.includes('cerebro'))) ||
              (cIdx === 1 && (t.includes('cora') || t.includes('vermelho') || t.includes('char_cora') || imgAlt.includes('cora')))
            );
          });

          if (resourceItems.length > 0) {
            targetItem = resourceItems[0];
            break;
          }

          // Fallback: cards com imagem na lista (por posição)
          const fallbackCards = Array.from(dialogContainer.querySelectorAll('button:has(img), [role="listitem"]:has(img), div[tabindex="0"]:has(img)')).filter(el => FlowMacroEngine.isElementVisible(el) && !el.closest('[id*="fd-"], [class*="fd-"]'));
          if (fallbackCards.length > cIdx) {
            targetItem = fallbackCards[cIdx];
            break;
          } else if (fallbackCards.length > 0) {
            targetItem = fallbackCards[0];
            break;
          }

          await new Promise(r => setTimeout(r, 400));
        }

        // 4.2: Clicar na imagem do card (anexo direto ao prompt confirmado pelo usuário)
        if (targetItem) {
          const clickEl = targetItem.closest('button, [role="button"], li, div[tabindex], div[role="listitem"]') || targetItem;
          const imgEl = targetItem.querySelector('img') || targetItem;

          this.addLog(`🎯 [Passo 4] Clicando na imagem de [${char.name}] no modal...`, 'info');

          // Dispara clique direto na tag <img> (aciona o anexo nativo do FLOW)
          this.simulateClick(imgEl);
          try { imgEl.click(); } catch (e) {}

          // Dispara clique também no elemento do card
          this.simulateClick(clickEl);
          try { clickEl.click(); } catch (e) {}

          // Dispara os handlers React diretamente
          [imgEl, clickEl, targetItem].filter(Boolean).forEach(el => {
            try {
              const propKey = Object.keys(el).find(k => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
              if (propKey && el[propKey] && typeof el[propKey].onClick === 'function') {
                el[propKey].onClick({ preventDefault: () => {}, stopPropagation: () => {}, target: el, currentTarget: el });
              }
            } catch (e) { /* ignora */ }
          });

          // Aguarda o FLOW processar a inclusão
          await new Promise(r => setTimeout(r, 600));
        } else {
          this.addLog(`⚠️ [Passo 4] Nenhum card de imagem encontrado para [${char.name}] no modal.`, 'warning');
          // Fecha o modal e tenta novamente no próximo attempt
          this.closeResourceModal(dialogContainer);
          continue;
        }

        // 4.3: Localizar e clicar no botão "Incluir no comando" (opcional - classes oficiais do FLOW)
        let includeBtn = null;
        for (let btnWait = 0; btnWait < 8; btnWait++) {
          // Seletor exato com as classes fornecidas pelo usuário:
          // <button class="sc-16c4830a-1 dnFqQq sc-e7a64add-0 sc-e7a64add-3 fPutAP jHjHyn sc-64c4dea-4 gecFQL">Incluir no comando</button>
          const exactInclude = document.querySelector([
            'button.gecFQL',
            'button.dnFqQq',
            'button.jHjHyn',
            'button.fPutAP',
            'button.sc-64c4dea-4',
            'button.sc-e7a64add-3',
            'div.sc-4da33547-5 button',
            'button[aria-label*="Incluir no comando" i]'
          ].join(', '));

          if (exactInclude && FlowMacroEngine.isElementVisible(exactInclude) && !exactInclude.disabled) {
            includeBtn = exactInclude;
            break;
          }

          // Busca genérica em botões visíveis
          const allButtons = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex="0"]')).filter(b => FlowMacroEngine.isElementVisible(b));

          includeBtn = allButtons.find(b => {
            const t = (b.textContent || b.innerText || '').toLowerCase().trim();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            if (t.includes('excluir') || aria.includes('excluir') || t.includes('cancelar') || aria.includes('cancelar')) return false;

            return (
              aria.includes('incluir no comando') ||
              t.includes('incluir no comando') ||
              aria.includes('incluir no prompt') ||
              t.includes('incluir no prompt') ||
              aria.includes('adicionar ao comando') ||
              t.includes('adicionar ao comando') ||
              aria.includes('include in') ||
              t.includes('include in') ||
              aria.includes('add to prompt') ||
              t.includes('add to prompt') ||
              t === 'incluir' ||
              aria === 'incluir'
            );
          });

          if (includeBtn && !includeBtn.disabled && includeBtn.getAttribute('aria-disabled') !== 'true') {
            break;
          }

          await new Promise(r => setTimeout(r, 200));
        }

        if (includeBtn) {
          this.addLog(`✨ [Passo 4] Clicando em "Incluir no comando" para [${char.name}]...`, 'info');

          const overlay = includeBtn.querySelector('[data-type="button-overlay"]') || includeBtn;
          if (overlay && overlay !== includeBtn) {
            this.simulateClick(overlay);
            try { overlay.click(); } catch(e) {}
          }

          this.simulateClick(includeBtn);
          try { includeBtn.click(); } catch(e) {}

          // Trigger React direto como redundância
          [includeBtn, overlay].forEach(el => {
            try {
              const propKey = Object.keys(el).find(k => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
              if (propKey && el[propKey] && typeof el[propKey].onClick === 'function') {
                el[propKey].onClick({
                  preventDefault: () => {},
                  stopPropagation: () => {},
                  target: el,
                  currentTarget: el
                });
              }
            } catch (e) { /* ignora */ }
          });

          await new Promise(r => setTimeout(r, 800));
        } else {
          this.addLog(`ℹ️ [Passo 4] Botão "Incluir no comando" opcional não exibido. Validando anexo direto da imagem...`, 'info');
        }

        // 4.4: VALIDAÇÃO OBRIGATÓRIA — Verifica se o chip realmente apareceu na barra de prompt
        this.addLog(`⏳ [Passo 4] Validando anexo do personagem [${char.name}] na barra de comando...`, 'info');
        let chipAttached = false;

        // Verifica por até 8 segundos se o chip do personagem apareceu
        for (let chk = 0; chk < 16; chk++) {
          // Conta chips visíveis na barra de prompt (imagens dentro do container do prompt)
          const promptContainer = this.getPromptContainer();
          if (promptContainer && promptContainer !== document.body) {
            const chips = Array.from(promptContainer.querySelectorAll([
              '[data-slate-node="element"]:has(img)',
              '[data-type*="ingredient" i]',
              '[data-type*="mention" i]',
              'div[class*="chip" i]:has(img)',
              'div[class*="pill" i]:has(img)',
              'div[class*="ingredient" i]',
              'div[class*="asset" i]:has(img)',
              'span[class*="chip" i]:has(img)',
              'span[class*="ingredient" i]',
              'img[alt*="char" i]',
              'img[alt*="cerebro" i]',
              'img[alt*="cora" i]',
              'img'
            ].join(', '))).filter(el => {
              if (!FlowMacroEngine.isElementVisible(el)) return false;
              if (el.closest('button[aria-label*="Criar" i]') || el.closest('button[aria-label*="add" i]')) return false;
              if (el.tagName === 'BUTTON') return false;
              return true;
            });
            // Sucesso se temos pelo menos (cIdx + 1) chips (o personagem atual foi adicionado)
            if (chips.length >= (cIdx + 1)) {
              chipAttached = true;
              break;
            }
          }

          // Se após algumas tentativas o chip ainda não apareceu, tenta clicar novamente na imagem
          if (chk === 3 && targetItem) {
            const imgEl = targetItem.querySelector('img') || targetItem;
            this.simulateClick(imgEl);
            try { imgEl.click(); } catch(e) {}
          }
          
          await new Promise(r => setTimeout(r, 450));
        }

        if (chipAttached) {
          this.addLog(`✅ [Passo 4 Concluído] Personagem [${char.name}] anexado com sucesso ao comando!`, 'success');
          chipConfirmedForChar = true;

          // Fecha o modal caso ainda esteja visível (via botão Fechar / X)
          this.closeResourceModal(dialogContainer);
          await new Promise(r => setTimeout(r, 400));
          break; // Sai do retry loop — este personagem foi anexado com sucesso
        } else {
          this.addLog(`⚠️ [Passo 4] Chip de [${char.name}] NÃO detectado na barra de prompt. Tentativa ${attempt + 1}/3.`, 'warning');

          // Fecha o modal antes de re-tentar
          this.closeResourceModal(dialogContainer);
          await new Promise(r => setTimeout(r, 400));
        }
      } // fim do retry loop (3 tentativas)

      // Se após 3 tentativas o chip não foi confirmado, INTERROMPE com erro claro
      if (!chipConfirmedForChar) {
        this.addLog(`❌ [ERRO CRÍTICO] Não foi possível anexar o personagem [${char.name}] após 3 tentativas. O macro NÃO prosseguirá sem os personagens de referência.`, 'error');
        this.stop();
        return false;
      }

      await new Promise(r => setTimeout(r, 600));
    }

    if (FlowMacroEngine.isFlowCharactersPage()) {
      await FlowMacroEngine.ensureOnFlowCanvas();
    }

    return true;
  }

  /**
   * Fecha o modal de recursos do FLOW de forma segura (botão Fechar / X, nunca Escape)
   * @param {HTMLElement} dialogContainer - Container do modal
   */
  closeResourceModal(dialogContainer) {
    try {
      if (!dialogContainer) {
        dialogContainer = document.querySelector('[role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="panel" i]');
      }
      if (!dialogContainer) return;

      // 1. Tenta fechar pelo botão Fechar / Close dentro do modal
      const closeBtn = dialogContainer.querySelector
        ? dialogContainer.querySelector('button[aria-label*="fechar" i], button[aria-label*="close" i], button[aria-label*="dismiss" i], button.sc-close, [data-testid*="close" i]')
        : null;

      if (closeBtn && FlowMacroEngine.isElementVisible(closeBtn)) {
        this.simulateClick(closeBtn);
        return;
      }

      // 2. Busca botão de fechar genérico em todo o modal
      const allCloseButtons = Array.from(dialogContainer.querySelectorAll('button, [role="button"], div[tabindex="0"]')).filter(b => {
        if (!FlowMacroEngine.isElementVisible(b)) return false;
        const t = (b.textContent || b.innerText || '').trim().toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        return t === 'close' || t === 'fechar' || t === '✕' || t === '×' || t === 'x' ||
               aria.includes('fechar') || aria.includes('close') || aria.includes('dismiss');
      });

      if (allCloseButtons.length > 0) {
        this.simulateClick(allCloseButtons[0]);
        return;
      }

      // 3. Clica fora do modal (no backdrop/overlay)
      const backdrop = document.querySelector('[class*="backdrop" i], [class*="overlay" i], [class*="scrim" i]');
      if (backdrop && FlowMacroEngine.isElementVisible(backdrop)) {
        backdrop.click();
        return;
      }

      // 4. Se nada funcionar, usa Escape como último recurso absoluto
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    } catch (e) { /* ignora */ }
  }

  /**
   * Monitora e aguarda a conclusão da geração da imagem no Canvas do FLOW
   * Detecta spinners, classes de loading e mudança no estado do botão de envio
   * @param {number} maxWaitSeconds - Tempo máximo de espera em segundos (padrão: 45s)
   * @returns {Promise<boolean>}
   */
  async waitForGenerationToComplete(maxWaitSeconds = 45) {
    this.addLog('⏳ [FLOW] Aguardando geração da imagem ser concluída no Canvas...', 'info');
    const startTime = Date.now();
    const maxMs = maxWaitSeconds * 1000;

    // Período de carência inicial para o React registrar o início da geração
    await new Promise(r => setTimeout(r, 2000));

    while (Date.now() - startTime < maxMs) {
      if (this.state !== 'running' && this.state !== 'idle') break;

      // 1. Verifica se o botão de envio está em estado de loading/desabilitado
      const submitBtn = this.findSubmitButton();
      const isSubmitLoading = submitBtn && (
        submitBtn.getAttribute('aria-disabled') === 'true' ||
        submitBtn.disabled ||
        submitBtn.querySelector('[class*="spinner" i], [class*="loading" i], [class*="progress" i]')
      );

      // 2. Verifica cards com indicadores de progresso/carregamento no Canvas
      const loadingCards = Array.from(document.querySelectorAll([
        '[class*="loading" i]',
        '[class*="spinner" i]',
        '[class*="progress" i]',
        '[class*="shimmer" i]',
        '[class*="skeleton" i]',
        'div[aria-label*="gerando" i]',
        'div[aria-label*="generating" i]',
        'div[aria-label*="criando" i]'
      ].join(', '))).filter(el => {
        if (el.closest('[id*="fd-"], [class*="fd-"]')) return false;
        return el.offsetParent !== null;
      });

      // Verifica textos nos cards indicando "Gerando..." ou "Criando..."
      const textNodes = Array.from(document.querySelectorAll('span, div, p')).filter(el => {
        if (el.closest('[id*="fd-"], [class*="fd-"]')) return false;
        if (el.offsetParent === null) return false;
        const t = (el.textContent || el.innerText || '').trim().toLowerCase();
        return t === 'gerando...' || t === 'criando...' || t === 'generating...' || t.startsWith('gerando') || t.startsWith('criando');
      });

      const isStillGenerating = isSubmitLoading || loadingCards.length > 0 || textNodes.length > 0;

      // Se a geração terminou e já se passaram mais de 4 segundos
      if (!isStillGenerating && (Date.now() - startTime > 4000)) {
        this.addLog('✨ [FLOW] Imagem gerada e carregada no Canvas com sucesso!', 'success');
        return true;
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      this.currentAction = `⏳ FLOW gerando imagem (${elapsed}s)...`;
      this.notify();

      await new Promise(r => setTimeout(r, 1000));
    }

    this.addLog('⏱️ Tempo de espera de geração concluído.', 'info');
    return true;
  }

  /**
   * Localiza todos os botões de "Reutilizar comando" nos cards gerados no Canvas do FLOW
   * @returns {Array<HTMLElement>}
   */
  findReuseCommandButtons() {
    // Seletor exato gravado no DevTools do FLOW para o botão de reutilização no card
    const directMatches = Array.from(document.querySelectorAll([
      '[data-testid="virtuoso-item-list"] div.sc-784d6f75-5 button',
      'div.sc-784d6f75-5 button',
      'div.sc-452db337-2 button',
      '[data-testid="virtuoso-item-list"] button:has(i)',
      '[data-testid="virtuoso-item-list"] button:has(svg)'
    ].join(', '))).filter(el => el.offsetParent !== null && !el.closest('[id*="fd-"], [class*="fd-"]') && FlowMacroEngine.isSafeToClick(el));

    if (directMatches.length > 0) {
      return directMatches;
    }

    const candidates = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex="0"], a, i, span')).filter(el => {
      if (el.offsetParent === null) return false;
      if (el.closest('[id*="fd-"], [class*="fd-"]')) return false;
      return true;
    });

    const matches = [];

    for (const el of candidates) {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      const tooltip = (el.getAttribute('data-tooltip') || '').toLowerCase();
      const testid = (el.getAttribute('data-testid') || '').toLowerCase();
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();

      const isReuseIcon = [
        'undo', 'reply', 'rotate_left', 'replay', 'arrow_back', 'cached', 'refresh',
        'history_toggle_drop_down', 'edit', 'edit_note', 'content_copy', 'auto_fix_high',
        'published_with_changes', 'prompt', 'cycle', 'swap_horiz', 'restore', 'repeat',
        'subdirectory_arrow_left', 'restart_alt', 'redo', '↩', '↪', '🔄'
      ].includes(text);

      const isReuseText = (
        aria.includes('reutilizar') || aria.includes('reuse') || aria.includes('usar como') ||
        aria.includes('use as') || aria.includes('editar comando') || aria.includes('edit prompt') ||
        title.includes('reutilizar') || title.includes('reuse') || title.includes('usar como') ||
        tooltip.includes('reutilizar') || tooltip.includes('reuse') || tooltip.includes('usar como') ||
        testid.includes('reuse') || testid.includes('prompt-reuse') ||
        text.includes('reutilizar comando') || text.includes('reuse prompt') || text.includes('reutilizar') || text.includes('reuse')
      );

      if (isReuseIcon || isReuseText) {
        const btn = el.tagName.toLowerCase() === 'button' ? el : (el.closest('button, [role="button"], div[tabindex="0"]') || el);
        if (!matches.includes(btn) && FlowMacroEngine.isSafeToClick(btn)) {
          matches.push(btn);
        }
      }
    }

    return matches;
  }

  /**
   * Reutiliza o comando da imagem gerada anteriormente no Canvas (Passo 7 do fluxograma)
   * Permite preservar os personagens e configurações sem precisar reanexar do zero
   * @returns {Promise<boolean>}
   */
  async reuseLatestCommand() {
    this.addLog('🔁 [Passo 7] Localizando card gerado para reutilizar comando anterior...', 'info');

    // 1. Tenta localizar diretamente o botão de reutilizar visível
    let reuseBtns = this.findReuseCommandButtons();

    // 2. Se não encontrar direto, foca e clica no último card gerado no Canvas para abrir a barra de ações
    if (reuseBtns.length === 0) {
      const generatedCards = Array.from(document.querySelectorAll([
        '[data-testid="virtuoso-item-list"] > div',
        'div.sc-784d6f75-0',
        'div.sc-784d6f75-1',
        'div.sc-784d6f75-5',
        'div[class*="generation" i]',
        'div[class*="card" i]:has(img)',
        'img[src*="googleusercontent"]'
      ].join(', '))).filter(el => el.offsetParent !== null && !el.closest('[id*="fd-"], [class*="fd-"]'));

      if (generatedCards.length > 0) {
        const latestCard = generatedCards[generatedCards.length - 1];
        try {
          latestCard.scrollIntoView({ behavior: 'instant', block: 'center' });
          latestCard.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          latestCard.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          latestCard.click();
          await new Promise(r => setTimeout(r, 600));
        } catch (e) { /* ignora */ }
      }

      reuseBtns = this.findReuseCommandButtons();
    }

    if (reuseBtns.length > 0) {
      const latestBtn = reuseBtns[reuseBtns.length - 1];
      this.simulateClick(latestBtn);
      this.addLog('🔁 [Passo 7 - Reutilizar Comando] Personagens e configurações reaproveitados do FLOW.', 'success');
      await new Promise(r => setTimeout(r, 800));
      return true;
    }

    // Se os personagens já estiverem anexados no prompt, considera sucesso
    if (this.hasCharacterChipsAttached()) {
      this.addLog('🔁 [Passo 7 - Reaproveitamento] Personagens já ativos no comando.', 'info');
      return true;
    }

    return false;
  }

  /**
   * Dispara uma sequência completa e realista de eventos de mouse, ponteiro e foco em um elemento
   * @param {HTMLElement} element - Elemento a ser clicado
   * @returns {boolean}
   */
  simulateClick(element) {
    if (!element) return false;
    try {
      element.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      element.focus();

      const rect = element.getBoundingClientRect();
      const clientX = rect.left + (rect.width > 0 ? rect.width / 2 : 10);
      const clientY = rect.top + (rect.height > 0 ? rect.height / 2 : 10);

      const eventOpts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX,
        clientY,
        button: 0,
        buttons: 1
      };

      // Dispara: pointerdown -> mousedown -> pointerup -> mouseup -> click
      if (typeof PointerEvent !== 'undefined') {
        element.dispatchEvent(new PointerEvent('pointerdown', { ...eventOpts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      }
      element.dispatchEvent(new MouseEvent('mousedown', eventOpts));

      if (typeof PointerEvent !== 'undefined') {
        element.dispatchEvent(new PointerEvent('pointerup', { ...eventOpts, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      }
      element.dispatchEvent(new MouseEvent('mouseup', eventOpts));

      try { element.click(); } catch (e) {}
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Helper para verificar se um botão/pílula de opção está ativo/selecionado no FLOW
   * @param {HTMLElement} btn - Botão a testar
   * @returns {boolean}
   */
  isButtonSelected(btn) {
    if (!btn) return false;
    if (btn.getAttribute('aria-selected') === 'true' || btn.getAttribute('aria-checked') === 'true') return true;
    if (btn.getAttribute('data-state') === 'active' || btn.getAttribute('data-state') === 'on') return true;
    if (btn.classList.contains('active') || btn.classList.contains('selected') || btn.classList.contains('checked')) return true;

    // Checa brilho da cor de fundo (botão selecionado tem fundo branco/cinza claro no modo escuro do FLOW)
    try {
      const style = window.getComputedStyle(btn);
      const bg = style.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        const rgb = bg.match(/\d+/g);
        if (rgb && rgb.length >= 3) {
          const brightness = (parseInt(rgb[0]) * 299 + parseInt(rgb[1]) * 587 + parseInt(rgb[2]) * 114) / 1000;
          if (brightness > 45) return true;
        }
      }
    } catch (e) { /* ignora */ }
    return false;
  }

  /**
   * Fecha de forma garantida o popover de configurações (Nano Banana) no FLOW
   * @param {HTMLElement} settingsTrigger - Pílula que abriu o popover
   * @param {HTMLElement} popover - Container do popover aberto
   */
  async closeSettingsPopover(settingsTrigger, popover) {
    // 1. Envia eventos da tecla Escape para window e document
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));

    // 2. Clica novamente no gatilho para alternar estado
    if (settingsTrigger) {
      try {
        settingsTrigger.click();
      } catch (e) {}
    }

    // 3. Foca e clica de volta no campo de prompt
    const promptInput = this.findPromptInput();
    if (promptInput) {
      try {
        promptInput.focus();
        promptInput.click();
      } catch (e) {}
    }

    // 4. Aguarda confirmação do fechamento do popover
    for (let w = 0; w < 10; w++) {
      await new Promise(r => setTimeout(r, 150));
      const stillOpen = document.querySelector('[role="dialog"], [role="menu"], [class*="popover" i], [data-radix-popper-content-wrapper]');
      if (!stillOpen || stillOpen.offsetParent === null) {
        break;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    }

    await new Promise(r => setTimeout(r, 200));
  }

  /**
   * Verifica se o projeto atual já teve seu formato e configurações de imagem validados no 1º slide.
   * REGRA DE OURO: A verificação de formato de imagem acontece EXCLUSIVAMENTE no 1º slide de cada projeto!
   * @returns {boolean}
   */
  isCurrentProjectConfigured() {
    const currentProjectId = FlowMacroEngine.getCurrentProjectId();
    if (!this.settingsConfiguredForProject) {
      return false;
    }
    // Se mudou de projeto na URL, precisa reconfigurar no 1º slide do novo projeto
    if (currentProjectId && this.lastConfiguredProjectId && currentProjectId !== this.lastConfiguredProjectId) {
      this.settingsConfiguredForProject = false;
      this.lastConfiguredProjectId = null;
      return false;
    }
    return true;
  }

  /**
   * Ajusta as configurações do FLOW (Passo 1 do fluxograma oficial):
   * Abre o menu "Nano Banana", define Proporção, Modo Imagem e Quantidade, e fecha a janela.
   * REGRA DE OURO: Executa EXCLUSIVAMENTE no 1º slide de cada projeto!
   * @returns {Promise<boolean>}
   */
  async applyFlowSettings() {
    const currentProjectId = FlowMacroEngine.getCurrentProjectId();

    // Se as configurações já foram feitas para este projeto, pula imediatamente!
    if (this.isCurrentProjectConfigured()) {
      this.addLog('⏩ [Passo 1] Formato de imagem já configurado para este projeto (executado exclusivamente no 1º slide).', 'info');
      return true;
    }

    try {
      this.dismissFlowOnboardingBanners();

      const targetRatio = this.config.aspectRatio || '16:9';
      const targetQuantity = `x${this.config.quantity || 4}`;

      const promptInput = this.findPromptInput();
      const promptContainer = this.getPromptContainer();

      if (!promptContainer) return true;

      // 1. Localiza a pílula de gatilho das configurações na barra inferior (ex: "🍌 Nano Banana Pro ...")
      const candidateTriggers = Array.from(promptContainer.querySelectorAll('button, [role="button"], div[tabindex="0"], div[class*="pill" i], div[class*="setting" i], span, div')).filter(el => !el.closest('[id*="fd-"], [class*="fd-"]'));
      let settingsTrigger = null;

      for (const el of candidateTriggers) {
        if (el.offsetParent === null) continue;
        const t = (el.textContent || el.innerText || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (
          (t.includes('vídeo') || t.includes('video') || t.includes('imagem') || t.includes('image') || t.includes('banana') || aria.includes('banana') || aria.includes('vídeo')) &&
          (t.includes('720p') || t.includes('360p') || t.includes('16:9') || t.includes('9:16') || t.includes('1:1') || t.includes('4:3') || t.includes('3:4') || t.includes('x4') || t.includes('x1') || t.includes('x2') || t.includes('x3') || t.includes('·') || aria.includes('x4') || aria.includes('crop_'))
        ) {
          settingsTrigger = el.closest('button, [role="button"], div[tabindex="0"]') || el;
          break;
        }
      }

      if (!settingsTrigger) {
        settingsTrigger = candidateTriggers.find(el => {
          const t = (el.textContent || el.innerText || '').trim().toLowerCase();
          return t.includes('vídeo') || t.includes('video') || t.includes('banana') || t.includes('720p') || t.includes('16:9') || t.includes('9:16') || t.includes('1:1');
        });
      }

      // 1.1 Caminho Rápido: Se a pílula já mostra exatamente as configurações desejadas, não precisa abrir o popover
      if (settingsTrigger) {
        const pillText = (settingsTrigger.textContent || settingsTrigger.innerText || '').toLowerCase();
        const pillAria = (settingsTrigger.getAttribute('aria-label') || '').toLowerCase();
        const isVideo = pillText.includes('vídeo') || pillText.includes('video') || pillAria.includes('vídeo') || pillAria.includes('video');
        const hasQty = pillText.includes(targetQuantity.toLowerCase()) || pillAria.includes(targetQuantity.toLowerCase());
        
        const ratioAliases = {
          '1:1': ['1:1', 'crop_square', 'square'],
          '9:16': ['9:16', 'crop_9_16', 'portrait'],
          '16:9': ['16:9', 'crop_16_9', 'landscape'],
          '3:4': ['3:4', 'crop_portrait', '3_4'],
          '4:3': ['4:3', 'crop_landscape', '4_3']
        };
        const aliases = ratioAliases[targetRatio] || [targetRatio];
        const hasRatio = aliases.some(a => pillText.includes(a) || pillAria.includes(a));

        if (!isVideo && hasQty && hasRatio) {
          this.addLog(`✨ [Passo 1] Configurações já ativas no FLOW: Imagem | ${targetRatio} | ${targetQuantity}`, 'success');
          this.settingsConfiguredForProject = true;
          this.lastConfiguredProjectId = currentProjectId || FlowMacroEngine.getCurrentProjectId();
          return true;
        }
      }

      if (settingsTrigger) {
        this.addLog('⚙️ [Passo 1] Abrindo painel de configurações (Nano Banana)...', 'info');
        this.simulateClick(settingsTrigger);
        await new Promise(r => setTimeout(r, 500));
      }

      // 2. Localiza o popover de opções aberto
      let popover = document.querySelector('[role="dialog"], [role="menu"], [class*="popover" i], [class*="menu" i], [data-radix-popper-content-wrapper]');
      if (!popover) {
        for (let w = 0; w < 8; w++) {
          await new Promise(r => setTimeout(r, 150));
          popover = document.querySelector('[role="dialog"], [role="menu"], [class*="popover" i], [class*="menu" i], [data-radix-popper-content-wrapper]');
          if (popover && popover.offsetParent !== null) break;
        }
      }

      if (popover && popover.offsetParent !== null) {
        const searchRoot = popover;
        const allButtons = Array.from(searchRoot.querySelectorAll('button, [role="button"], div[role="radio"], div[tabindex="0"]')).filter(b => b.offsetParent !== null && FlowMacroEngine.isSafeToClick(b));

        // 3. Seção 1: Garantir modo "Imagem" (nunca Vídeo)
        const exactImageBtn = searchRoot.querySelector('button[id*="-trigger-IMAGE"], [aria-label*="Imagem" i], [aria-label*="image" i]');
        const imageBtn = exactImageBtn || allButtons.find(b => {
          const t = (b.textContent || b.innerText || '').trim().toLowerCase();
          return (t === 'imagem' || t === 'image' || t.includes('imagem')) && !t.includes('vídeo') && !t.includes('video') && !t.includes('elemento');
        });

        if (imageBtn && !this.isButtonSelected(imageBtn)) {
          this.addLog('⚙️ [Passo 1] Alterando para modo "Imagem"...', 'info');
          this.simulateClick(imageBtn);
          await new Promise(r => setTimeout(r, 300));
        }

        // 4. Seção 2: Ajustar Proporção da Imagem (16:9, 9:16, 1:1, 3:4, 4:3)
        const ratioSelectorMap = {
          '1:1': 'button[id*="-trigger-SQUARE"], [aria-label*="1:1"], [aria-label*="crop_square"]',
          '9:16': 'button[id*="-trigger-PORTRAIT"], [aria-label*="9:16"], [aria-label*="crop_9_16"]',
          '16:9': 'button[id*="-trigger-LANDSCAPE"], [aria-label*="16:9"], [aria-label*="crop_16_9"]',
          '3:4': 'button[id*="-trigger-PORTRAIT_3_4"], [aria-label*="3:4"], [aria-label*="crop_portrait"]',
          '4:3': 'button[id*="-trigger-LANDSCAPE_4_3"], [aria-label*="4:3"], [aria-label*="crop_landscape"]'
        };

        const exactRatioBtn = ratioSelectorMap[targetRatio] ? searchRoot.querySelector(ratioSelectorMap[targetRatio]) : null;
        const targetRatioBtn = exactRatioBtn || allButtons.find(b => {
          const t = (b.textContent || b.innerText || '').trim();
          return t === targetRatio || t.includes(targetRatio);
        });

        if (targetRatioBtn && !this.isButtonSelected(targetRatioBtn)) {
          this.addLog(`⚙️ [Passo 1] Ajustando proporção para ${targetRatio}...`, 'info');
          this.simulateClick(targetRatioBtn);
          await new Promise(r => setTimeout(r, 300));
        }

        // 5. Seção 3: Ajustar Quantidade de Imagens (x1, x2, x3, x4)
        const qtySelectorMap = {
          'x1': 'button[id*="-trigger-1"], [aria-label="x1"]',
          'x2': 'button[id*="-trigger-2"], [aria-label="x2"]',
          'x3': 'button[id*="-trigger-3"], [aria-label="x3"]',
          'x4': 'button[id*="-trigger-4"], [aria-label="x4"]'
        };

        const exactQtyBtn = qtySelectorMap[targetQuantity.toLowerCase()] ? searchRoot.querySelector(qtySelectorMap[targetQuantity.toLowerCase()]) : null;
        const targetQtyBtn = exactQtyBtn || allButtons.find(b => {
          const t = (b.textContent || b.innerText || '').trim().toLowerCase();
          return t === targetQuantity.toLowerCase() || t === `${this.config.quantity}` || t === `×${this.config.quantity}`;
        });

        if (targetQtyBtn && !this.isButtonSelected(targetQtyBtn)) {
          this.addLog(`⚙️ [Passo 1] Ajustando quantidade para ${targetQuantity}...`, 'info');
          this.simulateClick(targetQtyBtn);
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // 6. Passo 1: Clicar novamente em Nano Banana e fechar a janela de configurações
      this.addLog('🔒 [Passo 1] Fechando janela de configurações do FLOW...', 'info');
      await this.closeSettingsPopover(settingsTrigger, popover);

      this.settingsConfiguredForProject = true;
      this.lastConfiguredProjectId = currentProjectId || FlowMacroEngine.getCurrentProjectId();
      this.addLog(`✨ [Passo 1 Concluído] Modo: Imagem | Proporção: ${targetRatio} | Quantidade: ${targetQuantity}`, 'success');
      return true;
    } catch (e) {
      console.warn('[FLOW Macro] applyFlowSettings warning:', e);
      this.settingsConfiguredForProject = true;
      this.lastConfiguredProjectId = currentProjectId || FlowMacroEngine.getCurrentProjectId();
      return false;
    }
  }

  // =========================================================================
  // Diagnóstico do DOM em Tempo Real e Espião FLOW
  // =========================================================================

  /**
   * Realiza uma varredura completa no DOM do FLOW e retorna um relatório estruturado
   * Identifica campo de prompt, botão de envio, botão +, chips de personagens e proporções
   * @returns {Object} - Relatório do estado do DOM
   */
  diagnoseFlowDOM() {
    const promptInput = this.findPromptInput();
    const submitBtn = this.findSubmitButton();
    const plusBtn = this.findPlusButton();
    const hasChips = this.hasCharacterChipsAttached();

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
      plusButton: {
        found: !!plusBtn,
        tag: plusBtn ? plusBtn.tagName.toLowerCase() : 'Não encontrado',
        text: plusBtn ? (plusBtn.getAttribute('aria-label') || plusBtn.innerText || 'Botão "+" / Adicionar') : 'Não detectado'
      },
      attachedChips: {
        found: hasChips,
        label: hasChips ? 'Personagens/Chips anexados detectados' : 'Nenhum chip anexado no momento'
      },
      reuseCommand: {
        found: reuseBtns.length > 0,
        count: reuseBtns.length,
        label: reuseBtns.length > 0 ? `${reuseBtns.length} botão(ões) "Reutilizar comando" detectado(s)` : 'Nenhum card detectado ainda'
      },
      aspectRatioButtons: ratios,
      quantityButtons: quantities,
      characterUploadSlot: {
        found: !!fileInput || !!plusBtn,
        type: fileInput ? 'Input File Nativo' : (plusBtn ? 'Botão "+" da Biblioteca FLOW' : 'Dropzone / Container de Imagens')
      },
      detectedImagesCount: images.length
    };
  }

  // =========================================================================
  // Pool de Chaves de IA e Sistema Multi-Provedor com Rotação Automática
  // =========================================================================

  /**
   * Adiciona uma nova chave de API de IA ao pool gerenciado
   * @param {string} keyString - Texto da chave de API
   * @param {string} providerHint - Provedor sugerido (gemini | groq | openrouter)
   * @param {string} modelHint - Modelo específico
   * @param {string} labelHint - Rótulo para identificação
   * @returns {Object|null}
   */
  addAIKey(keyString, providerHint = '', modelHint = '', labelHint = '') {
    if (!keyString || typeof keyString !== 'string') return null;
    const parsed = FlowPdfExtractor.parseAIKeysFromText(keyString);
    if (parsed.length === 0) return null;

    const newKey = parsed[0];
    if (providerHint) newKey.provider = providerHint;
    if (modelHint) newKey.model = modelHint;
    if (labelHint) newKey.label = labelHint;

    const existingIdx = this.aiKeysPool.findIndex(k => k.key === newKey.key);
    if (existingIdx !== -1) {
      this.aiKeysPool[existingIdx] = { ...this.aiKeysPool[existingIdx], ...newKey, status: 'active' };
    } else {
      this.aiKeysPool.push(newKey);
    }

    this.saveState();
    this.notify();
    return newKey;
  }

  /**
   * Importa múltiplas chaves de IA de uma lista
   * @param {Array<Object>} keysList - Lista de objetos de chave
   * @returns {number} - Quantidade de chaves adicionadas
   */
  importAIKeys(keysList) {
    if (!Array.isArray(keysList)) return 0;
    let addedCount = 0;
    keysList.forEach(k => {
      if (!k.key) return;
      const existing = this.aiKeysPool.find(item => item.key === k.key);
      if (!existing) {
        this.aiKeysPool.push(k);
        addedCount++;
      } else {
        existing.status = 'active';
      }
    });

    this.saveState();
    this.notify();
    return addedCount;
  }

  removeAIKey(id) {
    this.aiKeysPool = this.aiKeysPool.filter(k => k.id !== id);
    this.saveState();
    this.notify();
  }

  toggleAIKey(id) {
    const item = this.aiKeysPool.find(k => k.id === id);
    if (item) {
      item.enabled = !item.enabled;
      this.saveState();
      this.notify();
    }
  }

  resetAIKeysStatus() {
    this.aiKeysPool.forEach(k => {
      k.status = 'active';
      k.errorCount = 0;
    });
    this.saveState();
    this.notify();
  }

  clearAIKeysPool() {
    this.aiKeysPool = [];
    this.saveState();
    this.notify();
  }

  /**
   * Proxy universal de requisições HTTP roteado via Background Service Worker
   * Permite contornar restrições de CORS e CSP da página do Google
   * @param {string} url - URL de destino
   * @param {Object} options - Opções do fetch (headers, body, method)
   * @returns {Promise<Response|Object>}
   */
  static async fetchProxy(url, options = {}) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage && chrome.runtime.id) {
      try {
        const resp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'CALL_AI_PROXY', url, options }, (response) => {
            if (chrome.runtime.lastError || !response) {
              resolve(null);
            } else {
              resolve(response);
            }
          });
        });
        if (resp && resp.data !== undefined) {
          return {
            status: resp.status,
            ok: resp.ok,
            json: async () => resp.data,
            text: async () => (typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data))
          };
        }
      } catch (e) { /* fallback para fetch local */ }
    }
    return await fetch(url, options);
  }

  /**
   * Executa o auto-diagnóstico do DOM do Google FLOW com rotação automática de chaves de IA
   * Prioriza chaves já validadas e rotaciona automaticamente se atingir limites de cota (429)
   * @param {string} userQuery - Dúvida ou contexto adicional do usuário
   * @returns {Promise<Object>} - Resultado da análise da IA
   */
  async callAIDiagnostics(userQuery = '') {
    // 1. Constrói fila de prioridade: chaves validadas primeiro, ativas depois
    let candidates = [];
    if (this.aiKeysPool && this.aiKeysPool.length > 0) {
      const validKeys = this.aiKeysPool.filter(k => k.enabled !== false && k.status === 'valid');
      const activeKeys = this.aiKeysPool.filter(k => k.enabled !== false && k.status === 'active');
      const otherKeys = this.aiKeysPool.filter(k => k.enabled !== false && k.status !== 'valid' && k.status !== 'active');
      candidates = [...validKeys, ...activeKeys, ...otherKeys];
    }

    if (candidates.length === 0 && this.config.aiApiKey) {
      candidates.push({
        id: 'manual_key',
        key: this.config.aiApiKey,
        provider: this.config.aiProvider || 'gemini',
        model: this.config.aiModel || (this.config.aiProvider === 'groq' ? 'llama-3.3-70b-versatile' : this.config.aiProvider === 'openrouter' ? 'meta-llama/llama-3.2-3b-instruct:free' : 'gemini-2.5-flash'),
        status: 'active',
        label: `${(this.config.aiProvider || 'GEMINI').toUpperCase()} (Manual)`
      });
    }

    if (candidates.length === 0) {
      return {
        success: false,
        error: 'Nenhuma chave de API configurada. Carregue um arquivo (PDF, TXT, DOCX) ou insira sua chave na aba Espião FLOW.'
      };
    }

    const domDiag = this.diagnoseFlowDOM();
    const recentLogs = this.logs.slice(-15).map(l => `[${l.type.toUpperCase()}] ${l.message}`).join('\n');
    const currentUrl = (typeof window !== 'undefined' ? window.location.href : '');
    const isProject = FlowMacroEngine.isFlowProjectPage();
    const projectId = FlowMacroEngine.getCurrentProjectId();

    const systemPrompt = `Você é o Agente de Diagnóstico e Auto-Recuperação do FLOW Macro Studio Pro para o Google Flow (labs.google/fx/pt/tools/flow).
Seu objetivo é analisar o estado da página, o DOM, a barra de prompt, os botões, os erros e os logs recentes, identificando falhas ou lentidões e prescrevendo a solução exata em português brasileiro de forma direta e concisa.`;

    const userPrompt = `
ESTADO ATUAL DO GOOGLE FLOW:
- URL: ${currentUrl}
- Tipo de Página: ${isProject ? 'Dentro do Projeto (' + projectId + ')' : 'Hub Inicial do FLOW'}
- Estado do Macro: ${this.state} (Slide atual: ${this.currentIndex + 1}/${this.prompts.length})
- Campo de Prompt: ${domDiag.promptInput.found ? 'ENCONTRADO (' + domDiag.promptInput.tag + ')' : 'NÃO DETECTADO'}
- Botão de Envio (Criar/➔): ${domDiag.submitButton.found ? (domDiag.submitButton.disabled ? 'ENCONTRADO (DESABILITADO)' : 'ENCONTRADO (HABILITADO)') : 'NÃO DETECTADO'}
- Botão "Reutilizar Comando": ${domDiag.reuseCommand.found ? 'ENCONTRADO (' + domDiag.reuseCommand.count + ' botões)' : 'NÃO DETECTADO'}
- Imagens/Chips Anexados: ${this.hasCharacterChipsAttached() ? 'SIM (2+ chips detectados)' : 'NÃO'}
- Últimos Logs:
${recentLogs}

PERGUNTA / CONTEXTO ADICIONAL:
${userQuery || 'Analise o status atual do Google FLOW, verifique se há bloqueios, seletor travado ou erro e sugira a ação de auto-recuperação.'}
`;

    let lastError = '';

    // Loop de tentativas com rotação automática entre as chaves do pool
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const provider = cand.provider || 'gemini';
      const apiKey = cand.key;
      const model = cand.model || (provider === 'gemini' ? 'gemini-2.5-flash' : provider === 'groq' ? 'llama-3.3-70b-versatile' : 'meta-llama/llama-3.2-3b-instruct:free');

      try {
        let responseText = '';

        if (provider === 'gemini') {
          const candidateGeminiModels = [
            'gemini-2.5-flash',
            'gemini-flash-latest',
            'gemini-2.5-flash-lite',
            'gemini-2.0-flash',
            'gemini-3-flash-preview',
            'gemini-1.5-flash-latest',
            'gemini-1.5-flash',
            'gemini-1.5-pro'
          ];

          let geminiSuccess = null;
          let lastGeminiError = null;

          const tryCallGemini = async (modelName, version = 'v1beta') => {
            const cleanModel = modelName.replace(/^models\//, '');
            const url = `https://generativelanguage.googleapis.com/${version}/models/${cleanModel}:generateContent?key=${apiKey}`;
            const res = await FlowMacroEngine.fetchProxy(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 1000 }
              })
            });
            return await res.json();
          };

          // 1. Tenta modelos prioritários
          for (const m of candidateGeminiModels) {
            try {
              const data = await tryCallGemini(m, 'v1beta');
              if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                geminiSuccess = data.candidates[0].content.parts[0].text;
                cand.model = m;
                break;
              }
              if (data.error) {
                lastGeminiError = data.error;
                const errStr = (data.error.message || '').toLowerCase();
                if (data.error.code === 400 && errStr.includes('api key not valid')) {
                  break;
                }
                if (data.error.code === 429 || (data.error.status === 'RESOURCE_EXHAUSTED' && errStr.includes('quota'))) {
                  break; // Cota esgotada
                }
              }
            } catch (e) {
              lastGeminiError = e;
            }
          }

          // 2. Se falhar, busca modelos disponíveis via listModels
          if (!geminiSuccess && lastGeminiError && !(lastGeminiError.code === 429 || (lastGeminiError.status === 'RESOURCE_EXHAUSTED')) && !(lastGeminiError.code === 400 && (lastGeminiError.message || '').includes('API key not valid'))) {
            try {
              const listRes = await FlowMacroEngine.fetchProxy(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
              const listData = await listRes.json();
              if (listData.models && Array.isArray(listData.models)) {
                const supported = listData.models.filter(sm => Array.isArray(sm.supportedGenerationMethods) && sm.supportedGenerationMethods.includes('generateContent'));
                for (const sm of supported) {
                  const mName = sm.name || '';
                  const data = await tryCallGemini(mName, 'v1beta');
                  if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                    geminiSuccess = data.candidates[0].content.parts[0].text;
                    cand.model = mName;
                    break;
                  }
                }
              }
            } catch (err) { /* ignora */ }
          }

          if (!geminiSuccess) {
            const errStr = lastGeminiError ? (lastGeminiError.message || JSON.stringify(lastGeminiError)) : 'Falha na API Gemini';
            if (lastGeminiError && (lastGeminiError.code === 429 || (lastGeminiError.status === 'RESOURCE_EXHAUSTED' && errStr.toLowerCase().includes('quota')))) {
              cand.status = 'exhausted';
              this.addLog(`⚠️ Chave [${cand.label || 'Gemini'}] esgotou a cota diária. Rotacionando automaticamente para a próxima chave...`, 'warning');
              this.saveState();
              this.notify();
              lastError = `Cota excedida na chave Gemini: ${errStr}`;
              continue;
            }
            if (lastGeminiError && (lastGeminiError.code === 400 && errStr.toLowerCase().includes('api key not valid'))) {
              cand.status = 'error';
              this.addLog(`❌ Chave [${cand.label || 'Gemini'}] inválida. Pulando para a próxima chave...`, 'warning');
              this.saveState();
              this.notify();
              lastError = `Chave inválida: ${errStr}`;
              continue;
            }
            throw new Error(errStr);
          }

          responseText = geminiSuccess;
        } else if (provider === 'groq') {
          const url = 'https://api.groq.com/openai/v1/chat/completions';
          const groqModels = [
            'llama-3.3-70b-versatile',
            'llama-3.1-8b-instant',
            'mixtral-8x7b-32768',
            'gemma2-9b-it'
          ];
          let groqSuccess = null;
          let lastGroqError = null;

          for (const gModel of groqModels) {
            try {
              const res = await FlowMacroEngine.fetchProxy(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({
                  model: gModel,
                  messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
                  temperature: 0.2,
                  max_tokens: 1000
                })
              });

              const data = await res.json();
              if (data.choices?.[0]?.message?.content) {
                groqSuccess = data.choices[0].message.content;
                cand.model = gModel;
                break;
              }

              if (data.error) {
                lastGroqError = data.error;
                const errStr = (data.error.message || '').toLowerCase();
                if (data.error.code === 429 || errStr.includes('rate_limit') || errStr.includes('quota')) {
                  break;
                }
                if (errStr.includes('not found') || errStr.includes('deprecated') || errStr.includes('unavailable')) {
                  continue;
                }
              }
            } catch (e) {
              lastGroqError = e;
            }
          }

          if (!groqSuccess) {
            const errStr = lastGroqError ? (lastGroqError.message || JSON.stringify(lastGroqError)) : 'Falha na API Groq';
            if (lastGroqError && (lastGroqError.code === 429 || errStr.toLowerCase().includes('rate_limit') || errStr.toLowerCase().includes('quota'))) {
              cand.status = 'exhausted';
              this.addLog(`⚠️ Chave [${cand.label || 'Groq'}] esgotou a cota. Rotacionando automaticamente para a próxima chave...`, 'warning');
              this.saveState();
              this.notify();
              lastError = `Cota excedida na chave Groq: ${errStr}`;
              continue;
            }
            throw new Error(errStr);
          }

          responseText = groqSuccess;
        } else if (provider === 'openrouter') {
          const url = 'https://openrouter.ai/api/v1/chat/completions';
          const freeModels = [
            'meta-llama/llama-3.2-3b-instruct:free',
            'meta-llama/llama-3.1-8b-instruct:free',
            'mistralai/mistral-7b-instruct:free',
            'google/gemini-2.0-flash-thinking-exp:free',
            'deepseek/deepseek-r1:free',
            'openrouter/auto'
          ];

          let successResponse = null;
          let lastOrError = null;

          for (const targetModel of freeModels) {
            try {
              const res = await FlowMacroEngine.fetchProxy(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiKey}`,
                  'HTTP-Referer': 'https://labs.google/fx/pt/tools/flow',
                  'X-Title': 'FLOW Macro Studio Pro'
                },
                body: JSON.stringify({
                  model: targetModel,
                  messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
                  temperature: 0.2,
                  max_tokens: 1000
                })
              });

              const data = await res.json();
              if (data.choices?.[0]?.message?.content) {
                successResponse = data.choices[0].message.content;
                cand.model = targetModel;
                break;
              }

              if (data.error) {
                lastOrError = data.error;
                const errStr = (data.error.message || '').toLowerCase();
                if (errStr.includes('unavailable') || errStr.includes('no endpoints') || errStr.includes('slug instead') || errStr.includes('not found') || errStr.includes('paid version')) {
                  continue;
                }
                if (data.error.code === 429 || errStr.includes('quota') || errStr.includes('rate')) {
                  break;
                }
              }
            } catch (e) {
              lastOrError = e;
            }
          }

          if (!successResponse) {
            const errStr = lastOrError ? (lastOrError.message || JSON.stringify(lastOrError)) : 'Falha ao consultar OpenRouter';
            if (lastOrError && (lastOrError.code === 429 || errStr.toLowerCase().includes('rate') || errStr.toLowerCase().includes('quota'))) {
              cand.status = 'exhausted';
              this.addLog(`⚠️ Chave [${cand.label || 'OpenRouter'}] esgotou a cota. Rotacionando automaticamente para a próxima chave...`, 'warning');
              this.saveState();
              this.notify();
              lastError = `Cota excedida na chave OpenRouter: ${errStr}`;
              continue;
            }
            throw new Error(errStr);
          }

          responseText = successResponse;
        }

        // Sucesso: marca chave como válida e retorna resposta
        cand.status = 'valid';
        cand.lastUsed = Date.now();
        this.saveState();
        this.notify();

        return {
          success: true,
          provider: provider,
          model: model,
          keyUsed: cand.label || cand.key.substring(0, 8) + '...',
          analysis: responseText
        };
      } catch (err) {
        cand.status = 'error';
        cand.errorCount = (cand.errorCount || 0) + 1;
        lastError = err.message || 'Erro na requisição';
        this.addLog(`❌ Falha na chave [${cand.label || provider}]: ${lastError}`, 'warning');
      }
    }

    return {
      success: false,
      error: `Todas as ${candidates.length} chave(s) no Pool falharam ou esgotaram cota. Último erro: ${lastError}`
    };
  }

  /**
   * Constrói o texto limpo do prompt do slide (somente a descrição visual)
   * Personagens são anexados via imagens no FLOW (chips), nunca embutidos no texto.
   * @param {Object} promptItem - Item do slide
   * @returns {string} - Texto do prompt normalizado
   */
  composePromptText(promptItem) {
    const raw = promptItem.fullText || promptItem.imagePrompt || '';
    return FlowMacroEngine.normalizePromptText(raw);
  }

  // =========================================================================
  // Motor de Execução da Automação (Play, Pause, Stop, Step)
  // =========================================================================
  
  /**
   * Inicia ou retoma a execução sequencial dos carrosséis e slides
   */
  async start() {
    // Popula a lista de prompts a partir dos carrosséis configurados
    if (this.carousels && this.carousels.length > 0) {
      const activeCarousels = this.carousels.filter(c => c.enabled !== false);
      const allSlides = [];
      activeCarousels.forEach(c => {
        if (c.slides && Array.isArray(c.slides)) {
          c.slides.filter(s => s.enabled !== false).forEach(s => allSlides.push(s));
        }
      });
      if (allSlides.length > 0) {
        this.prompts = allSlides;
      }
    }

    if (this.prompts.length === 0) {
      this.addLog('⚠️ Nenhum prompt disponível para executar. Cole um roteiro ou carregue um PDF.', 'warning');
      return;
    }

    if (this.state === 'running') return;

    this.state = 'running';
    if (!this.startTime) {
      this.startTime = Date.now();
    }
    this.startTicker();
    this.addLog('▶️ Macro iniciada com controle de tempo e delays ativos.', 'success');
    this.notify();

    // Inicia a partir do primeiro slide pendente se não estiver retomando
    if (this.currentIndex === -1 || this.currentIndex >= this.prompts.length) {
      const firstPending = this.prompts.findIndex(p => p.enabled && p.status !== 'completed');
      this.currentIndex = firstPending !== -1 ? firstPending : 0;
      if (this.currentIndex === 0) {
        this.settingsConfiguredForProject = false;
        this.lastConfiguredProjectId = null;
      }
    }

    // Fecha banners ou modais obstrutivos antes de iniciar
    this.dismissFlowOnboardingBanners();

    this.runLoop();
  }

  /**
   * Pausa a execução da macro mantendo o progresso e o cronômetro
   */
  pause() {
    this.state = 'paused';
    if (this.timer) clearTimeout(this.timer);
    this.stopTicker();
    this.countdown = { remaining: 0, total: 0, label: '' };
    this.currentAction = 'Pausado';
    this.addLog('⏸️ Macro pausada pelo usuário.', 'warning');
    this.notify();
  }

  /**
   * Retoma a execução caso esteja pausada
   */
  resume() {
    if (this.state === 'paused') {
      this.start();
    }
  }

  /**
   * Interrompe totalmente a execução da macro e reseta o cronômetro e os status dos slides
   */
  stop() {
    this.state = 'idle';
    if (this.timer) clearTimeout(this.timer);
    this.stopTicker();
    this.startTime = 0;
    this.elapsedSeconds = 0;
    this.countdown = { remaining: 0, total: 0, label: '' };
    this.settingsConfiguredForProject = false;
    this.lastConfiguredProjectId = null;
    this.currentAction = '';
    this.currentIndex = -1;

    // Reseta o progresso em todos os prompts e slides
    this.prompts.forEach(p => {
      p.completedRepeats = 0;
      p.status = 'pending';
      p.errorMsg = '';
    });

    // Reseta o status de todos os carrosséis
    this.carousels.forEach(c => {
      c.status = 'pending';
      if (c.slides && Array.isArray(c.slides)) {
        c.slides.forEach(s => {
          s.completedRepeats = 0;
          s.status = 'pending';
          s.errorMsg = '';
        });
      }
    });

    this.saveState();
    this.addLog('⏹️ Macro encerrada e cronômetro resetado.', 'info');
    this.notify();
  }

  // =========================================================================
  // Gerenciamento de Múltiplos Carrosséis em Lote e Troca de Projetos
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
   * Retorna a URL limpa da página inicial (Hub) do Google FLOW respeitando o idioma da página
   * @returns {string} - URL do Hub (ex: "https://labs.google/fx/pt/tools/flow")
   */
  static getHubUrl() {
    if (typeof window === 'undefined') return 'https://labs.google/fx/pt/tools/flow';
    const origin = window.location.origin || 'https://labs.google';
    const pathname = window.location.pathname || '';
    const match = pathname.match(/(\/fx(?:\/[a-zA-Z-]+)?\/tools\/flow)/i);
    if (match) {
      return `${origin}${match[1]}`;
    }
    return 'https://labs.google/fx/pt/tools/flow';
  }

  /**
   * Valida se uma URL pertence estritamente ao Google FLOW
   * @param {string} url - URL a testar
   * @returns {boolean}
   */
  static isValidFlowUrl(url) {
    if (!url || typeof url !== 'string') return true;
    try {
      const parsed = new URL(url, window.location.origin);
      if (!parsed.hostname.includes('labs.google')) return false;
      const p = parsed.pathname.toLowerCase();
      const isHub = (p.includes('/tools/flow') || p.endsWith('/flow')) && !p.includes('/project/');
      const isProject = p.includes('/tools/flow/project/') || p.includes('/project/');
      return isHub || isProject;
    } catch (e) {
      return false;
    }
  }

  /**
   * Verifica com máxima precisão se um elemento DOM está visível na tela
   * Suporta nativamente modais com position: fixed, Radix UI portals e shadow DOM
   * @param {HTMLElement} element - Elemento a testar
   * @returns {boolean}
   */
  static isElementVisible(element) {
    if (!element) return false;
    if (element.closest && element.closest('[id*="fd-"], [class*="fd-"]')) return false;
    if (typeof element.checkVisibility === 'function') {
      try {
        return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      } catch (e) {}
    }
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    try {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    } catch (e) {}
    return true;
  }

  /**
   * Verifica se um elemento é seguro para clique (evita links externos, menus laterais e perigos)
   * @param {HTMLElement} element - Elemento DOM
   * @returns {boolean}
   */
  static isSafeToClick(element) {
    if (!element) return false;
    
    // Nunca clica dentro da interface da própria extensão
    if (element.closest('[id*="fd-"], [class*="fd-"]')) return false;

    // Nunca clica em menus de navegação ou barra lateral durante a geração
    if (element.closest('nav, aside, header, [role="navigation"], [class*="sidebar" i], [class*="navbar" i]')) {
      return false;
    }

    // Nunca clica em links que saiam do editor para /characters, /assets, /gallery, etc.
    const aTag = element.closest('a');
    if (aTag) {
      const href = (aTag.getAttribute('href') || aTag.href || '').toLowerCase();
      if (!FlowMacroEngine.isValidFlowUrl(href)) return false;
      if (href.includes('/characters') || href.includes('/assets') || href.includes('/gallery') || href.includes('/settings') || href.includes('/templates') || href.includes('/projects')) {
        return false;
      }
    }

    const anyHref = (element.getAttribute('href') || element.getAttribute('data-href') || '').toLowerCase();
    if (anyHref.includes('/characters') || anyHref.includes('/assets') || anyHref.includes('/gallery')) {
      return false;
    }

    return true;
  }

  /**
   * Retorna verdadeiro se o usuário estiver no Hub inicial do FLOW (onde fica o botão "+ Novo projeto")
   * @returns {boolean}
   */
  static isFlowHubPage() {
    if (typeof window === 'undefined') return false;
    const path = (window.location.pathname || '').toLowerCase();
    return (path.includes('/tools/flow') || path.endsWith('/flow')) && !path.includes('/project/');
  }

  /**
   * Retorna verdadeiro se o usuário estiver dentro de um projeto ativo (Canvas de geração)
   * @returns {boolean}
   */
  static isFlowProjectPage() {
    if (typeof window === 'undefined') return false;
    const path = (window.location.pathname || '').toLowerCase();
    return (path.includes('/tools/flow/project/') || path.includes('/project/')) && !path.includes('/characters') && !path.includes('/assets');
  }

  /**
   * Retorna verdadeiro se o usuário estiver na sub-página de gerenciamento de personagens
   * @returns {boolean}
   */
  static isFlowCharactersPage() {
    if (typeof window === 'undefined') return false;
    const path = (window.location.pathname || '').toLowerCase();
    return path.includes('/characters') || path.includes('/assets');
  }

  /**
   * Recupera o ID do projeto atual do FLOW na URL
   * @returns {string|null} - ID do projeto
   */
  static getCurrentProjectId() {
    if (typeof window === 'undefined') return null;
    const match = window.location.pathname.match(/\/project\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  /**
   * Garante que o navegador esteja na tela principal do Canvas do projeto e não em subpáginas
   */
  static async ensureOnFlowCanvas() {
    if (typeof window === 'undefined') return true;
    const path = window.location.pathname || '';
    if (!path.includes('/characters') && !path.includes('/assets')) {
      return true;
    }

    const projectId = FlowMacroEngine.getCurrentProjectId();

    // 1. Tenta clicar no botão "Canvas" ou "Editor" na barra lateral
    const canvasLink = Array.from(document.querySelectorAll('a, button, [role="button"], [role="tab"]')).find(el => {
      if (el.offsetParent === null) return false;
      const href = (el.getAttribute('href') || el.href || '').toLowerCase();
      const text = (el.textContent || el.innerText || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();

      const isCanvasHref = href && href.includes('/project/') && !href.includes('/characters') && !href.includes('/assets');
      const isCanvasText = text === 'canvas' || text.includes('canvas') || text === 'fluxo' || text === 'editor';
      const isCanvasAria = aria.includes('canvas') || aria.includes('fluxo') || aria.includes('editor');
      const isCanvasTitle = title.includes('canvas') || title.includes('fluxo') || title.includes('editor');

      return isCanvasHref || isCanvasText || isCanvasAria || isCanvasTitle;
    });

    if (canvasLink) {
      try {
        canvasLink.click();
        await new Promise(r => setTimeout(r, 1000));
      } catch (e) { /* ignora */ }
    }

    // 2. Fallback: navegação limpa por pushState na URL
    if (window.location.pathname.includes('/characters') || window.location.pathname.includes('/assets')) {
      const cleanPath = window.location.pathname.replace(/\/characters(\/.*)?$/i, '').replace(/\/assets(\/.*)?$/i, '');
      const cleanUrl = window.location.origin + cleanPath + window.location.search;

      try {
        window.history.pushState(null, '', cleanUrl);
        window.dispatchEvent(new PopStateEvent('popstate'));
        await new Promise(r => setTimeout(r, 600));
      } catch (e) { /* ignora */ }

      if (window.location.pathname.includes('/characters') || window.location.pathname.includes('/assets')) {
        window.location.href = cleanUrl;
        await new Promise(r => setTimeout(r, 1800));
      }
    }

    return true;
  }

  /**
   * Detecta e cancela automaticamente modais perigosos (como "Você quer mesmo excluir este projeto?")
   * Clica imediatamente em "Cancelar" e envia Escape para proteger os projetos do usuário
   * @returns {boolean}
   */
  dismissDangerousModals() {
    try {
      const dangerNodes = Array.from(document.querySelectorAll([
        '[role="dialog"]',
        '[role="alertdialog"]',
        'div[class*="modal" i]',
        'div[class*="dialog" i]',
        'h1, h2, h3, h4, div, p, span'
      ].join(', '))).filter(el => {
        if (el.closest('[id*="fd-"], [class*="fd-"]')) return false;
        const t = (el.textContent || el.innerText || '').toLowerCase();
        return t.includes('excluir este projeto') ||
               t.includes('você quer mesmo excluir') ||
               t.includes('voce quer mesmo excluir') ||
               t.includes('todos os seus clipes') ||
               t.includes('delete this project') ||
               t.includes('excluir o projeto') ||
               t.includes('deseja excluir');
      });

      if (dangerNodes.length > 0) {
        const cancelBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
          if (b.closest('[id*="fd-"], [class*="fd-"]')) return false;
          const t = (b.textContent || b.innerText || '').trim().toLowerCase();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          return t === 'cancelar' || t === 'cancel' || aria.includes('cancelar') || aria.includes('cancel');
        });

        if (cancelBtn) {
          cancelBtn.focus();
          cancelBtn.click();
          this.simulateClick(cancelBtn);
          this.addLog('🛡️ [Proteção Ativa] Modal "Você quer mesmo excluir este projeto?" detectado e CANCELADO imediatamente!', 'warning');
        }

        // Garante fechamento enviando tecla Escape
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
        return true;
      }
    } catch (e) { /* ignora */ }
    return false;
  }

  /**
   * Localiza o botão "+ Novo projeto" estritamente na tela do Hub inicial do Google FLOW
   * NUNCA é executado dentro de um projeto aberto nem em cards de projetos existentes.
   * Seletor exato no DOM do FLOW:
   * <button class="sc-16c4830a-1 iofibh sc-a38764c7-0 cgdjfr">
   *   <i class="sc-a39c2a59-0 bvvkYW google-symbols undefined">add_2</i>
   *   Novo projeto
   *   <div data-type="button-overlay" class="sc-16c4830a-0 cZvLor"></div>
   * </button>
   * @returns {HTMLElement|null}
   */
  findNewProjectButton() {
    // Cancela qualquer popup perigoso imediatamente
    this.dismissDangerousModals();

    // 0. NUNCA procura botão de Novo Projeto dentro do Canvas de um projeto aberto
    if (FlowMacroEngine.isFlowProjectPage()) {
      return null;
    }

    // 1. PRIORIDADE MÁXIMA: Seletores exatos das classes do botão Novo Projeto no FLOW
    const exactClassSelectors = [
      'button.cgdjfr',
      'button.iofibh',
      'button.sc-16c4830a-1',
      'button.sc-a38764c7-0',
      'button.sc-1c6805c6-1'
    ];

    for (const sel of exactClassSelectors) {
      const candidates = Array.from(document.querySelectorAll(sel)).filter(b => {
        if (b.offsetParent === null) return false;
        if (b.closest('[id*="fd-"], [class*="fd-"]')) return false;
        // SEGURANÇA: Nunca pode conter imagem nem ser card de projeto
        if (b.querySelector('img') || b.closest('[class*="card" i]:has(img), [role="gridcell"]')) return false;
        const text = (b.textContent || b.innerText || '').toLowerCase();
        return text.includes('novo projeto') || text.includes('new project') || text.includes('add_2');
      });

      if (candidates.length > 0) {
        return candidates[0];
      }
    }

    // 2. PRIORIDADE 2: Qualquer <button> no Hub com ícone 'add_2' / 'add' e texto 'Novo projeto'
    const buttonsWithAdd = Array.from(document.querySelectorAll('button')).filter(btn => {
      if (btn.offsetParent === null) return false;
      if (btn.closest('[id*="fd-"], [class*="fd-"]')) return false;
      // NUNCA pode ter imagem (cards de projeto contêm thumbnails)
      if (btn.querySelector('img')) return false;
      // NUNCA pode estar dentro de um card de projeto da galeria
      if (btn.closest('[class*="card" i]:has(img), [role="gridcell"], [class*="project-card" i]')) return false;

      const text = (btn.textContent || btn.innerText || '').trim().toLowerCase();
      // LISTA NEGRA ABSOLUTA
      if (
        text.includes('excluir') || text.includes('delete') || text.includes('apagar') ||
        text.includes('remover') || text.includes('more_vert') || text.includes('opções') ||
        text.includes('options') || text.includes('menu') || text.includes('personagem')
      ) {
        return false;
      }

      const iconEl = btn.querySelector('.google-symbols, .material-symbols-outlined, i');
      const iconText = iconEl ? (iconEl.textContent || iconEl.innerText || '').trim().toLowerCase() : '';
      const hasAddIcon = iconText === 'add_2' || iconText === 'add' || iconText === '+';

      const cleanText = text.replace(/add(_2)?/g, '').trim();
      return (hasAddIcon && (cleanText.includes('novo projeto') || cleanText.includes('new project'))) ||
             cleanText === 'novo projeto' || cleanText === 'new project';
    });

    if (buttonsWithAdd.length > 0) {
      return buttonsWithAdd[0];
    }

    // 3. PRIORIDADE 3: Botão com <div data-type="button-overlay"> que contenha "Novo projeto"
    const overlayBtn = Array.from(document.querySelectorAll('button:has(div[data-type="button-overlay"])')).find(btn => {
      if (btn.offsetParent === null) return false;
      if (btn.closest('[id*="fd-"], [class*="fd-"]')) return false;
      if (btn.querySelector('img')) return false;
      if (btn.closest('[class*="card" i]:has(img), [role="gridcell"]')) return false;
      const text = (btn.textContent || btn.innerText || '').toLowerCase();
      return (text.includes('novo projeto') || text.includes('new project')) && !text.includes('excluir');
    });

    if (overlayBtn) {
      return overlayBtn;
    }

    return null;
  }

  /**
   * Cria um novo projeto no Google FLOW de forma automática e segura (Passo A do fluxograma)
   * @returns {Promise<boolean>}
   */
  async createNewFlowProject() {
    this.dismissDangerousModals();
    this.settingsConfiguredForProject = false;
    this.lastConfiguredProjectId = null;
    this.addLog('📁 [Passo A] Preparando criação de novo projeto no FLOW...', 'info');

    const hubUrl = FlowMacroEngine.getHubUrl();

    // 1. Se estiver dentro de um projeto (/project/...), retorna ao Hub
    if (FlowMacroEngine.isFlowProjectPage()) {
      this.addLog('↩️ Navegando para o Hub inicial do FLOW...', 'info');
      
      const homeLink = Array.from(document.querySelectorAll('a')).find(a => {
        const href = (a.getAttribute('href') || a.href || '').toLowerCase();
        return href.endsWith('/tools/flow') || href.endsWith('/tools/flow/') || href.endsWith('/pt/tools/flow');
      });

      if (homeLink) {
        homeLink.click();
        await new Promise(r => setTimeout(r, 1200));
      }

      if (FlowMacroEngine.isFlowProjectPage()) {
        window.location.href = hubUrl;
        return true;
      }
    }

    // Aguarda confirmação de carregamento do Hub
    for (let h = 0; h < 10; h++) {
      this.dismissDangerousModals();
      if (FlowMacroEngine.isFlowHubPage() && !FlowMacroEngine.isFlowProjectPage()) {
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // 2. Localiza o botão "+ Novo projeto" no Hub
    let newProjBtn = this.findNewProjectButton();

    if (!newProjBtn) {
      for (let w = 0; w < 8; w++) {
        await new Promise(r => setTimeout(r, 500));
        this.dismissDangerousModals();
        newProjBtn = this.findNewProjectButton();
        if (newProjBtn) break;
      }
    }

    if (newProjBtn) {
      newProjBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
      newProjBtn.focus();

      const overlay = newProjBtn.querySelector('[data-type="button-overlay"]') || newProjBtn;

      // 1. Simula clique no overlay (que captura eventos pointer no Next.js/styled-components)
      if (overlay && overlay !== newProjBtn) {
        this.simulateClick(overlay);
        try { overlay.click(); } catch(e) {}
      }

      // 2. Simula clique no botão nativo
      this.simulateClick(newProjBtn);
      try { newProjBtn.click(); } catch(e) {}

      // 3. Aciona o handler React direto no botão e no overlay de forma limpa
      [newProjBtn, overlay].forEach(el => {
        try {
          const propKey = Object.keys(el).find(k => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
          if (propKey && el[propKey]) {
            if (typeof el[propKey].onClick === 'function') {
              el[propKey].onClick({ preventDefault: () => {}, stopPropagation: () => {}, target: el, currentTarget: el });
            }
          }
        } catch (e) {}
      });

      this.addLog('✨ Botão "Novo projeto" clicado! Aguardando o FLOW inicializar o projeto...', 'success');
      await new Promise(r => setTimeout(r, 1500));

      // Aguarda até 20s para o novo Canvas ser carregado (/project/...)
      for (let i = 0; i < 40; i++) {
        this.dismissDangerousModals();
        if (FlowMacroEngine.isFlowCharactersPage()) {
          await FlowMacroEngine.ensureOnFlowCanvas();
        }
        if (this.findPromptInput() && FlowMacroEngine.isFlowProjectPage()) {
          this.addLog(`📍 Novo projeto carregado: ${FlowMacroEngine.getCurrentProjectId() || 'ID ativo'}`, 'success');
          await new Promise(r => setTimeout(r, 800));
          return true;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      return true;
    }

    this.addLog('⚠️ Botão "Novo projeto" não encontrado na tela do Hub.', 'warning');
    return false;
  }

  /**
   * Executa um único prompt isoladamente (modo de teste manual)
   * @param {string} id - ID do prompt
   */
  async runSinglePrompt(id) {
    const item = this.prompts.find(p => p.id === id);
    if (!item) return;

    const prevIndex = this.currentIndex;
    this.currentIndex = this.prompts.indexOf(item);
    await this.executeSlide(item, false, item.index, 1, item.carouselTitle || 'Carrossel');
    this.currentIndex = prevIndex;
    this.notify();
  }

  /**
   * Loop mestre de execução: itera sobre todos os carrosséis e slides da sequência
   * Respeita os tempos entre slides (15s padrão) e carrosséis (25s padrão)
   */
  async runLoop() {
    // 0. Detecta se está no Hub ou dentro do projeto
    const promptInput = this.findPromptInput();
    if (!promptInput && FlowMacroEngine.isFlowHubPage()) {
      this.addLog('🏠 [Passo A] Página Inicial do FLOW detectada: criando novo projeto...', 'info');
      await this.createNewFlowProject();
    } else if (FlowMacroEngine.isFlowProjectPage() || promptInput) {
      this.addLog(`📍 [Dentro do Projeto] ID: ${FlowMacroEngine.getCurrentProjectId() || 'ativo'} - Execução direta ativada.`, 'info');
    }

    // Determina os carrosséis habilitados
    const activeCarousels = this.carousels.filter(c => c.enabled !== false);
    const carouselsToRun = activeCarousels.length > 0 ? activeCarousels : [{ id: 'carousel_1', title: 'Carrossel Principal', slides: this.prompts.filter(p => p.enabled !== false) }];

    this.addLog(`🎬 Iniciando execução em lote: ${carouselsToRun.length} carrossel(is) na fila.`, 'info');

    for (let cIdx = 0; cIdx < carouselsToRun.length; cIdx++) {
      if (this.state !== 'running') break;
      const carousel = carouselsToRun[cIdx];
      carousel.status = 'running';

      this.addLog(`\n========================================\n🌟 [Carrossel ${cIdx + 1}/${carouselsToRun.length}] Iniciando: ${carousel.title}\n========================================`, 'info');
      this.notify();

      // Se for um novo carrossel subsequente e a opção de criar novo projeto estiver ativa
      if (cIdx > 0 && this.config.autoCreateNewProjectPerCarousel) {
        this.addLog('🏠 [Passo A - Novo Carrossel] Acessando o Hub do FLOW para criar um novo projeto...', 'info');
        await this.createNewFlowProject();
      }

      const activeSlides = carousel.slides.filter(s => s.enabled !== false);

      for (let sIdx = 0; sIdx < activeSlides.length; sIdx++) {
        if (this.state !== 'running') break;
        const slide = activeSlides[sIdx];

        // O 1º slide de cada carrossel anexa os personagens e aplica as configurações iniciais
        const isFirstSlideOfCarousel = (sIdx === 0);

        await this.executeSlide(slide, isFirstSlideOfCarousel, sIdx + 1, activeSlides.length, carousel.title);

        if (this.state !== 'running') break;

        // Intervalo entre slides do mesmo carrossel com cronômetro regressivo (Padrão: 15s)
        if (sIdx + 1 < activeSlides.length && this.state === 'running') {
          const slideDelay = parseInt(this.config.delaySeconds, 10) || 15;
          await this.waitWithCountdown(slideDelay, `Próximo Slide (${sIdx + 2}/${activeSlides.length})`);
        }
      }

      carousel.status = 'completed';
      this.addLog(`✅ [Carrossel ${cIdx + 1}/${carouselsToRun.length}] Concluído com sucesso!`, 'success');
      this.saveState();

      // Intervalo entre o fim de um carrossel e o início do próximo (Padrão: 25s)
      if (cIdx + 1 < carouselsToRun.length && this.state === 'running') {
        const carouselDelay = parseInt(this.config.carouselDelaySeconds, 10) || 25;
        this.addLog(`\n⏳ [Transição de Carrossel] Aguardando ${carouselDelay}s antes de abrir o próximo carrossel...`, 'info');
        await this.waitWithCountdown(carouselDelay, `Próximo Carrossel (${cIdx + 2}/${carouselsToRun.length})`);
      }
    }

    if (this.state === 'running') {
      this.state = 'idle';
      this.stopTicker();
      this.countdown = { remaining: 0, total: 0, label: '' };
      this.currentAction = 'Concluído';
      const totalElapsed = FlowMacroEngine.formatDuration(this.elapsedSeconds);
      this.addLog(`🎉 Todos os carrosséis e slides foram gerados com sucesso! Tempo total: ${totalElapsed}`, 'success');
      this.saveState();
    }
  }

  /**
   * Executa um slide individual seguindo a sequência exata de Passos do Fluxograma:
   * - Slide 1: Passo 1 (Prompt) -> Passo 2 (Configurações 1x) -> Passos 3, 4, 5 (Personagens) -> Passo 6 (Envio & Espera)
   * - Slide 2+: Passo 7 (Reutilizar Comando & Substituir Prompt) -> Passo 6 (Envio & Espera)
   * @param {Object} item - Objeto do slide a ser gerado
   * @param {boolean} isFirstSlideOfCarousel - Se é o primeiro slide do projeto
   * @param {number} slideNum - Número do slide atual
   * @param {number} totalSlides - Total de slides do carrossel
   * @param {string} carouselTitle - Título do carrossel
   */
  async executeSlide(item, isFirstSlideOfCarousel, slideNum, totalSlides, carouselTitle) {
    item.status = 'running';
    const targetRepeats = Math.max(1, parseInt(item.repeatCount, 10) || parseInt(this.config.repeatPerPrompt, 10) || 1);
    const startRep = parseInt(item.completedRepeats, 10) || 0;

    for (let rep = startRep; rep < targetRepeats; rep++) {
      if (this.state !== 'running' && this.state !== 'idle') break;

      this.addLog(`🚀 [Slide ${slideNum}/${totalSlides}] ${carouselTitle} • ${item.slideTitle || item.title} (Inserção ${rep + 1}/${targetRepeats})`, 'info');
      this.notify();

      try {
        // Garante que estamos na tela do Canvas
        if (FlowMacroEngine.isFlowCharactersPage()) {
          this.addLog('↩️ Corrigindo página: retornando da tela de personagens para o Canvas do projeto...', 'info');
          await FlowMacroEngine.ensureOnFlowCanvas();
        }

        let reused = false;

        // Passo 7: Se NÃO for o primeiro slide do carrossel, reutiliza o comando anterior do Canvas
        if (!isFirstSlideOfCarousel && this.config.reusePreviousCommand !== false) {
          this.currentAction = '🔁 Reutilizando comando do slide anterior...';
          this.notify();
          reused = await this.reuseLatestCommand();
          await this.stepDelay(null, 'Aguardando FLOW carregar comando...');
        }

        // Se for o 1º slide (ou se a reutilização não foi possível):
        if (!reused) {
          this.dismissFlowOnboardingBanners();

          // Passo 1: Inserir o primeiro prompt de texto
          const inputEl = this.findPromptInput();
          if (!inputEl) {
            throw new Error('Campo de prompt do Flow não encontrado na página.');
          }
          this.currentAction = '📝 Inserindo texto do prompt inicial...';
          this.notify();
          const composedText = this.composePromptText(item);
          await this.setPromptInputValue(inputEl, composedText);
          this.addLog(`📝 [Passo 1] Prompt inicial inserido no campo de texto.`, 'info');
          await this.stepDelay(null, 'Verificando configurações...');

          // Passo 1 (Continuação): Verificação de formato de imagem (SOMENTE no 1º slide de cada projeto)
          // REGRA DE OURO: A verificação de formato de imagem acontece EXCLUSIVAMENTE no 1º slide de cada projeto!
          if (!this.isCurrentProjectConfigured()) {
            this.currentAction = '⚙️ [Passo 1] Verificando configurações de imagem do projeto (1ª vez)...';
            this.notify();
            await this.applyFlowSettings();

            // CORREÇÃO: Garante que nenhum popover/dialog ficou aberto após configurações
            // Isso evita que o menu Nano Banana interfira nos Passos 2-4
            for (let closeWait = 0; closeWait < 5; closeWait++) {
              const openPopover = document.querySelector('[role="dialog"], [role="menu"], [class*="popover" i], [data-radix-popper-content-wrapper]');
              if (!openPopover || openPopover.offsetParent === null) break;
              this.addLog('⚠️ Popover de configurações ainda aberto. Fechando...', 'info');
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
              await new Promise(r => setTimeout(r, 400));
            }
          } else {
            this.addLog('⏩ [Passo 1] Formato de imagem mantido (verificação ocorre exclusivamente no 1º slide de cada projeto).', 'info');
          }
          await this.stepDelay(null, 'Verificando personagens...');

          // Passos 2, 3 e 4: Anexar personagens de referência (botão +, buscar na biblioteca / upload, incluir no comando)
          if (this.config.applyGlobalCharacters !== false && this.characters && this.characters.length > 0) {
            this.currentAction = '🎭 Anexando personagens de referência...';
            this.notify();
            const charsAttached = await this.attachCharactersFromFlowLibrary();

            // CORREÇÃO: Se os personagens NÃO foram anexados, interrompe a execução do slide
            if (!charsAttached) {
              throw new Error(`Falha ao anexar personagens de referência. Os chips não foram confirmados na barra de prompt.`);
            }

            // Pausa de segurança pós-chips para o React estabilizar completamente
            await new Promise(r => setTimeout(r, 1500));
            this.addLog('✅ Todos os personagens confirmados na barra de prompt. Preparando envio...', 'success');
            await this.stepDelay(null, 'Validando prompt completo...');
          }
        } else {
          // Passo 7: Comando reutilizado com sucesso (personagens já anexados).
          // Agora substituir o texto do prompt pelo prompt do slide seguinte:
          const inputEl = this.findPromptInput();
          if (!inputEl) {
            throw new Error('Campo de prompt do Flow não encontrado na página.');
          }
          this.currentAction = `📝 Atualizando prompt para slide ${slideNum}...`;
          this.notify();
          const composedText = this.composePromptText(item);
          await this.setPromptInputValue(inputEl, composedText);
          this.addLog(`📝 [Passo 7] Prompt do slide ${slideNum} atualizado no comando reutilizado.`, 'info');
          await this.stepDelay(null, 'Preparando envio...');
        }

        this.dismissFlowOnboardingBanners();

        // CORREÇÃO: Verifica que nenhum dialog/popover está aberto antes de enviar
        for (let closeWait = 0; closeWait < 3; closeWait++) {
          const openDialog = document.querySelector('[role="dialog"], [role="menu"], [class*="popover" i], [class*="modal" i], [data-radix-popper-content-wrapper]');
          if (!openDialog || openDialog.offsetParent === null) break;
          this.addLog('⚠️ Dialog/popover detectado antes do envio. Fechando...', 'info');
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
          await new Promise(r => setTimeout(r, 400));
        }

        // CORREÇÃO: Verifica que o campo de prompt contém texto antes de enviar
        const inputEl = this.findPromptInput();
        const promptText = inputEl ? (inputEl.value || inputEl.innerText || inputEl.textContent || '').trim() : '';
        if (!promptText) {
          this.addLog('⚠️ Campo de prompt está vazio! Re-inserindo texto...', 'warning');
          if (inputEl) {
            const composedText = this.composePromptText(item);
            await this.setPromptInputValue(inputEl, composedText);
            await new Promise(r => setTimeout(r, 500));
          }
        }

        // Passo 5: Clicar na seta no campo direito para enviar o prompt e gerar imagens no FLOW
        this.currentAction = '🚀 Enviando prompt para geração no FLOW...';
        this.notify();
        const submitBtn = this.findSubmitButton();
        const submitted = await this.simulateSubmit(submitBtn, inputEl);

        if (submitted) {
          this.addLog(`✅ [Passo 5] Inserção ${rep + 1}/${targetRepeats} disparada no FLOW: ${item.slideTitle || item.title}`, 'success');
          // Aguarda a geração da imagem ser concluída no Canvas do FLOW antes do intervalo/próximo slide
          await this.waitForGenerationToComplete(60);
        } else {
          throw new Error('Não foi possível acionar o botão de envio nem a tecla Enter no FLOW.');
        }

        item.completedRepeats = rep + 1;
        this.saveState();

        // Se houver repetições configuradas para o mesmo slide, aguarda delay
        if (rep + 1 < targetRepeats && (this.state === 'running' || this.state === 'idle')) {
          const repDelay = parseInt(this.config.delaySeconds, 10) || 15;
          await this.waitWithCountdown(repDelay, `Repetição ${rep + 2}/${targetRepeats}`);
        }
      } catch (err) {
        item.status = 'error';
        item.errorMsg = err.message || 'Erro ao executar prompt';
        this.addLog(`❌ Falha no ${item.title} (rep ${rep + 1}): ${item.errorMsg}`, 'error');

        // Auto-diagnóstico em tempo real por I.A se habilitado
        if (this.config.aiAutoHeal !== false && this.config.aiApiKey) {
          this.addLog('🤖 [I.A Auto-Diagnóstico] Analisando a causa do erro em tempo real...', 'info');
          try {
            const aiRes = await this.callAIDiagnostics(`O slide ${slideNum} falhou com o seguinte erro: "${err.message}". Identifique o que impediu o envio no DOM.`);
            if (aiRes.success) {
              this.addLog(`💡 [Diagnóstico I.A]: ${aiRes.analysis.substring(0, 250)}...`, 'info');
            }
          } catch (aiErr) { /* ignora */ }
        }

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

// =========================================================================
// Inicialização e Exportação Global da Instância do Motor
// =========================================================================
if (typeof window !== 'undefined') {
  window.FlowMacroEngine = FlowMacroEngine;
  window.flowMacroInstance = new FlowMacroEngine();
}
