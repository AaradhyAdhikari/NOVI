// The look list (routines, 2026-11-13): the only tools a routine may use. Each one only reads and tells;
// none sends, changes, deletes, types, clicks, opens anything or runs code (user: "strictly look only").
// A tool joins only by being added here after a review, never by guessing from its name. Steps still run
// through runtime.callTool, which refuses anything that needs a card: two locks.
export const LOOK_TOOLS = [
  'weather_get',
  'github_activity', 'github_repo', 'github_graph',
  'leetcode_today', 'leetcode_stats',
  // Not here (final review 2026-11-13): project_status and claude_usage open claude.ai in Chrome; code_changes
  // runs git, where a project's own settings could run code.
  'project_board', 'project_about', 'team_status', 'project_said',
  'calendar_events', 'calendar_free', 'tasks_list',
  'notes_ask', 'notes_list', 'brain_search',
  'web_search', 'web_read',
  'laptop_battery', 'laptop_disk',
  'claude_activity',
  'reminder_list', 'preview_status',
];

const SET = new Set(LOOK_TOOLS);
export const isLook = (name) => SET.has(String(name || ''));
