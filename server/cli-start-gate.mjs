/** Holds no CLI command until the parent has durably recorded this process PID. */
import { spawn } from 'node:child_process';

let child;
let stopping = false;
let killTimer;
function stop(signal = 'SIGTERM') {
  if (stopping && signal !== 'SIGKILL') return;
  stopping = true;
  if (!child) { process.exit(1); return; }
  try { child.kill(signal); } catch { /* Already exited. */ }
  clearTimeout(killTimer);
  if (signal === 'SIGKILL') return;
  killTimer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
  }, 5000);
}
// After release this PID continues to represent the CLI, even if the observer exits.
process.on('disconnect', () => { if (!child) stop(); });
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
process.on('message', message => {
  if (message?.type === 'stop' && ['SIGTERM', 'SIGKILL'].includes(message.signal)) { stop(message.signal); return; }
  if (child || stopping || !process.connected || message?.type !== 'start'
    || typeof message.command !== 'string' || !Array.isArray(message.args)
    || message.args.some(value => typeof value !== 'string') || typeof message.stdin !== 'string') {
    stop(); return;
  }
  child = spawn(message.command, message.args, { stdio: ['pipe', 'inherit', 'inherit'], shell: false });
  child.on('error', () => { process.stderr.write('CLI executable failed to start\n'); });
  child.on('close', code => {
    clearTimeout(killTimer);
    process.exit(stopping ? 1 : code ?? 1);
  });
  child.stdin.on('error', () => { /* Child close reports the command failure. */ });
  child.stdin.end(message.stdin);
});
if (!process.connected) stop();
