import { definePluginEntry } from '#plugin-sdk';
import { secretWords } from '../screen/mode.js';
import { phoneCommand, onPhone } from './parse.js';

// Phone typing (user, 2026-10-29): type, send, tap, back/home and scroll inside apps on the user's
// phone, done by the Novi Android app's Accessibility service (android/ NoviAccess.kt) over the app's
// connection (runtime.phoneAction). The phone refuses password fields, payment/bank apps and Settings
// itself; here a password said aloud is never even sent.
export function createPhoneControlPlugin() {
  return definePluginEntry({
    id: 'phone-control',
    name: 'Phone control',
    description: 'Types and taps inside apps on the user\'s phone through the Novi app.',
    register(api) {
      const say = (details) => ({ content: [{ type: 'text', text: details.note || details.error || '' }], details });
      api.registerTool({
        name: 'phone_action',
        description: 'Do one step inside the app open on the user\'s phone: do = type (text, enter = also send/search), enter (send / search), tap (target = the words on the button), back, home, scroll (dir up/down). Never passwords, payments or bank apps.',
        parameters: {
          type: 'object',
          properties: {
            do: { type: 'string', enum: ['type', 'enter', 'tap', 'back', 'home', 'scroll'] },
            said: { type: 'string', description: 'Instead of do: what the user said, read here' },
            inApp: { type: 'boolean', description: 'With said: spoken from inside another phone app' },
            text: { type: 'string', description: 'What to type' },
            enter: { type: 'boolean', description: 'Send / search after typing' },
            target: { type: 'string', description: 'The words on what to tap' },
            dir: { type: 'string', enum: ['up', 'down'] },
          },
          required: [],
        },
        async execute(_id, input = {}) {
          // The agent's voice route passes the words (`said`) and whether they were spoken from inside a
          // phone app (`inApp`); outside one, only words that name the phone ("on my phone") count.
          let args = input;
          if (typeof input.said === 'string') {
            const cmd = input.inApp || onPhone(input.said) ? phoneCommand(input.said) : null;
            if (!cmd) return { content: [{ type: 'text', text: 'Not a phone step.' }], details: { unknown: true } };
            args = cmd;
          }
          if (args.do === 'type' && secretWords(args.text))return say({ error: "I can't type passwords aloud. Please type it yourself." });
          if (!api.runtime.phoneAction) return say({ error: "I can't reach your phone from here." });
          const out = await api.runtime.phoneAction(args);
          return say(out?.ok ? { note: out.note || 'Done.' } : { error: out?.note || "The phone couldn't do that." });
        },
      });
      // The user's own words are the yes; a step the AI picks asks first (like screen control).
      api.on('before_tool_call', ({ toolName, params, direct }) => {
        if (toolName !== 'phone_action' || direct) return undefined;
        return { requireApproval: { title: `On your phone: ${params?.do || 'a step'}${params?.text ? ` “${String(params.text).slice(0, 60)}”` : params?.target ? ` “${String(params.target).slice(0, 60)}”` : ''}`, description: '', severity: 'warning', category: 'screen', grantable: true } };
      });
    },
  });
}

export default createPhoneControlPlugin();
