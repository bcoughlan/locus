import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Write "Hello, world!" to a file. A placeholder that proves the project structure works. */
export async function writeHelloWorld(file = join(tmpdir(), 'hello-world')): Promise<string> {
    await writeFile(file, 'Hello, world!\n');
    return file;
}
