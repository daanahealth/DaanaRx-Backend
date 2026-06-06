"use strict";
// @daana-health/inventory-core
// Generic inventory engine: types, state machine, FEFO sort, code generators, validators.
//
// This package is intentionally domain-agnostic. Domain packs (e.g.
// @daana-health/domain-mass) register item types, attribute schemas,
// code-format templates, and validators against the registries exposed
// here. The core never imports a domain pack.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./types.js"), exports);
__exportStar(require("./status.js"), exports);
__exportStar(require("./fefo.js"), exports);
__exportStar(require("./code-generator.js"), exports);
__exportStar(require("./validators.js"), exports);
//# sourceMappingURL=index.js.map