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

## Phase 2: Building Anomaly Signals

1.  **Define Anomaly Types:**
    *   File: `src/backend/guardian/ai-gateway-costs.ts` (or a new file `analytics-signals.ts`)
    *   Define types for `UsageAnomaly`:
        *   `type`: 'HIGH_IOR' | 'COST_SPIKE' | 'ZERO_OUTPUT' | etc.
        *   `severity`: 'LOW' | 'MEDIUM' | 'HIGH'
        *   `details`: string (explanation of the anomaly)

2.  **Create `detectUsageAnomalies` Function:**
    *   This function will take historical data (e.g., last 30 days) and current data (last 1-3 days).
    *   It will compute baselines (moving averages) for the new ratios (IOR, CPR).
    *   It will flag instances where the current ratios deviate significantly from the baseline (e.g., using a simple threshold or Z-score).
    *   *Implementation Detail:* We may need to query the database for a broader date range to establish baselines before comparing against the most recent period.

3.  **Integrate Signals into Existing Flows:**
    *   Expose the `detectUsageAnomalies` output via a new endpoint or incorporate it into the existing `pricingHistory` or a new "Insights" dashboard API so the frontend can consume it.

## Phase 3: Frontend Visualization (Optional / Next Steps)

1.  **Update Dashboard Components:**
    *   If there are existing dashboard components for AI Gateway costs, update them to display the new ratios (IOR, CPR).
    *   Add visual indicators (e.g., warning icons) for data points flagged as anomalies by the backend.
