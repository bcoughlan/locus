/** Runs the CLI. `bin/run.js` imports the built copy; during development, run `node src/bin.ts`. */
import { main } from './main.ts';

process.exitCode = await main(process.argv.slice(2));
