import { PROTOCOL_VERSION } from '@orchestrator/protocol';
import { expect, it } from 'vitest';
import { describeServer } from './index.js';

it('reports the shared protocol version', () => {
  expect(describeServer()).toEqual({
    name: 'orchestrator-server',
    protocolVersion: PROTOCOL_VERSION,
  });
});
