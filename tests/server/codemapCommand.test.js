import { describe, it, expect } from 'vitest';
import { codemapCommand } from '../../server/brain/codemapCommand.js';

describe('code map by voice, no AI (plugins/codemap)', () => {
  it('make or refresh a map', () => {
    expect(codemapCommand('Map the Novi code.')).toEqual({ tool: 'codemap_build', args: { project: 'Novi' } });
    expect(codemapCommand('okay, map my tip calculator project')).toEqual({ tool: 'codemap_build', args: { project: 'tip calculator' } });
    expect(codemapCommand("map Novi's code")).toEqual({ tool: 'codemap_build', args: { project: 'Novi' } });
    expect(codemapCommand('graphify FLEXR')).toEqual({ tool: 'codemap_build', args: { project: 'FLEXR' } });
    expect(codemapCommand('update the code map of portfolio')).toEqual({ tool: 'codemap_build', args: { project: 'portfolio' } });
    expect(codemapCommand('make a code map')).toEqual({ tool: 'codemap_build', args: {} });
  });

  it('show the map', () => {
    expect(codemapCommand('show me the Novi code map')).toEqual({ tool: 'codemap_show', args: { project: 'Novi' } });
    expect(codemapCommand("open Novi's code map")).toEqual({ tool: 'codemap_show', args: { project: 'Novi' } });
    expect(codemapCommand('show me the code map of FLEXR')).toEqual({ tool: 'codemap_show', args: { project: 'FLEXR' } });
    expect(codemapCommand('show the code map')).toEqual({ tool: 'codemap_show', args: {} });
  });

  it('how two parts connect', () => {
    expect(codemapCommand('How does the orchestrator connect to the task manager?'))
      .toEqual({ tool: 'codemap_ask', args: { part: 'orchestrator', to: 'task manager' } });
    expect(codemapCommand('how is the agent connected with the plugin host in Novi'))
      .toEqual({ tool: 'codemap_ask', args: { part: 'agent', to: 'plugin host', project: 'Novi' } });
    expect(codemapCommand('what connects the router and the agent in my Novi code'))
      .toEqual({ tool: 'codemap_ask', args: { part: 'router', to: 'agent', project: 'Novi' } });
  });

  it('explain one part (only with a code word, so everyday "explain X" stays with the AI)', () => {
    expect(codemapCommand('explain the ApprovalQueue class')).toEqual({ tool: 'codemap_ask', args: { part: 'ApprovalQueue' } });
    expect(codemapCommand('what does the createNovi function do in Novi')).toEqual({ tool: 'codemap_ask', args: { part: 'createNovi', project: 'Novi' } });
    expect(codemapCommand('what uses the task manager')).toEqual({ tool: 'codemap_ask', args: { part: 'task manager', users: true } });
    expect(codemapCommand('where is the vocabulary module')).toEqual({ tool: 'codemap_ask', args: { part: 'vocabulary' } });
  });

  it('leaves everything else alone', () => {
    for (const t of ['explain the theory of relativity', 'what does my TraceBites app do', 'show me a map of Delhi', 'map', 'how does a car engine work', 'open google maps']) {
      expect(codemapCommand(t)).toBeNull();
    }
  });
});
