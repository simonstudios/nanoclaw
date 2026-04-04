import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnonymizeConfig } from './anonymize.js';

// Mock PDFParse class before importing media-pii
const mockGetText = vi.fn();
const mockDestroy = vi.fn();
vi.mock('pdf-parse', () => {
  class MockPDFParse {
    getText = mockGetText;
    destroy = mockDestroy;
  }
  return { PDFParse: MockPDFParse };
});

const mockExtractRawText = vi.fn();
vi.mock('mammoth', () => ({
  default: {
    extractRawText: (...args: unknown[]) => mockExtractRawText(...args),
  },
}));

import {
  checkImagePii,
  checkMediaPii,
  checkDocPii,
  extractDocText,
  substituteDocContent,
  warmupVisionModel,
} from './media-pii.js';

const mockFetch = vi.fn();

const baseCfg: AnonymizeConfig = {
  enabled: true,
  piiCheck: true,
  piiModel: 'gemma4:e4b',
  mediaPiiCheck: true,
  piiVisionModel: 'gemma4:e4b',
  mappings: { Olivia: 'Luna', Simon: 'Alex' },
};

const groupDir = '/tmp/test-group';

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  vi.spyOn(fs, 'statSync').mockReturnValue({ size: 1024 } as fs.Stats);
  vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('fake content'));
  mockDestroy.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
  mockGetText.mockReset();
  mockDestroy.mockReset();
  mockExtractRawText.mockReset();
});

describe('extractDocText', () => {
  it('returns extracted text from a PDF', async () => {
    mockGetText.mockResolvedValue({ text: 'Hello World' });

    const result = await extractDocText('/tmp/test.pdf');
    expect(result).toBe('Hello World');
  });

  it('returns null for PDFs larger than 10MB', async () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({
      size: 11 * 1024 * 1024,
    } as fs.Stats);

    const result = await extractDocText('/tmp/large.pdf');
    expect(result).toBeNull();
    expect(mockGetText).not.toHaveBeenCalled();
  });

  it('returns null when pdf-parse throws', async () => {
    mockGetText.mockRejectedValue(new Error('encrypted'));

    const result = await extractDocText('/tmp/encrypted.pdf');
    expect(result).toBeNull();
  });

  it('returns null when pdf has no text', async () => {
    mockGetText.mockResolvedValue({ text: '' });

    const result = await extractDocText('/tmp/empty.pdf');
    expect(result).toBeNull();
  });
});

describe('checkDocPii', () => {
  it('detects PII in PDF text and tags with source', async () => {
    mockGetText.mockResolvedValue({
      text: 'Report by Claire Smith about the case',
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          found: [{ text: 'Claire Smith', type: 'name' }],
        }),
      }),
    });

    const items = await checkDocPii('/tmp/report.pdf', 'report.pdf', baseCfg);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('Claire Smith');
    expect(items[0].source).toBe('report.pdf');
    expect(items[0].suggestion).toBe('Ember');
  });

  it('returns empty array when PDF extraction fails', async () => {
    mockGetText.mockRejectedValue(new Error('corrupt'));

    const items = await checkDocPii('/tmp/bad.pdf', 'bad.pdf', baseCfg);
    expect(items).toHaveLength(0);
  });

  it('returns empty array when no PII found in PDF', async () => {
    mockGetText.mockResolvedValue({ text: 'Luna and Alex went shopping' });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({ found: [] }),
      }),
    });

    const items = await checkDocPii('/tmp/clean.pdf', 'clean.pdf', baseCfg);
    expect(items).toHaveLength(0);
  });
});

