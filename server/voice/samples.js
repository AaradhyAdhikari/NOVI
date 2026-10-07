import fs from 'node:fs';
import path from 'node:path';

// Everyday commands the user records once in their own voice. The clips (kept private in
// data/voice-samples/) are the benchmark for comparing Whisper, Gemini and BHASHINI.
export const TEST_PHRASES = [
  { id: 'en-time', lang: 'en', text: 'Hey Novi, what time is it?' },
  { id: 'en-weather', lang: 'en', text: "What's the weather in Pune tomorrow?" },
  { id: 'en-reminder', lang: 'en', text: 'Remind me to drink water in twenty minutes.' },
  { id: 'en-youtube', lang: 'en', text: 'Play the second video on YouTube.' },
  { id: 'en-gmail', lang: 'en', text: 'Read my latest emails from Gmail.' },
  { id: 'en-github', lang: 'en', text: 'Do I have any new GitHub notifications?' },
  { id: 'hi-time', lang: 'hi', text: 'नोवी, अभी कितने बजे हैं?' },
  { id: 'hi-reminder', lang: 'hi', text: 'मुझे शाम छह बजे मम्मी को फ़ोन करने की याद दिलाना।' },
  { id: 'hi-weather', lang: 'hi', text: 'कल पुणे में मौसम कैसा रहेगा?' },
  { id: 'hi-music', lang: 'hi', text: 'यूट्यूब पर कोई अच्छा गाना चलाओ।' },
  { id: 'hi-timer', lang: 'hi', text: 'दस मिनट का टाइमर लगा दो।' },
  { id: 'hi-email', lang: 'hi', text: 'मेरे नए ईमेल पढ़कर सुनाओ।' },
  { id: 'mr-time', lang: 'mr', text: 'नोवी, आता किती वाजले?' },
  { id: 'mr-reminder', lang: 'mr', text: 'मला संध्याकाळी सहा वाजता आईला फोन करायची आठवण करून दे.' },
  { id: 'mr-weather', lang: 'mr', text: 'उद्या पुण्यात हवामान कसं असेल?' },
  { id: 'mr-timer', lang: 'mr', text: 'पंधरा मिनिटांचा टायमर लाव.' },
  { id: 'mr-youtube', lang: 'mr', text: 'यूट्यूबवर गाणी लाव.' },
  { id: 'mr-email', lang: 'mr', text: 'माझे नवीन ईमेल वाचून दाखव.' },
  { id: 'hinglish-alarm', lang: 'hinglish', text: 'Novi, kal subah 7 baje ka alarm laga do.' },
  { id: 'hinglish-github', lang: 'hinglish', text: 'Mere GitHub pe koi naya issue aaya kya?' },
  { id: 'hinglish-lofi', lang: 'hinglish', text: 'YouTube pe lofi music chala do please.' },
  { id: 'hinglish-rain', lang: 'hinglish', text: 'Aaj Pune mein baarish hogi kya?' },
  { id: 'hinglish-reminder', lang: 'hinglish', text: 'Mummy ko call karne ka reminder set karo shaam 6 baje.' },
  { id: 'hinglish-coder', lang: 'hinglish', text: 'Novi Coder se bolo ki tests fix kare.' },
];

const byId = new Map(TEST_PHRASES.map((p) => [p.id, p]));
const MAX_BYTES = 10 * 1024 * 1024;

export function createSampleStore({ dir }) {
  const indexFile = path.join(dir, 'index.jsonl');

  function list() {
    if (!fs.existsSync(indexFile)) return [];
    return fs.readFileSync(indexFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  return {
    list,
    recordedIds: () => [...new Set(list().map((e) => e.phraseId))],
    save({ phraseId, audio, mimeType = 'audio/wav' }) {
      const phrase = byId.get(phraseId);
      if (!phrase) throw new Error(`Unknown phrase: ${phraseId}`);
      if (!audio?.length) throw new Error('No audio received');
      if (audio.length > MAX_BYTES) throw new Error('Recording too long');
      fs.mkdirSync(dir, { recursive: true });
      const ext = String(mimeType).includes('wav') ? 'wav' : String(mimeType).includes('mp4') ? 'mp4' : 'webm';
      const file = `${phrase.id}-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(dir, file), audio);
      const entry = { file, phraseId: phrase.id, lang: phrase.lang, expected: phrase.text, mimeType, at: new Date().toISOString() };
      fs.appendFileSync(indexFile, `${JSON.stringify(entry)}\n`);
      return entry;
    },
  };
}
