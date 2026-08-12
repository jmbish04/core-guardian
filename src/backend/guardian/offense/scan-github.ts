/**
 * @fileoverview `scanGithub` — the P3 zero-AI GitHub Actions scanner.
 *
 * Lists the authenticated user's repos, reads each repo's `.github/workflows/*`
 * (plus `wrangler.jsonc`/`wrangler.toml` if present), and regexes the text for
 * AI usage with the shared {@link detectAiSignals} library. A repo that calls AI
 * on a cron — and that core-guardian has never logged — is a **bypass**: it is
 * burning the AI bill from CI without reporting through the AI Router.
 *
 * NO AI is used anywhere in this file. Pure GitHub REST + regex + arithmetic.
 * Only repos with at least one AI signal are upserted into `scan_targets`
 * (kind='github_action', name=full_name; re-scans preserve `first_seen`).
 *
 * @see {@link file://src/backend/guardian/offense/classify.ts} for the signal library + scorer.
 * @see {@link file://src/backend/guardian/offense/scan-workers.ts} for the P2 mirror.
 * @see {@link file://src/backend/guardian/hotfix.ts} for the GITHUB_TOKEN read pattern.
 */

import { getDb } from "@/backend/db";
import {
  aiRouterRequests,
  aiUsageRegistrations,
  scanTargets,
  type BypassVerdict,
  type NewScanTargetRow,
  type RiskSignals,
} from "@/backend/db/schema";
import {
  detectAiSignals,
  scoreRisk,
} from "@/backend/guardian/offense/classify";
import { getKnownBilledModels } from "@/backend/guardian/offense/known-models";
import { getSecret, getSecretStoreBinding } from "@/backend/utils/secrets";

const GH = "https://api.github.com";
/** Hard cap on repos enumerated (LOGged + reported when hit — no silent cap). */
const MAX_REPOS = 200;
/** Per-repo GitHub fan-out (workflows + wrangler fetches). */
const FANOUT = 8;

/** One GitHub repo, trimmed to what the scanner needs. */
interface Repo {
  full_name: string;
  name: string;
  default_branch: string;
}

/** One scanned repo, ready to upsert (only AI-signal repos reach here). */
interface ScannedRepo {
  name: string;
  workerName: string | null;
  cronSchedules: string[];
  signals: RiskSignals;
  riskScore: number;
  guardianRegistered: boolean;
  bypass: BypassVerdict;
}

/** Summary returned by {@link scanGithub} and surfaced on `POST /scan/github`. */
export interface GithubScanSummary {
  ok: boolean;
  /** Set when the token is missing or the very first listing call failed. */
  error?: string;
  reposListed: number;
  reposScanned: number;
  aiRepos: number;
  bypasses: number;
  /** True when more than MAX_REPOS repos exist (listing was capped). */
  truncated: boolean;
  /** True when a GitHub rate-limit (403/429) cut the scan short. */
  rateLimited: boolean;
  scannedAt: number;
  topRisk: {
    name: string;
    riskScore: number;
    guardianRegistered: boolean;
    isBypass: boolean;
    cronSchedules: string[];
    workerName: string | null;
  }[];
}

/** Bounded-concurrency map (mirrors scan-workers.ts / resources.ts). */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Read the GitHub token: Secrets Store binding, plain-env fallback (mirrors hotfix.ts). */
async function githubToken(env: Env): Promise<string | undefined> {
  return (await getSecretStoreBinding(env, "GITHUB_TOKEN")) ?? getSecret(env, "GITHUB_TOKEN");
}

/** A GitHub 403/429 caused by rate limiting (vs a plain auth/permission 403). */
function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  return res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
}

interface GhResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  rateLimited: boolean;
}

