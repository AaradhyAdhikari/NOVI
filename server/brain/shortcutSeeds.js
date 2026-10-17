// Starter shortcuts (user, 2026-10-17: "fill the shortcuts with previous simple tasks that we did").
// Only everyday requests that still went through the AI and need no approval; things a direct route
// already does at once (YouTube, GitHub graph, LeetCode, volume, battery, free space, files, web
// search, "what's running"…) aren't here. Weather days: 1 = today, 2 = today + tomorrow.
export const SEEDS = [
  { tool: 'weather_get', args: { days: 1 }, words: ["what's the weather", "what's the weather today", "how's the weather", 'weather today', 'aaj ka weather batao', 'aaj ka weather kaisa hai', 'mausam kaisa hai', 'aaj ka mausam kaisa hai', 'weather kaisa hai', 'आजचे हवामान सांग'] },
  { tool: 'weather_get', args: { days: 2 }, words: ["what's the weather tomorrow", 'weather tomorrow', 'will it rain tomorrow', 'kal ka weather batao', 'kal ka weather kaisa hoga', 'kal ka mausam kaisa hoga', 'उद्याचे हवामान सांग'] },
  { tool: 'weather_get', args: { days: 7 }, words: ['weather this week', "what's the weather this week"] },
  { tool: 'clock_now', args: {}, words: ['what time is it', "what's the time", 'time kya hua', 'kitne baje hai', 'kitne baj gaye', "what's the date today", "what's today's date", 'aaj ki date kya hai', 'आज तारीख काय आहे'] },
  { tool: 'project_next', args: {}, words: ['tell me my project updates', 'my project updates', 'project updates', 'where did i leave off', 'where did we leave off'] },
  { tool: 'briefing_get', args: {}, words: ['brief me', 'give me my briefing', "what's my day like", 'morning briefing', 'aaj ka din kaisa hai'] },
  ...[['Calculator', 'calculator'], ['Notepad', 'notepad'], ['WhatsApp', 'whatsapp'], ['Google Chrome', 'chrome'], ['Spotify', 'spotify'], ['File Explorer', 'file explorer'], ['Settings', 'settings']]
    .map(([name, said]) => ({ tool: 'open_app', args: { name }, words: [`open ${said}`, `open the ${said} app`, `${said} kholo`] })),
];
