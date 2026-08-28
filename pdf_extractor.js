/**
 * FLOW Macro Studio - Client-side Pure JS PDF Text Extractor
 * Uses native browser DecompressionStream for FlateDecode streams.
 * Works 100% offline without external dependencies.
 */

class FlowPdfExtractor {
  /**
   * Extract text from a File or ArrayBuffer
   * @param {File|ArrayBuffer|Uint8Array} source 
   * @returns {Promise<{text: string, pages: string[]}>}
   */
  static async extractText(source) {
    let arrayBuffer;
    if (source instanceof File || source instanceof Blob) {
      arrayBuffer = await source.arrayBuffer();
    } else if (source instanceof Uint8Array) {
      arrayBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    } else {
      arrayBuffer = source;
    }

    const uint8 = new Uint8Array(arrayBuffer);
    const textDecoder = new TextDecoder('latin1');
    const rawPdf = textDecoder.decode(uint8);

    const pages = [];
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match;

    // Find all stream chunks in binary
    const streamIndices = [];
    let searchPos = 0;
    const streamMarker = new TextEncoder().encode('stream');
    const endstreamMarker = new TextEncoder().encode('endstream');

    while (searchPos < uint8.length) {
      const idx = FlowPdfExtractor.indexOfSubarray(uint8, streamMarker, searchPos);
      if (idx === -1) break;

      // Skip newline after stream
      let streamStart = idx + 6;
      if (uint8[streamStart] === 13 && uint8[streamStart + 1] === 10) {
        streamStart += 2;
      } else if (uint8[streamStart] === 10 || uint8[streamStart] === 13) {
        streamStart += 1;
      }

      const endIdx = FlowPdfExtractor.indexOfSubarray(uint8, endstreamMarker, streamStart);
      if (endIdx === -1) break;

      // The end of stream data might have \r\n before 'endstream'
      let streamEnd = endIdx;
      if (streamEnd > streamStart && uint8[streamEnd - 1] === 10) streamEnd--;
      if (streamEnd > streamStart && uint8[streamEnd - 1] === 13) streamEnd--;

      streamIndices.push({ start: streamStart, end: streamEnd });
      searchPos = endIdx + 9;
    }

    let allExtractedText = [];

    // Process each stream chunk
    for (const { start, end } of streamIndices) {
      const chunk = uint8.subarray(start, end);
      let decompressed = null;

      // Attempt DecompressionStream('deflate')
      try {
        if (typeof DecompressionStream !== 'undefined') {
          // Standard raw deflate stream or zlib header check
          let deflateChunk = chunk;
          // If chunk has zlib header (0x78 0x9c or 0x78 0x01 or 0x78 0xda), we can decompress with 'deflate'
          const ds = new DecompressionStream('deflate');
          const writer = ds.writable.getWriter();
          writer.write(deflateChunk);
          writer.close();
          const reader = ds.readable.getReader();
          const chunks = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          let totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
          let merged = new Uint8Array(totalLen);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
          }
          decompressed = new TextDecoder('utf-8', { fatal: false }).decode(merged);
        }
      } catch (e) {
        // Fallback: decode raw uncompressed stream
        try {
          decompressed = textDecoder.decode(chunk);
        } catch (err) {}
      }

      if (decompressed) {
        const streamText = FlowPdfExtractor.parsePdfOperators(decompressed);
        if (streamText && streamText.trim().length > 0) {
          allExtractedText.push(streamText.trim());
        }
      }
    }

    // Fallback: Direct text extraction from raw PDF objects if stream extraction yielded little
    if (allExtractedText.join('\n\n').trim().length < 10) {
      const rawText = FlowPdfExtractor.parsePdfOperators(rawPdf);
      if (rawText.trim().length > 0) {
        allExtractedText.push(rawText.trim());
      }
    }

    // Secondary Fallback: Regex for parenthesis strings (e.g. `(Prompt de Imagem)`)
    if (allExtractedText.join('\n\n').trim().length < 10) {
      const literalStrings = [];
      const strRegex = /\(((?:[^()\\]|\\.)*)\)/g;
      let strMatch;
      while ((strMatch = strRegex.exec(rawPdf)) !== null) {
        const str = FlowPdfExtractor.unescapePdfString(strMatch[1]);
        if (str && str.length > 2 && !str.includes('Font') && !str.includes('PDF')) {
          literalStrings.push(str);
        }
      }
      if (literalStrings.length > 0) {
        allExtractedText.push(literalStrings.join(' '));
      }
    }

