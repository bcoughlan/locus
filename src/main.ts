/**
 * Command-line entry point. `main()` never calls `process.exit`: it returns the
 * exit code, so tests can call it in-process.
 */
import { Command, CommanderError } from 'commander';
import { writeHelloWorld } from './hello-world.ts';

export interface Io {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
}

/** Exit code for usage and input errors. Exit code 1 means "breaking changes found". */
export const EXIT_ERROR = 2;

const processIo: Io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
};

export async function main(argv: string[], io: Io = processIo): Promise<number> {
    const program = new Command()
        .name('locus')
        .description('Toolbox for validating and comparing OpenAPI changes.')
        .exitOverride()
        .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

    program
        .command('hello-world')
        .description('Write "Hello, world!" to a file.')
        .argument('[file]', 'output file (default: hello-world in the temporary folder)')
        .action(async (file: string | undefined) => {
            io.stdout(`Wrote ${await writeHelloWorld(file)}\n`);
        });

    try {
        await program.parseAsync(argv, { from: 'user' });
        return 0;
    } catch (err) {
        if (err instanceof CommanderError) {
            // --help and --version exit 0. Every other commander error is a usage error.
            return err.exitCode === 0 ? 0 : EXIT_ERROR;
        }
        io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
        return EXIT_ERROR;
    }
}
