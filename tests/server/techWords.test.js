import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { techWordsFrom, projectTechWords, termHits } from '../../server/voice/techWords.js';

// Coding by voice (user's ChatGPT plan, 2026-10-21): the speech hint carries each project's tech
// words (FastAPI, WebSocket, Firebase…) next to the project names, so they are heard right.
const tmp = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'novi-tech-')); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('techWordsFrom', () => {
  it('names from package.json, requirements, pyproject and the README, spelled properly, once each', () => {
    const words = techWordsFrom({
      'package.json': JSON.stringify({ dependencies: { react: '^18', 'socket.io': '4', '@supabase/supabase-js': '2' }, devDependencies: { vite: '6', tailwindcss: '3', vitest: '1' } }),
      'requirements.txt': 'fastapi==0.110\nuvicorn[standard]>=0.29\nopencv-python\n# a comment\n',
      'pyproject.toml': '[project]\ndependencies = ["pandas>=2", "streamlit"]',
      'README.md': '# Signsync\nA WebSocket server with Firebase auth, written in TypeScript. React again.',
    });
    expect(words).toEqual(['React', 'Socket.IO', 'Supabase', 'Vite', 'Tailwind', 'Vitest', 'FastAPI', 'Uvicorn', 'OpenCV', 'pandas', 'Streamlit', 'WebSocket', 'Firebase', 'TypeScript']);
  });

  it('unknown packages and plain words are left out; broken files are skipped', () => {
    expect(techWordsFrom({ 'package.json': '{ broken', 'README.md': 'A small app that does react to clicks? No: just a node in a list.' })).toEqual([]);
    expect(techWordsFrom({ 'package.json': JSON.stringify({ dependencies: { 'left-pad': '1' } }) })).toEqual([]);
  });
});

describe('projectTechWords', () => {
  it('reads each project folder, most-used words first, capped', () => {
    const a = mkdir();
    const b = mkdir();
    fs.writeFileSync(path.join(a, 'package.json'), JSON.stringify({ dependencies: { react: '1', express: '1' } }));
    fs.writeFileSync(path.join(b, 'package.json'), JSON.stringify({ dependencies: { react: '1', firebase: '1' } }));
    const words = projectTechWords([{ name: 'a', path: a }, { name: 'b', path: b }, { name: 'gone', path: path.join(a, 'missing') }, { name: 'web-only' }], { max: 2 });
    expect(words).toEqual(['React', 'Express']);
  });
});

describe('termHits (the word-accuracy test)', () => {
  it('a term counts when it is in the transcript, ignoring case, spaces and dots', () => {
    expect(termHits(['WebSocket', 'Novi'], 'Ask Claude to add a web socket to Novi.')).toEqual({ hit: ['WebSocket', 'Novi'], missed: [] });
    expect(termHits(['FastAPI', 'MediKiosk'], 'make a fast API backend for medi kiosk')).toEqual({ hit: ['FastAPI', 'MediKiosk'], missed: [] });
    expect(termHits(['FLEXR'], 'what is the progress of Lexa')).toEqual({ hit: [], missed: ['FLEXR'] });
    expect(termHits(['Node.js'], 'install node js')).toEqual({ hit: ['Node.js'], missed: [] });
  });
});

describe('hintNames (what the speech hint gets)', () => {
  it('project folder names, then claude.ai names, then the tech words', async () => {
    const { hintNames } = await import('../../server/voice/techWords.js');
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { firebase: '1' } }));
    expect(hintNames([{ name: 'signsync', path: dir }, { name: 'flexr' }], ['FLEXR'])).toEqual([path.basename(dir), 'FLEXR', 'Firebase']);
  });
});

// Word-accuracy run (2026-10-21): the hint alone barely helped (77–80 %) — Whisper wrote "tracebytes",
// "Sinesync", "Flexer", "Versil", "Vetus". Near-misses of the user's own names are now corrected.
describe('fixNames', () => {
  it('turns a near-miss of a known name into the name, one or two words long', async () => {
    const { fixNames } = await import('../../server/voice/techWords.js');
    const names = ['TraceBites', 'Signsync', 'FLEXR', 'Vercel', 'Vitest', 'Portfolio', 'MediKiosk', 'Novi'];
    expect(fixNames('Open my tracebytes project in VS Code.', names)).toBe('Open my TraceBites project in VS Code.');
    expect(fixNames('Use PostgreSQL for trace bytes', names)).toBe('Use PostgreSQL for TraceBites');
    expect(fixNames('Add Firebase login to Sinesync.', names)).toBe('Add Firebase login to Signsync.');
    expect(fixNames('the progress of my Flexer project', names)).toBe('the progress of my FLEXR project');
    expect(fixNames('Deploy the portfolio on Versil.', names)).toBe('Deploy the portfolio on Vercel.');
    expect(fixNames('make a backend for medi kiosk', names)).toBe('make a backend for MediKiosk');
  });

  it('leaves ordinary words and short names alone', async () => {
    const { fixNames } = await import('../../server/voice/techWords.js');
    const names = ['TraceBites', 'Novi', 'React', 'Express', 'Vercel'];
    for (const t of ['tell me a novel idea', 'how do I react to this', 'send it by express post', 'the very cell', 'trace the bug']) expect(fixNames(t, names), t).toBe(t);
  });
});

describe('hintNames cleans the list', () => {
  it('no empty or two-letter names, no repeats in other capitals', async () => {
    const { hintNames } = await import('../../server/voice/techWords.js');
    expect(hintNames([{ name: 'NOVI' }, { name: '' }, { name: 'cc' }, { name: 'AI' }], ['Novi', 'FLEXR'])).toEqual(['NOVI', 'FLEXR']);
  });
});
