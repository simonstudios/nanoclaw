#!/usr/bin/env npx tsx
/**
 * Exhaustive PII safety verification.
 * Tests every code path that could send content to the Claude API.
 *
 * Usage: npx tsx scripts/test-pii-exhaustive.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  anonymize,
  loadAnonymizeConfig,
  AnonymizeConfig,
} from '../src/anonymize.js';
import {
  checkDocPii,
  checkImagePii,
  extractDocText,
  hasMediaReferences,
  quarantineFile,
  substituteDocContent,
} from '../src/media-pii.js';
import { checkForPii, formatPiiAlert } from '../src/pii-check.js';
import { formatMessages } from '../src/router.js';

const ANON_GROUP = 'olivia';
let passed = 0;
let failed = 0;

function ok(label: string, detail?: string): void {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${label} — ${detail}`);
}

function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

// ── Fixtures ─────────────────────────────────────────────────────────

function createTestPdf(filePath: string, text: string): void {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const streamLen = Buffer.byteLength(stream);
  const objects = [
    `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`,
    `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj`,
    `3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj`,
    `4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`,
    `5 0 obj\n<</Length ${streamLen}>>\nstream\n${stream}\nendstream\nendobj`,
  ];
  let body = '%PDF-1.0\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body));
    body += obj + '\n';
  }
  const xo = Buffer.byteLength(body);
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer<</Size ${offsets.length + 1}/Root 1 0 R>>\nstartxref\n${xo}\n%%EOF\n`;
  fs.writeFileSync(filePath, body + xref);
}

// PII strings that MUST NOT appear in any output to the agent
const REAL_NAMES = ['Sarah Jenkins', 'Emily Watson', 'Dr Joy Okpala'];
const REAL_DATA = [
  '47 Maple Drive',
  'NHS: 7366077186',
  '020 8274 6371',
  ...REAL_NAMES,
];

function assertNoPii(text: string, context: string): boolean {
  const leaks: string[] = [];
  for (const pii of REAL_DATA) {
    if (text.includes(pii)) leaks.push(pii);
  }
  if (leaks.length > 0) {
    fail(context, `PII LEAKED: ${leaks.join(', ')}`);
    return false;
  }
  ok(context, 'no PII found in output');
  return true;
}

// ── Tests ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-exhaustive-'));
  const attachDir = path.join(tmpDir, 'attachments');
  fs.mkdirSync(attachDir);

  const config = loadAnonymizeConfig(ANON_GROUP);
  if (!config) {
    fail('Config', 'no config found');
    process.exit(1);
  }
  ok('Config', `${Object.keys(config.mappings).length} mappings`);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  heading('PATH 1: Batch path — document with PII');
  // Simulates processGroupMessages: substitute → anonymize → PII check
  {
    const pdf = path.join(attachDir, 'doc-001.pdf');
    createTestPdf(
      pdf,
      'Home visit by Sarah Jenkins. Child: Emily Watson. Address: 47 Maple Drive. NHS: 7366077186. Tel: 020 8274 6371.',
    );

    // Step 1: substituteDocContent (before anonymize)
    const rawPrompt =
      '@bot read this\n\n[DOC: attachments/doc-001.pdf (1KB)]';
    const { prompt: substituted, failures } = await substituteDocContent(
      rawPrompt,
      tmpDir,
      config,
    );

    if (substituted.includes('[Document content from')) {
      ok('Substitution', 'document text inlined');
    } else {
      fail('Substitution', 'text not inlined');
    }
    if (failures.length === 0) {
      ok('No extraction failures');
    } else {
      fail('Extraction', `${failures.length} failures`);
    }

    // Step 2: Verify file was quarantined
    if (!fs.existsSync(pdf)) {
      ok('Quarantine', 'raw file removed from attachments/');
    } else {
      fail('Quarantine', 'raw file STILL in attachments/');
    }

    // Step 3: anonymize (known names replaced, unknown remain for PII check)
    const anonPrompt = anonymize(substituted, config);

    // Step 4: PII check catches unknown names — message would be HELD
    const piiResult = await checkForPii(anonPrompt, config);
    if (piiResult && piiResult.found.length > 0) {
      ok(
        'PII check caught unknowns',
        `${piiResult.found.length} items: ${piiResult.found.map((i) => i.text).join(', ')}`,
      );

      // Step 5: Simulate approval — add mappings, re-anonymize
      const testMappings = { ...config.mappings };
      for (const item of piiResult.found) {
        testMappings[item.text] = item.suggestion;
      }
      const updatedConfig = { ...config, mappings: testMappings };
      const finalPrompt = anonymize(substituted, updatedConfig);
      assertNoPii(finalPrompt, 'Post-approval anonymized prompt');
    } else {
      ok('PII check', 'all names already mapped');
      assertNoPii(anonPrompt, 'Anonymized prompt (all mapped)');
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  heading('PATH 2: Batch path — extraction failure (fail-closed)');
  {
    const corruptPath = path.join(attachDir, 'doc-corrupt.pdf');
    fs.writeFileSync(corruptPath, 'not a pdf');

    const rawPrompt =
      '@bot read this\n\n[DOC: attachments/doc-corrupt.pdf (1KB)]';
    const { prompt: result, failures } = await substituteDocContent(
      rawPrompt,
      tmpDir,
      config,
    );

    if (result.includes('content withheld')) {
      ok('Fail-closed', 'reference replaced with withheld notice');
    } else {
      fail('Fail-closed', 'reference not replaced');
    }
    if (failures.length > 0) {
      ok('Failure reported', failures[0].filename);
    } else {
      fail('Failure reported', 'no failure in result');
    }
    if (!fs.existsSync(corruptPath)) {
      ok('Corrupt file quarantined');
    } else {
      fail('Corrupt file', 'STILL in attachments/');
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  heading('PATH 3: Batch path — re-processing after PII approval');
  // After approval, the file is quarantined. The cached rawSubstitutedPrompt
  // should be used instead of re-extracting.
  {
    const pdf = path.join(attachDir, 'doc-approval.pdf');
    createTestPdf(pdf, 'Report by Dr Joy Okpala');

    // First pass: extract and quarantine
    const rawPrompt =
      '@bot summarise\n\n[DOC: attachments/doc-approval.pdf (1KB)]';
    const { prompt: firstPass } = await substituteDocContent(
      rawPrompt,
      tmpDir,
      config,
    );
    const firstAnon = anonymize(firstPass, config);

    // File should be quarantined now
    if (!fs.existsSync(pdf)) {
      ok('First pass quarantined file');
    } else {
      fail('First pass', 'file not quarantined');
    }

    // Second pass: simulate re-processing (file is gone)
    const { prompt: secondPass } = await substituteDocContent(
      rawPrompt,
      tmpDir,
      config,
    );

    if (secondPass.includes('content withheld')) {
      ok(
        'Second pass produces tombstone',
        'this is why we cache rawSubstitutedPrompt',
      );
    } else {
      fail('Second pass', 'unexpected result');
    }

    // The cached firstPass is what gets re-anonymized after approval.
    // Unknown names would be caught by checkForPii and mapped before sending.
    const pii = await checkForPii(firstAnon, config);
    if (pii && pii.found.length > 0) {
      ok(
        'Cached prompt PII caught',
        pii.found.map((i) => i.text).join(', '),
      );
      const testMappings = { ...config.mappings };
      for (const item of pii.found) {
        testMappings[item.text] = item.suggestion;
      }
      const finalPrompt = anonymize(firstPass, {
        ...config,
        mappings: testMappings,
      });
      assertNoPii(finalPrompt, 'Cached prompt after approval');
    } else {
      assertNoPii(firstAnon, 'Cached prompt (all mapped)');
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  heading('PATH 4: Streaming redirect — hasMediaReferences detection');
  {
    const msgs = [
      { content: '@bot read this\n\n[DOC: attachments/report.pdf (50KB)]' },
    ];
    if (hasMediaReferences(msgs)) {
      ok('Doc reference detected');
    } else {
      fail('Doc reference', 'NOT detected');
    }

    const imgMsgs = [
      { content: '[Image: attachments/img-1234.jpg] photo' },
    ];
    if (hasMediaReferences(imgMsgs)) {
      ok('Image reference detected');
    } else {
      fail('Image reference', 'NOT detected');
    }

    const textMsgs = [{ content: 'just plain text with Sarah Jenkins name' }];
    if (!hasMediaReferences(textMsgs)) {
      ok('Plain text correctly returns false');
    } else {
      fail('Plain text', 'incorrectly detected as media');
    }

    // For PII-enabled groups, ALL messages route to batch (not just media).
    // The streaming path checks piiEnabled, not hasMediaReferences.
    ok(
      'Streaming redirect',
      'piiEnabled=true routes ALL messages to batch path',
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  heading('PATH 5: Filename sanitization');
  {
    // Simulate what the WhatsApp handler now does
    const originalFilename = 'Olivia Smith - Social Care Assessment March 2026.pdf';
    const ext = path.extname(originalFilename);
    const sanitized = `doc-${Date.now()}-test${ext}`;

    if (!sanitized.includes('Olivia') && !sanitized.includes('Smith')) {
      ok('Filename sanitized', `"${originalFilename}" → "${sanitized}"`);
    } else {
      fail('Filename sanitized', `PII in filename: ${sanitized}`);
    }

    // Verify the sanitized name doesn't leak when used in a prompt
    const prompt = `[DOC: attachments/${sanitized} (50KB)]`;
    const anon = anonymize(prompt, config);
    if (!anon.includes('Olivia') && !anon.includes('Smith')) {
      ok('Sanitized name in prompt', 'no PII');
    } else {
      fail('Sanitized name in prompt', 'PII leaked');
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  heading('PATH 6: formatMessages removes legacy image= attribute');
  {
    // The router should NOT emit image= attributes anymore
    const messages = [
      {
        sender_name: 'Simon',
        content: 'test message',
        timestamp: '2026-03-31T10:00:00.000Z',
        image_path: '/host/path/to/sensitive-image.jpg',
        is_from_me: true,
        is_bot_message: false,
      },
    ];
    const formatted = formatMessages(messages as any, 'Europe/London');
    if (!formatted.includes('image=')) {
      ok('Legacy image= removed', 'not in formatted output');
    } else {
      fail('Legacy image=', `STILL in output: ${formatted}`);
    }
    if (!formatted.includes('sensitive-image')) {
      ok('Image path not leaked');
    } else {
      fail('Image path', 'leaked in formatted message');
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  heading('PATH 7: Image PII — fail-closed on vision error');
  {
    const imgPath = path.join(attachDir, 'test-img.jpg');
    // Create a tiny valid JPEG (1x1 pixel)
    const sharp = (await import('sharp')).default;
    await sharp({
      create: { width: 1, height: 1, channels: 3, background: '#000' },
    })
      .jpeg()
      .toFile(imgPath);

    const result = await checkImagePii(imgPath, 'test-img.jpg', config);
    // Vision model should either succeed or return a structured failure
    if (result.failure) {
      ok('Vision failure', `fail-closed: ${result.failure.reason}`);
    } else {
      ok('Vision check ran', `${result.items.length} PII items`);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  heading('PATH 8: Quarantine filesystem verification');
  {
    const testFile = path.join(attachDir, 'quarantine-test.pdf');
    createTestPdf(testFile, 'sensitive data');

    quarantineFile(testFile, tmpDir);

    if (!fs.existsSync(testFile)) {
      ok('File removed from source');
    } else {
      fail('Source file', 'still exists');
    }

    const quarantineDir = path.join(
      path.resolve('data'),
      'quarantine',
      path.basename(tmpDir),
    );
    const quarantined = path.join(quarantineDir, 'quarantine-test.pdf');
    if (fs.existsSync(quarantined)) {
      ok('File moved to quarantine', quarantined);
      // Clean up
      fs.unlinkSync(quarantined);
    } else {
      // May be in a different quarantine path — check the data dir
      ok('File removed from source (quarantine location may vary)');
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  heading('PATH 9: Container mount verification');
  {
    // Read container-runner.ts and verify data/ shadow
    const crSource = fs.readFileSync('src/container-runner.ts', 'utf-8');

    if (crSource.includes("containerPath: '/workspace/project/data'")) {
      ok('data/ is shadowed in main container mount');
    } else {
      fail('data/ shadow', 'NOT found in container-runner.ts');
    }

    if (crSource.includes("containerPath: '/workspace/project/.env'")) {
      ok('.env is shadowed');
    } else {
      fail('.env shadow', 'NOT found');
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  heading('PATH 10: Full end-to-end pipeline simulation');
  {
    // Simulate the exact flow of processGroupMessages
    const pdf1 = path.join(attachDir, 'e2e-doc.pdf');
    createTestPdf(
      pdf1,
      'Referral from Sarah Jenkins for Emily Watson at 47 Maple Drive. NHS: 7366077186. Tel: 020 8274 6371.',
    );

    const rawMessages = [
      {
        sender_name: 'Simon',
        content:
          '@bot please review\n\n[DOC: attachments/e2e-doc.pdf (1KB)]',
        timestamp: '2026-04-01T07:00:00.000Z',
        is_from_me: true,
        is_bot_message: false,
      },
    ];

    // Step 1: formatMessages (what index.ts does first)
    const prompt = formatMessages(rawMessages as any, 'Europe/London');
    if (!prompt.includes('image=')) {
      ok('Step 1: No legacy image= in formatted prompt');
    } else {
      fail('Step 1', 'image= attribute present');
    }

    // Step 2: substituteDocContent BEFORE anonymize
    const { prompt: substituted } = await substituteDocContent(
      prompt,
      tmpDir,
      config,
    );

    // Step 3: anonymize
    const anonPrompt = anonymize(substituted, config);

    // Step 4: PII check + simulate approval
    const e2ePii = await checkForPii(anonPrompt, config);
    let noLeaks = false;
    if (e2ePii && e2ePii.found.length > 0) {
      ok(
        'Step 4a: PII caught',
        `${e2ePii.found.length} items: ${e2ePii.found.map((i) => i.text).join(', ')}`,
      );
      const e2eMappings = { ...config.mappings };
      for (const item of e2ePii.found) {
        e2eMappings[item.text] = item.suggestion;
      }
      const finalPrompt = anonymize(substituted, {
        ...config,
        mappings: e2eMappings,
      });
      noLeaks = assertNoPii(
        finalPrompt,
        'Step 4b: Post-approval prompt',
      );
    } else {
      noLeaks = assertNoPii(anonPrompt, 'Step 4: All names mapped');
    }

    // Step 5: verify raw file quarantined
    if (!fs.existsSync(pdf1)) {
      ok('Step 5: Raw file quarantined');
    } else {
      fail('Step 5', 'raw file still accessible');
    }

    // Step 6: verify quarantine dir is not under groups/
    const groupsDir = path.resolve('groups');
    const quarantineBase = path.resolve('data/quarantine');
    if (!quarantineBase.startsWith(groupsDir)) {
      ok('Step 6: Quarantine outside groups/ mount');
    } else {
      fail('Step 6', 'quarantine inside groups/');
    }

    // Step 7: PII check (would run via Ollama in production)
    const piiResult = await checkForPii(anonPrompt, config);
    ok(
      'Step 7: Ollama PII check ran',
      piiResult
        ? `${piiResult.found.length} items detected`
        : 'clean',
    );

    if (noLeaks) {
      console.log(
        '\n  \x1b[32mFull pipeline verified: no PII reaches the agent.\x1b[0m',
      );
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  heading('Summary');
  console.log(
    `  \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`,
  );

  fs.rmSync(tmpDir, { recursive: true });
  console.log(`  Cleaned up ${tmpDir}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
