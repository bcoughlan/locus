/**
 * Compares two view trees and produces the diff report.
 *
 * Nodes match by key among siblings. Operations match by `operationId` first,
 * then by method and path. A node on one side only is added or removed: the
 * rules classify it once, and its descendants inherit that severity. A node
 * on both sides compares its attributes, and each changed attribute gets a
 * verdict from the rules.
 */
import { isDeepStrictEqual } from 'node:util';
import type { AttrName, DocumentModel, ViewNode } from '../model/tree.ts';
import { STRUCTURAL_KINDS } from '../model/tree.ts';
import { canonicalJson } from '../util.ts';
import { maxSeverity } from './report.ts';
import type { AttrChange, ChangeStatus, DiffNode, DiffReport, DocumentDiff, EndpointCounts, Severity } from './report.ts';
import { SET_ATTRS, classifyAdded, classifyAttr, classifyRemoved, normalizePath } from './rules.ts';
import type { Parents } from './rules.ts';

type Pair = [base: ViewNode | undefined, head: ViewNode | undefined];

export interface DocumentSide {
    display: string;
    model: DocumentModel;
}

/** Compare one document pair. A side is absent when the file exists in one version only. */
export function diffDocument(id: string, base: DocumentSide | undefined, head: DocumentSide | undefined): DocumentDiff {
    const info = diffNode(base?.model.info, head?.model.info);
    const servers = { base: base?.model.info.attrs.servers, head: head?.model.info.attrs.servers };
    const operations = diffOperations(base?.model.operations ?? [], head?.model.operations ?? [], servers);
    const webhooks = diffOperations(base?.model.webhooks ?? [], head?.model.webhooks ?? [], servers);
    const impact = [info, ...operations, ...webhooks].reduce<Severity | undefined>((max, node) => maxSeverity(max, node.impact), undefined);
    const status: ChangeStatus = base === undefined ? 'added' : head === undefined ? 'removed' : impact === undefined ? 'unchanged' : 'changed';
    return {
        id,
        base: base?.display,
        head: head?.display,
        status,
        info,
        operations,
        webhooks,
        warnings: [...(head?.model.warnings ?? []), ...(base?.model.warnings ?? []).map((warning) => `base: ${warning}`)],
        impact,
    };
}

export function buildReport(documents: DocumentDiff[], baseLabel: string, headLabel: string): DiffReport {
    const endpoints: EndpointCounts = { added: 0, removed: 0, breaking: 0, compatible: 0, unchanged: 0 };
    for (const endpoint of documents.flatMap((doc) => [...doc.operations, ...doc.webhooks])) {
        if (endpoint.status === 'added' || endpoint.status === 'removed') {
            endpoints[endpoint.status]++;
        } else {
            endpoints[endpoint.impact ?? 'unchanged']++;
        }
    }
    return { baseLabel, headLabel, documents, endpoints, breaking: documents.some((doc) => doc.impact === 'breaking') };
}

/** Compare two nodes. `parents` holds their parents on both sides, for rules that look at the context. */
export function diffNode(base: ViewNode | undefined, head: ViewNode | undefined, parents: Parents = {}): DiffNode {
    if (base !== undefined && head !== undefined) {
        return diffMatched(base, head);
    }
    if (head !== undefined) {
        return diffOneSided(head, 'added', parents);
    }
    if (base !== undefined) {
        return diffOneSided(base, 'removed', parents);
    }
    throw new Error('diffNode needs at least one node');
}

function diffMatched(base: ViewNode, head: ViewNode): DiffNode {
    const children = pairChildren(base, head).map(([b, h]) => diffNode(b, h, { base, head }));
    const changes = STRUCTURAL_KINDS.has(head.kind) ? [] : diffAttrs(base, head);
    const own = changes.reduce<Severity | undefined>((max, change) => maxSeverity(max, change.severity), undefined);
    const node: DiffNode = {
        kind: head.kind,
        key: head.key,
        label: head.label,
        direction: head.direction,
        status: changes.length > 0 ? 'changed' : 'unchanged',
        verdict: own === undefined ? undefined : { severity: own },
        attrs: head.attrs,
        changes,
        children,
        impact: children.reduce((max, child) => maxSeverity(max, child.impact), own),
    };
    // `not` reverses the meaning of everything inside it, so the directional rules do not apply.
    return head.kind === 'not' ? allBreaking(node) : node;
}

