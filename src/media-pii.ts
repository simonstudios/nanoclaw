import fs from 'fs';
import path from 'path';

import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

import { anonymize, AnonymizeConfig } from './anonymize.js';
import { DATA_DIR } from './config.js';
import { IMAGE_REF_SOURCE, parseImageReferences } from './image.js';
import { logger } from './logger.js';
import { checkForPii, OLLAMA_URL, PiiItem } from './pii-check.js';

const DEFAULT_VISION_MODEL = 'gemma4:e4b';
const VISION_TIMEOUT_MS = 60_000;
const MAX_DOC_SIZE = 10 * 1024 * 1024; // 10MB

/** Matches [DOC: attachments/file.pdf (50KB)] and legacy [PDF: ...] references.
 *  Captures the full path including spaces in filenames. */
const DOC_REF_SOURCE = String.raw`\[(?:PDF|DOC): (attachments\/[^()\[\]]+?)\s*(?:\(\d+KB\))?\](?:\n?Use: pdf-reader extract [^\n]+)?`;

/**
 * Extract text from a document file (PDF, Word, or plain text).
 * Returns null on error (password-protected, corrupt, too large, unsupported).
 */
export async function extractDocText(docPath: string): Promise<string | null> {
  try {
    const stat = fs.statSync(docPath);
    if (stat.size > MAX_DOC_SIZE) {
      logger.warn(
        { path: docPath, sizeBytes: stat.size },
        'media-pii: document too large, skipping extraction',
      );
      return null;
    }

    const ext = path.extname(docPath).toLowerCase();
    const buffer = fs.readFileSync(docPath);

    if (ext === '.pdf') {
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        // Strip pdf-parse pagination footers like "-- 1 of 3 --"
        const cleaned = (result.text || '')
          .replace(/--\s*\d+\s*of\s*\d+\s*--/g, '')
          .trim();
        return cleaned || null;
      } finally {
        await parser.destroy();
      }
    }

    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim() || null;
    }

    if (ext === '.txt') {
      return buffer.toString('utf-8').trim() || null;
    }

    logger.warn({ path: docPath, ext }, 'media-pii: unsupported document type');
    return null;
  } catch (err) {
    logger.warn(
      { err, path: docPath },
      'media-pii: failed to extract document text',
    );
    return null;
  }
}

/**
 * Check a PDF for PII by extracting text, anonymizing, and running
 * through the Ollama PII checker.
 */
export async function checkDocPii(
  docPath: string,
  filename: string,
  config: AnonymizeConfig,
): Promise<PiiItem[]> {
  const text = await extractDocText(docPath);
  if (!text) return [];

  const anonymized = anonymize(text, config);
  const result = await checkForPii(anonymized, config);
  if (!result) return [];

  return result.found.map((item) => ({ ...item, source: filename }));
}

export interface MediaCheckFailure {
  filename: string;
  reason: string;
}

/**
 * Extract text from an image using an Ollama vision model.
 * Returns the raw text the model reads, or null if the model sees no text.
 * Throws on Ollama errors (connection refused, timeout, model not found)
 * so callers can distinguish "clean image" from "couldn't check".
 */
export async function extractImageText(
  imagePath: string,
  config: AnonymizeConfig,
): Promise<string | null> {
  const model = config.piiVisionModel || DEFAULT_VISION_MODEL;

  let imageData: string;
  try {
    const buffer = fs.readFileSync(imagePath);
    imageData = buffer.toString('base64');
  } catch (err) {
    logger.warn({ err, path: imagePath }, 'media-pii: failed to read image');
    // Throw so checkImagePii treats this as a failure (fail-closed),
    // not as "no text found" which would prompt for confirmation.
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt:
          'Read all text visible in this image. Output ONLY the text you see, nothing else. Include all names, dates, addresses, and reference numbers exactly as written.',
        images: [imageData],
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`Ollama returned status ${resp.status}`);
    }

    const body = (await resp.json()) as { response?: string };
    return body.response?.trim() || null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ImagePiiResult {
  items: PiiItem[];
  /** Set when the check could not run — image should be stripped. */
  failure?: MediaCheckFailure;
  /** Raw text extracted from image (before anonymization). When present,
   *  the caller should inline this text instead of sending the image. */
  extractedText?: string;
  /** True when the vision model found no readable text. The caller should
   *  prompt the user for confirmation before sending the raw image. */
  needsConfirmation?: boolean;
}

/**
 * Process an image for PII safety:
 * - If the image contains readable text: extract it (for the caller to
 *   anonymize and inline instead of the image). The raw image is NOT sent.
 * - If the image has no readable text: flag it for user confirmation.
 * - If the vision model is unreachable: return a failure (fail-closed).
 */
export async function checkImagePii(
  imagePath: string,
  filename: string,
  config: AnonymizeConfig,
): Promise<ImagePiiResult> {
  // Stage 1: Extract text from image via vision model
  let imageText: string | null;
  try {
    imageText = await extractImageText(imagePath, config);
  } catch {
    return {
      items: [],
      failure: { filename, reason: 'vision model unreachable' },
    };
  }

  // No readable text — image needs user confirmation before sending
  if (imageText === null) {
    return { items: [], needsConfirmation: true };
  }

  logger.debug(
    { filename, textLength: imageText.length },
    'media-pii: extracted text from image',
  );

  // Stage 2: Anonymize extracted text and check for PII
  const anonymized = anonymize(imageText, config);
  const result = await checkForPii(anonymized, config);

  return {
    items: result?.found.map((item) => ({ ...item, source: filename })) ?? [],
    extractedText: imageText,
  };
}

