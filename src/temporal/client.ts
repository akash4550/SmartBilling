/**
 * Temporal Client singleton (server-only).
 *
 * Lazily connects to the Temporal Frontend Service on first use and
 * reuses the connection across requests. `taskQueue` is shared between
 * the Worker and the API route that starts workflows — both read from
 * the same validated env so a worker bootstrapped against one queue
 * cannot silently miss workflows started by the webhook route against
 * a differently-named queue (a classic Temporal ops footgun).
 *
 * Configuration is read from the validated `env` object:
 *   TEMPORAL_ADDRESS      default localhost:7233
 *   TEMPORAL_NAMESPACE    default "default"
 *   TEMPORAL_TASK_QUEUE   default "smartbill-webhooks"
 *
 * Why lazy:
 *   Tests, RSCs, and CLI scripts that don't interact with Temporal
 *   never pay the connection cost; and a missing/unreachable Temporal
 *   only fails the code paths that actually try to start a workflow,
 *   not the entire app boot.
 */
import "server-only";

import { Connection, Client, type ClientOptions, WorkflowIdReusePolicy } from "@temporalio/client";
import { env } from "@/env";

export const TEMPORAL_TASK_QUEUE = env.TEMPORAL_TASK_QUEUE;

let clientPromise: Promise<Client> | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const connectOpts: ClientOptions = {
      namespace: env.TEMPORAL_NAMESPACE,
      connection: await Connection.connect({ address: env.TEMPORAL_ADDRESS }),
    };
    const client = new Client(connectOpts);
    return client;
  })();
  return clientPromise;
}

export { WorkflowIdReusePolicy };