describe('checkImagePii', () => {
  it('returns extractedText + PII items when image contains readable text', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'Letter to Dr Patel, 15 Oak Road' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            found: [{ text: 'Dr Patel', type: 'name' }],
          }),
        }),
      });

    const result = await checkImagePii('/tmp/doc.jpg', 'img-1234.jpg', baseCfg);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].text).toBe('Dr Patel');
    expect(result.extractedText).toBe('Letter to Dr Patel, 15 Oak Road');
    expect(result.needsConfirmation).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });

  it('returns failure when vision model is unreachable (fail-closed)', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const result = await checkImagePii('/tmp/doc.jpg', 'img-1234.jpg', baseCfg);
    expect(result.items).toHaveLength(0);
    expect(result.failure).toBeDefined();
    expect(result.failure!.filename).toBe('img-1234.jpg');
  });

  it('returns needsConfirmation when vision model finds no text', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ response: '' }),
    });

    const result = await checkImagePii(
      '/tmp/clean.jpg',
      'img-5678.jpg',
      baseCfg,
    );
    expect(result.items).toHaveLength(0);
    expect(result.needsConfirmation).toBe(true);
    expect(result.extractedText).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });

  it('returns extractedText with no PII items when text is clean', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'A picture of a sunset' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({ found: [] }),
        }),
      });

    const result = await checkImagePii(
      '/tmp/sunset.jpg',
      'img-5678.jpg',
      baseCfg,
    );
    expect(result.items).toHaveLength(0);
    expect(result.extractedText).toBe('A picture of a sunset');
    expect(result.needsConfirmation).toBeUndefined();
  });

  it('returns failure on vision timeout (fail-closed)', async () => {
    mockFetch.mockImplementation(
      () =>
        new Promise((_, reject) => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }),
    );

    const result = await checkImagePii('/tmp/doc.jpg', 'img-1234.jpg', baseCfg);
    expect(result.items).toHaveLength(0);
    expect(result.failure).toBeDefined();
  });

  it('returns failure when image file cannot be read (fail-closed)', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = await checkImagePii(
      '/tmp/missing.jpg',
      'missing.jpg',
      baseCfg,
    );
    expect(result.items).toHaveLength(0);
    expect(result.failure).toBeDefined();
    expect(result.failure!.filename).toBe('missing.jpg');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('substituteDocContent', () => {
  it('replaces PDF reference with anonymized extracted text', async () => {
    mockGetText.mockResolvedValue({ text: 'Report about Olivia by Simon' });

    const prompt =
      'User sent:\n[PDF: attachments/report.pdf (50KB)]\nUse: pdf-reader extract attachments/report.pdf';
    const { prompt: result, failures } = await substituteDocContent(
      prompt,
      groupDir,
      baseCfg,
    );

    expect(result).toContain('[Document content from report.pdf]');
    expect(result).toContain('Report about Olivia by Simon');
    expect(result).toContain('[End document content]');
    expect(result).not.toContain('pdf-reader');
    expect(failures).toHaveLength(0);
  });

  it('leaves prompt unchanged when no PDF references exist', async () => {
    const prompt = 'Hello Luna, how are you?';
    const { prompt: result, failures } = await substituteDocContent(
      prompt,
      groupDir,
      baseCfg,
    );
    expect(result).toBe(prompt);
    expect(failures).toHaveLength(0);
    expect(mockGetText).not.toHaveBeenCalled();
  });

  it('strips PDF reference and reports failure when extraction fails', async () => {
    mockGetText.mockRejectedValue(new Error('corrupt'));

    const prompt =
      '[PDF: attachments/bad.pdf (10KB)]\nUse: pdf-reader extract attachments/bad.pdf';
    const { prompt: result, failures } = await substituteDocContent(
      prompt,
      groupDir,
      baseCfg,
    );
    // Reference should be replaced with a withheld notice, not left as-is
    expect(result).toContain('content withheld');
    expect(result).not.toContain('pdf-reader');
    expect(failures).toHaveLength(1);
    expect(failures[0].filename).toBe('bad.pdf');
  });

  it('handles multiple PDF references', async () => {
    let callCount = 0;
    mockGetText.mockImplementation(async () => {
      callCount++;
      return {
        text: callCount === 1 ? 'First doc by Olivia' : 'Second doc by Simon',
      };
    });

    const prompt = [
      '[PDF: attachments/first.pdf (10KB)]',
      'Use: pdf-reader extract attachments/first.pdf',
      'Some text in between',
      '[PDF: attachments/second.pdf (20KB)]',
      'Use: pdf-reader extract attachments/second.pdf',
    ].join('\n');

    const { prompt: result } = await substituteDocContent(
      prompt,
      groupDir,
      baseCfg,
    );
    expect(result).toContain('First doc by Olivia');
    expect(result).toContain('Second doc by Simon');
    expect(result).toContain('Some text in between');
  });
});

describe('checkMediaPii', () => {
  it('checks both PDFs and images in messages', async () => {
    mockGetText.mockResolvedValue({ text: 'Report by Claire' });

    // Fetch calls: 1st PDF text PII, 2nd image vision extract, 3rd image text PII
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            found: [{ text: 'Claire', type: 'name' }],
          }),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'Letter to Dr Patel' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            found: [{ text: 'Dr Patel', type: 'name' }],
          }),
        }),
      });

    const messages = [
      {
        content:
          '[PDF: attachments/report.pdf (50KB)]\nUse: pdf-reader extract attachments/report.pdf',
      },
      { content: '[Image: attachments/img-1234.jpg] Photo of document' },
    ];

    const items = await checkMediaPii(messages, groupDir, baseCfg);
    expect(items).toHaveLength(2);
    expect(items[0].source).toBe('report.pdf');
    expect(items[1].source).toBe('img-1234.jpg');
  });

  it('returns empty when no media references in messages', async () => {
    const messages = [{ content: 'Just a text message' }];
    const items = await checkMediaPii(messages, groupDir, baseCfg);
    expect(items).toHaveLength(0);
  });
});

describe('warmupVisionModel', () => {
  it('sends warmup request to Ollama', () => {
    mockFetch.mockResolvedValue({ ok: true });

    warmupVisionModel(baseCfg);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/generate'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('gemma4:e4b'),
      }),
    );
  });

  it('does not warm up when mediaPiiCheck is false', () => {
    warmupVisionModel({ ...baseCfg, mediaPiiCheck: false, piiCheck: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
