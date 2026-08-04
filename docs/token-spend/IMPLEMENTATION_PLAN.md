# Implementation Plan: Enhancing Token Spend Analytics

This plan outlines the steps to build the recommended ratio calculations and anomaly signals into `core-guardian`.

## Phase 1: Enriching Existing Data Models (Backend)

1.  **Update `GatewayCostRange` Type:**
    *   File: `src/backend/guardian/ai-gateway-costs.ts`
    *   Add new calculated fields to the `GatewayCostRange` type:
        *   `inputOutputRatio: number | null`
        *   `costPerRequest: number | null`
        *   `tokensPerRequest: number | null`

2.  **Update `queryGatewayCosts` Function:**
    *   File: `src/backend/guardian/ai-gateway-costs.ts`
    *   Modify the return mapping to calculate the new ratios:
        *   `inputOutputRatio`: `c.tokensOut > 0 ? c.tokensIn / c.tokensOut : null`
        *   `costPerRequest`: `c.requests > 0 ? c.costUsd / c.requests : null`
        *   `tokensPerRequest`: `c.requests > 0 ? (c.tokensIn + c.tokensOut) / c.requests : null`

## Phase 2: Building Anomaly Signals for "Spin"

1.  **Define Anomaly Types:**
    *   File: `src/backend/guardian/ai-gateway-costs.ts` (or a new file `analytics-signals.ts`)
    *   Define types for `UsageAnomaly`:
        *   `type`: 'HIGH_IOR' | 'COST_SPIKE' | 'ZERO_OUTPUT' | 'HIGH_PRE_PROMPT_TAX'
        *   `severity`: 'LOW' | 'MEDIUM' | 'HIGH'
        *   `details`: string (explanation of the anomaly)

2.  **Create `detectUsageAnomalies` Function:**
    *   This function will analyze historical and current data to flag instances of "spin".
    *   **Zero-Output Logic:** Flag if `inputOutputRatio` > 1000 (configurable threshold).
    *   **Z-Score Logic:** Compute baselines for IOR, CPR, and TPR, and flag significant deviations.
    *   *Implementation Detail:* We may need to query the database for a broader date range to establish baselines before comparing against the most recent period.

3.  **Integrate Signals into Existing Flows:**
    *   Expose the `detectUsageAnomalies` output via a new "Insights" dashboard API so the frontend can consume it and warn users about potential wasteful loops.

## Phase 3: Task-Based Costing & Frontend Auditing (Future)

1.  **Tagging Infrastructure:**
    *   Update the Cloudflare AI Gateway integration (if possible) or the wrapper to pass custom tags representing "Task ID" or "Job Type".
    *   Update `snapshotGatewayCosts` to aggregate by these new tags to calculate "Cost per Task."
2.  **Auditing Dashboard:**
    *   Create a frontend view similar to Anthropic's `/doctor` command that highlights the anomalies found in Phase 2, explicitly pointing out "Tokens that Spin" vs "Tokens that Produce."
