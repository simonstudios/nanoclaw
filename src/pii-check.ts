import { AnonymizeConfig } from './anonymize.js';
import { logger } from './logger.js';

export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = 'gemma4:e4b';
const TIMEOUT_MS = 90_000;

export const PII_CMD_APPROVE = 'approve';
export const PII_CMD_SKIP = 'skip';
export const PII_CMD_MAP_PREFIX = 'map ';

export interface PiiItem {
  text: string;
  type: string;
  suggestion: string;
  /** Set when matchVariant detects this is likely a nickname of an existing mapping. */
  variantOf?: string;
  /** Source file when PII was found in media (e.g. "report.pdf", "img-1234.jpg"). */
  source?: string;
}

export interface PiiResult {
  found: PiiItem[];
}

/**
 * Heuristic filter: reject findings that look like medical/clinical terms
 * rather than actual PII. The Ollama model frequently flags these despite
 * prompt instructions not to.
 */
const MEDICAL_KEYWORDS = [
  'vaccine',
  'vaccination',
  'immunisation',
  'immunization',
  'prescription',
  'allergy',
  'allergies',
  'drooling',
  'rash',
  'feeding',
  'weaning',
  'eczema',
  'reflux',
  'asthma',
  'cough',
  'coughing',
  'teething',
  'eruption',
  'multivitamin',
  'vitamin',
  'paracetamol',
  'ibuprofen',
  'antibiotic',
  'neocate',
  'aptamil',
  'gaviscon',
  'omeprazole',
  'diagnosis',
  'prognosis',
  'symptom',
  'treatment',
  'mileston',
  'centile',
  'percentile',
  'weight gain',
  'head circumference',
  'developmental',
  'rsv',
  'mmr',
  'bcg',
  'dtap',
  'dentist',
  'gp visit',
  'health visitor',
  'review',
  'clinic',
  'referral',
];

