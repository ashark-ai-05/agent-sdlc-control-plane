import { main as runAgentSdlc } from './app.mjs';

export function main(argv = process.argv.slice(2)) {
  return runAgentSdlc(argv);
}
