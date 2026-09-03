# ⚡ FLOW Studio Pro - Macro de Prompts por PDF & Baixador Automático

Extensão profissional para navegadores baseados em Chromium (**Google Chrome, Brave, Microsoft Edge, Opera**) projetada para automatizar o envio de sequências de prompts a partir de arquivos **PDF / Roteiros**, gerenciar **personagens pré-definidos**, configurar formatos e quantidades e realizar o **download automático em lote** de imagens no **FLOW / Google Labs**.

---

## 🌟 Principais Recursos

### 1. ⚡ FLOW Macro Studio (Automação de Prompts & PDF)
- **Leitor de PDF 100% Offline**: Arraste seu PDF ou arquivo de roteiro (`.pdf`, `.txt`, `.json`, `.csv`) para extrair automaticamente a sequência de prompts e cenas.
- **Identificação Inteligente de Padrões**: Reconhece seções como `Cena 1`, `Texto nos Balões: PT: "..."` e `Prompt de Imagem (Midjourney / Dall-E): ...`.
- **Tabela Sequencial Interativa**:
  - Visualize cada prompt com status em tempo real (**Pendente**, **Executando**, **Concluído**, **Erro**, **Pulado**).
  - Ative/desative prompts individuais com checkboxes.
  - Edite ou adicione novos prompts manualmente.
  - Botão de **Execução Individual (`▶️`)** para testar qualquer prompt isoladamente.
- **Motor de Execução Automática**:
  - Injeta o texto no campo de prompt do FLOW com simulação de eventos nativos.
  - Clica no botão de envio (`➔`) ou aciona a tecla Enter automaticamente.
  - Aguarda o intervalo configurável (ex: 8s) entre envios.
  - Controles de **Iniciar**, **Pausar**, **Continuar** e **Parar**.
  - Barra de progresso visual com porcentagem e console de logs com registro temporal.

---

### 2. 🎭 Gerenciador de Personagens Pré-definidos
- Cadastre fichas de personagens com **Nome**, **Avatar/Foto de Referência** e **Prompt Tag / Descrição**.
- Ativação/desativação individual ou global de personagens.
- O macro insere automaticamente as tags e referências dos personagens ativos em cada prompt da sequência, garantindo consistência visual entre as cenas.

---

### 3. ⚙️ Painel de Formato e Geração (Fiel à Interface do FLOW)
- **Seleção de Mídia**: Abas `[🖼️ Imagem]` e `[🎥 Vídeo]`.
- **Proporções de Tela (Aspect Ratio)**:
  - `16:9` (Paisagem widescreen)
  - `4:3` (Padrão 4:3)
  - `1:1` (Quadrado)
  - `3:4` (Retrato 3:4)
  - `9:16` (Vertical / Reels / Stories / TikTok)
- **Seletor de Modelo**: `⚡ Nano Banana Pro`, `Imagen 3`, etc.
- **Quantidade por Geração**: `x1`, `x2`, `x3`, `x4`.
- **Intervalo de Segurança**: Ajuste o tempo de espera entre cada envio (3 a 120 segundos).

---

### 4. 📥 Download em Lote & Auto-Download em Tempo Real
- **Rolagem Automática Inteligente**: Rola a página para acionar o carregamento preguiçoso de todas as imagens antes de baixar.
- **Botão de 1-Clique nos Cards**: Baixe qualquer imagem diretamente no card.
- **Resoluções Suportadas**: 1K Original Máximo, 2K, 4K Aumentada e Extração Direta de Alta Definição.
- **Organização**: Escolha a subpasta de download (ex: `Downloads/FLOW_Downloads/`).

---

## 🔄 Fluxograma Oficial de Execução do FLOW Macro

O motor de automação segue rigorosamente o fluxograma oficial de ações no Google FLOW:

