import { createAmpAdapter } from './amp.mjs';
import { createMockAgentAdapter } from './mock-agent.mjs';

export function resolveAgentAdapter(name = 'mock-agent') {
  if (name === 'mock-agent' || name === 'mock') return createMockAgentAdapter();
  if (name === 'amp') return createAmpAdapter();
  throw new Error(`unsupported agent adapter: ${name}`);
}
