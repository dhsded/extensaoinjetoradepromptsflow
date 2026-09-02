/**
 * FLOW Prompt Injector & Downloader - Gerador de Ícones PNG
 * 
 * Script utilitário em Node.js puro (sem dependências externas) para gerar
 * os ícones da extensão nos tamanhos padrão da Chrome Web Store (16, 48, 128px)
 * desenhando um gradiente roxo/índigo com uma seta de download e salvando como PNG válido.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Cria o Buffer binário de uma imagem PNG com dimensões especificadas
 * @param {number} width - Largura em pixels
 * @param {number} height - Altura em pixels
 * @returns {Buffer} Buffer do arquivo PNG completo
 */
function createPNG(width, height) {
  // Aloca a matriz de pixels brutos RGBA (4 bytes por pixel: R, G, B, Alpha)
  const buffer = Buffer.alloc(width * height * 4);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      
      // Coordenadas normalizadas (-1 a +1) a partir do centro
      const nx = (x / width) * 2 - 1;
      const ny = (y / height) * 2 - 1;
      const dist = Math.sqrt(nx * nx + ny * ny);
      
      // Cantos arredondados do ícone (transparência nas bordas circulares externas)
      if (dist > 0.92) {
        buffer[idx] = 0;     // Vermelho
        buffer[idx + 1] = 0; // Verde
        buffer[idx + 2] = 0; // Azul
        buffer[idx + 3] = 0; // Alpha 0 (transparente)
        continue;
      }
      
      // Gradiente vertical moderno (Índigo para Roxo)
      const gradient = y / height;
      const r = Math.floor(79 + (124 - 79) * gradient);
      const g = Math.floor(70 + (58 - 70) * gradient);
      const b = Math.floor(229 + (237 - 229) * gradient);
      
      // Geometria da seta de download desenhada no centro
      const cx = width / 2;
      const cy = height / 2;
      const relX = (x - cx) / (width / 2);
      const relY = (y - cy) / (height / 2);
      
      let isArrow = false;
      // Haste vertical da seta
      if (Math.abs(relX) <= 0.18 && relY >= -0.55 && relY <= 0.15) {
        isArrow = true;
      }
      // Cabeça triangular da seta apontando para baixo
      if (relY >= 0.1 && relY <= 0.45 && Math.abs(relX) <= (0.45 - relY) * 1.1) {
        isArrow = true;
      }
      // Bandeja horizontal inferior de suporte
      if (relY >= 0.55 && relY <= 0.7 && Math.abs(relX) <= 0.55) {
        isArrow = true;
      }
      
      if (isArrow) {
        // Pixel branco para o desenho da seta
        buffer[idx] = 255;
        buffer[idx + 1] = 255;
        buffer[idx + 2] = 255;
        buffer[idx + 3] = 255;
      } else {
        // Pixel com a cor do gradiente de fundo
        buffer[idx] = r;
        buffer[idx + 1] = g;
        buffer[idx + 2] = b;
        buffer[idx + 3] = 255;
      }
    }
  }
  
  /**
   * Calcula a soma de verificação CRC32 para conformidade com a especificação PNG
   * @param {Buffer} buf - Buffer de dados
   * @returns {number} Valor CRC32
   */
  function crc32(buf) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
  }
  
  // Tabela pré-computada para cálculo veloz do CRC32
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    table[i] = c;
  }
  
  /**
   * Monta um Chunk padrão do formato PNG (Tamanho + Tipo + Dados + CRC32)
   * @param {string} type - Identificador de 4 letras do chunk (ex: 'IHDR', 'IDAT', 'IEND')
   * @param {Buffer} data - Dados binários do chunk
   * @returns {Buffer} Chunk completo
   */
  function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(8 + len + 4);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const crcVal = crc32(buf.slice(4, 8 + len));
    buf.writeUInt32BE(crcVal, 8 + len);
    return buf;
  }
  
  // Linhas de varredura com byte de filtro 0 (None)
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    scanlines[y * (width * 4 + 1)] = 0;
    buffer.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  
  // Cabeçalho IHDR: Largura, Altura, 8 bits por canal, RGBA (tipo 6)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // Profundidade de bits
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // Compressão Deflate
  ihdr[11] = 0; // Filtro padrão
  ihdr[12] = 0; // Sem entrelaçamento
  
  // Compressão dos dados da imagem com zlib deflate
  const idatData = zlib.deflateSync(scanlines);
  
  // Assinatura mágica do formato PNG (8 bytes fixos)
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idatData),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

// Cria a pasta icons se não existir e gera os 3 tamanhos requeridos
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 48, 128].forEach(size => {
  const pngData = createPNG(size, size);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), pngData);
  console.log(`[Ícone] icon${size}.png (${size}x${size}) gerado com sucesso!`);
});
