# Recommendations to Improve ROI of Analytics in core-guardian

To improve the ROI of token spend analytics in `core-guardian` and address the challenges of the "agentic era" mentioned in the podcast, we recommend the following enhancements:

## 1. Implement Session & Request-Level Ratios
Currently, data is aggregated daily. We need to introduce metrics that help identify specific problematic patterns.

*   **Input-to-Output Ratio (IOR):** Calculate `tokensIn / tokensOut`. A very high IOR (e.g., thousands to one) might indicate an agent stuck reading large contexts without producing useful output (a "spin" state). A very low IOR might indicate hallucinations or overly verbose responses.
*   **Cost per Request (CPR):** Calculate `costUsd / requests`. Significant spikes in CPR for a specific model/gateway indicate queries are suddenly becoming much more complex (longer context) or more expensive models are being substituted.
*   **Tokens per Request (TPR):** Calculate `(tokensIn + tokensOut) / requests`. This helps normalize usage against volume.

## 2. Develop Anomaly Signals for "Tokens that Spin"
Go beyond `driftCheck` (which focuses on pricing) to detect *usage* anomalies, specifically targeting "spin."

*   **Zero-Output Detection:** Flag models or gateways where `tokensIn` is high but `tokensOut` is near zero (or an extreme ratio). This is the hallmark of an internal monologue or a broken loop.
*   **Z-Score Tracking:** Track the historical mean and standard deviation of IOR, CPR, and TPR for each (provider, model, gateway) combination. Flag any daily aggregate that exceeds a certain Z-score (e.g., > 3 standard deviations from the norm).
*   **Velocity Alerts (Weekend Test):** Detect rapid increases in token consumption during expected off-hours or compared to rolling averages.
*   **Identify Common Spin Causes:** Build heuristics to look for:
    *   **Pre-prompt tax:** Overly bloated system prompts running repeatedly.
    *   **Immortal conversations:** Sessions carrying too much old history.
    *   **Unfiltered data retrieval:** Pulling massive data sets instead of specific rows.

## 3. Shift Towards "Cost Per Accepted Task"
*   **Task-Level Tagging:** Enhance the tracking to associate AI Gateway requests with specific internal "tasks" or "jobs" so cost can be evaluated against value delivered, rather than just raw API calls.

## 4. Actionable Reporting and Auditing
*   **Provide a `/doctor` equivalent:** Build an auditing tool that analyzes a user's or team's usage and points out stale automations or highly inefficient loops.
*   **Update Dashboards:** Modify reporting endpoints to return these new ratios alongside the raw numbers, and visually flag extreme ratios as "Potential Spin."
