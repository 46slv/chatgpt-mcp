import os from 'node:os';
import path from 'node:path';

export const WS_DISPATCH_OWNER = 'ChatGPTMCPProbe';
export const WS_DISPATCH_ROOT_NAME = 'ws-dispatch-v1';
export const WS_DISPATCH_TASK_NAME = 'ChatGPTMCPProbe WS Dispatch v1';

export function resolveWsDispatchConfig({ env = process.env, root = null, checkpointStateRoot = null } = {}) {
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const ownerRoot = path.join(localAppData, WS_DISPATCH_OWNER);
  const dispatchRoot = path.resolve(root || env.WS_DISPATCH_ROOT || path.join(ownerRoot, WS_DISPATCH_ROOT_NAME));
  const resolvedCheckpointStateRoot = path.resolve(
    checkpointStateRoot
      || env.CHECKPOINT_AUTOREPORT_STATE_ROOT
      || path.join(ownerRoot, 'checkpoint-autoreport-v1'),
  );
  return Object.freeze({
    owner: WS_DISPATCH_OWNER,
    root: dispatchRoot,
    checkpoint_state_root: resolvedCheckpointStateRoot,
    runtime_root: path.join(dispatchRoot, 'runtime'),
    releases_root: path.join(dispatchRoot, 'runtime', 'releases'),
    installation_file: path.join(dispatchRoot, 'runtime', 'installation.json'),
    log_file: path.join(dispatchRoot, 'logs', 'dispatcher.jsonl'),
    task_name: env.WS_DISPATCH_TASK_NAME || WS_DISPATCH_TASK_NAME,
  });
}
