/**
 * The rules table: which changes are breaking. `docs/breaking-changes.md`
 * describes the same rules in prose. Keep the two in step.
 *
 * Many rules depend on direction. A value the client sends (request) can
 * accept more over time, but not less. A value the client receives
 * (response) can promise more over time, but not less.
 */
import type { AttrName, ViewNode } from '../model/tree.ts';
import { canonicalJson } from '../util.ts';
import type { Severity, Verdict } from './report.ts';

const BREAKING: Severity = 'breaking';
const COMPATIBLE: Severity = 'compatible';

/** The parents of a node in both versions. A parent is absent when it does not exist in that version. */
export interface Parents {
    base?: ViewNode;
    head?: ViewNode;
}

/** Classify a node that exists only in the head version. */
export function classifyAdded(node: ViewNode, parents: Parents = {}): Verdict {
    const parent = parents.head;
    switch (node.kind) {
        case 'operation':
            return verdict(COMPATIBLE, 'endpoint added');
        case 'callback':
            return verdict(COMPATIBLE, 'callback added');
        case 'securityRequirement':
            if (node.key === 'none') {
                return verdict(COMPATIBLE, 'anonymous access added');
            }
            // Clients without credentials break only when anonymous access ends.
            return allowsAnonymous(parents.base) && !allowsAnonymous(parents.head)
                ? verdict(BREAKING, 'security added to an endpoint that had none')
                : verdict(COMPATIBLE, 'security alternative added');
        case 'parameter':
        case 'header':
        case 'requestBody':
        case 'property':
            if (node.direction === 'request') {
                return node.attrs.required
                    ? verdict(BREAKING, `required ${noun(node, parent)} added`)
                    : verdict(COMPATIBLE, `optional ${noun(node, parent)} added`);
            }
            return verdict(COMPATIBLE, `${noun(node, parent)} added`);
        case 'oauthFlow':
            return verdict(COMPATIBLE, `OAuth flow ${node.label} added`);
        case 'response':
            return verdict(COMPATIBLE, `response ${node.key} added`);
        case 'mediaType':
            return verdict(COMPATIBLE, `media type ${node.label} added`);
        case 'additionalProperties':
            // A schema where `additionalProperties: false` was opens the object up, like new optional properties.
            if (parents.base?.attrs.additionalProperties === false) {
                return verdict(COMPATIBLE, 'additional properties allowed');
            }
            return constraint(node, true, `${noun(node)} schema added`);
        case 'items':
        case 'patternProperty':
            return constraint(node, true, `${noun(node)} schema added`);
        case 'variant':
            return directional(node, COMPATIBLE, BREAKING, `variant ${node.label} added`);
        case 'not':
            return verdict(BREAKING, '"not" schema added');
        default:
            return verdict(COMPATIBLE, `${node.kind} added`);
    }
}

/** Classify a node that exists only in the base version. */
export function classifyRemoved(node: ViewNode, parents: Parents = {}): Verdict {
    switch (node.kind) {
        case 'operation':
            return verdict(BREAKING, 'endpoint removed');
        case 'callback':
            return verdict(BREAKING, 'callback removed');
        case 'securityRequirement':
            if (allowsAnonymous(parents.head)) {
                return verdict(COMPATIBLE, node.key === 'none' ? 'anonymous access removed' : 'security removed');
            }
            return verdict(BREAKING, node.key === 'none' ? 'anonymous access removed' : 'security alternative removed');
        case 'parameter':
        case 'header':
        case 'requestBody':
        case 'property':
            return verdict(BREAKING, `${noun(node, parents.base)} removed`);
        case 'oauthFlow':
            return verdict(BREAKING, `OAuth flow ${node.label} removed`);
        case 'response':
            // Clients depend on success and redirect responses. A removed error response needs no client change.
            return /^[123]/.test(node.key)
                ? verdict(BREAKING, `response ${node.key} removed`)
                : verdict(COMPATIBLE, `response ${node.key} removed`);
        case 'mediaType':
            return verdict(BREAKING, `media type ${node.label} removed`);
        case 'additionalProperties':
            // `additionalProperties: false` in place of a schema closes the object. The attribute change reports that.
            if (parents.head?.attrs.additionalProperties === false) {
                return verdict(COMPATIBLE, 'additional properties schema removed');
            }
            return constraint(node, false, `${noun(node)} schema removed`);
        case 'items':
        case 'patternProperty':
            return constraint(node, false, `${noun(node)} schema removed`);
        case 'variant':
            return directional(node, BREAKING, COMPATIBLE, `variant ${node.label} removed`);
        case 'not':
            return verdict(BREAKING, '"not" schema removed');
        default:
            return verdict(COMPATIBLE, `${node.kind} removed`);
    }
}