/**
 * Orchestrate PII checks across all PDFs and images in a set of messages.
 * Runs PDF checks first (reuses text model), then image checks (loads vision model).
 */
export async function checkMediaPii(
  messages: Array<{ content: string }>,
  groupDir: string,
  config: AnonymizeConfig,
): Promise<PiiItem[]> {
  const allItems: PiiItem[] = [];

  // Collect PDF references
  for (const ref of collectDocRefs(messages.map((m) => m.content).join('\n'))) {
    const fullPath = path.join(groupDir, ref.relativePath);
    const items = await checkDocPii(fullPath, ref.filename, config);
    allItems.push(...items);
  }

  // Check images (sequential to avoid Ollama memory pressure)
  for (const img of parseImageReferences(messages)) {
    const fullPath = path.join(groupDir, img.relativePath);
    const result = await checkImagePii(
      fullPath,
      path.basename(img.relativePath),
      config,
    );
    allItems.push(...result.items);
  }

  return allItems;
}

/** Extract PDF reference paths from text using a fresh regex instance. */
function collectDocRefs(
  text: string,
): Array<{ relativePath: string; filename: string; fullMatch: string }> {
  const pattern = new RegExp(DOC_REF_SOURCE, 'g');
  const refs: Array<{
    relativePath: string;
    filename: string;
    fullMatch: string;
  }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    refs.push({
      relativePath: match[1],
      filename: path.basename(match[1]),
      fullMatch: match[0],
    });
  }
  return refs;
}

export interface DocSubstitutionResult {
  prompt: string;
  /** PDFs that could not be extracted — the reference was stripped to prevent
   *  the container from reading the raw file via pdf-reader. */
  failures: MediaCheckFailure[];
  /** Docs that were successfully extracted — caller decides whether to quarantine
   *  based on PII results. Each entry has the full path and filename. */
  extractedDocs: Array<{ fullPath: string; filename: string }>;
}

/**
 * Replace [DOC: ...] and [PDF: ...] references in the prompt with anonymized
 * extracted text. Supports PDF, Word (.docx), and plain text files.
 * This is deterministic (no Ollama calls) and safe for the streaming path.
 *
 * If extraction fails, the reference is STRIPPED (not left in place)
 * to prevent the container from reading the raw, unanonymized file.
 */
export async function substituteDocContent(
  prompt: string,
  groupDir: string,
  config: AnonymizeConfig,
): Promise<DocSubstitutionResult> {
  const replacements = collectDocRefs(prompt);
  if (replacements.length === 0)
    return { prompt, failures: [], extractedDocs: [] };

  let result = prompt;
  const failures: MediaCheckFailure[] = [];
  const extractedDocs: Array<{ fullPath: string; filename: string }> = [];

  for (const rep of replacements) {
    const fullPath = path.join(groupDir, rep.relativePath);
    const filename = path.basename(rep.relativePath);
    const text = await extractDocText(fullPath);
    if (text) {
      const substitution = `[Document content from ${filename}]\n${text}\n[End document content]`;
      result = result.replace(rep.fullMatch, substitution);
      extractedDocs.push({ fullPath, filename });
    } else {
      result = result.replace(
        rep.fullMatch,
        `[Document: ${filename} — could not extract text for PII check, content withheld]`,
      );
      failures.push({ filename, reason: 'text extraction failed' });
      // Quarantine files that couldn't be extracted (fail-closed)
      quarantineFile(fullPath, groupDir);
    }
  }

  return { prompt: result, failures, extractedDocs };
}

/**
 * Move a file from the container-accessible group directory to a quarantine
 * directory that is NOT mounted into the container. This prevents the agent
 * from reading the raw unanonymized file via the filesystem.
 */
export function quarantineFile(filePath: string, groupDir: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const groupName = path.basename(groupDir);
    const quarantineDir = path.join(DATA_DIR, 'quarantine', groupName);
    fs.mkdirSync(quarantineDir, { recursive: true });
    const dest = path.join(quarantineDir, path.basename(filePath));
    fs.renameSync(filePath, dest);
    logger.info(
      { from: filePath, to: dest },
      'media-pii: document quarantined — removed from container-accessible path',
    );
  } catch (err) {
    logger.warn(
      { err, filePath },
      'media-pii: failed to quarantine file — attempting delete',
    );
    try {
      fs.unlinkSync(filePath);
    } catch {
      logger.error(
        { filePath },
        'media-pii: CRITICAL — could not remove raw file from container path',
      );
    }
  }
}

/**
 * Returns true if any message contains document or image references
 * that require PII checking before being sent to the container.
 */
export function hasMediaReferences(
  messages: Array<{ content: string }>,
): boolean {
  const docPattern = new RegExp(DOC_REF_SOURCE);
  const imgPattern = new RegExp(IMAGE_REF_SOURCE);
  return messages.some(
    (m) => docPattern.test(m.content) || imgPattern.test(m.content),
  );
}

/**
 * Pre-load the Ollama vision model into memory.
 * Fire-and-forget — does not block startup.
 */
export function warmupVisionModel(config: AnonymizeConfig): void {
  if (!(config.mediaPiiCheck ?? config.piiCheck)) return;
  const model = config.piiVisionModel || DEFAULT_VISION_MODEL;
  logger.info({ model }, 'media-pii: warming up vision model');
  fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: 'hi', stream: false }),
  }).catch((err) => {
    logger.warn(
      { err, model },
      'media-pii: vision model warmup failed (model may not be pulled)',
    );
  });
}
