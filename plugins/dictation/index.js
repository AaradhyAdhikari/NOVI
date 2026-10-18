import { definePluginEntry } from '#plugin-sdk';

// Dictation (user, 2026-10-18): "Hey Novi, type …" or holding Ctrl+Shift+Space (the orb) types the
// words into the app in front, through laptop-control's clipboard (the old copy is put back).
// It never presses Enter, so nothing is sent; the user asked for it, so it doesn't ask.
export function createDictationPlugin() {
  return definePluginEntry({
    id: 'dictation',
    name: 'Dictation',
    description: 'Types spoken words into the app in front on the laptop.',
    register(api) {
      api.registerTool({
        name: 'dictate_type',
        description: 'Type the given words into the app in front on the laptop (or the app named), exactly as given. Never presses Enter.',
        parameters: { type: 'object', properties: { text: { type: 'string', description: 'The exact words to type' }, app: { type: 'string', description: 'App to type into (optional; default: the one in front)' } }, required: ['text'] },
        async execute(_id, { text, app } = {}) {
          if (!String(text || '').trim()) return { content: [], details: { error: "There's nothing to type." } };
          const out = await api.runtime.callTool('laptop_clipboard', { do: 'type', text: String(text), ...(app ? { app } : {}) });
          return { content: [], details: out || {} };
        },
      });
    },
  });
}

export default createDictationPlugin();
