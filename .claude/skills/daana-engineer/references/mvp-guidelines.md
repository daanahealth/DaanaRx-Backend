# MASS MVP spec — engineering guidelines (distilled)

Source: "DaanaRX MASS Clinic MVP — Updated Product Specification" v1.1. These are
the rules any DaanaRx change touching inventory, checkout, auth, or reporting must
satisfy. Treat them as acceptance criteria.

## Critical database rules (non-negotiable)
- Every medication unit has a unique DaanaRX code.
- Each physical unit = exactly one DB record (unit-level tracking).
- Checkout changes status `Active → Checked Out`.
- Removal changes status `Active → Removed` (with reason).
- Records are NEVER deleted — all status changes are soft-delete.
- Every action creates a transaction-log entry.
- Search returns only `Active` inventory unless advanced filters are applied.
- Cart reservations prevent duplicate checkout; in-cart items are unavailable to others.
- Carts clear after 24h inactivity; reserved items return to `Active`.
- DRX codes are sequential **per location**, zero-padded 5 digits, never reused.

## Status state machine (one per unit)
| Status | Searchable | Visible to restricted user |
|---|---|---|
| Active | yes | yes |
| In Cart | no | no |
| Pending Approval | no | own cart only |
| Checked Out | no | no |
| Removed | no (reports/logs only) | no |
| Expired | flagged (!) | no |

## Roles
- **Superadmin** (upstairs staff): full access; approves/rejects checkout; edits;
  removes with reason; manages locations/users/settings; acts on expired flags.
- **Restricted user** (intern/volunteer): search; intake if assigned; add to cart;
  CANNOT complete checkout (requires superadmin approval).
- **Provider/staff**: request via the checkout flow; no direct inventory mgmt.

## Check-In
Required fields: medication name, dosage, unit, form (Bottle/Card/Other…),
medication class/specialty, location, expiry date, quantity (if applicable), date
received (defaults today, editable). System suggests location by class, generates
the per-location DRX code on confirm, logs the transaction.

## Check-Out / FEFO
Sort: (1) expiry asc, (2) date received asc, (3) lower DRX numeric value. Only
`Active` shown by default. Expired = blocked from restricted checkout; superadmin
may Confirm Removal (reason Expired) or Override+Checkout (mandatory note). Every
checkout: superadmin approval → log → `Active → Checked Out` → removed from search.

## Removal reasons (required on remove)
Expired · Damaged · Duplicate entry · Incorrect entry · Lost or missing · Disposed · Other.
Captured with removed-by (auto), timestamp (auto), optional note.

## Change tracking (every edit)
Log: user, timestamp, old value, new value, reason (when applicable). Action types:
Check In · Check Out · Edit · Remove · Cart Approved · Cart Rejected · Expired Override.

## DRX code format (Option 1, chosen)
`DRX-MASS-{LOCATION}-{counter:05d}` → e.g. `DRX-MASS-CARDIO1-00042`. Counter is
per-location. (Options 2/3 with embedded specialty/med/dose redundancy exist in
`@daana-health/domain-mass/code-template.ts` but are not the MVP default.)

## Medication classification guide (specialty_class → bin)
CARDIO, LIPID, PSYCH*, PULM, ENDOCRINE, INFECT, PAINFLAM, GASTRO, UROL, NEPHRO*,
SLEEP*, NEURO*, VITSUP, Hold* (uncategorized). `*` = supervisor_review required.
Source of truth: `MASS_CLASSIFICATION_GUIDE` in `@daana-health/domain-mass`.

## Capacity
Default bin capacity 50 units per side (L/R; 100 combined), configurable per
location. Alert at 90% (45 of 50). Overflow → suggest next number in same
specialty (CARDIO1 full → CARDIO2), never cross specialties.

## Auth
- Login by email + password. MASS pilot account = superadmin at launch.
- Passwords: ≥10 chars, ≥1 upper, ≥1 lower, ≥1 number, ≥1 special (`!@#$%^&*`).
- Forgot-password = time-limited reset link.
- Sessions expire after 60 min inactivity; cart preserved 24h.
- Unknown expiry fallback = 10 years forward (domain validator), not "before".

## Modules / nav (scope map for features)
Home (FEFO search + insight cards) · Check In · Check Out · Inventory (superadmin
control panel) · Cart · Reports (Expiring 30/60/90, Lots approaching capacity,
High-use, Recently removed, Inventory edits, Transaction log) · Settings
(locations, users, classification guide, capacity) · Account. Floating chat icon
(feature request / bug) routes to Daana Health.

## Design
Clean clinical SaaS, Daana brand colors, liquid-glass cards/modals/sidebar.
Status chips: Active=green, In Cart=blue, Pending=amber, Checked Out=gray,
Removed=dark gray, Expired=red (!). Fully mobile-responsive (hard requirement);
sidebar collapses to hamburger on small screens.
