import type { CodeGenerationContext, CodeGenerator } from "./types.js";
export type { CodeGenerationContext, CodeGenerator } from "./types.js";
export declare class CodeTemplateError extends Error {
    constructor(message: string);
}
/**
 * Render a code template against a context. Pure function.
 * Throws CodeTemplateError on unknown placeholders or malformed counter specs.
 */
export declare function renderCodeTemplate(template: string, ctx: CodeGenerationContext): string;
/**
 * Default template-based CodeGenerator factory. Domain packs typically use
 * this directly by registering the template on their ItemType.
 *
 * Eagerly validates the template syntax with a probe context so typos surface
 * at registration time rather than at first check-in.
 */
export declare function createTemplateCodeGenerator(format: string): CodeGenerator;
/** Registry of code generators, keyed by item-type id. */
export interface CodeGeneratorRegistry {
    register(itemTypeId: string, generator: CodeGenerator): void;
    get(itemTypeId: string): CodeGenerator | undefined;
}
/** Default in-memory CodeGeneratorRegistry. */
export declare class InMemoryCodeGeneratorRegistry implements CodeGeneratorRegistry {
    private readonly byType;
    register(itemTypeId: string, generator: CodeGenerator): void;
    get(itemTypeId: string): CodeGenerator | undefined;
}
//# sourceMappingURL=code-generator.d.ts.map