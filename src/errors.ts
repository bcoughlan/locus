/**
 * A problem with the user's input: a missing file, a file that does not parse,
 * an unsupported OpenAPI version. The CLI prints the message and exits with 2.
 */
export class InputError extends Error {}
