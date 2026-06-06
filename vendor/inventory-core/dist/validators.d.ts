import type { Item } from "./types.js";
export interface ValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly code?: string;
}
export interface ValidationResult {
    readonly ok: boolean;
    readonly issues: readonly ValidationIssue[];
}
export type Validator<T = Item> = (value: T) => ValidationResult;
/**
 * Registry of (itemTypeName -> Validator[]) pairs. Domain packs call
 * `register(itemTypeName, validator)` at module init time.
 */
export declare class ValidatorRegistry {
    private readonly byType;
    register(itemTypeName: string, validator: Validator<Item>): void;
    /**
     * Get all validators registered for a given item-type name. Returns an
     * empty array if none registered (not an error — many item types only
     * need JSON-Schema validation).
     */
    get(itemTypeName: string): readonly Validator<Item>[];
    /**
     * Run every validator registered for the item's type. Aggregates all
     * issues; does NOT short-circuit on first failure.
     */
    validate(itemTypeName: string, item: Item): ValidationResult;
}
/**
 * Helper: build a successful ValidationResult.
 */
export declare const ok: ValidationResult;
/**
 * Helper: build a failing ValidationResult from one or more issues.
 */
export declare function fail(...issues: ValidationIssue[]): ValidationResult;
//# sourceMappingURL=validators.d.ts.map