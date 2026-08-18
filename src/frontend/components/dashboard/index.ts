/**
 * @fileoverview Barrel export for the Admin Dashboard feature.
 *
 * The Astro page imports only the top-level island from here; everything else
 * is an internal implementation detail of the feature folder.
 */

export { AccountantView } from "./AccountantView";
export { AiRecommendationsView } from "./AiRecommendationsView";
export { AdminDashboard } from "./AdminDashboard";
export { ActionItems } from "./ActionItems";
export { AiRouterConsole } from "./AiRouterConsole";
export { AiRouterUsage } from "./AiRouterUsage";
export { AiRouterRecommendations } from "./AiRouterRecommendations";
export { AllowancesPanel } from "./AllowancesPanel";
export { BudgetMeter } from "./BudgetMeter";
export { RadialGauge, type RadialGaugeProps } from "./RadialGauge";
export { Sparkline, type SparklineProps, type ChartKey } from "./Sparkline";
export { KPIStatCard, KPIStatCardSkeleton, type KPIStatCardProps } from "./KPIStatCard";
export { GuardianOverview } from "./GuardianOverview";
export { TimeSeriesChart, type TimeSeriesChartProps, type TimeSeries } from "./TimeSeriesChart";
export { HeroMetricChart, type HeroMetricChartProps, type HeroPoint } from "./HeroMetricChart";
export {
  SpendHero,
  D1UsageDetail,
  GatewayUsageDetail,
  AlertsSeverityTrend,
  AlertsInsights,
} from "./L2Details";
export { SpendHeadline } from "./SpendHeadline";
export { CostTraceIsland } from "./CostTraceIsland";
export { IncidentsPanel } from "./IncidentsPanel";
export { RiskTargetsPanel } from "./RiskTargetsPanel";
export { SpendOverview } from "./SpendOverview";
export { SpendByProject } from "./SpendByProject";
export { SpendLanes } from "./SpendLanes";
export { DailyCost } from "./DailyCost";
export { BillableUsage } from "./BillableUsage";
export { ModelAdvisor } from "./ModelAdvisor";
export { ModelSubstitutions } from "./ModelSubstitutions";
export { AlertsBoard } from "./AlertsBoard";
export { BindingDetail } from "./BindingDetail";
export { WorkerSpendMonitor } from "./WorkerSpendMonitor";
export { HealthConsole } from "./HealthConsole";
export { GuardianAuditLog } from "./GuardianAuditLog";
export { GuardianPanel } from "./GuardianPanel";
