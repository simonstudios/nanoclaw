/**
 * Voice message transcription using Groq's Whisper API (free tier).
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import Groq from 'groq-sdk';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

interface TranscriptionConfig {
  provider: string;
  groq?: { apiKey: string; model: string };
  enabled: boolean;
  fallbackMessage: string;
}

const CONFIG_PATH = path.join(DATA_DIR, '..', '.transcription.config.json');

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

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = loadConfig();

  if (!config.enabled) {
    return config.fallbackMessage;
  }

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

    logger.info({ bytes: buffer.length }, 'Downloaded voice message');

    const transcript = await transcribeWithGroq(buffer, config);
    if (!transcript) return config.fallbackMessage;

    logger.info({ length: transcript.length }, 'Transcribed voice message');
    return transcript;
  } catch (err) {
    logger.error({ err }, 'Transcription error');
    return config.fallbackMessage;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
