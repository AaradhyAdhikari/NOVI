import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTask, buildPrompt, readResult, waitForResult } from '../../tools/antigravity/handoff.js'

let root
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('createTask', () => {
  it('writes a self-contained task file with the rules, files and done path', () => {
    const t = createTask({
      root,
      title: 'Add README section',
      instructions: 'Document the reminders plugin.',
      files: ['README.md'],
      verify: 'npx vitest run',
      now: new Date('2026-10-07T10:00:00Z')
    })
    expect(t.id).toMatch(/^20261007-100000-add-readme-section$/)
    const text = fs.readFileSync(t.taskPath, 'utf8')
    expect(t.taskPath).toBe(path.join(root, '.handoff', 'tasks', `${t.id}.md`))
    expect(text).toContain('Document the reminders plugin.')
    expect(text).toContain('- README.md')
    expect(text).toContain('npx vitest run')
    expect(text).toContain(`.handoff/done/${t.id}.md`)
    expect(text).toMatch(/do not commit/i)
    expect(text).toMatch(/\.env/)
  })

  it('refuses an empty title or instructions', () => {
    expect(() => createTask({ root, title: '', instructions: 'x' })).toThrow()
    expect(() => createTask({ root, title: 'x', instructions: '  ' })).toThrow()
  })
})

describe('buildPrompt', () => {
  it('is one line that points the agent at the task file and its result file', () => {
    const prompt = buildPrompt('abc')
    expect(prompt).toContain('.handoff/tasks/abc.md')
    expect(prompt).not.toMatch(/\n/)
  })
})

describe('readResult / waitForResult', () => {
  const writeDone = (id, body) => {
    fs.mkdirSync(path.join(root, '.handoff', 'done'), { recursive: true })
    fs.writeFileSync(path.join(root, '.handoff', 'done', `${id}.md`), body)
  }

  it('returns null until the done file exists, then its status and text', () => {
    expect(readResult({ root, id: 'abc' })).toBeNull()
    writeDone('abc', 'STATUS: done\nChanged README.md')
    expect(readResult({ root, id: 'abc' })).toEqual({ status: 'done', text: 'STATUS: done\nChanged README.md' })
  })

  it('treats a missing STATUS line as unknown and reads blocked', () => {
    writeDone('a', 'hello')
    writeDone('b', 'STATUS: blocked\nneed key')
    expect(readResult({ root, id: 'a' }).status).toBe('unknown')
    expect(readResult({ root, id: 'b' }).status).toBe('blocked')
  })

  it('waits for the result and times out with status timeout', async () => {
    setTimeout(() => writeDone('w', 'STATUS: done'), 30)
    expect((await waitForResult({ root, id: 'w', timeoutMs: 2000, intervalMs: 10 })).status).toBe('done')
    expect((await waitForResult({ root, id: 'never', timeoutMs: 40, intervalMs: 10 })).status).toBe('timeout')
  })
})
