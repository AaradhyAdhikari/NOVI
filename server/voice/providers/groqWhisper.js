import { transcribe, DEFAULT_PROMPT } from '../stt.js';

// Main speech-to-text: Groq's hosted Whisper (free tier, rotates GROQ_API_KEYS).
// prompt: (base hint) → hint with your word list added (Settings → Words).
export function createGroqWhisperStt({ keys = [], fetchImpl, prompt = (base) => base } = {}) {
  return {
    id: 'groq-whisper',
    available: () => keys.length > 0,
    // { text, language }: the speech engine sends Hindi / Marathi on to the Indian-language provider.
    transcribe: ({ audio, mimeType, language }) => transcribe({ audio, mimeType, language, keys, fetchImpl, detailed: true, prompt: prompt(DEFAULT_PROMPT) }),
  };
}
