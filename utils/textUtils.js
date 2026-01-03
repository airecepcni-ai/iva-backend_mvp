/**
 * Text processing utilities for web crawling and content extraction.
 */

/**
 * Cleans text by removing extra whitespace, normalizing line breaks, and trimming.
 * @param {string} text - Raw text to clean
 * @returns {string} Cleaned text
 */
export function cleanText(text) {
  if (!text || typeof text !== 'string') return '';
  
  return text
    // Normalize line breaks
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Replace multiple newlines with double newline
    .replace(/\n{3,}/g, '\n\n')
    // Replace multiple spaces with single space
    .replace(/[ \t]+/g, ' ')
    // Remove leading/trailing whitespace from each line
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    // Final trim
    .trim();
}

/**
 * Splits text into overlapping chunks for embedding/processing.
 * @param {string} text - Text to chunk
 * @param {number} chunkSize - Maximum characters per chunk (default 900)
 * @param {number} overlap - Overlap between chunks in characters (default 150)
 * @returns {string[]} Array of text chunks
 */
export function chunkText(text, chunkSize = 900, overlap = 150) {
  if (!text || typeof text !== 'string') return [];
  
  const cleanedText = text.trim();
  if (cleanedText.length === 0) return [];
  
  // If text is shorter than chunk size, return as single chunk
  if (cleanedText.length <= chunkSize) {
    return [cleanedText];
  }
  
  const chunks = [];
  let start = 0;
  
  while (start < cleanedText.length) {
    // Calculate end position
    let end = Math.min(start + chunkSize, cleanedText.length);
    
    // If this is not the last chunk, try to break at a sentence or word boundary
    if (end < cleanedText.length) {
      // Look for sentence boundary (. ! ?) within the last 20% of the chunk
      const searchStart = Math.max(start + Math.floor(chunkSize * 0.8), start);
      const searchText = cleanedText.substring(searchStart, end);
      
      // Find last sentence boundary
      const sentenceMatch = searchText.match(/[.!?]\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/);
      if (sentenceMatch) {
        end = searchStart + sentenceMatch.index + 1;
      } else {
        // Fall back to word boundary
        const lastSpace = cleanedText.lastIndexOf(' ', end);
        if (lastSpace > start + chunkSize * 0.5) {
          end = lastSpace;
        }
      }
    }
    
    // Extract chunk and trim
    const chunk = cleanedText.substring(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    
    // Move start position: advance by (end - start - overlap) to create overlap
    // But ensure we always move forward by at least 1 character to prevent infinite loops
    const step = end - start;
    const nextStart = end - overlap;
    
    // Ensure we move forward (prevent infinite loops)
    if (nextStart <= start) {
      start = end; // No overlap possible, just move to end
    } else {
      start = nextStart;
    }
    
    // Safety: if we've created too many chunks, break (shouldn't happen with correct logic)
    if (chunks.length > cleanedText.length) {
      console.error('[chunkText] Too many chunks created, breaking infinite loop');
      break;
    }
  }
  
  return chunks;
}

