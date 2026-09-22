import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildOpenCodeRun } from './ws-dispatch-core.mjs';

export function resolveOpenCodeExecutable(
  platform = process.platform,
  env = process.env,
  existsSync = fs.existsSync,
) {
  if (env.OPENCODE_EXECUTABLE) return path.resolve(env.OPENCODE_EXECUTABLE);
  if (platform !== 'win32') return 'opencode';
  const candidate = env.APPDATA
    ? path.join(env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    : null;
  if (candidate && existsSync(candidate)) return candidate;
  throw new Error('OpenCode native Windows executable was not found; set OPENCODE_EXECUTABLE to the exact opencode.exe path');
}

export async function runOpenCodeWorker({
  job,
  evidence_dir,
  attach = null,
  model = 'opencode-go/muse-spark-1.3-contributor',
  agent = null,
  spawnImpl = spawn,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (!evidence_dir) throw new Error('evidence_dir is required');
  fs.mkdirSync(evidence_dir, { recursive: true });
  const run = buildOpenCodeRun({ job, model, agent, attach });
  const executable = resolveOpenCodeExecutable(platform, env);
  const stdoutName = `${job.job_id}.opencode.jsonl`;
  const stderrName = `${job.job_id}.opencode.stderr.log`;
  const stdoutPath = path.join(evidence_dir, stdoutName);
  const stderrPath = path.join(evidence_dir, stderrName);
  const stdoutFd = fs.openSync(stdoutPath, 'wx');
  const stderrFd = fs.openSync(stderrPath, 'wx');
  return await new Promise((resolve, reject) => {
    let settled = false;
    const closeFds = () => {
      for (const fd of [stdoutFd, stderrFd]) { try { fs.closeSync(fd); } catch {} }
    };
    let child;
    try {
      child = spawnImpl(executable, run.args, { cwd: run.cwd, env, windowsHide: true, shell: false, stdio: ['ignore', stdoutFd, stderrFd] });
    } catch (error) {
      closeFds();
      reject(error);
      return;
    }
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      closeFds();
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      closeFds();
      const evidence_refs = [`evidence/${stdoutName}`, `evidence/${stderrName}`];
      if (code === 0) {
        resolve({ state: 'COMPLETED', summary: 'OpenCode Worker exited successfully; structured JSONL evidence was captured locally.', evidence_refs, error: null });
      } else {
        resolve({ state: 'FAILED', summary: 'OpenCode Worker exited without success.', evidence_refs, error: `exit_code=${code ?? 'null'} signal=${signal ?? 'null'}` });
      }
    });
  });
}
