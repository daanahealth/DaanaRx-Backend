// Generic code-generator interface + template rendering helper + registry.
//
// Templates use brace-delimited placeholders:
//   {LOCATION}        -> ctx.locationCode
//   {TYPE}            -> ctx.itemTypeName
//   {counter}         -> ctx.counter (no padding)
//   {counter:0Nd}     -> ctx.counter zero-padded to N digits (e.g. {counter:05d})
//   {attr.<key>}      -> ctx.attributes[key] coerced to string
//
// Example: "DRX-MASS-{LOCATION}-{counter:05d}" with
//   { locationCode: "CARDIO1", counter: 42 }
//   -> "DRX-MASS-CARDIO1-00042"
//
// Counters are managed atomically by the platform (see code_counters SQL
// table + RPC). This module only renders strings; it does NOT allocate
// counter values.
export class CodeTemplateError extends Error {
    constructor(message) {
        super(message);
        this.name = "CodeTemplateError";
    }
}
const COUNTER_PADDED_RE = /^counter:0(\d+)d$/;
/**
 * Render a code template against a context. Pure function.
 * Throws CodeTemplateError on unknown placeholders or malformed counter specs.
 */
export function renderCodeTemplate(template, ctx) {
    return template.replace(/\{([^{}]+)\}/g, (_, raw) => {
        const token = raw.trim();
        if (token === "LOCATION")
            return ctx.locationCode;
        if (token === "TYPE")
            return ctx.itemTypeName;
        if (token === "counter")
            return String(ctx.counter);
        const paddedMatch = token.match(COUNTER_PADDED_RE);
        if (paddedMatch) {
            const widthStr = paddedMatch[1];
            const width = Number(widthStr);
            if (!Number.isFinite(width) || width <= 0 || width > 20) {
                throw new CodeTemplateError(`Invalid counter width in token {${token}}`);
            }
            return String(ctx.counter).padStart(width, "0");
        }
        if (token.startsWith("attr.")) {
            const key = token.slice("attr.".length);
            const v = ctx.attributes[key];
            if (v === undefined || v === null) {
                throw new CodeTemplateError(`Template placeholder {${token}} references missing attribute "${key}"`);
            }
            return String(v);
        }
        throw new CodeTemplateError(`Unknown template placeholder {${token}}`);
    });
}
/**
 * Default template-based CodeGenerator factory. Domain packs typically use
 * this directly by registering the template on their ItemType.
 *
 * Eagerly validates the template syntax with a probe context so typos surface
 * at registration time rather than at first check-in.
 */
export function createTemplateCodeGenerator(format) {
    const probe = {
        itemTypeId: "probe",
        itemTypeName: "PROBE",
        locationCode: "PROBE",
        counter: 1,
        attributes: {},
    };
    try {
        renderCodeTemplate(format, probe);
    }
    catch (err) {
        if (err instanceof CodeTemplateError && err.message.includes("attribute")) {
            // OK — attribute placeholders cannot be validated without real attrs.
        }
        else {
            throw err;
        }
    }
    return {
        format,
        generate(ctx) {
            return renderCodeTemplate(format, ctx);
        },
    };
}
/** Default in-memory CodeGeneratorRegistry. */
export class InMemoryCodeGeneratorRegistry {
    byType = new Map();
    register(itemTypeId, generator) {
        this.byType.set(itemTypeId, generator);
    }
    get(itemTypeId) {
        return this.byType.get(itemTypeId);
    }
}
//# sourceMappingURL=code-generator.js.map