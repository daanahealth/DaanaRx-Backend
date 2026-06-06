/**
 * Every inventory unit has exactly one status at any time.
 * Mirrors SQL enum `item_status`.
 */
export type ItemStatus = "active" | "in_cart" | "pending_approval" | "checked_out" | "removed" | "expired";
/**
 * Transaction log action types. Mirrors SQL enum `transaction_action`.
 */
export type TransactionAction = "check_in" | "check_out" | "edit" | "remove" | "cart_approved" | "cart_rejected" | "expired_override";
/**
 * Cart lifecycle status. Mirrors SQL enum `cart_status`.
 */
export type CartStatus = "active" | "pending_approval" | "approved" | "rejected" | "expired";
/**
 * Minimal subset of JSON Schema (draft 2020-12) we accept for item attribute
 * definitions. Full JSON Schema is permitted at runtime; this typing exists
 * for ergonomic authoring in domain packs.
 */
export interface AttributeSchema {
    readonly $schema?: string;
    readonly type: "object";
    readonly properties: Readonly<Record<string, AttributePropertySchema>>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean;
}
export type AttributePropertySchema = {
    type: "string";
    enum?: readonly string[];
    format?: string;
    description?: string;
} | {
    type: "number" | "integer";
    minimum?: number;
    maximum?: number;
    description?: string;
} | {
    type: "boolean";
    description?: string;
} | {
    type: "array";
    items: AttributePropertySchema;
    description?: string;
} | {
    type: "object";
    properties: Readonly<Record<string, AttributePropertySchema>>;
    required?: readonly string[];
    description?: string;
} | {
    type: "null";
    description?: string;
};
export interface ItemType {
    readonly id: string;
    readonly name: string;
    readonly codeFormatTemplate: string;
    readonly attributeSchema: AttributeSchema;
    readonly createdAt: string;
}
export interface Location {
    readonly id: string;
    readonly code: string;
    readonly specialty: string | null;
    readonly capacity: number;
    readonly itemTypeId: string | null;
    readonly deactivatedAt: string | null;
    readonly createdAt: string;
}
export interface Item {
    readonly id: string;
    readonly typeId: string;
    readonly status: ItemStatus;
    readonly locationId: string | null;
    readonly expiryDate: string | null;
    readonly unitCode: string;
    readonly attributes: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
    readonly createdBy: string | null;
    readonly lastEditedAt: string | null;
    readonly lastEditedBy: string | null;
    readonly removedAt: string | null;
    readonly removedBy: string | null;
    readonly removedReason: string | null;
}
export interface Transaction {
    readonly id: string;
    readonly itemId: string;
    readonly action: TransactionAction;
    readonly actorId: string | null;
    readonly oldValue: Readonly<Record<string, unknown>> | null;
    readonly newValue: Readonly<Record<string, unknown>> | null;
    readonly reason: string | null;
    readonly note: string | null;
    readonly createdAt: string;
}
export interface Cart {
    readonly id: string;
    readonly ownerId: string;
    readonly status: CartStatus;
    readonly submittedAt: string | null;
    readonly decidedAt: string | null;
    readonly decidedBy: string | null;
    readonly expiresAt: string;
    readonly createdAt: string;
}
export interface CartItem {
    readonly cartId: string;
    readonly itemId: string;
    readonly addedAt: string;
}
/**
 * Context passed to a code generator. Carries enough state to render any
 * placeholder in a code_format_template (e.g. {LOCATION}, {TYPE}, {counter:05d}).
 */
export interface CodeGenerationContext {
    readonly itemTypeId: string;
    readonly itemTypeName: string;
    readonly locationCode: string;
    readonly counter: number;
    readonly attributes: Readonly<Record<string, unknown>>;
}
export interface CodeGenerator {
    /** The format template, e.g. "DRX-MASS-{LOCATION}-{counter:05d}". */
    readonly format: string;
    generate(ctx: CodeGenerationContext): string;
}
import type { Validator } from "./validators.js";
/**
 * A domain pack composes one of these per item type it supplies.
 * The platform validates items.attributes against `attributeSchema` and
 * runs every entry in `validators` for cross-field / business rules.
 */
export interface ItemTypeConfig {
    readonly name: string;
    readonly codeFormatTemplate: string;
    readonly attributeSchema: AttributeSchema;
    readonly validators: ReadonlyArray<Validator<Item>>;
}
//# sourceMappingURL=types.d.ts.map