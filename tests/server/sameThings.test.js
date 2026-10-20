import { describe, it, expect } from 'vitest';
import { normalize, sameness, mainName, parseSame, addSame, findGroups, isContainerName } from '../../plugins/wiki/same.js';

// "Same thing = one dot" (user, 2026-10-20: "merge NOVI CONTEXT and NOVI… medikiiosk and Medikiosk are the
// same… if you get anything related to a single thing connect it"). Sure matches merge by themselves,
// less sure ones are asked; the main name is the shortest clean one.
describe('which names are the same thing', () => {
  it('ignores spaces, capitals and words like context / project / AI / app', () => {
    expect(normalize('NOVI CONTEXT')).toBe('novi');
    expect(normalize('MediKiosk AI')).toBe('medikiosk');
    expect(normalize('novi-playground')).toBe('noviplayground');
    expect(normalize('ドキュメント')).toBe('ドキュメント');
  });

  it('sure: same once cleaned, or a small typo in a long name; never across different numbers', () => {
    expect(sameness('NOVI CONTEXT', 'NOVI')).toBe('sure');
    expect(sameness('medikiiosk', 'Medikiosk')).toBe('sure');
    expect(sameness('MediKiosk AI', 'medikiiosk')).toBe('sure');
    expect(sameness('TraceBites', 'TraceBite')).toBe('sure');
    expect(sameness('Portfolio 2', 'Portfolio')).toBe(null);
    expect(sameness('novi-playground', 'NOVI')).toBe(null);
    expect(sameness('R&B', 'RnB')).toBe(null); // short names: exact only
    expect(sameness('FLEXR', 'Flex')).toBe(null);
  });

  it('maybe: a bigger difference in a long name is asked, not merged', () => {
    expect(sameness('Signsyncer', 'Signsync')).toBe('maybe');
    expect(sameness('Technical Seminar', 'Technical Seminars')).toBe('sure');
  });

  it('main name: the spelling most sources use, then not all-lowercase, then the shortest', () => {
    expect(mainName(['NOVI CONTEXT', 'NOVI', 'novi'])).toBe('NOVI');
    expect(mainName(['medikiiosk', 'Medikiosk', 'MediKiosk AI'])).toBe('Medikiosk');
  });

  it('a Documents-like folder is never a project', () => {
    expect(isContainerName('ドキュメント')).toBe(true);
    expect(isContainerName('Documents')).toBe(true);
    expect(isContainerName('NOVI')).toBe(false);
  });
});

describe('the "Same things" note', () => {
  it('reads groups (=) and "not the same" pairs (≠), and adds without repeating', () => {
    const text = '# Same things\n\n- NOVI = NOVI CONTEXT\n- Portfolio ≠ Portfolio 2\n';
    expect(parseSame(text)).toEqual({ groups: [['NOVI', 'NOVI CONTEXT']], different: [['Portfolio', 'Portfolio 2']] });
    expect(addSame(text, ['NOVI', 'Novi app'])).toBe('- NOVI = NOVI CONTEXT = Novi app');
    expect(addSame(text, ['NOVI', 'NOVI CONTEXT'])).toBe(null);
    expect(addSame(text, ['novi', 'NOVI CONTEXT'])).toBe(null); // capitals alone are nothing new
  });

  it('finds new groups from names: sure ones to merge, maybe ones to ask; skips known and "not the same"', () => {
    const names = ['NOVI CONTEXT', 'NOVI', 'novi', 'medikiiosk', 'Medikiosk', 'MediKiosk AI', 'Signsync', 'Signsyncer', 'Portfolio', 'novi-playground'];
    const out = findGroups(names, parseSame('- Signsync ≠ Signsyncer\n'));
    expect(out.merge).toEqual([
      { main: 'NOVI', names: ['NOVI CONTEXT', 'NOVI'] },
      { main: 'Medikiosk', names: ['medikiiosk', 'Medikiosk', 'MediKiosk AI'] },
    ]);
    expect(out.ask).toEqual([]);
    expect(findGroups(['Signsync', 'Signsyncer'], parseSame('')).ask).toEqual([['Signsync', 'Signsyncer']]);
    expect(findGroups(['NOVI', 'NOVI CONTEXT'], parseSame('- NOVI = NOVI CONTEXT')).merge).toEqual([]);
  });
});
