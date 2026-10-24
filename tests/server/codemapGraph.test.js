import { describe, it, expect } from 'vitest';
import { loadGraph, findNode, explain, shortestPath, pathText, explainText, summary } from '../../plugins/codemap/graph.js';

// A small graph in graphify's graph.json shape (live Novi graph, 2026-10-24: ids, labels, relations).
const node = (id, label, file, extra = {}) => ({ id, label, norm_label: label.toLowerCase(), source_file: file, source_location: 'L1', file_type: 'code', community: 0, community_name: 'Core', ...extra });
const link = (source, target, relation) => ({ source, target, relation });
const DATA = {
  nodes: [
    node('app', 'app.js', 'server/app.js'),
    node('app_createnovi', 'createNovi()', 'server/app.js', { _callable: true, source_location: 'L66' }),
    node('perm_approvalqueue', 'ApprovalQueue', 'server/permissions.js', { _callable: true, _callable_class: true, community_name: 'Permissions' }),
    node('perm_decide', '.decide()', 'server/permissions.js', { _callable: true }),
    node('orch_plugin', 'createOrchestratorPlugin()', 'plugins/orchestrator/index.js', { _callable: true }),
    node('tm_taskmanager', 'TaskManager', 'server/claude/taskManager.js', { _callable: true, _callable_class: true }),
    node('test_setup', 'setup()', 'tests/server/x.test.js', { _callable: true }),
    node('pkg_vitest', 'vitest', 'package.json'),
    node('ref_node_crypto', 'ref_node_crypto', '', { file_type: 'concept', external: true }),
    // Live (2026-10-24): a CLAUDE.md heading came out as one of Novi's "most connected" parts.
    node('doc_roadmap', 'Roadmap (agreed with the user)', 'CLAUDE.md', { file_type: 'document' }),
  ],
  links: [
    link('app', 'app_createnovi', 'contains'),
    link('app_createnovi', 'perm_approvalqueue', 'calls'),
    link('perm_approvalqueue', 'perm_decide', 'method'),
    link('orch_plugin', 'app_createnovi', 'imports'),
    link('app_createnovi', 'tm_taskmanager', 'calls'),
    // A shortcut through a test file must never be the answer.
    link('test_setup', 'orch_plugin', 'calls'),
    link('test_setup', 'tm_taskmanager', 'calls'),
    link('test_setup', 'pkg_vitest', 'imports'),
    link('app', 'ref_node_crypto', 'imports'),
    link('doc_roadmap', 'app', 'contains'),
    link('doc_roadmap', 'app_createnovi', 'contains'),
    link('doc_roadmap', 'perm_approvalqueue', 'contains'),
    link('doc_roadmap', 'tm_taskmanager', 'contains'),
  ],
};

describe('codemap graph (graphify graph.json, read by Novi without AI)', () => {
  const g = loadGraph(DATA);

  it('finds a part by how it is said aloud: spaces, case, "()" and file names', () => {
    expect(findNode(g, 'approval queue').id).toBe('perm_approvalqueue');
    expect(findNode(g, 'the ApprovalQueue class').id).toBe('perm_approvalqueue');
    expect(findNode(g, 'create novi').id).toBe('app_createnovi');
    expect(findNode(g, 'orchestrator').id).toBe('orch_plugin');
    expect(findNode(g, 'task manager').id).toBe('tm_taskmanager');
    expect(findNode(g, 'app.js').id).toBe('app');
    expect(findNode(g, 'zebra')).toBeNull();
    // Live (2026-10-24): "the vocabulary module" found a variable called vocabulary, not vocabulary.js.
    const v = loadGraph({ nodes: [node('var', 'vocabulary', 'tools/bench.mjs'), node('file', 'vocabulary.js', 'server/voice/vocabulary.js')], links: [] });
    expect(findNode(v, 'the vocabulary module').id).toBe('file');
    expect(findNode(v, 'vocabulary').id).toBe('var');
  });

  it('"what uses X" lists only the parts that use it', () => {
    expect(explainText(explain(g, 'app_createnovi', { users: true })))
      .toBe('createNovi() is in server/app.js, line 66. It is in app.js and is imported by createOrchestratorPlugin().');
    expect(explainText(explain(g, 'orch_plugin', { users: true }))).toBe('createOrchestratorPlugin() is in plugins/orchestrator/index.js, line 1. Nothing else in the map uses it.');
  });

  it('explains a part: where it is and what it links to, test files last', () => {
    const e = explain(g, 'app_createnovi');
    expect(e).toMatchObject({ label: 'createNovi()', file: 'server/app.js', line: 66, group: 'Core' });
    expect(e.links.map((l) => l.text)).toEqual(['calls ApprovalQueue', 'calls TaskManager', 'is in app.js', 'is imported by createOrchestratorPlugin()']);
    expect(explainText(e)).toBe('createNovi() is in server/app.js, line 66. It calls ApprovalQueue and TaskManager, is in app.js and is imported by createOrchestratorPlugin().');
    // Spoken aloud: one verb per group, not "has the method" eight times.
    expect(explainText(explain(g, 'perm_approvalqueue'))).toBe('ApprovalQueue is in server/permissions.js, line 1. It has the method .decide() and is called by createNovi().');
    expect(explainText({ label: 'X', file: 'x.js', line: null, links: ['.a()', '.b()'].map((t) => ({ verb: 'has the method', label: t })), total: 5 }))
      .toBe('X is in x.js. It has the methods .a() and .b(), and 3 more links.');
  });

  it('finds how two parts connect, never through tests, packages or outside modules', () => {
    const p = shortestPath(g, 'orch_plugin', 'tm_taskmanager');
    expect(p).toEqual(['orch_plugin', 'app_createnovi', 'tm_taskmanager']);
    expect(pathText(g, p)).toBe('createOrchestratorPlugin() reaches TaskManager in 2 steps: createOrchestratorPlugin() imports createNovi(), and createNovi() calls TaskManager.');
    expect(shortestPath(g, 'perm_decide', 'pkg_vitest')).toBeNull();
  });

  it('sums up a map: parts, links, groups and the most connected parts (no tests or packages)', () => {
    expect(summary(g)).toEqual({ parts: 6, links: 5, groups: 2, hubs: ['createNovi()', 'ApprovalQueue', 'app.js'] });
  });
});
