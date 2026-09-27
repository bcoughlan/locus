/**
 * Compares two view trees and produces the diff report.
 *
 * Nodes match by key among siblings. Operations match by `operationId` first,
 * then by method and path. A node on one side only is added or removed: the
 * rules classify it once, and its descendants inherit that severity. A node
 * on both sides compares its attributes, and each changed attribute gets a
 * verdict from the rules.
 *
 * References: when both nodes refer to schema definitions, the diff compares
 * the two definitions once, stores the result in the report's schema table,
 * and every node with the same pair of references shares it. When only one
 * node is a reference, it is expanded one level and compared in place.
 */
import { isDeepStrictEqual } from 'node:util';
import { STRUCTURAL_KINDS, effectiveAttrs } from '../model/tree.ts';
import type { AttrName, DocumentModel, ViewNode } from '../model/tree.ts';
import { canonicalJson } from '../util.ts';
import { endpointOutcome, maxSeverity } from './report.ts';
import type { AttrChange, ChangeStatus, DiffNode, DiffReport, DocumentDiff, EndpointCounts, Severity, Verdict } from './report.ts';
import { SET_ATTRS, TYPE_SPECIFIC_ATTRS, classifyAdded, classifyAttr, classifyRemoved, normalizePath, typesDisjoint } from './rules.ts';
import type { Parents } from './rules.ts';

type Pair = [base: ViewNode | undefined, head: ViewNode | undefined];

export interface DocumentSide {
    display: string;
    model: DocumentModel;
}

/** The schema definitions of both sides, and the definition diffs built from them. */
interface DiffContext {
    base: Map<string, ViewNode>;
    head: Map<string, ViewNode>;
    /** Definition diffs by id. An id is taken before its diff is done, so a reference cycle finds it. */
    schemas: Map<string, DiffNode>;
    /** Ids of definition diffs by what they compare: `<base ref>\0<head ref>`, or a one-sided key. */
    ids: Map<string, string>;
}

/** Compare one document pair. A side is absent when the file exists in one version only. */
export function diffDocument(id: string, base: DocumentSide | undefined, head: DocumentSide | undefined): DocumentDiff {
    const ctx: DiffContext = { base: base?.model.schemas ?? new Map(), head: head?.model.schemas ?? new Map(), schemas: new Map(), ids: new Map() };
    const info = diffNode(base?.model.info, head?.model.info, {}, ctx);
    const servers = { base: base?.model.info.attrs.servers, head: head?.model.info.attrs.servers };
    const operations = diffOperations(base?.model.operations ?? [], head?.model.operations ?? [], servers, ctx);
    const webhooks = diffOperations(base?.model.webhooks ?? [], head?.model.webhooks ?? [], servers, ctx);
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
        schemas: Object.fromEntries(ctx.schemas),
        warnings: mergeWarnings(base?.model.warnings ?? [], head?.model.warnings ?? []),
        impact,
    };
}

/** Head warnings, then base warnings that the head does not repeat, marked as such. */
function mergeWarnings(base: string[], head: string[]): string[] {
    const shown = new Set(head);
    return [...head, ...base.filter((warning) => !shown.has(warning)).map((warning) => `base: ${warning}`)];
}

export function buildReport(documents: DocumentDiff[], baseLabel: string, headLabel: string): DiffReport {
    const endpoints: EndpointCounts = { added: 0, removed: 0, breaking: 0, compatible: 0, unchanged: 0 };
    for (const endpoint of documents.flatMap((doc) => [...doc.operations, ...doc.webhooks])) {
        endpoints[endpointOutcome(endpoint)]++;
    }
    return { baseLabel, headLabel, documents, endpoints, breaking: documents.some((doc) => doc.impact === 'breaking') };
}

/** Compare two nodes. `parents` holds their parents on both sides, for rules that look at the context. */
function diffNode(base: ViewNode | undefined, head: ViewNode | undefined, parents: Parents, ctx: DiffContext): DiffNode {
    if (base !== undefined && head !== undefined) {
        return diffMatched(base, head, ctx);
    }
    if (head !== undefined) {
        return diffOneSided(head, 'added', parents, ctx);
    }
    if (base !== undefined) {
        return diffOneSided(base, 'removed', parents, ctx);
    }
    throw new Error('diffNode needs at least one node');
}

