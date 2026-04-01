/**
 * Voice message transcription.
 * - Groups with PII checking: local whisper-cpp (no audio sent to cloud)
 * - Other groups: Groq Whisper API (cloud, free tier)
 */
import { execFile } from 'child_process';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Groq from 'groq-sdk';

import { DATA_DIR } from './config.js';
import { loadAnonymizeConfig } from './anonymize.js';
import { logger } from './logger.js';

interface TranscriptionConfig {
  provider: string;
  groq?: { apiKey: string; model: string };
  enabled: boolean;
  fallbackMessage: string;
}

const CONFIG_PATH = path.join(DATA_DIR, '..', '.transcription.config.json');
const WHISPER_MODEL = path.join(DATA_DIR, 'models', 'ggml-base.en.bin');
const WHISPER_TIMEOUT_MS = 60_000;

function loadConfig(): TranscriptionConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {
      provider: 'groq',
      enabled: false,
      fallbackMessage: '[Voice Message - transcription unavailable]',
    };
  }
}

async function transcribeWithGroq(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): Promise<string | null> {
  if (!config.groq?.apiKey) {
    logger.warn('Groq API key not configured');
    return null;
  }

  const groq = new Groq({ apiKey: config.groq.apiKey });

  // Groq's API expects a File-like object
  const file = new File([audioBuffer], 'voice.ogg', { type: 'audio/ogg' });

  const transcription = await groq.audio.transcriptions.create({
    file,
    model: config.groq.model || 'whisper-large-v3',
    response_format: 'text',
  });

  // When response_format is 'text', the API returns a plain string
  return (transcription as unknown as string)?.trim() || null;
}

async function transcribeWithLocalWhisper(
  audioBuffer: Buffer,
): Promise<string | null> {
  if (!fs.existsSync(WHISPER_MODEL)) {
    logger.warn(
      { modelPath: WHISPER_MODEL },
      'Local whisper model not found — cannot transcribe locally',
    );
    return null;
  }

  // Write audio to temp file, convert to WAV via ffmpeg, run whisper-cli
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  const oggPath = path.join(tmpDir, 'voice.ogg');
  const wavPath = path.join(tmpDir, 'voice.wav');

  try {
    fs.writeFileSync(oggPath, audioBuffer);

    // Convert OGG to 16kHz mono WAV (whisper-cpp requirement)
    await new Promise<void>((resolve, reject) => {
      execFile(
        'ffmpeg',
        ['-i', oggPath, '-ar', '16000', '-ac', '1', '-y', wavPath],
        { timeout: 15_000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });

    // Run whisper-cli
    const transcript = await new Promise<string | null>((resolve, reject) => {
      execFile(
        'whisper-cli',
        ['-m', WHISPER_MODEL, '-f', wavPath, '--no-timestamps', '--no-prints'],
        { timeout: WHISPER_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout.trim() || null);
        },
      );
    });

    return transcript;
  } finally {
    // Clean up temp files
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Transcribe a voice message. Uses local whisper-cpp for PII-enabled groups
 * (no audio sent to cloud). Falls back to Groq API for other groups.
 */
export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
  groupFolder?: string,
): Promise<string | null> {
  const config = loadConfig();

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  // Use local whisper for PII-enabled groups to keep audio off the cloud
  const anonConfig = groupFolder ? loadAnonymizeConfig(groupFolder) : null;
  const useLocal =
    anonConfig?.piiCheck === true ||
    (anonConfig?.mediaPiiCheck ?? false) === true;

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: logger as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      logger.error('Failed to download audio message');
      return config.fallbackMessage;
    }

    logger.info(
      { bytes: buffer.length, provider: useLocal ? 'local' : 'groq' },
      'Downloaded voice message',
    );

    let transcript: string | null;
    if (useLocal) {
      transcript = await transcribeWithLocalWhisper(buffer);
      if (!transcript) {
        // Local whisper failed — do NOT fall back to cloud for PII groups
        logger.warn(
          'Local whisper failed for PII-enabled group — not sending audio to cloud',
        );
        return config.fallbackMessage;
      }
    } else {
      transcript = await transcribeWithGroq(buffer, config);
      if (!transcript) return config.fallbackMessage;
    }

    logger.info(
      { length: transcript.length, provider: useLocal ? 'local' : 'groq' },
      'Transcribed voice message',
    );
    return transcript;
  } catch (err) {
    logger.error({ err }, 'Transcription error');
    return config.fallbackMessage;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
