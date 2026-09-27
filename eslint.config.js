import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    // .claude holds agent worktrees: other checkouts of this repository.
    { ignores: ['dist', 'coverage', '.claude'] },
    eslint.configs.recommended,
    tseslint.configs.recommended,
    { languageOptions: { globals: globals.node } },
);
