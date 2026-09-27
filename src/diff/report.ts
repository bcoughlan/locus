/**
 * The diff report: the generic output structure that every renderer consumes.
 *
 * It mirrors the view tree ({@link ../model/tree.ts}): each node carries the
 * facts to display plus how they changed. It holds no presentation (colors,
 * markup, layout), so a console renderer and an HTML renderer print the same
 * report.
 */
import type { AttrName, Attrs, Direction, NodeKind } from '../model/tree.ts';

export type Severity = 'breaking' | 'compatible';

/** How the node itself changed. `changed` means its own facts changed. A change below it shows in `impact`. */
export type ChangeStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface Verdict {
    severity: Severity;
    /** Why the change has this severity, for example "maximum decreased in a request". */
    reason: string;
}

export interface AttrChange extends Verdict {
    /** An attribute, or `name` for a node whose label changed (a renamed path parameter). */
    name: AttrName | 'name';
    before?: unknown;
    after?: unknown;
}

export interface DiffNode {
    kind: NodeKind;
    key: string;
    /** The head label, or the base label for a removed node. */
    label: string;
    direction: Direction;
    status: ChangeStatus;
    /**
     * Added or removed node: its classification. The root of an added or
     * removed subtree has a reason; its descendants inherit the severity only.
     * Changed node: the most severe change of its own attributes.
     */
    verdict?: Verdict | { severity: Severity; reason?: undefined };
    /** The facts to display: head values, or base values for a removed node. */
    attrs: Attrs;
    /** Changes of the node's own attributes. Empty unless `status` is `changed`. */
    changes: AttrChange[];
    children: DiffNode[];
    /** The most severe change in this subtree, the node included. Absent when nothing changed. */
    impact?: Severity;
}

export interface DocumentDiff {
    /** Pairing key of the file. */
    id: string;
    /** Display name of the base file. Absent for a new file. */
    base?: string;
    /** Display name of the head file. Absent for a deleted file. */
    head?: string;
    status: ChangeStatus;
    /** The `document` node: title, versions, description, servers. */
    info: DiffNode;
    operations: DiffNode[];
    webhooks: DiffNode[];
    warnings: string[];
    impact?: Severity;
}

export interface EndpointCounts {
    added: number;
    removed: number;
    /** Changed endpoints with at least one breaking change. */
    breaking: number;
    /** Changed endpoints with only compatible changes. */
    compatible: number;
    unchanged: number;
}

export interface DiffReport {
    /** What the base is, for example `origin/main` or `../old/specs/*.yml`. */
    baseLabel: string;
    /** What the head is, for example `working tree` or `specs/*.yml`. */
    headLabel: string;
    documents: DocumentDiff[];
    /** Operations and webhooks of all documents. */
    endpoints: EndpointCounts;
    breaking: boolean;
}

const RANK: Record<Severity, number> = { compatible: 1, breaking: 2 };

/** The more severe of two severities. `undefined` means "no change". */
export function maxSeverity(a: Severity | undefined, b: Severity | undefined): Severity | undefined {
    if (a === undefined) {
        return b;
    }
    if (b === undefined) {
        return a;
    }
    return RANK[a] >= RANK[b] ? a : b;
}