/** One authenticated GitHub GET. Never throws — callers branch on `ok`. */
async function ghGet<T>(env: Env, token: string, path: string): Promise<GhResult<T>> {
  const res = await fetch(`${GH}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "core-guardian-offense",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const rateLimited = isRateLimited(res);
  if (!res.ok) return { ok: false, status: res.status, data: null, rateLimited };
  const data = (await res.json().catch(() => null)) as T | null;
  return { ok: true, status: res.status, data, rateLimited };
}

/** base64 (GitHub contents API) → UTF-8. */
function fromB64(s: string): string {
  const bin = atob((s ?? "").replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Pages `GET /user/repos` (pushed-desc) up to MAX_REPOS.
 *
 * Stops early and flags `rateLimited` on a 403/429; flags `truncated` when a
 * full final page implies more repos exist beyond the cap.
 */
async function listRepos(
  env: Env,
  token: string,
): Promise<{ repos: Repo[]; truncated: boolean; rateLimited: boolean; firstCallFailed: boolean }> {
  const repos: Repo[] = [];
  let truncated = false;
  let rateLimited = false;
  let firstCallFailed = false;
  const perPage = 100;

  for (let page = 1; repos.length < MAX_REPOS; page++) {
    const r = await ghGet<Repo[]>(
      env,
      token,
      `/user/repos?per_page=${perPage}&sort=pushed&page=${page}`,
    );
    if (!r.ok || !r.data) {
      if (page === 1) firstCallFailed = true;
      rateLimited = rateLimited || r.rateLimited;
      break;
    }
    repos.push(...r.data);
    if (r.data.length < perPage) break; // last page
    if (repos.length >= MAX_REPOS) {
      truncated = true; // a full page landed us at/over the cap → more remain
      break;
    }
  }
  return { repos: repos.slice(0, MAX_REPOS), truncated, rateLimited, firstCallFailed };
}

/**
 * Fetches one repo's scannable text: every `.github/workflows/*` file plus
 * `wrangler.jsonc`/`wrangler.toml` if present. Returns the concatenated
 * workflow text and config text separately (crons come from workflows, the
 * worker name from the config).
 */
async function fetchRepoText(
  env: Env,
  token: string,
  repo: Repo,
): Promise<{ workflows: string; config: string; rateLimited: boolean }> {
  const ref = repo.default_branch || "main";
  let rateLimited = false;

  const dir = await ghGet<{ path: string; type: string }[]>(
    env,
    token,
    `/repos/${repo.full_name}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`,
  );
  rateLimited = rateLimited || dir.rateLimited;

  const files = (dir.data ?? []).filter((e) => e?.type === "file");
  const workflowTexts = await mapLimit(files, FANOUT, async (f) => {
    const c = await ghGet<{ content?: string }>(
      env,
      token,
      `/repos/${repo.full_name}/contents/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(ref)}`,
    );
    rateLimited = rateLimited || c.rateLimited;
    return c.data?.content ? fromB64(c.data.content) : "";
  });

  let config = "";
  for (const configPath of ["wrangler.jsonc", "wrangler.toml", "wrangler.json"]) {
    const c = await ghGet<{ content?: string }>(
      env,
      token,
      `/repos/${repo.full_name}/contents/${configPath}?ref=${encodeURIComponent(ref)}`,
    );
    rateLimited = rateLimited || c.rateLimited;
    if (c.ok && c.data?.content) {
      config += fromB64(c.data.content) + "\n";
      break; // one wrangler config is enough
    }
  }

  return { workflows: workflowTexts.join("\n"), config, rateLimited };
}

/**
 * Extracts every cron expression from GitHub Actions `schedule:` triggers.
 * Matches `- cron: '…'` / `- cron: "…"` / `- cron: …` (trailing comment stripped).
 */
export function extractWorkflowCrons(yaml: string): string[] {
  const out: string[] = [];
  const re = /-\s*cron:\s*['"]?([^'"\n#]+?)['"]?\s*(?:#.*)?$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yaml)) !== null) {
    const expr = m[1].trim();
    if (expr) out.push(expr);
  }
  return out;
}

/** Extracts the worker name from a wrangler jsonc/json (`"name": "…"`) or toml (`name = "…"`). */
export function extractWorkerName(config: string): string | null {
  const json = config.match(/"name"\s*:\s*"([^"]+)"/);
  if (json) return json[1];
  const toml = config.match(/^\s*name\s*=\s*"([^"]+)"/m);
  if (toml) return toml[1];
  return null;
}

/**
 * Builds the set of names core-guardian has already logged AI usage for —
 * `ai_router_requests.project` + `ai_usage_registrations.worker`, lowercased.
 * (Same cross-check source as the P2 worker scanner.)
 */
async function loadRegisteredNames(db: ReturnType<typeof getDb>): Promise<Set<string>> {
  const [projects, workers] = await Promise.all([
    db.selectDistinct({ name: aiRouterRequests.project }).from(aiRouterRequests),
    db.selectDistinct({ name: aiUsageRegistrations.worker }).from(aiUsageRegistrations),
  ]);
  const set = new Set<string>();
  for (const r of [...projects, ...workers]) {
    if (r.name) set.add(r.name.toLowerCase());
  }
  return set;
}

/**
 * Scans one repo. Returns `null` when the repo has no AI signal (not a target)
 * or when its text could not be read.
 */
