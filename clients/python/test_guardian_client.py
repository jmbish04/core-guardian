"""Self-check for guardian_client.py — no network, injected HTTP transport.

Run: python3 clients/python/test_guardian_client.py   (exits non-zero on failure)
Mirrors the TypeScript client's test intent: config resolution, importance
mapping + override, per-endpoint token routing, request shape, and error paths.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from guardian_client import GuardianClient, GuardianError, VERSION  # noqa: E402


def make_client(status=200, body=None, priority="important"):
    """Build a client whose HTTP transport records the last call and returns a
    canned (status, body)."""
    calls = []

    def http(method, url, headers, data, stream):
        calls.append({
            "method": method,
            "url": url,
            "headers": headers,
            "body": json.loads(data) if data else None,
            "stream": stream,
        })
        if status >= 400:
            # urllib transport raises GuardianError itself for HTTP errors;
            # emulate that so non-stream error handling is exercised end-to-end.
            raise GuardianError(status, body)
        return status, body

    c = GuardianClient(
        project="my-worker",
        priority=priority,
        base_url="https://g.example.com",
        ai_token="AI",
        api_key="API",
        http=http,
    )
    return c, calls


def test_run_routes_ai_token_and_injects_project_importance():
    c, calls = make_client(body={"request_uuid": "u1", "tokens_in": 1})
    r = c.ai.run(provider="openai", model="gpt", input={"messages": []})
    assert r["request_uuid"] == "u1"
    assert len(calls) == 1
    call = calls[0]
    assert call["url"] == "https://g.example.com/api/ai-router/run"
    assert call["method"] == "POST"
    assert call["headers"]["authorization"] == "Bearer AI"
    assert call["body"]["project"] == "my-worker"
    assert call["body"]["importance"] == "medium"  # important -> medium
    assert call["body"]["stream"] is False


def test_importance_override_and_unknown_priority_fallback():
    c, calls = make_client(body={})
    c.ai.run(provider="p", model="m", input={}, importance="low")
    assert calls[0]["body"]["importance"] == "low"

    bad, calls2 = make_client(body={}, priority="Normal")  # unknown casing
    bad.ai.run(provider="p", model="m", input={})
    assert calls2[0]["body"]["importance"] == "low"  # falls back, never None

    empty, calls3 = make_client(body={}, priority="")
    empty.ai.run(provider="p", model="m", input={})
    assert calls3[0]["body"]["importance"] == "low"


def test_register_routes_api_key_and_maps_worker():
    c, calls = make_client(body={"registrationId": "r", "priced": "scraped"})
    c.usage.register(provider="p", model="m", tokens_in=10, tokens_out=5)
    call = calls[0]
    assert call["url"] == "https://g.example.com/api/guardian/usage/register"
    assert call["headers"]["authorization"] == "Bearer API"
    assert call["body"]["worker"] == "my-worker"
    assert call["body"]["tokensIn"] == 10
    assert call["body"]["tokensOut"] == 5


def test_budget_and_project_use_api_key_via_get():
    c, calls = make_client(body={"cap": 100})
    c.budget()
    assert calls[0]["url"] == "https://g.example.com/api/ai/budget"
    assert calls[0]["method"] == "GET"
    assert calls[0]["headers"]["authorization"] == "Bearer API"

    c2, calls2 = make_client(body={"name": "my-worker"})
    c2.project_status()
    assert calls2[0]["url"] == "https://g.example.com/api/guardian/projects/my-worker"
    assert calls2[0]["method"] == "GET"


def test_error_raises_guardian_error_with_breaker_flag():
    c, _ = make_client(status=429, body={"isCircuitBreaker": True, "circuitBrokenMessage": "cooling"})
    try:
        c.ai.run(provider="p", model="m", input={})
        assert False, "expected GuardianError"
    except GuardianError as e:
        assert e.status == 429
        assert e.is_circuit_breaker is True
        assert e.circuit_broken_message == "cooling"


def test_from_env_parses_string_and_dict_and_validates():
    env_str = {"GUARDIAN": json.dumps({"project": "p1"}), "GUARDIAN_AI_TOKEN": "AI", "GUARDIAN_API_KEY": "API"}
    assert isinstance(GuardianClient.from_env(env_str), GuardianClient)

    env_dict = {"GUARDIAN": {"project": "p2", "baseUrl": "https://x"}, "GUARDIAN_AI_TOKEN": "AI"}
    g = GuardianClient.from_env(env_dict)
    assert g.project == "p2"
    assert g.base_url == "https://x"

    for bad in ({}, {"GUARDIAN": "{not json"}, {"GUARDIAN": {"repo": "x"}}):
        try:
            GuardianClient.from_env(bad)
            assert False, f"expected ValueError for {bad}"
        except ValueError:
            pass


def test_version_matches_clients_version_file():
    version_path = os.path.join(os.path.dirname(__file__), "..", "VERSION")
    with open(version_path, "r", encoding="utf-8") as f:
        assert f.read().strip() == VERSION


def test_tokens_stored_under_private_names_only():
    # Tokens live under leading-underscore attrs so a public-attr dump
    # (the common "serialize the config" path) never carries them. Mirrors
    # the TS client's toJSON() secret-exclusion intent.
    c, _ = make_client(body={})
    public = {k: v for k, v in vars(c).items() if not k.startswith("_")}
    assert "AI" not in public.values()
    assert "API" not in public.values()
    assert c._ai_token == "AI" and c._api_key == "API"


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} passed")


if __name__ == "__main__":
    main()
