# Findings: AI Token Spend & Analytics

Based on the transcript from "The AI Daily Brief" regarding AI token spend management, and an analysis of the `core-guardian` codebase (specifically `src/backend/guardian/ai-gateway-costs.ts`), here are the findings:

## Industry Context
*   **The "Agentic Era":** Companies are increasingly using AI agents, which leads to high variability and complexity in token consumption. Agentic tasks can consume 5-30x more tokens than a simple chat.
*   **Token Economics is Universal:** Every company dealing with AI is facing similar questions regarding token economics and billing management.
*   **Need for Robust Analytics:** As usage scales, simply tracking aggregate cost isn't enough; organizations need deeper analytics to identify billing issues, anomalies, and inefficiencies in token usage.
*   **Cost per Task:** The industry is moving away from "cost per token" to "Useful Intelligence Per Dollar" or "cost per accepted task" because different models use completely different tokenizers (e.g., a "cheaper" model might require 3x the iterations, costing more per task).
*   **Token Categorization:** Tokens generally fall into three categories:
    *   **Tokens that Teach:** Experimentation, learning, and teaching the AI context (defend these).
    *   **Tokens that Produce:** Successful work that ships (protect these).
    *   **Tokens that Spin:** Machines talking to themselves, unused automations, and inefficient loops (eliminate these).

## Current State of `core-guardian`
*   **Data Collection:** `core-guardian` successfully snapshots daily AI Gateway costs from Cloudflare GraphQL analytics, storing per-model, per-provider request counts, token counts, and cost data.
*   **Drift Detection:** It has a `driftCheck` function that compares actual gateway costs to expected costs based on scraped list prices. This is a great feature for identifying pricing changes or caching discrepancies.
*   **Basic Metrics:** It calculates an `effectivePerMillion` (blended effective USD per 1M tokens), which is a useful high-level metric.
*   **Gap - Session/Granular Analysis:** The current analytics are aggregated daily at the model/provider/gateway level. It lacks granular session-level or request-level ratio calculations that could identify specific instances of "runaway agents" or billing anomalies.
*   **Gap - Anomaly Signals:** While `driftCheck` finds *pricing* anomalies, there are no explicit signals for *usage* anomalies (e.g., sudden spikes in input-to-output ratios, or unusually high token consumption for a given task type).