/** Classify a change of one attribute. `node` is the head node. */
export function classifyAttr(name: AttrName, before: unknown, after: unknown, node: ViewNode): Verdict {
    switch (name) {
        case 'summary':
        case 'description':
        case 'title':
        case 'example':
        case 'examples':
        case 'tags':
        case 'operationId':
        case 'version':
        case 'readOnly':
        case 'writeOnly':
        case 'bearerFormat':
            return verdict(COMPATIBLE, `${name} changed`);
        case 'deprecated':
            return verdict(COMPATIBLE, after === true ? 'deprecated' : 'no longer deprecated');
        case 'method':
            return verdict(BREAKING, 'method changed');
        case 'path':
            return normalizePath(String(before)) === normalizePath(String(after))
                ? verdict(COMPATIBLE, 'path parameter renamed')
                : verdict(BREAKING, 'path changed');
        case 'servers':
            return difference(before, after).length > 0 ? verdict(BREAKING, 'server removed') : verdict(COMPATIBLE, 'server added');
        case 'required':
            return after === true
                ? directional(node, BREAKING, COMPATIBLE, `${noun(node)} became required`)
                : directional(node, COMPATIBLE, BREAKING, `${noun(node)} became optional`);
        case 'style':
        case 'explode':
        case 'allowReserved':
        case 'contentType':
            return verdict(BREAKING, `serialization changed (${name})`);
        case 'allowEmptyValue':
            return after === true ? verdict(COMPATIBLE, 'empty value allowed') : verdict(BREAKING, 'empty value no longer allowed');
        case 'type':
            return typeVerdict(node, before as string[] | undefined, after as string[] | undefined);
        case 'nullable':
            return constraint(node, after === undefined, after === undefined ? 'null no longer allowed' : 'null allowed');
        case 'format':
        case 'contentMediaType':
        case 'contentEncoding':
        case 'pattern':
        case 'const':
            // Adding one restricts the values. Changing one gives a different set, not a subset.
            if (before !== undefined && after !== undefined) {
                return verdict(BREAKING, `${name} changed`);
            }
            return constraint(node, before === undefined, `${name} ${before === undefined ? 'added' : 'removed'}`);
        case 'enum':
            return enumVerdict(node, before as unknown[] | undefined, after as unknown[] | undefined);
        case 'default':
            return before !== undefined && after !== undefined
                ? directional(node, BREAKING, COMPATIBLE, 'default changed')
                : verdict(COMPATIBLE, `default ${before === undefined ? 'added' : 'removed'}`);
        case 'minimum':
        case 'exclusiveMinimum':
        case 'minLength':
        case 'minItems':
        case 'minProperties':
            return limitVerdict(node, name, before as number | undefined, after as number | undefined, 'lower');
        case 'maximum':
        case 'exclusiveMaximum':
        case 'maxLength':
        case 'maxItems':
        case 'maxProperties':
            return limitVerdict(node, name, before as number | undefined, after as number | undefined, 'upper');
        case 'multipleOf':
            return multipleOfVerdict(node, before as number | undefined, after as number | undefined);
        case 'uniqueItems':
            return constraint(node, after === true, after === true ? 'items must be unique' : 'items no longer need to be unique');
        case 'additionalProperties':
            return after === false
                ? directional(node, BREAKING, COMPATIBLE, 'additional properties no longer allowed')
                : verdict(COMPATIBLE, 'additional properties allowed');
        case 'mapping':
            return mappingVerdict(node, before as Record<string, string> | undefined, after as Record<string, string> | undefined);
        case 'truncated':
            return verdict(COMPATIBLE, 'schema not expanded here (the document is too large)');
        case 'recursive':
            // Both sides refer back to an enclosing schema: only its name changed.
            return before !== undefined && after !== undefined
                ? verdict(COMPATIBLE, 'recursive schema renamed')
                : verdict(BREAKING, 'schema structure changed');
        case 'composition':
        case 'discriminator':
        case 'defaultMapping':
            return verdict(BREAKING, `${name} changed`);
        case 'unresolved':
            return after === undefined ? verdict(COMPATIBLE, 'reference resolves') : verdict(BREAKING, 'reference does not resolve');
        case 'schemeType':
        case 'in':
        case 'parameterName':
        case 'scheme':
        case 'openIdConnectUrl':
        case 'oauth2MetadataUrl':
            return verdict(BREAKING, `security scheme changed (${name})`);
        case 'authorizationUrl':
        case 'deviceAuthorizationUrl':
        case 'tokenUrl':
        case 'refreshUrl':
            return verdict(BREAKING, `OAuth ${name} changed`);
        case 'scopes':
            return difference(after, before).length > 0 ? verdict(BREAKING, 'scope added') : verdict(COMPATIBLE, 'scope removed');
        default:
            return verdict(COMPATIBLE, `${name} changed`);
    }
}

/** Attributes whose array values are sets: order does not matter. */
export const SET_ATTRS: ReadonlySet<AttrName> = new Set(['enum', 'tags', 'servers', 'scopes', 'type']);

/** `/pets/{id}` and `/pets/{petId}` address the same endpoint. */
export function normalizePath(path: string): string {
    return path.replace(/\{[^}]*\}/g, '{}');
}

// --- Rule helpers -----------------------------------------------------------

function verdict(severity: Severity, reason: string): Verdict {
    return { severity, reason };
}

/** A security section lets clients call without credentials: it is absent, empty, or lists the anonymous alternative. */
function allowsAnonymous(section: ViewNode | undefined): boolean {
    return section === undefined || section.children.length === 0 || section.children.some((child) => child.key === 'none');
}

