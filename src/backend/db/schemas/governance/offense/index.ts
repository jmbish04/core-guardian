/**
 * @fileoverview Barrel for the Spend Offense governance tables.
 *
 * P1 ships `circuit_break_events`; P2 adds `scan_targets`. Later phases add
 * `jules_dispatches` here (see docs/architecture/spend-offense.md).
 */

export * from "./circuit-break-events";
export * from "./scan-targets";
