import fs from 'node:fs';
import path from 'node:path';

export function loadRunStates(stateDir) {
  if (!fs.existsSync(stateDir)) return [];
  return fs.readdirSync(stateDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(stateDir, name);
      try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { file, state, mtimeMs: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function resolveLatestLeafRun({ state_dir, root_run_id } = {}) {
  if (!state_dir) throw new Error('state_dir required');
  if (!root_run_id) throw new Error('root_run_id required');
  const all = loadRunStates(state_dir);
  const byId = new Map(all.map((entry) => [entry.state.run_id, entry]));
  if (!byId.has(root_run_id)) throw new Error('root run not found: ' + root_run_id);
  const descendants = new Set([root_run_id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of all) {
      const parent = entry.state.parent_run_id;
      const id = entry.state.run_id;
      if (parent && descendants.has(parent) && !descendants.has(id)) {
        descendants.add(id);
        changed = true;
      }
    }
  }
  const parentsWithChildren = new Set(
    all
      .filter((entry) => entry.state.parent_run_id && descendants.has(entry.state.parent_run_id))
      .map((entry) => entry.state.parent_run_id)
  );
  const leaves = all.filter(
    (entry) => descendants.has(entry.state.run_id) && !parentsWithChildren.has(entry.state.run_id)
  );
  leaves.sort((a, b) =>
    String(b.state.created_at || '').localeCompare(String(a.state.created_at || '')) ||
    b.mtimeMs - a.mtimeMs ||
    String(b.state.run_id).localeCompare(String(a.state.run_id))
  );
  if (!leaves.length) throw new Error('leaf run not found');
  return leaves[0];
}

export function classifyHeartbeatLeaf(state = {}) {
  if (state.pending) return { safe: false, reason: 'EXEC_IN_FLIGHT' };
  if (String(state.phase || '').includes('IN_FLIGHT')) return { safe: false, reason: 'PHASE_IN_FLIGHT' };
  if (Object.values(state.rounds || {}).some((round) => round && round.send_state === 'IN_FLIGHT')) {
    return { safe: false, reason: 'SUPERVISOR_IN_FLIGHT' };
  }
  if (state.phase === 'NEEDS_HUMAN') return { safe: false, reason: 'NEEDS_HUMAN' };
  if (state.stop_type === 'CIRCUIT_BREAKER_OPEN') return { safe: false, reason: 'CIRCUIT_BREAKER_OPEN' };
  if (state.phase === 'COMPLETE') return { safe: false, reason: 'COMPLETE' };
  if (state.phase === 'CANCELLED') return { safe: false, reason: 'CANCELLED' };
  return { safe: true, reason: 'SAFE' };
}
