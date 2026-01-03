import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'iva_prompt_default.txt');

/**
 * Format current date/time for Czech prompt
 * @returns {string} Formatted date/time string in cs-CZ locale, Europe/Prague timezone
 */
function formatNowForCzechPrompt() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('cs-CZ', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Europe/Prague',
  });
  return formatter.format(now);
}

/**
 * Build base system prompt from template file, replacing {{now}} with current date/time
 * @returns {string} System prompt with {{now}} replaced
 */
export function buildBaseSystemPrompt() {
  try {
    const template = fs.readFileSync(BASE_PROMPT_PATH, 'utf8');
    const nowStr = formatNowForCzechPrompt();
    // Replace all occurrences of {{now}} in the template
    return template.replace(/{{now}}/g, nowStr);
  } catch (error) {
    console.error('[PROMPTS] Error loading base prompt template:', error.message);
    console.error('[PROMPTS] Falling back to default prompt without date');
    // Fallback: return a basic prompt if file can't be read
    return `Dnešní datum a čas: ${formatNowForCzechPrompt()}\n\nJsi chytrá česká hlasová recepční jménem IVA.`;
  }
}

/**
 * Replace {{now}} placeholder in any prompt text
 * @param {string} promptText - Prompt text that may contain {{now}}
 * @returns {string} Prompt text with {{now}} replaced
 */
export function replaceNowPlaceholder(promptText) {
  if (!promptText) return promptText;
  const nowStr = formatNowForCzechPrompt();
  return promptText.replace(/{{now}}/g, nowStr);
}














