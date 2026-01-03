import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from './supabaseClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATE_FILE_NAME = 'iva_prompt_v1_template.txt';

/**
 * Load business_profile for a tenant.
 * @param {string} tenantId - Business ID (UUID)
 * @returns {Promise<Object|null>} Business profile data or null if not found/error
 */
async function getBusinessProfileForTenant(tenantId) {
  if (!tenantId) return null;

  try {
    const { data, error } = await supabase
      .from('business_profile')
      .select('*')
      .eq('business_id', tenantId)
      .single();

    if (error) {
      console.warn('[PROMPT] Error loading business_profile for tenant', tenantId, error.message);
      return null;
    }

    if (!data) {
      console.warn('[PROMPT] No business_profile row for tenant', tenantId);
      return null;
    }

    return data;
  } catch (err) {
    console.warn('[PROMPT] Exception loading business_profile for tenant', tenantId, err);
    return null;
  }
}

/**
 * Apply template replacements to prompt template.
 * @param {string} template - Template string with placeholders
 * @param {Object} params
 * @param {Object} params.settings - IVA settings object
 * @param {Object} params.businessProfile - Business profile object
 * @returns {string} Template with placeholders replaced
 */
function applyPromptTemplate(template, { settings, businessProfile }) {
  let result = template;

  // Map to real Supabase columns first, then fallbacks.
  // business_profile example:
  // name_display, name, name_legal, address, phone, email, website_url, notes, ...
  const businessName =
    businessProfile?.name_display ||
    businessProfile?.name ||
    businessProfile?.name_legal ||
    businessProfile?.display_name ||   // fallback if we later rename columns
    businessProfile?.legal_name ||     // fallback
    'váš salon';

  // We currently don't have a dedicated city column, so keep it empty or later parse from address.
  const businessCity =
    businessProfile?.city || ''; // will usually be empty for now

  const businessPhone =
    businessProfile?.phone || '';

  const businessWebsite =
    businessProfile?.website_url ||
    businessProfile?.website ||
    '';

  const businessType =
    businessProfile?.business_type || 'salon';

  const greeting =
    settings?.greeting ||
    'Dobrý den, tady IVA. Jak vám mohu pomoci?';

  const tone =
    settings?.tone || 'friendly';

  // Also handle existing placeholders from template
  const address =
    businessProfile?.address ||
    businessProfile?.street ||
    '';

  const servicesSummary =
    businessProfile?.services_summary ||
    'kadeřnické a kosmetické služby';

  const locationsArray = Array.isArray(settings?.locations) ? settings.locations : [];
  const locationsText =
    locationsArray.length === 0
      ? ''
      : locationsArray
          .map((loc) => {
            const name = loc?.name || '';
            const addr = loc?.address ? ` – ${loc.address}` : '';
            return `- ${name}${addr}`;
          })
          .join('\n');

  const nowIso = new Date().toISOString();

  const replacements = {
    '{{BUSINESS_NAME}}': businessName,
    '{{BUSINESS_CITY}}': businessCity,
    '{{BUSINESS_PHONE}}': businessPhone,
    '{{BUSINESS_WEBSITE}}': businessWebsite,
    '{{BUSINESS_TYPE}}': businessType,
    '{{BUSINESS_ADDRESS}}': address,
    '{{BUSINESS_SERVICES_SUMMARY}}': servicesSummary,
    '{{IVA_GREETING}}': greeting,
    '{{IVA_TONE}}': tone,
    '{{LOCATIONS_LIST}}': locationsText,
    '{{TODAY_ISO}}': nowIso,
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    // Gracefully handle undefined / null by replacing with empty string
    const safeValue = (value ?? '').toString();
    result = result.replaceAll(placeholder, safeValue);
  }

  return result;
}

/**
 * Build system prompt for IVA based on tenant settings and business profile.
 * @param {Object} params
 * @param {string} params.tenantId - Business ID (UUID)
 * @param {Object} params.settings - IVA settings object from iva_settings table
 * @returns {Promise<string>} Complete system prompt with placeholders replaced
 */
export async function buildSystemPrompt({ tenantId, settings }) {
  console.log('[PROMPT] buildSystemPrompt called for tenant', tenantId);

  // 1) Full override from DB, if present
  if (settings?.system_prompt && settings.system_prompt.trim().length > 0) {
    console.log('[PROMPT] Using system_prompt override from DB');
    const trimmed = settings.system_prompt.trim();
    console.log('[PROMPT] Prompt preview (override):', trimmed.slice(0, 200), '...');
    return trimmed;
  }

  // 2) Load template from file
  const templatePath = path.join(__dirname, '..', 'prompts', TEMPLATE_FILE_NAME);

  let template;
  try {
    template = await fs.readFile(templatePath, 'utf8');
  } catch (err) {
    console.error('[PROMPT] Failed to load prompt template', TEMPLATE_FILE_NAME, err);
    // Fallback: use some minimal default if the file is missing
    return 'Jsi česká hlasová recepční jménem IVA. Mluv česky, přátelsky a profesionálně.';
  }

  // 3) Load business_profile for tenant
  const businessProfile = await getBusinessProfileForTenant(tenantId);

  // 4) Apply replacements
  const finalPrompt = applyPromptTemplate(template, { settings, businessProfile });

  console.log('[PROMPT] Business profile used for template:', {
    business_id: businessProfile?.business_id,
    name_display: businessProfile?.name_display,
    name: businessProfile?.name,
    phone: businessProfile?.phone,
    website_url: businessProfile?.website_url,
  });

  console.log('[PROMPT] Using template source: file_v1_template');
  console.log('[PROMPT] Prompt preview (after replacements):', finalPrompt.slice(0, 200), '...');

  return finalPrompt;
}
