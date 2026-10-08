// Builds tools/wakeword/train_hey_novi.ipynb from Alfie Dennen's MIT-licensed openWakeWord Colab
// notebook (github.com/alfiedennen/openwakeword-colab-2026), with Novi's changes:
//   1. wake phrase "hey novi" / "hey novee", model name hey_novi
//   2. synthetic background noise instead of the 8 GB FMA music download (free Colab dropped the VM)
//   3. the user's own "Hey Novi" recordings (hey-novi-clips.zip uploaded to /content) added to the
//      positive clips — the synthetic voices alone scored the user's voice near 0
// Usage: node tools/wakeword/build-notebook.mjs <original.ipynb>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) throw new Error('Usage: node tools/wakeword/build-notebook.mjs <original train_wakeword.ipynb>');
const nb = JSON.parse(fs.readFileSync(src, 'utf8'));
const text = (cell) => (Array.isArray(cell.source) ? cell.source.join('') : cell.source);
const lines = (s) => s.split('\n').map((l, i, all) => (i < all.length - 1 ? `${l}\n` : l));
const code = (s) => ({ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: lines(s) });
const markdown = (s) => ({ cell_type: 'markdown', metadata: {}, source: lines(s) });
const indexOf = (pred) => {
  const i = nb.cells.findIndex(pred);
  if (i < 0) throw new Error('notebook layout changed: a cell to patch was not found');
  return i;
};

// 1. Phrase + model name (cell 10).
const config = nb.cells[indexOf((c) => c.cell_type === 'code' && text(c).includes("TARGET_PHRASE = ['mr graves', 'mister graves']"))];
config.source = lines(text(config)
  .replace("TARGET_PHRASE = ['mr graves', 'mister graves']", "TARGET_PHRASE = ['hey novi', 'hey novee']")
  .replace("MODEL_NAME    = 'mr_graves'", "MODEL_NAME    = 'hey_novi'"));
if (!text(config).includes("'hey_novi'")) throw new Error('model name was not replaced');

// 2. Synthetic noise before the FMA/ACAV download (cell 7 skips FMA when /content/fma has >100 entries
//    and cell 8 skips conversion when /content/fma_wav has 1500 WAVs).
const noise = `# NOVI: "novi" isn't in the CMU pronunciation dictionary, so openwakeword's adversarial-phrase step
# needs DeepPhonemizer (dp.phonemizer), which the original notebook never installs ("mr graves" never needed it).
!pip install -q deep-phonemizer
from dp.phonemizer import Phonemizer  # fails here, early, if the install broke
# NOVI: synthetic background noise instead of the 8 GB FMA music download (free Colab dropped the VM during it).
import os, numpy as np, soundfile as sf
os.makedirs('/content/fma_wav', exist_ok=True)
os.makedirs('/content/fma', exist_ok=True)
for i in range(101):
    open(f'/content/fma/placeholder_{i}', 'w').close()
rng = np.random.default_rng(0)
def make_noise(kind):
    w = rng.standard_normal(80000)
    x = w if kind == 0 else (np.cumsum(w) if kind == 1 else np.convolve(w, np.ones(8) / 8, 'same'))  # white / brown / soft
    x = x - x.mean()
    return (0.3 * x / (np.abs(x).max() + 1e-9)).astype('float32')
for i in range(1500):
    out = f'/content/fma_wav/{i:05d}.wav'
    if not os.path.exists(out):
        sf.write(out, make_noise(i % 3), 16000, subtype='PCM_16')
print('noise WAVs:', len(os.listdir('/content/fma_wav')), ' FMA placeholders:', len(os.listdir('/content/fma')))`;
const fmaCode = indexOf((c) => c.cell_type === 'code' && text(c).includes('ACAV features (17 GB)'));
nb.cells.splice(fmaCode, 0, markdown('### Novi: background noise (instead of the FMA download)'), code(noise));

// 3. The user's own recordings, after resampling and before augment + featurise.
const userClips = `# NOVI: add the user's own "Hey Novi" recordings. Upload hey-novi-clips.zip to /content (Files panel);
# this cell waits up to 20 minutes for it, then continues without (synthetic voices only).
import os, glob, time, zipfile, yaml, numpy as np, soundfile as sf
cfg = yaml.safe_load(open('/content/my_model.yaml'))
waited = 0
while not glob.glob('/content/hey-novi-clips*.zip') and waited < 1200:
    print('waiting for hey-novi-clips.zip upload...', waited, 's', flush=True)
    time.sleep(30)
    waited += 30
for z in glob.glob('/content/hey-novi-clips*.zip'):
    zipfile.ZipFile(z).extractall('/content/user_clips')
clips = sorted(glob.glob('/content/user_clips/**/*.wav', recursive=True))
print(len(clips), 'real clips found')
def trim(p):
    # Keep the spoken part (+-0.15 s) so the clip looks like the short synthetic ones.
    a, sr = sf.read(p)
    a = a if a.ndim == 1 else a.mean(axis=1)
    e = np.convolve(np.abs(a), np.ones(1600) / 1600, 'same')
    idx = np.where(e > 0.25 * e.max())[0]
    s, t = (max(0, idx[0] - 2400), min(len(a), idx[-1] + 2400)) if len(idx) else (0, len(a))
    return a[s:t].astype('float32'), sr
test_clips = clips[::6]
train_clips = [c for c in clips if c not in test_clips]
for i, c in enumerate(train_clips):
    a, sr = trim(c)
    for k in range(15):  # repeated so the real voice counts; augmentation varies each copy
        sf.write(f"{cfg['positive_clips_train_dir']}/user_{i:03d}_{k}.wav", a, sr)
for i, c in enumerate(test_clips):
    a, sr = trim(c)
    sf.write(f"{cfg['positive_clips_test_dir']}/user_{i:03d}.wav", a, sr)
print('added', len(train_clips) * 15, 'train copies and', len(test_clips), 'test clips of the real voice')`;
const augment = indexOf((c) => c.cell_type === 'code' && text(c).includes('--augment_clips'));
nb.cells.splice(augment, 0, markdown("### Novi: add the user's own recordings"), code(userClips));

// Credit + what changed, at the top.
nb.cells.unshift(markdown(`# Novi "Hey Novi" wake-word trainer
Based on [openwakeword-colab-2026](https://github.com/alfiedennen/openwakeword-colab-2026) by Alfie Dennen (MIT). Built by \`tools/wakeword/build-notebook.mjs\`.

Novi's changes: phrase **hey novi**, synthetic background noise instead of the FMA download, and the user's own recordings (upload **hey-novi-clips.zip** to \`/content\` during the first ~45 minutes).

Runtime: **T4 GPU**, runtime version **2026.04**. Then *Runtime → Run all*.`));

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'train_hey_novi.ipynb');
fs.writeFileSync(out, `${JSON.stringify(nb, null, 1)}\n`);
console.log(`wrote ${out} (${nb.cells.length} cells)`);
