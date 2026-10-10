// Novi knows its own folder as the project "novi", so "open Novi in Claude and add dark mode" or
// "fix the login bug in Novi" work without first teaching it the folder. A "novi" project the user
// saved themselves always wins.
export function rememberOwnProject(memory, dir) {
  if (memory.listProjects().some((p) => p.name === 'novi')) return false;
  try {
    memory.rememberProject('novi', dir);
    return true;
  } catch {
    return false; // folder gone: never stop Novi starting over this
  }
}
