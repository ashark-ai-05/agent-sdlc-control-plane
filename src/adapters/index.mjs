import { createMockAgentAdapter } from './mock-agent.mjs';

export function resolveAgentAdapter(name = 'mock-agent') {
  if (name === 'mock-agent' || name === 'mock') return createMockAgentAdapter();
  throw new Error(`unsupported agent adapter: ${name}`);
}
