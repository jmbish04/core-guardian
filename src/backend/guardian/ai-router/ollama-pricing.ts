/**
 * @fileoverview Ollama Cloud pricing watcher — detect + alert on plan changes.
 *
 * WHY THIS EXISTS
 *   The Max plan is currently "New sign-ups paused" and Pro caps at "3 cloud
 *   models / 50x Free usage". We want to know the moment either changes —
 *   especially when Max reopens — without checking the page by hand.
 *
 * HOW (no AI — pure extraction + line diff)
 *   https://ollama.com/pricing is a public, server-rendered page (no auth). We
 *   fetch it, strip to the visible text of the **Individuals** cards (Free / Pro
 *   / Max — Team & Enterprise are ignored), and normalise it to an ordered line
 *   array (the "fingerprint"). Each cron tick compares the fingerprint to the
 *   last snapshot in OLLAMA_KV:
 *     • unchanged           → nothing recorded.
 *     • changed             → store the new snapshot, append a capped change-log
 *                             entry (before/after line diff), and upsert a row
 *                             into the `alerts` D1 table (dashboard-read).
 *     • Max sign-ups reopen → same, flagged `maxReopened` as an INFO alert (the
 *                             headline event) instead of a WARNING.
 *
 * NO DURABLE OBJECTS. Alerts go to the `alerts` D1 table, not the
 * NotificationsAgent DO — DO invocations are a runaway-spend vector. Snapshots +
 * change-log live in OLLAMA_KV (pricing changes rarely) — no new D1 table, no
 * migration. The change-log is a capped array under `ollama:pricing:changes`.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/backend/db";
import { alerts } from "@/backend/db/schema";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const PRICING_URL = "https://ollama.com/pricing";
const SNAPSHOT_KEY = "ollama:pricing:latest";
const CHANGELOG_KEY = "ollama:pricing:changes";
const CHANGELOG_CAP = 50; // keep the last N change events
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once/day (cron is hourly — self-gated)
/** Text shown on the Max card while new subscriptions are paused. */
const MAX_PAUSED_MARKER = "New sign-ups paused";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface OllamaPlan {
  name: string;        // "Free" | "Pro" | "Max"
  price: string;       // "$0" | "$20" | "$100"
  unit: string;        // "" | "/ mo"
  available: boolean;  // false when the card shows "New sign-ups paused"
  features: string[];  // bullet lines for the plan
}

export interface OllamaPricingSnapshot {
  capturedAt: number;
  maxSignupsPaused: boolean;
  plans: OllamaPlan[];
  /** Ordered, normalised visible-text lines of the Individuals cards — the diff surface. */
  fingerprint: string[];
}

export interface OllamaPricingDiff {
  changed: boolean;
  maxReopened: boolean;         // paused → available this tick
  addedLines: string[];         // present now, absent before
  removedLines: string[];       // present before, absent now
  priceChanges: string[];       // e.g. "Pro: $20 → $25"
}

export interface OllamaPricingChangeEvent {
  at: number;
  maxReopened: boolean;
  addedLines: string[];
  removedLines: string[];
  priceChanges: string[];
}

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

const PLAN_HEADERS = new Set(["Free", "Pro", "Max"]);

/** Minimal HTML entity decode for the handful that appear in the pricing text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

/** Strip a full HTML doc to normalised, non-empty visible-text lines. */
export function htmlToLines(html: string): string[] {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => decodeEntities(l).trim())
    .filter(Boolean);
}

/**
 * Parse the Individuals pricing cards from the full page HTML.
 * Slices the visible text from the first "Free" plan header (anchored after the
 * "Individuals" tab) up to the "Team" plan header, so Team & Enterprise never
 * bleed in.
 */
