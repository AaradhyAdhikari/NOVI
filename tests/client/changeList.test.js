import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ChangeList from '../../src/components/ChangeList.jsx';

const html = (changes) => renderToStaticMarkup(createElement(ChangeList, { changes, api: async () => ({}) }));

describe('the files on the commit card', () => {
  it('shows the message and each file with green and red counts', () => {
    const out = html({ id: 'v', message: 'Add the login page', files: [{ file: 'login.js', added: 20, removed: 3 }, { file: 'new.js', isNew: true }] });
    expect(out).toContain('Add the login page');
    expect(out).toContain('login.js');
    expect(out).toContain('<span class="change-count plus">+20</span>');
    expect(out).toContain('<span class="change-count minus">−3</span>');
    expect(out).toContain('<span class="change-count plus">new</span>');
  });
  it('says what was left out, and how many more', () => {
    const out = html({ id: 'v', files: [], more: 4, left: ['.env'] });
    expect(out).toContain('and 4 more');
    expect(out).toContain('Left out: .env');
  });
});
