import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Reminders saved in data/reminders.json so they survive restarts.
export class ReminderStore {
  constructor(file) {
    this.file = file;
    this.reminders = this._load();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data.reminders) ? data.reminders : [];
    } catch {
      return [];
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ reminders: this.reminders }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return [...this.reminders].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  get(id) {
    return this.reminders.find((r) => r.id === id) || null;
  }

  add({ text, at, repeat = null }) {
    const reminder = { id: crypto.randomUUID(), text, at: at.toISOString(), repeat, createdAt: new Date().toISOString() };
    this.reminders.push(reminder);
    this._save();
    return reminder;
  }

  update(id, patch) {
    const reminder = this.get(id);
    if (reminder) {
      Object.assign(reminder, patch);
      this._save();
    }
    return reminder;
  }

  remove(id) {
    const before = this.reminders.length;
    this.reminders = this.reminders.filter((r) => r.id !== id);
    if (this.reminders.length !== before) this._save();
    return this.reminders.length !== before;
  }
}
