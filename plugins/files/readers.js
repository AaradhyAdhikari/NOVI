// Turns a file into plain text for a summary: text and code as they are, Word paragraphs, Excel
// sheets as rows, PowerPoint slide texts, PDF text. Capped so a huge file stays quick.
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const TEXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.php', '.rb', '.sql', '.yml', '.yaml', '.sh', '.ps1', '.ipynb', '.log']);
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const texts = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => unxml(m[1]));
const entry = (zip, name) => zip.getEntry(name)?.getData().toString('utf8') || '';

function docx(file) {
  const xml = entry(new AdmZip(file), 'word/document.xml');
  return xml.split(/<\/w:p>/).map((p) => texts(p, 'w:t').join('')).filter((p) => p.trim()).join('\n');
}

function xlsx(file) {
  const zip = new AdmZip(file);
  const shared = entry(zip, 'xl/sharedStrings.xml').split(/<\/si>/).map((si) => texts(si, 't').join(''));
  const names = [...entry(zip, 'xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unxml(m[1]));
  const out = [];
  for (let i = 1; zip.getEntry(`xl/worksheets/sheet${i}.xml`); i++) {
    out.push(`Sheet: ${names[i - 1] || `Sheet${i}`}`);
    for (const row of entry(zip, `xl/worksheets/sheet${i}.xml`).split(/<\/row>/)) {
      const cells = [...row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, attrs, body = '']) => {
        const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        if (/t="s"/.test(attrs)) return shared[Number(v)] ?? '';
        if (/t="inlineStr"/.test(attrs)) return texts(body, 't').join('');
        return v != null ? unxml(v) : '';
      });
      if (cells.some((c) => c !== '')) out.push(cells.join('\t'));
    }
  }
  return out.join('\n');
}

function pptx(file) {
  const zip = new AdmZip(file);
  const out = [];
  for (let i = 1; zip.getEntry(`ppt/slides/slide${i}.xml`); i++) out.push(`Slide ${i}: ${texts(entry(zip, `ppt/slides/slide${i}.xml`), 'a:t').join(' ')}`);
  return out.join('\n');
}

async function pdf(file) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
  const { text } = await extractText(doc, { mergePages: true });
  return String(text);
}

export async function readFileText(file, { max = 60_000 } = {}) {
  const ext = path.extname(file).toLowerCase();
  let text;
  if (TEXT.has(ext)) text = fs.readFileSync(file, 'utf8');
  else if (ext === '.docx') text = docx(file);
  else if (ext === '.xlsx') text = xlsx(file);
  else if (ext === '.pptx') text = pptx(file);
  else if (ext === '.pdf') text = await pdf(file);
  else throw new Error(`I can't read ${ext || 'that kind of'} files yet.`);
  return text.length > max ? `${text.slice(0, max)}\n…(cut)` : text;
}
