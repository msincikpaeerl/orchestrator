// Placeholder: the Fastify server is added in lot 0, step B.
import { PROTOCOL_VERSION } from '@orchestrator/protocol';

export function describeServer(): { name: string; protocolVersion: number } {
  return { name: 'orchestrator-server', protocolVersion: PROTOCOL_VERSION };
}
