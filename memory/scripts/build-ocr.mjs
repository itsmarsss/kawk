import { spawnSync } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit local build only. The application never downloads or builds OCR.
if (process.platform !== 'darwin') {
  console.error('Apple Vision OCR requires macOS.');
  process.exit(1);
}
const source = fileURLToPath(new URL('../native/recognize-text.swift', import.meta.url));
const output = fileURLToPath(new URL('../node_modules/.cache/kawk/recognize-text', import.meta.url));
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const result = spawnSync('xcrun', ['swiftc', '-O', source, '-o', output], {
  shell: false, stdio: 'inherit', timeout: 120000,
});
if (result.error || result.status !== 0) {
  console.error('OCR build failed. Install the macOS command-line developer tools and retry.');
  process.exit(1);
}
await chmod(output, 0o700);
console.log(`Built local Apple Vision OCR: ${output}`);
