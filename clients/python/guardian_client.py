"""core-guardian client — vendor this single file into any Python service.

Zero external dependencies (urllib only). Identity comes from the ``GUARDIAN``
config (a JSON string env var or a dict); the two token audiences come from the
``GUARDIAN_AI_TOKEN`` and ``GUARDIAN_API_KEY`` env vars. Mirrors the TypeScript
client's contract exactly. Source of truth:
https://github.com/jmbish04/core-guardian/blob/main/clients/python/guardian_client.py
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Iterator, Mapping, Optional, Tuple

VERSION = "1.0.0"
DEFAULT_BASE_URL = "https://core-guardian.hacolby.workers.dev"
PRIORITY_TO_IMPORTANCE: Dict[str, str] = {
    "hobby": "low",
    "normal": "low",
    "important": "medium",
    "critical": "high",
}

# An injected HTTP transport: (method, url, headers, body_bytes, stream) ->
# (status:int, body:bytes|Iterator[bytes]). Lets the self-check run without a
# network. Defaults to urllib.
Http = Callable[[str, str, Dict[str, str], Optional[bytes], bool], Tuple[int, Any]]


class GuardianError(Exception):
    """Raised for any non-2xx response. Mirrors the TS GuardianError."""

    def __init__(self, status: int, body: Any):
        super().__init__(f"Guardian request failed ({status})")
        self.status = status
        self.body = body
        b = body if isinstance(body, dict) else {}
        self.is_circuit_breaker = bool(b.get("isCircuitBreaker"))
        msg = b.get("circuitBrokenMessage")
        self.circuit_broken_message = msg if isinstance(msg, str) else None


def _drop_none(d: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _parse_json(raw: Optional[bytes]) -> Any:
    # Catch ValueError (covers json.JSONDecodeError AND the UnicodeDecodeError a
    # binary/gzip error page would raise) so a bad body degrades to None, never
    # escaping past the caller's GuardianError handling.
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


def _urllib_http(
    method: str, url: str, headers: Dict[str, str], body: Optional[bytes], stream: bool, timeout: Optional[float] = 30.0
) -> Tuple[int, Any]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        # Streaming reads happen after urlopen returns, so the connect timeout
        # still applies but a long stream isn't cut off by it.
        resp = urllib.request.urlopen(req, timeout=timeout)  # noqa: S310 (fixed base URL, not user-controlled scheme)
    except urllib.error.HTTPError as e:
        raise GuardianError(e.code, _parse_json(e.read()))
    if stream:
        def chunks() -> Iterator[bytes]:
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                yield chunk
        return resp.status, chunks()
    return resp.status, _parse_json(resp.read())


class _AI:
    def __init__(self, client: "GuardianClient"):
        self._c = client

    def run(
        self,
        *,
        provider: str,
        model: str,
        input: Any,
        importance: Optional[str] = None,
        mode: Optional[str] = None,
        ai_gateway_id: Optional[str] = None,
        transport: Optional[str] = None,
        provider_api_key: Optional[str] = None,
    ) -> Any:
        return self._c._run(
            provider, model, input, importance, mode, ai_gateway_id, transport, provider_api_key, False
        )

    def stream(
        self,
        *,
        provider: str,
        model: str,
        input: Any,
        importance: Optional[str] = None,
        mode: Optional[str] = None,
        ai_gateway_id: Optional[str] = None,
        transport: Optional[str] = None,
        provider_api_key: Optional[str] = None,
    ) -> Iterator[bytes]:
        return self._c._run(
            provider, model, input, importance, mode, ai_gateway_id, transport, provider_api_key, True
        )


class _Usage:
    def __init__(self, client: "GuardianClient"):
        self._c = client

    def register(
        self,
        *,
        provider: str,
        model: str,
        tokens_in: Optional[int] = None,
        tokens_out: Optional[int] = None,
        tokens_thinking: Optional[int] = None,
        requests: Optional[int] = None,
        cost_usd: Optional[float] = None,
        operation_id: Optional[str] = None,
        task_description: Optional[str] = None,
    ) -> Any:
        return self._c._register(
            _drop_none({
                "provider": provider,
                "model": model,
                "tokensIn": tokens_in,
                "tokensOut": tokens_out,
                "tokensThinking": tokens_thinking,
                "requests": requests,
                "costUsd": cost_usd,
                "operationId": operation_id,
                "taskDescription": task_description,
            })
        )


class GuardianClient:
    VERSION = VERSION

    def __init__(
        self,
        *,
        project: str,
        repo: Optional[str] = None,
        priority: Optional[str] = None,
        budget: Optional[float] = None,
        base_url: Optional[str] = None,
        ai_token: Optional[str] = None,
        api_key: Optional[str] = None,
        http: Optional[Http] = None,
        timeout: Optional[float] = 30.0,
    ):
        if not project:
            raise ValueError("GuardianClient: project is required")
        self.project = project
        self.repo = repo
        self.priority = priority
        # Named budget_usd so it can't shadow the budget() endpoint method.
        self.budget_usd = budget
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        # Leading underscore keeps the tokens out of a casual vars()/repr dump.
        self._ai_token = ai_token
        self._api_key = api_key
        # Default transport carries the timeout; an injected http keeps the
        # 5-arg signature (timeout is the transport's concern).
        self._http = http or (lambda m, u, h, b, s: _urllib_http(m, u, h, b, s, timeout))
        self.ai = _AI(self)
        self.usage = _Usage(self)

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, Any]] = None, **kwargs: Any) -> "GuardianClient":
        env = env if env is not None else os.environ
        raw = env.get("GUARDIAN")
        if raw is None:
            raise ValueError("GuardianClient.from_env: GUARDIAN missing")
        try:
            cfg = json.loads(raw) if isinstance(raw, str) else dict(raw)
        except (ValueError, TypeError):
            raise ValueError("GuardianClient.from_env: GUARDIAN is not valid JSON or a mapping")
        if not cfg.get("project"):
            raise ValueError("GuardianClient.from_env: GUARDIAN.project missing")
        return cls(
            project=cfg["project"],
            repo=cfg.get("repo"),
            priority=cfg.get("priority"),
            budget=cfg.get("budget"),
            base_url=cfg.get("baseUrl"),
            ai_token=env.get("GUARDIAN_AI_TOKEN"),
            api_key=env.get("GUARDIAN_API_KEY"),
            **kwargs,
        )

    def _importance_for(self, over: Optional[str]) -> str:
        return over or PRIORITY_TO_IMPORTANCE.get(self.priority or "normal", "low")

    def _send(self, method: str, path: str, token: Optional[str], body: Optional[dict], stream: bool = False) -> Tuple[int, Any]:
        if not token:
            raise RuntimeError(f"GuardianClient: missing token for {path}")
        headers = {"authorization": f"Bearer {token}"}
        data: Optional[bytes] = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        status, payload = self._http(method, self.base_url + path, headers, data, stream)
        # Raise on error for streaming too (matches the TS client): a 400 for a
        # non-openai stream or a 429 breaker must surface, not be iterated.
        if status >= 400:
            raise GuardianError(status, payload)
        return status, payload

    def _run(self, provider, model, input, importance, mode, ai_gateway_id, transport, provider_api_key, stream):
        body = _drop_none({
            "project": self.project,
            "importance": self._importance_for(importance),
            "provider": provider,
            "model": model,
            "input": input,
            "mode": mode,
            "aiGatewayId": ai_gateway_id,
            "transport": transport,
            "providerApiKey": provider_api_key,
            "stream": stream,
        })
        _status, payload = self._send("POST", "/api/ai-router/run", self._ai_token, body, stream)
        return payload

    def _register(self, u: Dict[str, Any]) -> Any:
        body = {"worker": self.project, **u}
        _status, payload = self._send("POST", "/api/guardian/usage/register", self._api_key, body)
        return payload

    def budget(self) -> Any:
        _status, payload = self._send("GET", "/api/ai/budget", self._api_key, None)
        return payload

    def project_status(self) -> Any:
        """GET the registered project record. (Named project_status to avoid
        shadowing the ``project`` identity attribute.)"""
        path = "/api/guardian/projects/" + urllib.parse.quote(self.project, safe="")
        _status, payload = self._send("GET", path, self._api_key, None)
        return payload