function isMedicalTerm(text: string): boolean {
  const lower = text.toLowerCase();
  return MEDICAL_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Structured PII patterns that the LLM sometimes misses. */
const STRUCTURED_PII_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  // NHS numbers: 10 digits, optionally spaced as 3-3-4
  { pattern: /\b[1-9]\d{2}\s?\d{3}\s?\d{4}\b/g, type: 'other' },
  // UK postcodes
  {
    pattern: /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi,
    type: 'address',
  },
  // UK phone numbers (landline and mobile)
  { pattern: /\b0\d{2,4}\s?\d{3,4}\s?\d{3,4}\b/g, type: 'phone' },
  // Email addresses
  { pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, type: 'email' },
  // Case/reference numbers (e.g. Ref: 2675434)
  { pattern: /\bRef[:\s#]+\d{4,}\b/gi, type: 'other' },
];

function scanForStructuredPii(
  text: string,
  pseudonymSet: Set<string>,
): PiiItem[] {
  const items: PiiItem[] = [];
  const seen = new Set<string>();
  for (const { pattern, type } of STRUCTURED_PII_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(re)) {
      const found = match[0].trim();
      if (seen.has(found) || pseudonymSet.has(found.toLowerCase())) continue;
      seen.add(found);
      items.push({ text: found, type, suggestion: '' });
    }
  }
  return items;
}

/**
 * Ask a local Ollama model to scan already-anonymized text for any remaining PII.
 * Returns found items, or null if clean / error / timeout / piiCheck disabled.
 */
export async function checkForPii(
  anonymizedText: string,
  config: AnonymizeConfig,
): Promise<PiiResult | null> {
  if (!config.piiCheck) return null;

  const model = config.piiModel || DEFAULT_MODEL;
  const knownPseudonyms = Object.values(config.mappings).join(', ');

  const prompt = `You are a PII detector. Analyze this message for any personally identifiable information (PII) that has NOT been anonymized. PII includes: real names of people, nicknames, dates of birth, home addresses, postcodes, phone numbers, email addresses, social worker names, case reference numbers.

IMPORTANT — Do NOT flag any of the following as PII:
- Medical or clinical terms (symptoms, diagnoses, conditions, procedures)
- Prescription or medication names (e.g. Neocate, paracetamol, omeprazole)
- Vaccine names or abbreviations (RSV, MMR, BCG)
- Health descriptions (drooling, rash, weight gain, feeding)
- General schedules or milestones (e.g. "from age 1", "12 months")
- Organisation types without specific names (e.g. "the GP", "the nursery")
Only flag things that identify a SPECIFIC person, place, or contact detail.

Known pseudonyms already in use (these are NOT PII — ignore them): ${knownPseudonyms}

Message to analyze:
"""
${anonymizedText}
"""

If you find PII, respond with JSON: {"found": [{"text": "the exact PII text", "type": "name|date|address|phone|email|other"}]}
If no PII found, respond with: {"found": []}
Respond with ONLY valid JSON, nothing else.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`Ollama returned status ${resp.status}`);
    }

    const body = (await resp.json()) as { response?: string };
    if (!body.response) {
      throw new Error('Ollama returned empty response');
    }

    // Extract JSON from response (model may include markdown fences)
    const jsonStr = body.response
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    const parsed = JSON.parse(jsonStr) as PiiResult;

    if (!Array.isArray(parsed.found)) {
      throw new Error(
        'Ollama returned malformed response (missing found array)',
      );
    }

    // Filter out any findings that are actually known pseudonyms
    const pseudonymSet = new Set(
      Object.values(config.mappings).map((v) => v.toLowerCase()),
    );
    parsed.found = parsed.found.filter(
      (item) => !pseudonymSet.has(item.text.toLowerCase()),
    );

    // Filter out non-PII types the model sometimes returns despite instructions
    const ACCEPTED_TYPES = new Set([
      'name',
      'date',
      'address',
      'phone',
      'email',
      'other',
    ]);
    parsed.found = parsed.found.filter((item) =>
      ACCEPTED_TYPES.has(item.type.toLowerCase()),
    );

    // Filter out medical/clinical false positives via keyword heuristic
    parsed.found = parsed.found.filter((item) => !isMedicalTerm(item.text));

    // Supplement with regex-based detection for structured patterns the
    // LLM may miss (NHS numbers, postcodes, phone numbers, emails).
    const regexFindings = scanForStructuredPii(anonymizedText, pseudonymSet);
    for (const rf of regexFindings) {
      if (!parsed.found.some((f) => f.text === rf.text)) {
        parsed.found.push(rf);
      }
    }

    // Generate pseudonyms for all items (LLM + regex combined)
    const usedPseudonyms = new Set(Object.values(config.mappings));
    for (const item of parsed.found) {
      const match = matchVariant(item.text, config.mappings);
      if (match) {
        item.suggestion = match.pseudo;
        item.variantOf = match.real;
      } else {
        item.suggestion = generatePseudonym(usedPseudonyms);
        usedPseudonyms.add(item.suggestion);
      }
    }

    if (parsed.found.length === 0) return null;
    return parsed;
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Ollama request timed out (is the model loaded?)');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pre-load the Ollama model into memory so the first real PII check
 * doesn't pay the cold-start penalty (~20-30s model load).
 * Fire-and-forget — does not block startup.
 */
export function warmupPiiModel(config: AnonymizeConfig): void {
  if (!config.piiCheck) return;
  const model = config.piiModel || DEFAULT_MODEL;
  logger.info({ model }, 'pii-check: warming up Ollama model');
  fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: 'hi', stream: false }),
  }).catch((err) => {
    logger.warn(
      { err },
      'pii-check: warmup failed (Ollama may not be running)',
    );
  });
}

/** Pool of nature/object themed pseudonyms. Clearly not real names. */
const PSEUDONYM_POOL = [
  'Ember',
  'Azure',
  'Coral',
  'Sage',
  'River',
  'Cedar',
  'Ivory',
  'Jade',
  'Pearl',
  'Flint',
  'Hazel',
  'Onyx',
  'Robin',
  'Sterling',
  'Wren',
  'Briar',
  'Echo',
  'Fern',
  'Harbor',
  'Indigo',
  'Lark',
  'Maple',
  'Nova',
  'Orion',
  'Piper',
  'Reed',
  'Sable',
  'Terra',
  'Vale',
  'Willow',
];

/** Pick the next unused pseudonym from the pool. */
export function generatePseudonym(usedPseudonyms: Set<string>): string {
  const used = new Set([...usedPseudonyms].map((v) => v.toLowerCase()));
  for (const name of PSEUDONYM_POOL) {
    if (!used.has(name.toLowerCase())) return name;
  }
  // Fallback if pool exhausted
  return `Person${usedPseudonyms.size + 1}`;
}

/**
 * Deterministic variant detection using string similarity.
 * Returns the existing pseudonym + real name if the detected name is likely
 * a nickname or shortened form.
 *
 * Uses two strategies:
 * 1. Shared prefix ≥3 chars (catches Sim→Simon, Liv→Olivia)
 * 2. Levenshtein distance ≤2 for similar-length names (catches Livvy↔Olivia)
 *
 * The old 3-char sliding window was too permissive — "drooling" matched
 * "Olivia" because both contain "oli". This version avoids those false positives.
 */
export function matchVariant(
  detectedName: string,
  mappings: Record<string, string>,
): { pseudo: string; real: string } | null {
  const lower = detectedName.toLowerCase();
  if (lower.length < 3) return null;

  // Skip multi-word phrases — variant detection is for name variants,
  // not for sentences or medical terms that happen to overlap
  if (lower.includes(' ') && lower.split(/\s+/).length > 2) return null;

  for (const [real, pseudo] of Object.entries(mappings)) {
    const realLower = real.toLowerCase();
    if (realLower.length < 3) continue;

    // Skip non-name mappings (emails, postcodes, phone numbers, dates)
    if (realLower.includes('@') || /^\d/.test(realLower)) continue;

    // Strategy 1: Shared prefix ≥3 chars
    const minLen = Math.min(lower.length, realLower.length);
    let prefixLen = 0;
    for (let i = 0; i < minLen; i++) {
      if (lower[i] === realLower[i]) prefixLen++;
      else break;
    }
    if (prefixLen >= 3) return { pseudo, real };

    // Strategy 2: One name contains the other (Liv inside Olivia)
    if (
      lower.length >= 3 &&
      realLower.length >= 3 &&
      (realLower.includes(lower) || lower.includes(realLower))
    ) {
      return { pseudo, real };
    }

    // Strategy 3: Levenshtein distance ≤3 for similar-length strings
    // Catches nickname variants like Livvy↔Olivia (distance 3)
    if (Math.abs(lower.length - realLower.length) <= 3) {
      if (levenshtein(lower, realLower) <= 3) {
        return { pseudo, real };
      }
    }
  }
  return null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

/** Format a PII alert message for the user. */
export function formatPiiAlert(result: PiiResult): string {
  const textItems = result.found.filter((i) => !i.source);
  const mediaItems = result.found.filter((i) => i.source);
  const hasImagePii = mediaItems.some((i) =>
    /\.(jpe?g|png|gif|webp)$/i.test(i.source!),
  );

  const formatItem = (item: PiiItem): string => {
    const linkNote = item.variantOf ? ` (variant of ${item.variantOf})` : '';
    const sourceNote = item.source ? `, in ${item.source}` : '';
    return `  - "${item.text}" (${item.type}${sourceNote})${linkNote} — suggest mapping to "${item.suggestion}"`;
  };

  const lines: string[] = ['PII detected in pending message:'];
  for (const item of [...textItems, ...mediaItems]) {
    lines.push(formatItem(item));
  }

  if (hasImagePii) {
    lines.push('');
    lines.push(
      'Note: Image content cannot be anonymized. Approving will send the image to the agent with PII visible.',
    );
  }

  lines.push('');
  lines.push('Reply:');
  lines.push(`  "${PII_CMD_APPROVE}" — add suggested mappings and send`);
  lines.push(`  "${PII_CMD_SKIP}" — send without new mappings`);
  lines.push(
    `  "${PII_CMD_MAP_PREFIX}X > Y" — use custom pseudonym (e.g. "map Livvy > Lulu")`,
  );

  return lines.join('\n');
}