async function scanOne(
  env: Env,
  token: string,
  repo: Repo,
  registered: Set<string>,
  knownModels: string[],
  onRateLimit: () => void,
): Promise<ScannedRepo | null> {
  const { workflows, config, rateLimited } = await fetchRepoText(env, token, repo);
  if (rateLimited) onRateLimit();

  const ai = detectAiSignals(`${workflows}\n${config}`, { knownModels });
  if (!ai.ai) return null; // no AI usage → not a spend player, don't record

  const cronSchedules = extractWorkflowCrons(workflows);
  const workerName = extractWorkerName(config);

  const signals: RiskSignals = {
    ai: true,
    cron: cronSchedules.length > 0,
    browser: false,
    scraping: false,
    d1: false,
    vectorize: false,
    durableObject: false,
  };
  const riskScore = scoreRisk({ signals, cronExprs: cronSchedules, invocationsPerDay: 0 });

  // Registered if guardian sees this repo/worker in its logs, OR the workflow
  // literally routes through guardian's endpoint (ai.guardianRouted).
  const guardianRegistered =
    ai.guardianRouted ||
    registered.has(repo.full_name.toLowerCase()) ||
    registered.has(repo.name.toLowerCase()) ||
    (workerName !== null && registered.has(workerName.toLowerCase()));

  const bypass: BypassVerdict = !guardianRegistered
    ? {
        isBypass: true,
        why: `Repo "${repo.full_name}" uses AI (${ai.matched.join(", ") || "guardian-routed"}) in CI but has no rows in ai_router_requests/ai_usage_registrations — AI spend is not reported through core-guardian.`,
      }
    : { isBypass: false, why: "" };

  return { name: repo.full_name, workerName, cronSchedules, signals, riskScore, guardianRegistered, bypass };
}

/**
 * Enumerates the authenticated user's GitHub repos, regex-scans each for AI
 * usage in CI, upserts AI-using repos into `scan_targets`, and returns a summary.
 *
 * @param env - Worker env carrying the GITHUB_TOKEN Secrets Store binding + `DB`
 */
export async function scanGithub(env: Env): Promise<GithubScanSummary> {
  const now = Date.now();
  const empty: GithubScanSummary = {
    ok: false,
    reposListed: 0,
    reposScanned: 0,
    aiRepos: 0,
    bypasses: 0,
    truncated: false,
    rateLimited: false,
    scannedAt: now,
    topRisk: [],
  };

  const token = await githubToken(env);
  if (!token) {
    return { ...empty, error: "GITHUB_TOKEN is not configured (Secrets Store binding GH_TOKEN)." };
  }

  const db = getDb(env);
  // Fetch the exact billed-model allowlist ONCE (not per file) — the text
  // detector matches these literally instead of a false-positive-prone `@cf/`.
  const [{ repos, truncated, rateLimited: listRateLimited, firstCallFailed }, registered, knownModels] =
    await Promise.all([listRepos(env, token), loadRegisteredNames(db), getKnownBilledModels(env)]);

  if (firstCallFailed) {
    return {
      ...empty,
      rateLimited: listRateLimited,
      error: listRateLimited
        ? "GitHub rate limit hit before any repo could be listed."
        : "GitHub /user/repos listing failed (check GITHUB_TOKEN scope).",
    };
  }
  if (truncated) {
    console.warn(`[scan-github] repo listing capped at ${MAX_REPOS}; more repos exist and were not scanned.`);
  }

  let rateLimited = listRateLimited;
  let reposScanned = 0; // repos actually fetched (not short-circuited by rate limit)
  const onRateLimit = () => {
    rateLimited = true;
  };

  const scanned = await mapLimit(repos, FANOUT, async (repo) => {
    // Once rate-limited, stop starting new repo scans — stop gracefully.
    if (rateLimited) return null;
    reposScanned++;
    try {
      return await scanOne(env, token, repo, registered, knownModels, onRateLimit);
    } catch {
      return null; // one unreadable repo must not sink the whole scan
    }
  });

  const aiRepos = scanned.filter((r): r is ScannedRepo => r !== null);

  if (rateLimited) {
    console.warn(
      `[scan-github] GitHub rate limit hit: scanned ${reposScanned} of ${repos.length} listed repos; remainder skipped.`,
    );
  }

  let bypasses = 0;
  for (const r of aiRepos) {
    const row: NewScanTargetRow = {
      id: crypto.randomUUID(),
      kind: "github_action",
      name: r.name,
      workerName: r.workerName,
      cronSchedules: r.cronSchedules,
      riskSignals: r.signals,
      riskScore: r.riskScore,
      guardianRegistered: r.guardianRegistered,
      bypass: r.bypass,
      firstSeen: now,
      lastScan: now,
    };
    await db
      .insert(scanTargets)
      .values(row)
      .onConflictDoUpdate({
        target: [scanTargets.kind, scanTargets.name],
        set: {
          workerName: row.workerName,
          cronSchedules: row.cronSchedules,
          riskSignals: row.riskSignals,
          riskScore: row.riskScore,
          guardianRegistered: row.guardianRegistered,
          bypass: row.bypass,
          lastScan: now,
        },
      });
    if (r.bypass.isBypass) bypasses++;
  }

  const topRisk = [...aiRepos]
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 10)
    .map((r) => ({
      name: r.name,
      riskScore: r.riskScore,
      guardianRegistered: r.guardianRegistered,
      isBypass: r.bypass.isBypass,
      cronSchedules: r.cronSchedules,
      workerName: r.workerName,
    }));

  return {
    ok: true,
    reposListed: repos.length,
    reposScanned,
    aiRepos: aiRepos.length,
    bypasses,
    truncated,
    rateLimited,
    scannedAt: now,
    topRisk,
  };
}
