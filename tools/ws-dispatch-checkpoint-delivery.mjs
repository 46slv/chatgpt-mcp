import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  dispatchCheckpoint,
  loadCheckpoint,
} from './checkpoint-core.mjs';
import { projectWsDispatchResultToCheckpoint } from './ws-dispatch-checkpoint-adapter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let transportLoaded = false;

async function defaultSend({ packet, target, event }) {
  const transportPath = path.resolve(here, '..', 'dist', 'chatgpt.js');
  const transport = await import(pathToFileURL(transportPath).href);
  transportLoaded = true;
  return event.mode === 'CONSULT'
    ? transport.blockingReply(
        packet,
        60,
        { target_url: target.chat_url, expected_conversation_id: target.conversation_id },
      )
    : transport.sendOnlyReply(
        packet,
        { target_url: target.chat_url, expected_conversation_id: target.conversation_id },
      );
}

export async function closeWsDispatchCheckpointTransport() {
  if (!transportLoaded) return false;
  const browserPath = path.resolve(here, '..', 'dist', 'browser.js');
  const browser = await import(pathToFileURL(browserPath).href);
  await browser.closeBrowser();
  transportLoaded = false;
  return true;
}

export async function connectTerminalResultToCheckpoint({
  root,
  job_id,
  stateRoot,
  now = () => new Date().toISOString(),
  send = defaultSend,
} = {}) {
  const projection = projectWsDispatchResultToCheckpoint({ root, job_id, stateRoot, now });
  if (projection.status === 'SKIPPED' || projection.status === 'IN_FLIGHT_AMBIGUOUS') {
    return Object.freeze({ projection, delivery: null });
  }
  const event = projection.event || loadCheckpoint(
    stateRoot,
    projection.link.mission_id,
    projection.link.checkpoint_id,
  );
  if (!event) throw new Error(`linked checkpoint event is missing: ${job_id}`);
  const delivery = await dispatchCheckpoint({ event, stateRoot, now, send });
  return Object.freeze({ projection, delivery });
}
