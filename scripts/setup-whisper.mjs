// Downloads a pinned whisper.cpp Windows build and an English model into
// tools/whisper so local speech-to-text works without manual setup.
//
//   node scripts/setup-whisper.mjs                # base.en model (~142 MB)
//   node scripts/setup-whisper.mjs --model tiny.en
//   node scripts/setup-whisper.mjs --model large-v3-turbo-q8_0 --gpu   # most accurate, NVIDIA GPU (~1.5 GB)
//
// --gpu adds the CUDA build in tools/whisper/bin-gpu, which the app then prefers
// over the CPU build in bin/. Every download is checked against the SHA-256 that
// GitHub or Hugging Face publishes for it.
//
// Everything lands in tools/whisper (git-ignored). The app looks there by
// default in development, and electron-builder bundles the CPU build if present.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const WHISPER_TAG = 'b5454';
const RELEASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}`;
const CPU_ZIP = 'whisper-bin-x64.zip';
/** NVIDIA build; needs a driver with CUDA 12.4 support (551.61 or newer). */
const GPU_ZIP = 'whisper-bin-win-cuda-12.4.0-x64.zip';
const MODELS = ['tiny.en', 'base.en', 'small.en', 'large-v3-turbo-q5_0', 'large-v3-turbo-q8_0', 'large-v3-turbo'];
const gpu = process.argv.includes('--gpu');

const modelArg = process.argv.indexOf('--model');
const model = modelArg > 0 ? process.argv[modelArg + 1] : 'base.en';
if (!MODELS.includes(model)) {
  console.error(`Unknown model "${model}". Choose one of: ${MODELS.join(', ')}`);
  process.exit(1);
}

const root = resolve('tools', 'whisper');
const binDir = join(root, 'bin');
const gpuDir = join(root, 'bin-gpu');
const modelDir = join(root, 'models');
mkdirSync(binDir, { recursive: true });
mkdirSync(modelDir, { recursive: true });

/** SHA-256 digests published for the release assets (GitHub) and model files (Hugging Face). */
async function publishedDigests() {
  const digests = new Map();
  const headers = { 'User-Agent': 'interviewpilot-setup' };
  const get = async (url) => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  };
  try {
    const release = await get(`https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/${WHISPER_TAG}`);
    for (const a of release.assets ?? []) if (a.digest) digests.set(a.name, a.digest.replace(/^sha256:/, ''));
    for (const repo of ['ggerganov/whisper.cpp', 'ggml-org/whisper-vad']) {
      for (const f of await get(`https://huggingface.co/api/models/${repo}/tree/main`)) if (f.lfs?.oid) digests.set(f.path, f.lfs.oid);
    }
  } catch (err) {
    console.warn(`Could not fetch published checksums (${err.message}); downloads will not be verified.`);
  }
  return digests;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, dest, expected) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  if (expected) {
    const actual = await sha256(tmp);
    if (actual !== expected) {
      rmSync(tmp, { force: true });
      throw new Error(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}`);
    }
    console.log('  SHA-256 verified');
  } else {
    console.warn('  No published checksum found; not verified');
  }
  renameSync(tmp, dest);
  console.log(`  -> ${dest} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
}

/** The release zip nests binaries in a Release/ folder; flatten it into `dir`. */
function flatten(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      flatten(full);
      for (const inner of readdirSync(full)) renameSync(join(full, inner), join(dir, inner));
      rmSync(full, { recursive: true, force: true });
    }
  }
}

/** Download a release zip and unpack it into `dir`. */
async function installBinaries(zipName, dir) {
  mkdirSync(dir, { recursive: true });
  const zip = join(root, zipName);
  await download(`${RELEASE_URL}/${zipName}`, zip, digests.get(zipName));
  // Windows 10+ ships bsdtar, which extracts zip files.
  const result = spawnSync('tar', ['-xf', zip, '-C', dir], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Failed to extract ${zipName}`);
  flatten(dir);
  rmSync(zip, { force: true });
  if (!existsSync(join(dir, 'whisper-server.exe'))) {
    throw new Error('whisper-server.exe not found after extraction; the release layout may have changed.');
  }
}

const digests = await publishedDigests();

if (existsSync(join(binDir, 'whisper-server.exe'))) {
  console.log('whisper.cpp binaries already present.');
} else {
  await installBinaries(CPU_ZIP, binDir);
}

if (gpu) {
  if (existsSync(join(gpuDir, 'whisper-server.exe'))) console.log('whisper.cpp GPU (CUDA) binaries already present.');
  else await installBinaries(GPU_ZIP, gpuDir);
}

const modelName = `ggml-${model}.bin`;
const modelFile = join(modelDir, modelName);
if (existsSync(modelFile)) {
  console.log(`Model ${model} already present.`);
} else {
  await download(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelName}`, modelFile, digests.get(modelName));
}

// Silero voice-activity detection (~0.9 MB): lets the server skip noise instead of
// inventing text for it. The app enables it whenever this file is present.
const vadName = 'ggml-silero-v5.1.2.bin';
const vadFile = join(modelDir, vadName);
if (existsSync(vadFile)) {
  console.log('VAD model already present.');
} else {
  await download(`https://huggingface.co/ggml-org/whisper-vad/resolve/main/${vadName}`, vadFile, digests.get(vadName));
}

console.log('\nwhisper.cpp is ready:');
console.log(`  server: ${join(gpu ? gpuDir : binDir, 'whisper-server.exe')}`);
console.log(`  model:  ${modelFile}`);
console.log(`  VAD:    ${vadFile}`);
