import { definePluginEntry } from '#plugin-sdk';

// Example Novi plugin, written in OpenClaw's plugin shape.
export default definePluginEntry({
  id: 'clock',
  name: 'Clock',
  description: 'Tells the time and can announce a message (example plugin).',
  register(api) {
    api.registerTool({
      name: 'clock_now',
      description: 'Get the current date and time on the laptop.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const now = new Date();
        const text = now.toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
        return { content: [{ type: 'text', text }], details: { iso: now.toISOString() } };
      },
    });

    api.registerTool({
      name: 'clock_announce',
      description: 'Speak a short announcement out loud on every device connected to Novi.',
      parameters: { type: 'object', properties: { message: { type: 'string', description: 'What to announce' } }, required: ['message'] },
      async execute(_toolCallId, { message }) {
        api.runtime.speak?.(`Announcement: ${message}`);
        return { content: [{ type: 'text', text: 'Announced.' }], details: { announced: message } };
      },
    });

    api.on('before_tool_call', ({ toolName, params }) => {
      if (toolName !== 'clock_announce') return undefined;
      return { requireApproval: { title: 'Announce a message on all devices', description: String(params.message || ''), severity: 'warning' } };
    });
  },
});