| Passo | Ação no FLOW | Regras & Comportamento |
|---|---|---|
| **Início** | **Detecção de Página** | Detecta se está na página principal (`https://labs.google/fx/pt/tools/flow`) ou em um projeto aberto (`.../project/<id>`). |
| **Passo A** | **Criação de Novo Projeto** | Se ativado o modo de novo projeto a cada carrossel, clica em `+ Novo projeto`. Reseta a verificação de formato para o novo projeto. |
| **Passo 1** | **Inserção do Prompt + Formato de Imagem** | 1. Insere o primeiro prompt de texto.<br>2. **SOMENTE no 1º slide de cada projeto**: Abre o menu *Nano Banana*, valida/configura modo Imagem, proporção (ex: 9:16) e quantidade (x4), e fecha o menu.<br>3. **Nos slides seguintes (2+)**: A verificação de formato é completamente dispensada. |
| **Passo 2** | **Botão `+`** | Clica no botão `+` na barra de prompt para abrir a biblioteca/upload. |
| **Passo 3** | **Enviar Mídia / Biblioteca** | Busca **primeiro** na biblioteca pelo nome de referência. Se não encontrar (1ª operação), clica em *Enviar Mídia* e carrega a imagem. |
| **Passo 4** | **Selecionar Imagem & Incluir no Comando** | Seleciona o card do personagem pelo nome e clica em *Incluir no comando*.<br>*(Se existir mais de um personagem, retorna ao Passo 2).* |
| **Passo 5** | **Envio do Prompt Inicial** | Com todos os personagens confirmados na barra, clica na seta à direita (`➔`) para gerar a imagem. |
| **Passo 6/7** | **Reutilizar Comando nos Slides 2+** | Nos slides seguintes: clica no card gerado no Canvas, clica em *Reutilizar comando*, substitui o texto pelo novo prompt e envia.<br>*(Sem verificação de formato nem reenvio de personagens).* |
| **Ciclo Final** | **Retorno ao Passo A** | Ao término da sequência de um carrossel, retorna ao **Passo A** se configurado para criar novos projetos em lote. |

---

## 🚀 Como Instalar no Navegador

1. Abra o navegador (**Chrome, Brave, Edge ou Opera**) e acesse:
   - `chrome://extensions`
2. No canto superior direito, ative a chave **"Modo do desenvolvedor"** (Developer mode).
3. Clique em **"Carregar sem compactação"** (Load unpacked).
4. Selecione a pasta:
   ```
   C:\Users\Diego Dutra\Documents\Baixador
   ```
5. Pronto! O **FLOW Studio Pro** estará instalado.

---

## 💡 Como Usar o Macro Studio no FLOW

1. Abra a página do **FLOW** no seu navegador.
2. Clique no botão **"⚡ Macro Studio (PDF & Prompts)"** no painel flutuante à direita ou abra pelo ícone da extensão no topo.
3. Na aba **Sequência & PDF**, arraste seu arquivo PDF ou cole o texto do roteiro.
4. Na aba **Personagens**, cadastre seus personagens com fotos e descrições.
5. Na aba **Formato & Geração**, escolha a proporção desejada (`9:16`, `16:9`, etc.) e a quantidade (`x4`, etc.).
6. Na aba **Execução & Logs**, clique em **"Iniciar Macro"** para acompanhar a geração automática da sua história!

---

## 📂 Estrutura dos Arquivos

```
Baixador/
├── manifest.json         # Manifesto da extensão (Manifest V3)
├── pdf_extractor.js      # Extrator de PDF puro em JS & parser de roteiros
├── macro_engine.js       # Motor de automação e injeção do FLOW
├── background.js         # Service Worker para downloads e persistência
├── content.js            # Interface Studio injetada, HUD e listeners
├── content.css           # Estilos Dark Glassmorphism para o Studio e controles
├── icons/                # Ícones da extensão (16px, 48px, 128px)
├── popup/
│   ├── popup.html        # Menu popup com atalho para o Macro Studio
│   ├── popup.css         # Estilos modernos do popup
│   └── popup.js          # Lógica do painel popup
└── README.md             # Documentação completa
```

