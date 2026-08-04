# Recommendations to Improve ROI of Analytics in core-guardian

To improve the ROI of token spend analytics in `core-guardian` and address the challenges of the "agentic era" mentioned in the podcast, we recommend the following enhancements:

## 1. Implement Session & Request-Level Ratios
Currently, data is aggregated daily. We need to introduce metrics that help identify specific problematic patterns.

*   **Input-to-Output Ratio (IOR):** Calculate `tokensIn / tokensOut`. A very high IOR might indicate an agent stuck reading large contexts without producing useful output, or prompt injection attempts. A very low IOR might indicate hallucinations or overly verbose responses.
*   **Cost per Request (CPR):** Calculate `costUsd / requests`. Significant spikes in CPR for a specific model/gateway indicate queries are suddenly becoming much more complex (longer context) or more expensive models are being substituted.
*   **Tokens per Request (TPR):** Calculate `(tokensIn + tokensOut) / requests`. This helps normalize usage against volume.

## 2. Develop Anomaly Signals
Go beyond `driftCheck` (which focuses on pricing) to detect *usage* anomalies.

*   **Z-Score Tracking:** Track the historical mean and standard deviation of IOR, CPR, and TPR for each (provider, model, gateway) combination. Flag any daily aggregate that exceeds a certain Z-score (e.g., > 3 standard deviations from the norm).
*   **Velocity Alerts:** Detect rapid increases in token consumption (e.g., a 200% increase in `tokensIn` compared to the rolling 7-day average).
*   **Zero-Output Detection:** Flag models or gateways where `tokensIn` is high but `tokensOut` is near zero, indicating potential errors or blocked outputs in the application logic.

## 3. Enhance Data Granularity (Future Consideration)
*   While `snapshotGatewayCosts` pulls daily aggregates, consider pulling hourly data (`datetimeHour_geq` is already used in the GraphQL query) to allow for faster anomaly detection (e.g., stopping a runaway agent within hours instead of days).

## 4. Actionable Reporting
*   Modify `queryGatewayCosts` or create a new reporting function to return these new ratios alongside the raw numbers.
*   Create an "Insights" or "Anomalies" endpoint that specifically surfaces the flagged deviations (Z-score anomalies, extreme ratios) for proactive investigation.
