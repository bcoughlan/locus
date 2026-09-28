/**
 * Command-line entry point. `main()` never calls `process.exit`: it returns the
 * exit code, so tests can call it in-process.
 */
import { createRequire } from 'node:module';
import { supportsColor } from 'chalk';
import type { ColorSupport } from 'chalk';
import { Command, CommanderError, Option } from 'commander';
import { DEFAULT_BASE, runDiff } from './commands/diff.ts';
import { InputError } from './errors.ts';
import type { ColorLevel } from './render/console.ts';

export interface Io {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    /** The folder that relative paths start from. */
    cwd: string;
    /** The colors that stdout shows. `--no-color` turns colors off either way. */
    color: ColorLevel;
}

/** Exit code for usage and input errors. Exit code 1 means "breaking changes found". */
export const EXIT_ERROR = 2;

const { version, description } = createRequire(import.meta.url)('../package.json') as { version: string; description: string };

/**
 * The color level for stdout. chalk detects the terminal and honors
 * FORCE_COLOR. NO_COLOR (https://no-color.org) turns colors off.
 */
export function detectColor(env: NodeJS.ProcessEnv, detected: Pick<ColorSupport, 'level'> | false): ColorLevel {
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
        return 0;
    }
    return detected === false ? 0 : detected.level;
}

function processIo(): Io {
    return {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        cwd: process.cwd(),
        color: detectColor(process.env, supportsColor),
    };
}

export async function main(argv: string[], io: Io = processIo()): Promise<number> {
    let exitCode = 0;
    const program = new Command()
        .name('locus')
        .description(description)
        .version(version)
        .exitOverride()
        .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

    program
        .command('diff')
        .description('Compare OpenAPI documents with a base version. Exit code 1 means breaking changes.')
        .argument('<specs...>', 'head version: OpenAPI files, folders, or glob patterns (quote the globs)')
        .addOption(new Option('--base <ref>', `git ref of the base version (default: ${DEFAULT_BASE})`).conflicts('source'))
        .addOption(
            new Option('--source <pattern>', 'base version from local files instead of git: a file, folder, or glob pattern. Repeatable.')
                .argParser((value: string, previous: string[] = []) => [...previous, value]),
        )
        .option('--all', 'also print unchanged endpoints', false)
        .option('--no-color', 'print without colors')
        .option('--html <path>', 'also write the report as an HTML page to this file')
        .action(async (specs: string[], options: { base?: string; source?: string[]; all: boolean; color: boolean; html?: string }) => {
            exitCode = await runDiff(specs, { ...options, source: options.source ?? [], color: options.color ? io.color : 0 }, io);
        });

    try {
        await program.parseAsync(argv, { from: 'user' });
        return exitCode;
    } catch (err) {
        if (err instanceof CommanderError) {
            // --help and --version exit 0. Every other commander error is a usage error.
            return err.exitCode === 0 ? 0 : EXIT_ERROR;
        }
        if (err instanceof InputError) {
            io.stderr(`error: ${err.message}\n`);
            return EXIT_ERROR;
        }
        io.stderr(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        return EXIT_ERROR;
    }
}
