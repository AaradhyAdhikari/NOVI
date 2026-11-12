// The one team registry Novi is running with, for other plugins (project-state asks it which roles a named
// agent can do). Set by the agents plugin when it registers; null in tests that run without it.
let current = null;
export const setTeam = (registry) => { current = registry; };
export const team = () => current;
export const rolesOf = () => Object.fromEntries((current?.list?.() || []).map((a) => [a.id, a.roles]));
