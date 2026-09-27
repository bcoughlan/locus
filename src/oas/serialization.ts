/** OpenAPI serialization defaults for parameters and headers. The model and the renderers share them. */

/** The `style` that a parameter or header of this location has when it names none. */
export function defaultStyle(location: string): string {
    return location === 'query' || location === 'cookie' ? 'form' : 'simple';
}

/** The `explode` that a style has when the parameter names none: true for form only. */
export function defaultExplode(style: string): boolean {
    return style === 'form';
}