function allBreaking(node: DiffNode): DiffNode {
    const breaking = <T extends { severity: Severity; reason?: string }>(verdict: T): T => ({
        ...verdict,
        severity: 'breaking',
        ...(verdict.reason === undefined ? {} : { reason: `${verdict.reason}, inside "not"` }),
    });
    return {
        ...node,
        verdict: node.verdict === undefined ? undefined : breaking(node.verdict),
        changes: node.changes.map(breaking),
        children: node.children.map(allBreaking),
        impact: node.impact === undefined ? undefined : 'breaking',
    };
}

/**
 * An added or removed node. A structural node (section, group) has no facts
 * of its own, so each child is classified on its own. Any other node is
 * classified once, and its subtree inherits the severity.
 */
function diffOneSided(node: ViewNode, status: 'added' | 'removed', parents: Parents): DiffNode {
    if (STRUCTURAL_KINDS.has(node.kind)) {
        const own: Parents = status === 'added' ? { head: node } : { base: node };
        const children = node.children.map((child) => diffOneSided(child, status, own));
        const impact = children.reduce<Severity | undefined>((max, child) => maxSeverity(max, child.impact), undefined);
        return { ...copy(node, status, children), verdict: impact === undefined ? undefined : { severity: impact }, impact };
    }
    const verdict = status === 'added' ? classifyAdded(node, parents) : classifyRemoved(node, parents);
    const inherit = (child: ViewNode): DiffNode => ({
        ...copy(child, status, child.children.map(inherit)),
        verdict: { severity: verdict.severity },
        impact: verdict.severity,
    });
    return { ...copy(node, status, node.children.map(inherit)), verdict, impact: verdict.severity };
}

function copy(node: ViewNode, status: ChangeStatus, children: DiffNode[]): DiffNode {
    return { kind: node.kind, key: node.key, label: node.label, direction: node.direction, status, attrs: node.attrs, changes: [], children };
}

function diffAttrs(base: ViewNode, head: ViewNode): AttrChange[] {
    const changes: AttrChange[] = [];
    // Path parameters match by position, so their name can differ. Other labels derive from keys or attributes.
    if (base.label !== head.label && head.kind === 'parameter') {
        changes.push({ name: 'name', before: base.label, after: head.label, severity: 'compatible', reason: 'renamed' });
    }
    const names = new Set([...Object.keys(head.attrs), ...Object.keys(base.attrs)] as AttrName[]);
    for (const name of names) {
        const before = base.attrs[name];
        const after = head.attrs[name];
        if (!attrEqual(name, before, after)) {
            changes.push({ name, before, after, ...classifyAttr(name, before, after, head) });
        }
    }
    return changes;
}

function attrEqual(name: AttrName, a: unknown, b: unknown): boolean {
    if (SET_ATTRS.has(name) && Array.isArray(a) && Array.isArray(b)) {
        const sorted = (list: unknown[]) => list.map(canonicalJson).sort();
        return isDeepStrictEqual(sorted(a), sorted(b));
    }
    return isDeepStrictEqual(a, b);
}

// --- Matching ---------------------------------------------------------------

function pairChildren(base: ViewNode, head: ViewNode): Pair[] {
    return head.kind === 'callback' ? matchOperations(base.children, head.children) : pairRenamedVariants(matchByKey(base.children, head.children));
}

function diffOperations(base: ViewNode[], head: ViewNode[], servers: { base?: string[]; head?: string[] }): DiffNode[] {
    return matchOperations(base, head).map((pair) => diffNode(...inheritServers(pair, servers)));
}

/**
 * An operation without `servers` uses the document servers. When only one
 * side overrides them, give the other side its document servers, so the rule
 * compares the servers that clients actually call.
 */
function inheritServers([base, head]: Pair, servers: { base?: string[]; head?: string[] }): Pair {
    if (base === undefined || head === undefined || (base.attrs.servers === undefined) === (head.attrs.servers === undefined)) {
        return [base, head];
    }
    const fill = (node: ViewNode, inherited: string[] | undefined): ViewNode =>
        node.attrs.servers !== undefined || inherited === undefined ? node : { ...node, attrs: { ...node.attrs, servers: inherited } };
    return [fill(base, servers.base), fill(head, servers.head)];
}

