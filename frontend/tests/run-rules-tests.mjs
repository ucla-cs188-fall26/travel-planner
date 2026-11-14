import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The standalone Firebase CLI bundles its own Node and rewrites bare `node`
// subprocesses. An absolute path preserves this project's Node 22 test runner.
const quoteShell = value => `'${value.replaceAll("'", "'\\''")}'`;
const command = [process.execPath, '--test', fileURLToPath(new URL('./firestore-rules.test.mjs', import.meta.url))]
  .map(quoteShell).join(' ');
const child = spawn('firebase', [
  'emulators:exec', '--only', 'firestore', '--project', 'demo-constraint-rules',
  '--config', 'firebase.rules-test.json', command,
], { stdio: 'inherit', cwd: fileURLToPath(new URL('.', import.meta.url)) });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
