const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(width, height) {
  // Simple PNG generator with gradient and download arrow
  const buffer = Buffer.alloc(width * height * 4);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      
      // Calculate normalized coordinates (-1 to 1)
      const nx = (x / width) * 2 - 1;
      const ny = (y / height) * 2 - 1;
      const dist = Math.sqrt(nx * nx + ny * ny);
      
      // Rounded icon background
      if (dist > 0.92) {
        buffer[idx] = 0;     // R
        buffer[idx + 1] = 0; // G
        buffer[idx + 2] = 0; // B
        buffer[idx + 3] = 0; // Alpha 0
        continue;
      }
      
      // Indigo-Purple Gradient
      const gradient = y / height;
      const r = Math.floor(79 + (124 - 79) * gradient);
      const g = Math.floor(70 + (58 - 70) * gradient);
      const b = Math.floor(229 + (237 - 229) * gradient);
      
      // Download Arrow drawing logic
      const cx = width / 2;
      const cy = height / 2;
      const relX = (x - cx) / (width / 2);
      const relY = (y - cy) / (height / 2);
      
      let isArrow = false;
      // Vertical stem of arrow
      if (Math.abs(relX) <= 0.18 && relY >= -0.55 && relY <= 0.15) {
        isArrow = true;
      }
      // Arrow head (triangle)
      if (relY >= 0.1 && relY <= 0.45 && Math.abs(relX) <= (0.45 - relY) * 1.1) {
        isArrow = true;
      }
      // Base tray line
      if (relY >= 0.55 && relY <= 0.7 && Math.abs(relX) <= 0.55) {
        isArrow = true;
      }
      
      if (isArrow) {
        buffer[idx] = 255;
        buffer[idx + 1] = 255;
        buffer[idx + 2] = 255;
        buffer[idx + 3] = 255;
      } else {
        buffer[idx] = r;
        buffer[idx + 1] = g;
        buffer[idx + 2] = b;
        buffer[idx + 3] = 255;
      }
    }
  }
  
  // Format as PNG with standard chunks: IHDR, IDAT, IEND
  function crc32(buf) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
  }
  
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    table[i] = c;
  }
  
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
  
  // Raw scanlines with filter byte 0
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    scanlines[y * (width * 4 + 1)] = 0; // Filter: None
    buffer.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  
  const compressed = zlib.deflateSync(scanlines);
  
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  
  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 48, 128].forEach(size => {
  const pngData = createPNG(size, size);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), pngData);
  console.log(`Generated icon${size}.png`);
});