/**
 * Variants match by schema name. When names change (a renamed component), as
 * many variants are removed as added: pair those by position, so the diff
 * shows the rename and the real differences, not a removal plus an addition.
 */
function pairRenamedVariants(pairs: Pair[]): Pair[] {
    const removed = pairs.filter(([b, h]) => b?.kind === 'variant' && h === undefined);
    const added = pairs.filter(([b, h]) => b === undefined && h?.kind === 'variant');
    if (removed.length === 0 || removed.length !== added.length) {
        return pairs;
    }
    const partner = new Map(added.map((pair, i) => [pair, removed[i][0]]));
    return pairs.filter((pair) => !removed.includes(pair)).map((pair): Pair => (partner.has(pair) ? [partner.get(pair), pair[1]] : pair));
}

/**
 * Match operations by `operationId` (when unique on both sides), then by
 * method and path, then by method and path with path parameter names ignored.
 */
export function matchOperations(base: ViewNode[], head: ViewNode[]): Pair[] {
    const matches = new Map<ViewNode, ViewNode>(); // head -> base
    const matchedBase = new Set<ViewNode>();
    const strategies: ((op: ViewNode) => string | undefined)[] = [
        (op) => op.attrs.operationId,
        (op) => op.key,
        (op) => `${op.attrs.method} ${normalizePath(op.attrs.path ?? '')}`,
    ];
    for (const [index, keyOf] of strategies.entries()) {
        const unique = index === 0; // An operationId that repeats identifies nothing.
        const candidates = groupBy(base.filter((op) => !matchedBase.has(op)), keyOf);
        const wanted = groupBy(head.filter((op) => !matches.has(op)), keyOf);
        for (const [key, heads] of wanted) {
            const bases = candidates.get(key) ?? [];
            if (unique && (heads.length > 1 || bases.length > 1)) {
                continue;
            }
            heads.forEach((op, i) => {
                if (bases[i] !== undefined) {
                    matches.set(op, bases[i]);
                    matchedBase.add(bases[i]);
                }
            });
        }
    }
    return orderPairs(base, head, matches);
}

/**
 * Match nodes by kind and key: a property named `not` is not a `not` schema.
 * A repeated key (only in invalid documents) matches in order.
 */
function matchByKey(base: ViewNode[], head: ViewNode[]): Pair[] {
    const matches = new Map<ViewNode, ViewNode>();
    const identity = (node: ViewNode) => `${node.kind}:${node.key}`;
    const bases = groupBy(base, identity);
    for (const [key, heads] of groupBy(head, identity)) {
        heads.forEach((node, i) => {
            const match = bases.get(key)?.[i];
            if (match !== undefined) {
                matches.set(node, match);
            }
        });
    }
    return orderPairs(base, head, matches);
}

/**
 * All pairs in head order. A base-only node goes after the node that
 * precedes it in the base order, so removals show where they were.
 */
function orderPairs(base: ViewNode[], head: ViewNode[], matches: Map<ViewNode, ViewNode>): Pair[] {
    const baseIndex = new Map(base.map((node, i) => [node, i]));
    const matchedBase = new Set(matches.values());
    const pairs: Pair[] = [];
    let next = 0; // First base position not yet placed.
    const placeRemovedBefore = (limit: number) => {
        for (; next < limit; next++) {
            if (!matchedBase.has(base[next])) {
                pairs.push([base[next], undefined]);
            }
        }
    };
    for (const node of head) {
        const match = matches.get(node);
        if (match !== undefined) {
            placeRemovedBefore(baseIndex.get(match)!);
            next = Math.max(next, baseIndex.get(match)! + 1);
        }
        pairs.push([match, node]);
    }
    placeRemovedBefore(base.length);
    return pairs;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string | undefined): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const key = keyOf(item);
        if (key === undefined) {
            continue;
        }
        const group = groups.get(key);
        if (group === undefined) {
            groups.set(key, [item]);
        } else {
            group.push(item);
        }
    }
    return groups;
}