export function parseOllamaPricing(html: string, capturedAt: number): OllamaPricingSnapshot {
  const lines = htmlToLines(html);

  // Anchor past the nav using the "Individuals" tab label, then take the
  // Individuals card region: [first "Free"] .. [before "Team" plan header].
  const indivIdx = lines.indexOf("Individuals");
  const freeIdx = lines.indexOf("Free", indivIdx >= 0 ? indivIdx : 0);
  const teamIdx = lines.indexOf("Team", freeIdx + 1);
  const region = freeIdx >= 0 ? lines.slice(freeIdx, teamIdx > 0 ? teamIdx : undefined) : [];

  // Walk the region, splitting into plan cards on each Free/Pro/Max header.
  const plans: OllamaPlan[] = [];
  let cur: { name: string; body: string[] } | null = null;
  for (const line of region) {
    if (PLAN_HEADERS.has(line)) {
      if (cur) plans.push(finishPlan(cur));
      cur = { name: line, body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) plans.push(finishPlan(cur));

  return {
    capturedAt,
    maxSignupsPaused: region.includes(MAX_PAUSED_MARKER),
    plans,
    fingerprint: region,
  };
}

/** Derive {price, unit, available, features} from a plan card's body lines. */
function finishPlan(card: { name: string; body: string[] }): OllamaPlan {
  const { name, body } = card;
  const priceIdx = body.findIndex((l) => /^\$\d/.test(l) || l === "Custom");
  const price = priceIdx >= 0 ? body[priceIdx] : "";
  const unit = priceIdx >= 0 && /^\/\s/.test(body[priceIdx + 1] ?? "") ? body[priceIdx + 1].trim() : "";
  const available = !body.includes(MAX_PAUSED_MARKER);

  // Features = the "Everything in X, plus:" bullets (or, for Free which has no
  // such header, every card line after the CTA). Drop pure-chrome lines.
  const NOISE = new Set(["Download", "Get Pro", "annually", "Learn more", MAX_PAUSED_MARKER]);
  const plusIdx = body.findIndex((l) => /^(Everything in .+, plus:|What's included:)$/.test(l));
  const featureSource = plusIdx >= 0 ? body.slice(plusIdx + 1) : body.slice(priceIdx + 1);
  const features = featureSource.filter(
    (l) => l !== price && l !== unit && !NOISE.has(l) && !l.startsWith("or $") && !/temporarily paused/.test(l),
  );

  return { name, price, unit, available, features };
}

// -----------------------------------------------------------------------------
// Fetch + diff
// -----------------------------------------------------------------------------

/** Fetch + parse the current Individuals pricing (public page, no auth). */
export async function fetchOllamaPricing(_env: Env): Promise<OllamaPricingSnapshot> {
  const res = await fetch(PRICING_URL, {
    headers: { Accept: "text/html", "User-Agent": "core-guardian/1.0 (pricing-watch)" },
  });
  if (!res.ok) throw new Error(`ollama.com/pricing returned ${res.status}`);
  return parseOllamaPricing(await res.text(), Date.now());
}

/** Compare two snapshots. `changed` is true iff the fingerprint differs. */
export function diffPricing(prev: OllamaPricingSnapshot | null, cur: OllamaPricingSnapshot): OllamaPricingDiff {
  const prevLines = new Set(prev?.fingerprint ?? []);
  const curLines = new Set(cur.fingerprint);
  const addedLines = cur.fingerprint.filter((l) => !prevLines.has(l));
  const removedLines = (prev?.fingerprint ?? []).filter((l) => !curLines.has(l));

  const priceChanges: string[] = [];
  if (prev) {
    const prevPrice = new Map(prev.plans.map((p) => [p.name, `${p.price}${p.unit ? " " + p.unit : ""}`]));
    for (const p of cur.plans) {
      const before = prevPrice.get(p.name);
      const after = `${p.price}${p.unit ? " " + p.unit : ""}`;
      if (before !== undefined && before !== after) priceChanges.push(`${p.name}: ${before} → ${after}`);
    }
  }

  const maxReopened = Boolean(prev?.maxSignupsPaused) && !cur.maxSignupsPaused;
  const changed = !prev || addedLines.length > 0 || removedLines.length > 0;
  return { changed, maxReopened, addedLines, removedLines, priceChanges };
}

// -----------------------------------------------------------------------------
// Alert (D1 `alerts` table — NO Durable Objects)
// -----------------------------------------------------------------------------
// Intentionally does NOT route through NotificationsAgent (a Durable Object):
// DO invocations are a runaway-spend vector. The `alerts` table is the durable,
// dashboard-read surface, keyed by a stable id so a change updates in place
// rather than piling up rows.

const ALERT_ID = "ollama-pricing:individuals";

/** Upsert a governance alert row for a detected pricing change (never throws). */
async function raisePricingAlert(env: Env, diff: OllamaPricingDiff): Promise<void> {
  try {
    const db = getDb(env);
    const now = Date.now();

    const parts: string[] = [];
    if (diff.priceChanges.length) parts.push(`price ${diff.priceChanges.join("; ")}`);
    if (diff.addedLines.length) parts.push(`added: ${diff.addedLines.join(" · ")}`);
    if (diff.removedLines.length) parts.push(`removed: ${diff.removedLines.join(" · ")}`);
    const cause = diff.maxReopened
      ? `Ollama Max sign-ups reopened. ${parts.join(" | ")}`.trim()
      : `Ollama Individuals pricing changed — ${parts.join(" | ")}`;
    const recommendation = diff.maxReopened
      ? `Max is available again — subscribe if you want the higher tier. ${PRICING_URL}`
      : `Review the change and adjust plan/budget expectations. ${PRICING_URL}`;
    const severity: "info" | "warning" = diff.maxReopened ? "info" : "warning";

    const [existing] = await db.select({ id: alerts.id }).from(alerts).where(sql`${alerts.id} = ${ALERT_ID}`).limit(1);
    if (existing) {
      await db.update(alerts)
        .set({ severity, cause, recommendation, status: "active", updatedAt: now })
        .where(sql`${alerts.id} = ${ALERT_ID}`);
    } else {
      await db.insert(alerts).values({
        id: ALERT_ID,
        service: "ollama-pricing",
        resource: "individuals",
        worker: null,
        severity,
        cause,
        recommendation,
        projectedFraction: null,
        estCostDelta: null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch (err) {
    console.error(JSON.stringify({ level: "ERROR", source: "guardian.ollama.pricing.alert", error: String(err) }));
  }
}

// -----------------------------------------------------------------------------
// Cron entrypoint
// -----------------------------------------------------------------------------

/**
 * Self-gated daily check. Fetches current pricing, diffs against the KV
 * snapshot, and on any change stores the new snapshot + appends a capped
 * change-log entry + raises a D1 `alerts` row. First run just seeds the baseline
 * (no alert). Returns the diff (or null only when skipped by the daily gate).
 *
 * @param force - skip the once/day gate (manual "check now" from the API).
 */
export async function maybeCheckOllamaPricing(env: Env, force = false): Promise<OllamaPricingDiff | null> {
  const prevRaw = await env.OLLAMA_KV.get(SNAPSHOT_KEY, "json") as OllamaPricingSnapshot | null;

  // Gate: at most once/day. First run (no snapshot) always proceeds to seed.
  if (!force && prevRaw && Date.now() - prevRaw.capturedAt < CHECK_INTERVAL_MS) return null;

  const cur = await fetchOllamaPricing(env);
  const diff = diffPricing(prevRaw, cur);

  // Always refresh the stored snapshot so the daily gate advances even when the
  // page is unchanged (otherwise an unchanged page would re-fetch every hour).
  await env.OLLAMA_KV.put(SNAPSHOT_KEY, JSON.stringify(cur));

  // Seed run (no prior snapshot): record baseline, don't alert.
  if (!prevRaw) return diff;

  if (diff.changed) {
    const event: OllamaPricingChangeEvent = {
      at: cur.capturedAt,
      maxReopened: diff.maxReopened,
      addedLines: diff.addedLines,
      removedLines: diff.removedLines,
      priceChanges: diff.priceChanges,
    };
    const log = (await env.OLLAMA_KV.get(CHANGELOG_KEY, "json") as OllamaPricingChangeEvent[] | null) ?? [];
    log.unshift(event);
    await env.OLLAMA_KV.put(CHANGELOG_KEY, JSON.stringify(log.slice(0, CHANGELOG_CAP)));
    await raisePricingAlert(env, diff);
    console.warn(JSON.stringify({ level: "INFO", source: "guardian.ollama.pricing", maxReopened: diff.maxReopened, priceChanges: diff.priceChanges, added: diff.addedLines.length, removed: diff.removedLines.length }));
  }

  return diff;
}

// -----------------------------------------------------------------------------
// Self-check — parser + diff against the current live pricing fixture.
// Run with `bun src/backend/guardian/ai-router/ollama-pricing.ts`.
// -----------------------------------------------------------------------------
if (import.meta.main) {
  const eq = (a: unknown, b: unknown, m: string) => { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

  // Fixture mirrors the real Individuals cards (Aug 2026).
  const fixture = `
  <div>Individuals</div><div>Team &amp; Enterprise</div>
  <h3>Free</h3><p>Get started with Ollama</p><div>$0</div><a>Download</a>
  <li>Access cloud models</li><li>Unlimited public models</li>
  <h3>Pro</h3><p>Solve harder tasks, faster</p><div>$20</div><span>/ mo</span>
  <span>or $200/yr billed</span><a>annually</a><a>Get Pro</a>
  <div>Everything in Free, plus:</div>
  <li>Run 3 cloud models at a time</li><li>50x more cloud usage than Free</li>
  <h3>Max</h3><p>For your most demanding work</p><div>$100</div><span>/ mo</span>
  <div>New sign-ups paused</div><p>New Max subscriptions are temporarily paused while we add capacity.</p><a>Learn more</a>
  <div>Everything in Pro, plus:</div>
  <li>Run 10 cloud models at a time</li><li>5x more usage than Pro</li>
  <h3>Team</h3><p>Introductory pricing</p><div>$25</div><span>/ seat / mo</span>`;

  const snap = parseOllamaPricing(fixture, 1000);
  eq(snap.plans.length, 3, "plan count (Team excluded)");
  eq(snap.plans.map((p) => p.name).join(","), "Free,Pro,Max", "plan names");
  eq(snap.maxSignupsPaused, true, "max paused");
  const pro = snap.plans.find((p) => p.name === "Pro")!;
  eq(pro.price, "$20", "pro price");
  eq(pro.unit, "/ mo", "pro unit");
  eq(pro.features.includes("Run 3 cloud models at a time"), true, "pro feature present");
  eq(pro.features.includes("annually"), false, "cta chrome excluded from features");
  const max = snap.plans.find((p) => p.name === "Max")!;
  eq(max.available, false, "max unavailable");
  eq(snap.fingerprint.includes("$25"), false, "team price not in fingerprint");

  // Diff: Max reopens + Pro bumps to 4 models.
  const reopened = fixture
    .replace("<div>New sign-ups paused</div><p>New Max subscriptions are temporarily paused while we add capacity.</p><a>Learn more</a>", "<a>Get Max</a>")
    .replace("Run 3 cloud models at a time", "Run 4 cloud models at a time");
  const snap2 = parseOllamaPricing(reopened, 2000);
  const diff = diffPricing(snap, snap2);
  eq(diff.changed, true, "changed");
  eq(diff.maxReopened, true, "max reopened");
  eq(diff.addedLines.includes("Run 4 cloud models at a time"), true, "added new bullet");
  eq(diff.removedLines.includes("Run 3 cloud models at a time"), true, "removed old bullet");

  // No-change diff is stable.
  eq(diffPricing(snap, parseOllamaPricing(fixture, 3000)).changed, false, "identical → no change");

  // eslint-disable-next-line no-console
  console.log("ok — ollama pricing watcher verified");
}
