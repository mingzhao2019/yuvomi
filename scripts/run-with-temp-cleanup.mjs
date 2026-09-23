#!/usr/bin/env node
/**
 * Run one command in an isolated temporary directory and remove that directory.
 * The child gets its own process group so forwarded signals also reach npm,
 * shell wrappers, and their descendants.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const command = process.argv[2];
const args = process.argv.slice(3);

if (!command) {
  console.error('Usage: node scripts/run-with-temp-cleanup.mjs COMMAND [ARGUMENT...]');
  process.exitCode = 2;
} else {
  const runTempDir = mkdtempSync(join(tmpdir(), 'yuvomi-test-run-'));
  const childResult = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      detached: true,
      env: { ...process.env, TMPDIR: runTempDir, TMP: runTempDir, TEMP: runTempDir },
      stdio: 'inherit',
    });
    let forwardedSignal = null;
    let escalated = false;

    const forward = (signal) => {
      if (forwardedSignal) {
        if (!escalated) {
          escalated = true;
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        }
        return;
      }
      forwardedSignal = signal;
      try { process.kill(-child.pid, signal); } catch { /* already gone */ }
    };

    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);

    const finish = (result) => {
      process.removeListener('SIGINT', forward);
      process.removeListener('SIGTERM', forward);
      resolve(result);
    };

    child.once('error', (error) => finish({ error }));
    child.once('exit', (code, signal) => finish({ code, signal, forwardedSignal }));
  });

  let cleanupFailed = false;
  try {
    rmSync(runTempDir, { recursive: true, force: true });
  } catch (error) {
    cleanupFailed = true;
    console.error(`Could not remove test temp directory ${runTempDir}: ${error.message}`);
  }

  if (childResult.error) {
    console.error(childResult.error.message);
    process.exitCode = 127;
  } else if (childResult.signal) {
    process.exitCode = 128 + ({ SIGINT: 2, SIGTERM: 15 }[childResult.signal] ?? 1);
  } else {
    process.exitCode = childResult.code ?? 1;
  }

  // A cleanup failure must be visible when the wrapped command was successful,
  // but never hides the command's own failure code.
  if (process.exitCode === 0 && cleanupFailed) process.exitCode = 1;
}
