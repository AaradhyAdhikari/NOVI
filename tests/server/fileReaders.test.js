import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { readFileText } from '../../plugins/files/readers.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novi-read-'));
const zip = (file, entries) => {
  const z = new AdmZip();
  for (const [name, text] of Object.entries(entries)) z.addFile(name, Buffer.from(text));
  z.writeZip(file);
  return file;
};

// A tiny real PDF with the text "Hello DBMS".
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 20 100 Td (Hello DBMS) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;

describe('readFileText (what Novi reads to summarize)', () => {
  it('text, markdown, csv and code as they are', async () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'a.md'), '# Notes\nNormalization');
    expect(await readFileText(path.join(d, 'a.md'))).toBe('# Notes\nNormalization');
  });

  it('Word: the paragraphs', async () => {
    const f = zip(path.join(dir(), 'n.docx'), { 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>DBMS</w:t></w:r><w:r><w:t xml:space="preserve"> notes</w:t></w:r></w:p><w:p><w:r><w:t>Joins &amp; keys</w:t></w:r></w:p></w:body></w:document>' });
    expect(await readFileText(f)).toBe('DBMS notes\nJoins & keys');
  });

  it('Excel: every sheet as rows (shared strings and numbers)', async () => {
    const f = zip(path.join(dir(), 's.xlsx'), {
      'xl/workbook.xml': '<workbook><sheets><sheet name="Q1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/sharedStrings.xml': '<sst><si><t>Month</t></si><si><t>Sales</t></si><si><t>Jan</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row></sheetData></worksheet>',
    });
    expect(await readFileText(f)).toBe('Sheet: Q1\nMonth\tSales\nJan\t1200');
  });

  it('PowerPoint: the slide texts', async () => {
    const f = zip(path.join(dir(), 'p.pptx'), { 'ppt/slides/slide1.xml': '<p:sld><a:t>Intro</a:t></p:sld>', 'ppt/slides/slide2.xml': '<p:sld><a:t>Results</a:t></p:sld>' });
    expect(await readFileText(f)).toBe('Slide 1: Intro\nSlide 2: Results');
  });

  it('PDF: the text', async () => {
    const f = path.join(dir(), 'x.pdf');
    fs.writeFileSync(f, PDF);
    expect(await readFileText(f)).toContain('Hello DBMS');
  });

  it('caps very long files and refuses what it cannot read', async () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'big.txt'), 'a'.repeat(100_000));
    expect((await readFileText(path.join(d, 'big.txt'), { max: 1000 })).length).toBeLessThanOrEqual(1020);
    fs.writeFileSync(path.join(d, 'x.bin'), 'x');
    await expect(readFileText(path.join(d, 'x.bin'))).rejects.toThrow(/can't read/);
  });
});
