/** Library entry point: the CLI, the diff pipeline, and the report types for custom renderers. */
export { main } from './main.ts';
export type { Io } from './main.ts';
export { compareFiles } from './compare.ts';
export type { CompareOptions } from './compare.ts';
export { expandPatterns } from './sources/files.ts';
export type { SpecFile } from './sources/files.ts';
export { renderConsole } from './render/console.ts';
export type { ConsoleOptions } from './render/console.ts';
export { renderHtml } from './render/html.ts';
export type { HtmlOptions } from './render/html.ts';
export { InputError } from './errors.ts';
export type * from './diff/report.ts';
export type * from './model/tree.ts';