function diffMatched(base: ViewNode, head: ViewNode, ctx: DiffContext): DiffNode {
    if ((base.ref === undefined) !== (head.ref === undefined)) {
        // A reference on one side only (a schema moved into or out of a component): compare in place.
        return diffMatched(expand(base, ctx.base), expand(head, ctx.head), ctx);
    }
    const ref = base.ref !== undefined && head.ref !== undefined ? definitionDiff(base.ref, head.ref, ctx) : undefined;
    const children = pairChildren(base, head).map(([b, h]) => diffNode(b, h, { base, head }, ctx));
    const changes = STRUCTURAL_KINDS.has(head.kind) ? [] : diffAttrs(base, head);
    const own = changes.reduce<Severity | undefined>((max, change) => maxSeverity(max, change.severity), undefined);
    const inside = ref === undefined ? undefined : ctx.schemas.get(ref)?.impact;
    const node: DiffNode = {
        ...copy(head, changes.length > 0 ? 'changed' : 'unchanged', children),
        verdict: own === undefined ? undefined : { severity: own },
        changes,
        ref,
        source: { base: base.source, head: head.source },
        impact: children.reduce((max, child) => maxSeverity(max, child.impact), maxSeverity(own, inside)),
    };
    // `not` reverses the meaning of everything inside it, so the directional rules do not apply.
    return head.kind === 'not' ? allBreaking(node) : node;
}

/**
 * The diff of two schema definitions, by id in the context's table. Each pair
 * is compared once. A reference cycle finds the id while the diff is still in
 * progress; the enclosing node carries the impact.
 */
function definitionDiff(baseRef: string, headRef: string, ctx: DiffContext): string | undefined {
    const base = ctx.base.get(baseRef);
    const head = ctx.head.get(headRef);
    if (base === undefined || head === undefined) {
        return undefined;
    }
    return memo(`${baseRef}\0${headRef}`, head.label, ctx, () => diffMatched(base, head, ctx));
}

/**
 * A definition shown as added or removed, for the reference of an added or
 * removed node. It inherits the severity of that node.
 */
function oneSidedDefinition(ref: string, status: 'added' | 'removed', severity: Severity, ctx: DiffContext): string | undefined {
    const definition = (status === 'added' ? ctx.head : ctx.base).get(ref);
    if (definition === undefined) {
        return undefined;
    }
    return memo(`${status}\0${severity}\0${ref}`, definition.label, ctx, () => inherit(definition, status, severity, ctx));
}

/** Take an id for `key`, then build its entry. The id exists before the build, so a cycle finds it. */
function memo(key: string, label: string, ctx: DiffContext, build: () => DiffNode): string {
    let id = ctx.ids.get(key);
    if (id === undefined) {
        id = `${label}#${ctx.ids.size + 1}`;
        ctx.ids.set(key, id);
        ctx.schemas.set(id, build());
    }
    return id;
}