/** A severity that depends on who writes the value. */
function directional(node: ViewNode, whenClientSends: Severity, whenClientReceives: Severity, reason: string): Verdict {
    return node.direction === 'request'
        ? verdict(whenClientSends, `${reason} (client sends)`)
        : verdict(whenClientReceives, `${reason} (client receives)`);
}

/** A tightened constraint breaks what clients send. A loosened one breaks what clients receive. */
function constraint(node: ViewNode, tightened: boolean, reason: string): Verdict {
    return tightened ? directional(node, BREAKING, COMPATIBLE, reason) : directional(node, COMPATIBLE, BREAKING, reason);
}

function limitVerdict(node: ViewNode, name: string, before: number | undefined, after: number | undefined, bound: 'lower' | 'upper'): Verdict {
    if (before === undefined || after === undefined) {
        return constraint(node, before === undefined, `${name} ${before === undefined ? 'added' : 'removed'}`);
    }
    const increased = after > before;
    return constraint(node, bound === 'lower' ? increased : !increased, `${name} ${increased ? 'increased' : 'decreased'}`);
}

/** A new `multipleOf` loosens the constraint only when it divides the old one (2 to 1, not 2 to 3). */
function multipleOfVerdict(node: ViewNode, before: number | undefined, after: number | undefined): Verdict {
    if (before === undefined || after === undefined) {
        return constraint(node, before === undefined, `multipleOf ${before === undefined ? 'added' : 'removed'}`);
    }
    const ratio = before / after;
    const loosened = Math.abs(ratio - Math.round(ratio)) < 1e-9;
    return constraint(node, !loosened, 'multipleOf changed');
}

/** `integer` is a subset of `number`. */
function covers(types: string[], type: string): boolean {
    return types.includes(type) || (type === 'integer' && types.includes('number'));
}

function typeVerdict(node: ViewNode, before: string[] | undefined, after: string[] | undefined): Verdict {
    if (before === undefined || after === undefined) {
        // No type means any type.
        return constraint(node, before === undefined, before === undefined ? 'type restricted' : 'type restriction removed');
    }
    const widened = before.every((type) => covers(after, type));
    const narrowed = after.every((type) => covers(before, type));
    if (widened && narrowed) {
        return verdict(COMPATIBLE, 'type changed');
    }
    const nullOnly = (a: string[], b: string[]) => difference(a, b).join() === 'null';
    if (widened) {
        return constraint(node, false, nullOnly(after, before) ? 'null allowed' : 'type widened');
    }
    if (narrowed) {
        return constraint(node, true, nullOnly(before, after) ? 'null no longer allowed' : 'type narrowed');
    }
    return verdict(BREAKING, 'type changed');
}

function enumVerdict(node: ViewNode, before: unknown[] | undefined, after: unknown[] | undefined): Verdict {
    if (before === undefined || after === undefined) {
        return constraint(node, before === undefined, before === undefined ? 'enum added' : 'enum removed');
    }
    const added = difference(after, before);
    const removed = difference(before, after);
    if (added.length > 0 && removed.length > 0) {
        return verdict(BREAKING, `enum values changed (added ${list(added)}, removed ${list(removed)})`);
    }
    return added.length > 0
        ? constraint(node, false, `enum ${plural(added, 'value')} added: ${list(added)}`)
        : constraint(node, true, `enum ${plural(removed, 'value')} removed: ${list(removed)}`);
}

function mappingVerdict(node: ViewNode, before: Record<string, string> = {}, after: Record<string, string> = {}): Verdict {
    const added = Object.keys(after).filter((key) => !(key in before));
    const removed = Object.keys(before).filter((key) => !(key in after));
    const retargeted = Object.keys(after).filter((key) => key in before && before[key] !== after[key]);
    if (retargeted.length > 0 || (added.length > 0 && removed.length > 0)) {
        return verdict(BREAKING, 'discriminator mapping changed');
    }
    return added.length > 0
        ? constraint(node, false, `discriminator mapping added: ${added.join(', ')}`)
        : constraint(node, true, `discriminator mapping removed: ${removed.join(', ')}`);
}

/** Items of `a` that `b` lacks, compared as JSON values. */
function difference(a: unknown, b: unknown): unknown[] {
    const other = new Set((Array.isArray(b) ? b : []).map(canonicalJson));
    return (Array.isArray(a) ? a : []).filter((item) => !other.has(canonicalJson(item)));
}

function list(values: unknown[]): string {
    return values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(', ');
}

function plural(values: unknown[], word: string): string {
    return values.length === 1 ? word : `${word}s`;
}

/** What to call a node in a reason. A parameter takes its location from its group. */
function noun(node: ViewNode, parent?: ViewNode): string {
    switch (node.kind) {
        case 'parameter':
            return parent === undefined || parent.key === 'querystring' ? 'parameter' : `${parent.key} parameter`;
        case 'requestBody':
            return 'request body';
        case 'additionalProperties':
            return 'additional properties';
        case 'patternProperty':
            return 'pattern property';
        default:
            return node.kind;
    }
}
