import fs from 'node:fs';
import path from 'node:path';

const MAX_TASKS = 50;
const empty = () => ({ projects: {}, tasks: [], prefs: {} });

export class Memory {
  constructor(file) {
    this.file = file;
    this.data = this._load();
  }

  static key(name) {
    return String(name).trim().toLowerCase();
  }

  _load() {
    try {
      return { ...empty(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      }
      return empty();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  listProjects() {
    return Object.entries(this.data.projects).map(([name, p]) => ({ name, ...p }));
  }

  findProject(name) {
    const key = Memory.key(name);
    if (this.data.projects[key]) return { name: key, ...this.data.projects[key] };
    const matches = this.listProjects().filter((p) => key.includes(p.name) || p.name.includes(key));
    return matches.length === 1 ? matches[0] : null;
  }

  rememberProject(name, projectPath) {
    const resolved = path.resolve(projectPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`Folder not found: ${resolved}`);
    const key = Memory.key(name);
    this.data.projects[key] = { path: resolved, lastUsed: null };
    this.save();
    return { name: key, path: resolved };
  }

  forgetProject(name) {
    const key = Memory.key(name);
    if (!this.data.projects[key]) return false;
    delete this.data.projects[key];
    this.save();
    return true;
  }

  touchProject(name) {
    const key = Memory.key(name);
    if (!this.data.projects[key]) return;
    this.data.projects[key].lastUsed = new Date().toISOString();
    this.save();
  }

  addTask(task) {
    this.data.tasks = [task, ...this.data.tasks].slice(0, MAX_TASKS);
    this.save();
  }

  updateTask(id, patch) {
    const task = this.data.tasks.find((t) => t.id === id);
    if (task) {
      Object.assign(task, patch);
      this.save();
    }
    return task;
  }

  lastTask() {
    return this.data.tasks[0] || null;
  }

  // Newest first, copies (plugins count them for the Novi log; they can't change history).
  listTasks() {
    return this.data.tasks.map((t) => ({ ...t }));
  }
}
