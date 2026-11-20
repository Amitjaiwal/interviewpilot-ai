// Makes sure the installer's copy of whisper.cpp can start on a PC with nothing else installed.
//
// whisper-server.exe and its DLLs link dynamically against the Microsoft C++ runtime, which is
// not part of a clean Windows and not in the whisper.cpp release. Developer PCs nearly always
// have it in System32, so the app works there and only fails on someone else's machine. An
// installer that asks for the VC++ Redistributable would need administrator rights, which this
// per-user installer otherwise does not, so the DLLs are deployed next to the server instead;
// Windows looks in the exe's folder first. Used by scripts/after-pack.cjs.
const { copyFileSync, existsSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const VC_RUNTIME = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll'];

/** The bundle the installer promises; electron-builder silently skips files that are absent. */
const REQUIRED_FILES = [
  'bin/whisper-server.exe',
  'bin/whisper.dll',
  'bin/ggml.dll',
  'bin/ggml-base.dll',
  'bin/ggml-cpu-x64.dll',
  'models/ggml-small.en.bin',
  'models/ggml-base.en.bin',
  'models/ggml-silero-v5.1.2.bin',
];

/** Part of every supported Windows (10 version 2004 or newer). */
const WINDOWS_DLL = /^(kernel32|advapi32|user32|shell32|ole32|oleaut32|ws2_32|bcrypt|ntdll|api-ms-win-.+)\.dll$/i;

/** DLL names a PE file imports (normal and delay-loaded), and whether it is x64. */
function readImports(file) {
  const b = readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  const optional = pe + 24;
  const directories = optional + 112; // PE32+ layout; other formats are rejected by the x64 check
  const sectionTable = optional + b.readUInt16LE(pe + 20);
  const sections = Array.from({ length: b.readUInt16LE(pe + 6) }, (_, i) => {
    const s = sectionTable + i * 40;
    return { rva: b.readUInt32LE(s + 12), size: b.readUInt32LE(s + 8), raw: b.readUInt32LE(s + 20) };
  });
  const offset = (rva) => {
    const s = sections.find((x) => rva >= x.rva && rva < x.rva + x.size);
    if (!s) throw new Error(`${file}: bad RVA ${rva}`);
    return rva - s.rva + s.raw;
  };
  const cstring = (at) => b.toString('latin1', at, b.indexOf(0, at));

  const x64 = b.readUInt16LE(pe + 4) === 0x8664;
  const names = [];
  // [data directory index, descriptor size, offset of the name field in a descriptor]
  for (const [index, size, nameField] of [[1, 20, 12], [13, 32, 4]]) {
    const rva = b.readUInt32LE(directories + index * 8);
    if (!rva) continue;
    for (let d = offset(rva); b.readUInt32LE(d + nameField) !== 0; d += size) {
      names.push(cstring(offset(b.readUInt32LE(d + nameField))));
    }
  }
  return { x64, names };
}

/** Problems that would stop the binaries in `binDir` from loading on a clean PC. */
function findLoadProblems(binDir) {
  const files = readdirSync(binDir).filter((f) => /\.(exe|dll)$/i.test(f));
  const present = new Set(files.map((f) => f.toLowerCase()));
  const problems = [];
  for (const file of files) {
    const { x64, names } = readImports(path.join(binDir, file));
    if (!x64) problems.push(`${file} is not x64`);
    for (const dll of names) {
      if (!present.has(dll.toLowerCase()) && !WINDOWS_DLL.test(dll)) problems.push(`${file} needs ${dll}`);
    }
  }
  return problems;
}

/** Add the C++ runtime to a bundled whisper folder; throw if the result could not run on a clean PC. */
function prepareWhisperBundle(whisperDir) {
  const absent = REQUIRED_FILES.filter((f) => !existsSync(path.join(whisperDir, f)));
  if (absent.length) {
    throw new Error(`The installer would have no working speech engine; missing: ${absent.join(', ')}. Run "npm run setup:whisper:installer" first.`);
  }
  const binDir = path.join(whisperDir, 'bin');
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  for (const dll of VC_RUNTIME) {
    const source = path.join(system32, dll);
    if (!existsSync(source)) {
      throw new Error(`${source} not found. Install the C++ runtime on this build machine: winget install Microsoft.VCRedist.2015+.x64`);
    }
    copyFileSync(source, path.join(binDir, dll));
  }
  const problems = findLoadProblems(binDir);
  if (problems.length) throw new Error(`whisper.cpp would not start on a clean PC:\n  ${problems.join('\n  ')}`);
}

module.exports = { findLoadProblems, prepareWhisperBundle };
