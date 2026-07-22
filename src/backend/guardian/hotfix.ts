/**
 * @fileoverview Emergency-hotfix GitHub agent — DRY-RUN ONLY.
 *
 * Given a repo, a file path, and a plain-language instruction, this fetches the
 * file, asks Workers AI to produce the patched version, creates a branch,
 * commits the patch, and opens a **draft** pull request. It never merges and
 * never deploys — a human reviews and merges the draft PR. This is the safe
 * subset of the Jules/GitHub hotfix idea: propose, don't execute.
 *
 * Uses the GITHUB_TOKEN Secrets Store binding. No Jules API key required for the
 * dry-run path.
 *
 * @see the account-wide bulk variant + Jules API + auto-merge are intentionally
 *   NOT built — auto-merging to live workers is out of scope for a spend guard.
 */

import { getSecret, getSecretStoreBinding } from "@/backend/utils/secrets";

const GH = "https://api.github.com";

async function githubToken(env: Env): Promise<string> {
  const t = (await getSecretStoreBinding(env, "GITHUB_TOKEN")) ?? getSecret(env, "GITHUB_TOKEN");
  if (!t) throw new Error("GITHUB_TOKEN is not configured.");
  return t;
}

async function gh<T = any>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const token = await githubToken(env);
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "core-guardian-hotfix",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${json?.message ?? "error"}`);
  return json as T;
}

/** UTF-8 → base64 (GitHub contents API wants base64). */
function toB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** base64 → UTF-8. */
function fromB64(s: string): string {
  const bin = atob(s.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Ask Workers AI to produce the patched file. Returns the full new content. */
async function proposePatch(env: Env, path: string, original: string, instruction: string): Promise<string> {
  const model = (env as any).MODEL_DRAFT || "@cf/openai/gpt-oss-120b";
  const prompt = `You are patching the file "${path}". Apply this instruction: "${instruction}".
Return ONLY the complete new file content, no markdown fences, no commentary.

--- CURRENT FILE ---
${original.slice(0, 20000)}`;
  const res: any = await env.AI.run(model, { messages: [{ role: "user", content: prompt }], max_tokens: 8192 });
  const text: string =
    res?.response ?? res?.choices?.[0]?.message?.content ?? res?.result?.response ?? "";
  // Strip an accidental code fence if the model added one.
  return text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "").trim() + "\n";
}

export type HotfixResult = {
  repo: string;
  path: string;
  branch: string;
  prNumber: number;
  prUrl: string;
  changed: boolean;
};

/**
 * Propose a dry-run hotfix: patch a file and open a DRAFT PR.
 *
 * @param repo - "owner/name"
 * @param path - file path in the repo
 * @param instruction - what to change (plain language)
 * @param now - epoch ms (for the branch name; passed in for determinism)
 */
export async function proposeHotfix(
  env: Env,
  repo: string,
  path: string,
  instruction: string,
  now: number,
): Promise<HotfixResult> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`repo must be "owner/name", got "${repo}"`);

  // 1) Current file + default branch.
  const repoInfo = await gh(env, `/repos/${owner}/${name}`);
  const base = repoInfo.default_branch as string;
  const file = await gh(env, `/repos/${owner}/${name}/contents/${encodeURIComponent(path)}?ref=${base}`);
  const original = fromB64(file.content as string);

  // 2) AI-proposed patch.
  const patched = await proposePatch(env, path, original, instruction);
  const changed = patched.trim() !== original.trim();

  // 3) Branch off the base head.
  const ref = await gh(env, `/repos/${owner}/${name}/git/ref/heads/${base}`);
  const branch = `guardian-hotfix-${now}`;
  await gh(env, `/repos/${owner}/${name}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.object.sha }),
  });

  // 4) Commit the patch to the branch (only if it actually changed).
  if (changed) {
    await gh(env, `/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `hotfix: ${instruction}`.slice(0, 72),
        content: toB64(patched),
        branch,
        sha: file.sha,
      }),
    });
  }

  // 5) Open a DRAFT PR — never merged by us.
  const pr = await gh(env, `/repos/${owner}/${name}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: `[Guardian hotfix] ${instruction}`.slice(0, 120),
      head: branch,
      base,
      draft: true,
      body:
        `Proposed by Core Guardian (dry-run).\n\n**Instruction:** ${instruction}\n\n` +
        (changed
          ? "The file was patched by Workers AI. **Review carefully before merging** — this is an AI proposal, not a verified fix."
          : "⚠️ The AI produced no change to the file. This PR is empty — the instruction may need to be more specific."),
    }),
  });

  return { repo, path, branch, prNumber: pr.number, prUrl: pr.html_url, changed };
}
