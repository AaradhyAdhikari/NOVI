import { transcribe } from '../stt.js';

// Main speech-to-text: Groq's hosted Whisper (free tier, rotates GROQ_API_KEYS).
export function createGroqWhisperStt({ keys = [], fetchImpl } = {}) {
  return {
    id: 'groq-whisper',
    available: () => keys.length > 0,
    // { text, language }: the speech engine sends Hindi / Marathi on to the Indian-language provider.
    transcribe: ({ audio, mimeType, language }) => transcribe({ audio, mimeType, language, keys, fetchImpl, detailed: true }),
  };
}
