export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  add(tool) {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name) {
    return this.tools.get(name);
  }

  schemas() {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));
  }
}