/** A reference node as an inline node: its definition's facts under its own, and the definition's children. */
function expand(node: ViewNode, schemas: Map<string, ViewNode>): ViewNode {
    const definition = node.ref === undefined ? undefined : schemas.get(node.ref);
    if (definition === undefined) {
        return node;
    }
    return {
        ...node,
        attrs: effectiveAttrs(node, (id) => schemas.get(id)),
        children: [...definition.children, ...node.children],
        omitted: definition.omitted,
        ref: undefined,
    };
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
function diffOneSided(node: ViewNode, status: 'added' | 'removed', parents: Parents, ctx: DiffContext): DiffNode {
    if (STRUCTURAL_KINDS.has(node.kind)) {
        const own: Parents = status === 'added' ? { head: node } : { base: node };
        const children = node.children.map((child) => diffOneSided(child, status, own, ctx));
        const impact = children.reduce<Severity | undefined>((max, child) => maxSeverity(max, child.impact), undefined);
        return { ...copy(node, status, children), verdict: impact === undefined ? undefined : { severity: impact }, impact };
    }
    const verdict = status === 'added' ? classifyAdded(node, parents) : classifyRemoved(node, parents);
    return { ...inherit(node, status, verdict.severity, ctx), verdict };
}

/** A node and its subtree, all with the same status and severity. References point to one-sided definitions. */
function inherit(node: ViewNode, status: 'added' | 'removed', severity: Severity, ctx: DiffContext): DiffNode {
    const verdict: Verdict | { severity: Severity } = { severity };
    return {
        ...copy(node, status, node.children.map((child) => inherit(child, status, severity, ctx))),
        verdict,
        ref: node.ref === undefined ? undefined : oneSidedDefinition(node.ref, status, severity, ctx),
        impact: severity,
    };
}

function copy(node: ViewNode, status: ChangeStatus, children: DiffNode[]): DiffNode {
    const source = node.source === undefined ? undefined : status === 'removed' ? { base: node.source } : { head: node.source };
    return { kind: node.kind, key: node.key, label: node.label, direction: node.direction, status, attrs: node.attrs, changes: [], children, source };
}

function diffAttrs(base: ViewNode, head: ViewNode): AttrChange[] {
    const changes: AttrChange[] = [];
    // Path parameters match by position (key `#0`), so their name can differ. Other labels derive from keys or attributes.
    if (base.label !== head.label && head.kind === 'parameter' && head.key.startsWith('#')) {
        changes.push({ name: 'name', before: base.label, after: head.label, severity: 'compatible', reason: 'renamed' });
    }
    // After a change to a type with nothing in common (string to object), the old format or length limit says nothing new.
    const skip = typesDisjoint(base.attrs.type, head.attrs.type) ? TYPE_SPECIFIC_ATTRS : new Set<AttrName>();
    const names = new Set([...Object.keys(head.attrs), ...Object.keys(base.attrs)] as AttrName[]);
    for (const name of names) {
        const before = base.attrs[name];
        const after = head.attrs[name];
        if (!skip.has(name) && !attrEqual(name, before, after)) {
            changes.push({ name, before, after, ...classifyAttr(name, before, after, head) });
        }
    }
    return changes;
}

function attrEqual(name: AttrName, a: unknown, b: unknown): boolean {
    if (SET_ATTRS.has(name) && Array.isArray(a) && Array.isArray(b)) {
        // Sets: order and repeated values do not matter.
        const members = (list: unknown[]) => [...new Set(list.map(canonicalJson))].sort();
        return isDeepStrictEqual(members(a), members(b));
    }
    return isDeepStrictEqual(a, b);
}

// --- Matching ---------------------------------------------------------------

function pairChildren(base: ViewNode, head: ViewNode): Pair[] {
    return head.kind === 'callback' ? matchOperations(base.children, head.children) : pairRenamedVariants(matchByKey(base.children, head.children));
}

function diffOperations(base: ViewNode[], head: ViewNode[], servers: { base?: string[]; head?: string[] }, ctx: DiffContext): DiffNode[] {
    return matchOperations(base, head).map((pair) => {
        const [b, h] = inheritServers(pair, servers);
        return diffNode(b, h, {}, ctx);
    });
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
 * All pairs in head order. A base-only node goes where it was in the base
 * order. Within one gap between matched nodes, removals come before
 * additions, so `- 201` prints before `+ 202`.
 */
function orderPairs(base: ViewNode[], head: ViewNode[], matches: Map<ViewNode, ViewNode>): Pair[] {
    const baseIndex = new Map(base.map((node, i) => [node, i]));
    const matchedBase = new Set(matches.values());
    // For each head node: the base position of the next matched node, which closes its gap.
    const gapEnd: number[] = [];
    for (let i = head.length - 1, end = base.length; i >= 0; i--) {
        const match = matches.get(head[i]);
        end = match === undefined ? end : baseIndex.get(match)!;
        gapEnd[i] = end;
    }
    const pairs: Pair[] = [];
    let next = 0; // First base position not yet placed.
    head.forEach((node, i) => {
        for (; next < gapEnd[i]; next++) {
            if (!matchedBase.has(base[next])) {
                pairs.push([base[next], undefined]);
            }
        }
        const match = matches.get(node);
        if (match !== undefined) {
            next = Math.max(next, baseIndex.get(match)! + 1);
        }
        pairs.push([match, node]);
    });
    for (; next < base.length; next++) {
        if (!matchedBase.has(base[next])) {
            pairs.push([base[next], undefined]);
        }
    }
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
