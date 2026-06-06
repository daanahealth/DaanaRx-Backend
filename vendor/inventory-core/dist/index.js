// @daana-health/inventory-core
// Generic inventory engine: types, state machine, FEFO sort, code generators, validators.
//
// This package is intentionally domain-agnostic. Domain packs (e.g.
// @daana-health/domain-mass) register item types, attribute schemas,
// code-format templates, and validators against the registries exposed
// here. The core never imports a domain pack.
export * from "./types.js";
export * from "./status.js";
export * from "./fefo.js";
export * from "./code-generator.js";
export * from "./validators.js";
//# sourceMappingURL=index.js.map