    const fullText = allExtractedText.join('\n\n');
    return {
      text: fullText,
      pages: allExtractedText
    };
  }

  /**
   * Helper to find subarray index
   */
  static indexOfSubarray(haystack, needle, startIndex = 0) {
    const hLen = haystack.length;
    const nLen = needle.length;
    if (nLen === 0) return 0;
    if (hLen < nLen) return -1;

    for (let i = startIndex; i <= hLen - nLen; i++) {
      let found = true;
      for (let j = 0; j < nLen; j++) {
        if (haystack[i + j] !== needle[j]) {
          found = false;
          break;
        }
      }
      if (found) return i;
    }
    return -1;
  }

  /**
   * Unescape PDF string literals: \( \) \\ \n \r \t \ooo
   */
  static unescapePdfString(str) {
    if (!str) return '';
    return str
      .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\b/g, '\b')
      .replace(/\\f/g, '\f')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
  }

  /**
   * Parse PDF text operators: BT...ET, Tj, TJ, ', "
   */
  static parsePdfOperators(streamContent) {
    if (!streamContent) return '';
    let result = '';
    
    // Extract BT ... ET blocks (Begin Text ... End Text)
    const btBlocks = streamContent.match(/BT[\s\S]*?ET/g) || [streamContent];

    for (const block of btBlocks) {
      let blockText = '';
      
      // Match TJ arrays: [(text1) -120 (text2)] TJ
      const tjArrayRegex = /\[((?:[^\(\]]*|\([^\)]*\))*?)\]\s*TJ/gi;
      let match;
      while ((match = tjArrayRegex.exec(block)) !== null) {
        const inner = match[1];
        const strRegex = /\(([^)]*)\)/g;
        let sMatch;
        let subText = '';
        while ((sMatch = strRegex.exec(inner)) !== null) {
          subText += FlowPdfExtractor.unescapePdfString(sMatch[1]);
        }
        if (subText) blockText += subText + ' ';
      }

      // Match single string Tj: (Some text) Tj
      const tjSingleRegex = /\(((?:[^()\\]|\\.)*)\)\s*Tj/gi;
      while ((match = tjSingleRegex.exec(block)) !== null) {
        blockText += FlowPdfExtractor.unescapePdfString(match[1]) + '\n';
      }

      // Match ' or " operators: (Text) ' or (Text) "
      const quoteRegex = /\(((?:[^()\\]|\\.)*)\)\s*['"]/gi;
      while ((match = quoteRegex.exec(block)) !== null) {
        blockText += '\n' + FlowPdfExtractor.unescapePdfString(match[1]) + '\n';
      }

      if (blockText.trim()) {
        result += blockText.trim() + '\n\n';
      }
    }

    return result.trim();
  }

  /**
   * Intelligently parses raw text into discrete prompt items
   * Supports structured scripts like:
   * - "Texto nos Balões: ... Prompt de Imagem: ..."
   * - "Cena 1:", "Cena 2:", "Scene 1", "Prompt 1"
   * - Page-by-page blocks or blank-line separated blocks
   */
  /**
   * Intelligently parses raw text or multi-page PDF text into discrete prompt/slide items
   * Intelligently parses raw text or multi-page PDF into Carousels (Lotes) with child Slides
   * Supports:
   * - "CARROSSEL 1: ...", "CARROSSEL 2: ...", up to N carousels
   * - "SLIDE 1", "SLIDE 2" inside each carousel
   * - "Texto nos Balões: PT: ...", "Prompt de Imagem (Midjourney / Dall-E): ..."
   * - Automatic dialogue placeholder replacement per slide
   * - Instagram Captions per carousel
   */
  static parseCarouselsFromScript(rawText, pages = []) {
    if (!rawText || !rawText.trim()) return [];
    const text = rawText.replace(/\r\n/g, '\n').trim();

    // 1. Detect Carousel headers
    const carouselHeaderRegex = /(?:^|\n)(?=(?:CARROSSEL|CAROUSEL|LOTE|POST)\s*#?\s*\d+)/i;
    const hasMultipleCarousels = carouselHeaderRegex.test(text);

    let rawCarousels = [];
    if (hasMultipleCarousels) {
      rawCarousels = text.split(carouselHeaderRegex).map(c => c.trim()).filter(c => c.length > 20);
    } else {
      rawCarousels = [text];
    }

    const carousels = [];

    rawCarousels.forEach((cText, cIdx) => {
      let title = `Carrossel ${cIdx + 1}`;
      let styleInfo = '';
      let caption = '';

      // Extract Carousel title
      const cTitleMatch = cText.match(/^(?:CARROSSEL|CAROUSEL|LOTE|POST)\s*#?\s*\d+[^\n]*/i);
      if (cTitleMatch) {
        title = cTitleMatch[0].trim();
      }

      // Extract Style / Niche
      const styleMatch = cText.match(/(?:Estilo|Style|Nicho|Niche)\s*:\s*[^\n]+/i);
      if (styleMatch) {
        styleInfo = styleMatch[0].trim();
      }

      // Extract Instagram Caption / Legenda
      const captionMatch = cText.match(/(?:LEGENDA\s+DO\s+INSTAGRAM|LEGENDA|CAPTION)\s*[\:\n]([\s\S]*?)(?=(?:#|$))/i);
      if (captionMatch) {
        caption = captionMatch[1].trim();
      }

      // Isolate slides content
      let slidesBody = cText;
      if (cTitleMatch) slidesBody = slidesBody.replace(cTitleMatch[0], '');
      if (styleMatch) slidesBody = slidesBody.replace(styleMatch[0], '');
      if (captionMatch) slidesBody = slidesBody.replace(captionMatch[0], '');

      // Split slides within this carousel
      const slideSplitRegex = /(?:^|\n)(?=(?:SLIDE|CENA|SCENE|QUADRO|PAINEL|PÁGINA|PAGE)\s*#?\s*\d+)/i;
      let slideBlocks = [];
      if (slideSplitRegex.test(slidesBody)) {
        slideBlocks = slidesBody.split(slideSplitRegex).map(s => s.trim()).filter(s => s.length > 15);
      } else {
        const balloonSplitRegex = /(?:^|\n)(?=(?:Texto\s+(?:nos?\s+)?Bal(?:ão|ões)|Bal(?:ão|ões)|Diálogo|Dialogue)\s*[\:\n])/i;
        if (balloonSplitRegex.test(slidesBody)) {
          slideBlocks = slidesBody.split(balloonSplitRegex).map(s => s.trim()).filter(s => s.length > 15);
        } else {
          slideBlocks = [slidesBody];
        }
      }

      const slides = slideBlocks.map((block, sIdx) => {
        let slideTitle = `Slide ${sIdx + 1}`;
        const titleMatch = block.match(/^(?:(?:SLIDE|CENA|SCENE|QUADRO|PAINEL|PÁGINA|PAGE)\s*#?\s*\d+[^\n]*)/i);
        if (titleMatch) slideTitle = titleMatch[0].trim();

        // Extract Portuguese balloon text
        let ptDialogue = '';
        let balloonText = '';
        const balloonMatch = block.match(/(?:Texto\s+(?:nos?\s+)?Bal(?:ão|ões)|Bal(?:ão|ões)|Diálogo|Dialogue)\s*[\:\n]([\s\S]*?)(?=(?:Prompt\s+de\s+Imagem|Image\s+Prompt|Visual\s+Prompt|$))/i);
        if (balloonMatch) {
          balloonText = balloonMatch[1].trim();
          const ptMatch = balloonText.match(/PT\s*:\s*["“]?([^"”\n\r]+)["”]?/i) || balloonText.match(/["“]([^"”]+)["”]/);
          if (ptMatch) {
            ptDialogue = ptMatch[1].trim();
          } else {
            ptDialogue = balloonText.split('\n')[0].replace(/^(?:PT|BR|Texto|Fala)\s*:\s*/i, '').trim();
          }
        }

        // Extract image prompt
        let imagePrompt = '';
        const promptMatch = block.match(/(?:Prompt\s+de\s+Imagem[^\n\:]*|Image\s+Prompt|Visual\s+Prompt)\s*[\:\n]\s*([\s\S]*?)(?=(?:LEGENDA|$))/i);
        if (promptMatch) {
          imagePrompt = promptMatch[1].trim();
        } else {
          imagePrompt = block.replace(titleMatch ? titleMatch[0] : '').replace(balloonMatch ? balloonMatch[0] : '').trim();
        }

        // Substitute dialogue placeholder
        let finalPrompt = imagePrompt;
        if (ptDialogue && finalPrompt.includes('dialogue placeholder')) {
          finalPrompt = finalPrompt.replace(/'dialogue placeholder'/gi, `'${ptDialogue}'`)
                                   .replace(/"dialogue placeholder"/gi, `"${ptDialogue}"`)
                                   .replace(/dialogue placeholder/gi, `'${ptDialogue}'`);
        }

        return {
          id: `slide_${cIdx + 1}_${sIdx + 1}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          index: sIdx + 1,
          globalIndex: 0, // Assigned below
          carouselIndex: cIdx + 1,
          carouselTitle: title,
          title: `${title} • ${slideTitle}`,
          slideTitle: slideTitle,
          balloonText: balloonText,
          ptDialogue: ptDialogue,
          imagePrompt: imagePrompt,
          fullText: finalPrompt || imagePrompt || block,
          enabled: true,
          repeatCount: 1,
          completedRepeats: 0,
          status: 'pending',
          errorMsg: ''
        };
      });

      carousels.push({
        id: `carousel_${cIdx + 1}`,
        index: cIdx + 1,
        title: title,
        styleInfo: styleInfo,
        caption: caption,
        slidesCount: slides.length,
        slides: slides,
        enabled: true,
        status: 'pending'
      });
    });

    // Assign continuous global indexes across all slides
    let gIdx = 1;
    carousels.forEach(c => {
      c.slides.forEach(s => {
        s.globalIndex = gIdx++;
      });
    });

    return carousels;
  }

  /**
   * Intelligently parses raw text or multi-page PDF text into discrete prompt/slide items
   */
  static parsePromptsFromScript(rawText, pages = []) {
    const carousels = FlowPdfExtractor.parseCarouselsFromScript(rawText, pages);
    const flatPrompts = [];
    carousels.forEach(c => {
      c.slides.forEach(s => flatPrompts.push(s));
    });
    return flatPrompts;
  }

  static createPromptItemFromBlock(blockText, index) {
    if (!blockText || blockText.trim().length === 0) return null;

    let title = `Slide #${index}`;
    let balloonText = '';
    let imagePrompt = '';
    let rawCleaned = blockText.trim();

    // 1. Extract Slide / Scene Title (e.g. "Slide 1", "Cena 2 - Encontro")
    const titleMatch = rawCleaned.match(/^(?:(?:Slide|Cena|Scene|Quadro|Painel|Página|Page|Prompt|Item)\s*#?\s*\d+[^\n]*)/i);
    if (titleMatch) {
      title = titleMatch[0].trim();
    }

    // 2. Extract "Texto nos Balões" (supports PT:, EN:, or direct quotes)
    const balloonHeaderRegex = /(?:Texto\s+(?:nos?\s+)?Bal(?:ão|ões)|Bal(?:ão|ões)|Diálogo|Dialogue)\s*[\:\n]([\s\S]*?)(?=(?:Prompt\s+de\s+Imagem[^\n\:]*|Image\s+Prompt|Visual\s+Prompt|Prompt\s*[\:\n]|$))/i;
    const balloonMatch = rawCleaned.match(balloonHeaderRegex);
    if (balloonMatch) {
      balloonText = balloonMatch[1].trim();
    }

    // 3. Extract "Prompt de Imagem (Midjourney / Dall-E / etc):"
    const promptHeaderRegex = /(?:Prompt\s+de\s+Imagem[^\n\:]*|Image\s+Prompt|Visual\s+Prompt|Prompt)\s*[\:\n]\s*([\s\S]*)$/i;
    const promptMatch = rawCleaned.match(promptHeaderRegex);
    if (promptMatch) {
      imagePrompt = promptMatch[1].trim();
    } else {
      // If no explicit prompt label was found, remove the balloon text part and keep the visual description
      if (balloonMatch) {
        imagePrompt = rawCleaned.replace(balloonMatch[0], '').replace(titleMatch ? titleMatch[0] : '', '').trim();
      } else {
        imagePrompt = rawCleaned.replace(titleMatch ? titleMatch[0] : '', '').trim();
      }
    }

    // 4. Extract Portuguese dialogue string specifically if available
    let ptDialogue = '';
    if (balloonText) {
      const ptMatch = balloonText.match(/PT\s*:\s*["“]?([^"”\n\r]+)["”]?/i) || balloonText.match(/["“]([^"”]+)["”]/);
      if (ptMatch) {
        ptDialogue = ptMatch[1].trim();
      } else {
        ptDialogue = balloonText.split('\n')[0].replace(/^(?:PT|BR|Texto|Fala)\s*:\s*/i, '').trim();
      }
    }

    // 5. Build full composite prompt for FLOW
    // If image prompt has 'dialogue placeholder', automatically substitute dialogue
    let finalPrompt = imagePrompt;
    if (ptDialogue && finalPrompt.includes('dialogue placeholder')) {
      finalPrompt = finalPrompt.replace(/'dialogue placeholder'/gi, `'${ptDialogue}'`)
                               .replace(/"dialogue placeholder"/gi, `"${ptDialogue}"`)
                               .replace(/dialogue placeholder/gi, `'${ptDialogue}'`);
    }

    // If title was default, generate a descriptive title from the dialogue
    if (title === `Slide #${index}` && ptDialogue) {
      const shortSnippet = ptDialogue.length > 35 ? ptDialogue.substring(0, 35) + '...' : ptDialogue;
      title = `Slide #${index} - "${shortSnippet}"`;
    }

    return {
      id: `prompt_${Date.now()}_${index}_${Math.random().toString(36).substring(2, 7)}`,
      index: index,
      title: title,
      balloonText: balloonText,
      ptDialogue: ptDialogue,
      imagePrompt: imagePrompt,
      fullText: finalPrompt || imagePrompt || blockText,
      enabled: true,
      repeatCount: 1,
      completedRepeats: 0,
      status: 'pending',
      errorMsg: '',
      characters: []
    };
  }
}

// Make available globally
if (typeof window !== 'undefined') {
  window.FlowPdfExtractor = FlowPdfExtractor;
}
