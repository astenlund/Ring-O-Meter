import {join} from 'node:path';

// Resolves relative to this file's own location so callers at any
// depth in web/ get the same result without composing the relative
// hop themselves. import.meta.dirname needs Node 20.11+; the repo
// requires Node 22+ per CLAUDE.md.
export function audioFixturePath(name: string): string {
    return join(import.meta.dirname, 'test-fixtures', name);
}
