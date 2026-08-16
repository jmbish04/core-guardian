/**
 * core-guardian client for Google Apps Script (V8 runtime).
 *
 * Vendor this single file into any Apps Script project. Identity comes from
 * Script Properties: GUARDIAN (a JSON string), GUARDIAN_AI_TOKEN, and
 * GUARDIAN_API_KEY. Mirrors the TypeScript/Python client contract. Streaming is
 * not supported (UrlFetchApp is buffered) — ai.stream throws. Source of truth:
 * https://github.com/jmbish04/core-guardian/blob/main/clients/gas/GuardianClient.gs
 */

// Manual sync point: GAS can't read clients/VERSION at runtime. Keep this equal
// to clients/VERSION — clients/gas/version-sync.test.mjs fails CI if it drifts.
var GUARDIAN_CLIENT_VERSION = '1.0.0';
var GUARDIAN_DEFAULT_BASE_URL = 'https://core-guardian.hacolby.workers.dev';
var GUARDIAN_PRIORITY_TO_IMPORTANCE = {
  hobby: 'low',
  normal: 'low',
  important: 'medium',
  critical: 'high',
};

/** Thrown for any non-2xx response. Carries status, parsed body, breaker flag. */
class GuardianError extends Error {
  constructor(status, body) {
    super('Guardian request failed (' + status + ')');
    this.name = 'GuardianError';
    this.status = status;
    this.body = body;
    var b = body && typeof body === 'object' ? body : {};
    this.isCircuitBreaker = Boolean(b.isCircuitBreaker);
    this.circuitBrokenMessage =
      typeof b.circuitBrokenMessage === 'string' ? b.circuitBrokenMessage : undefined;
  }
}

/** Default HTTP transport over UrlFetchApp. Returns {code, text}. */
function guardianUrlFetch_(method, url, headers, payload) {
  var params = { method: method, headers: headers, muteHttpExceptions: true };
  if (payload != null) {
    params.contentType = 'application/json';
    params.payload = payload;
  }
  var res = UrlFetchApp.fetch(url, params);
  return { code: res.getResponseCode(), text: res.getContentText() };
}

function guardianDropNull_(obj) {
  var out = {};
  Object.keys(obj).forEach(function (k) {
    if (obj[k] !== null && obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

class GuardianClient {
  /**
   * @param {{project:string, repo?:string, priority?:string, budget?:number,
   *   baseUrl?:string, aiToken?:string, apiKey?:string, fetchImpl?:Function}} opts
   */
  constructor(opts) {
    if (!opts || !opts.project) throw new Error('GuardianClient: project is required');
    this.project = opts.project;
    this.repo = opts.repo;
    this.priority = opts.priority;
    this.budgetUsd = opts.budget;
    this.baseUrl = (opts.baseUrl || GUARDIAN_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this._aiToken = opts.aiToken;
    this._apiKey = opts.apiKey;
    this._fetch = opts.fetchImpl || guardianUrlFetch_;

    var self = this;
    this.ai = {
      run: function (input) {
        return self._run(input, false);
      },
      stream: function () {
        throw new Error('GuardianClient.ai.stream: streaming is not supported in Apps Script');
      },
    };
    this.usage = {
      register: function (u) {
        return self._register(u);
      },
    };
  }

  static get VERSION() {
    return GUARDIAN_CLIENT_VERSION;
  }

  /** Build from Script Properties (GUARDIAN JSON + the two token props). */
  static fromScriptProperties(props) {
    var store = props || PropertiesService.getScriptProperties();
    var raw = store.getProperty('GUARDIAN');
    if (!raw) throw new Error('GuardianClient.fromScriptProperties: GUARDIAN missing');
    var cfg;
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      throw new Error('GuardianClient.fromScriptProperties: GUARDIAN is not valid JSON');
    }
    if (!cfg.project) throw new Error('GuardianClient.fromScriptProperties: GUARDIAN.project missing');
    return new GuardianClient({
      project: cfg.project,
      repo: cfg.repo,
      priority: cfg.priority,
      budget: cfg.budget,
      baseUrl: cfg.baseUrl,
      aiToken: store.getProperty('GUARDIAN_AI_TOKEN'),
      apiKey: store.getProperty('GUARDIAN_API_KEY'),
    });
  }

  _importanceFor(over) {
    return over || GUARDIAN_PRIORITY_TO_IMPORTANCE[this.priority || 'normal'] || 'low';
  }

  _send(method, path, token, body) {
    if (!token) throw new Error('GuardianClient: missing token for ' + path);
    var headers = { Authorization: 'Bearer ' + token };
    var payload = body != null ? JSON.stringify(body) : null;
    var res = this._fetch(method, this.baseUrl + path, headers, payload);
    var parsed = null;
    if (res.text) {
      try {
        parsed = JSON.parse(res.text);
      } catch (e) {
        parsed = null;
      }
    }
    if (res.code >= 400) throw new GuardianError(res.code, parsed);
    return parsed;
  }

  _run(input, stream) {
    var body = guardianDropNull_({
      project: this.project,
      importance: this._importanceFor(input.importance),
      provider: input.provider,
      model: input.model,
      input: input.input,
      mode: input.mode,
      aiGatewayId: input.aiGatewayId,
      transport: input.transport,
      providerApiKey: input.providerApiKey,
      stream: stream,
    });
    return this._send('POST', '/api/ai-router/run', this._aiToken, body);
  }

  _register(u) {
    var body = guardianDropNull_({
      worker: this.project,
      provider: u.provider,
      model: u.model,
      tokensIn: u.tokensIn,
      tokensOut: u.tokensOut,
      tokensThinking: u.tokensThinking,
      requests: u.requests,
      costUsd: u.costUsd,
      operationId: u.operationId,
      taskDescription: u.taskDescription,
    });
    return this._send('POST', '/api/guardian/usage/register', this._apiKey, body);
  }

  budget() {
    return this._send('GET', '/api/ai/budget', this._apiKey, null);
  }

  projectStatus() {
    return this._send(
      'GET',
      '/api/guardian/projects/' + encodeURIComponent(this.project),
      this._apiKey,
      null
    );
  }

  /**
   * JSON.stringify hook — excludes the two tokens so the common GAS debug
   * idiom (Logger.log(JSON.stringify(g)) / console.log(g)) can't spill secrets
   * into Cloud Logging. Mirrors the TS client's toJSON().
   */
  toJSON() {
    return {
      project: this.project,
      repo: this.repo,
      priority: this.priority,
      budgetUsd: this.budgetUsd,
      baseUrl: this.baseUrl,
    };
  }
}

/**
 * In-editor self-check. Run this function from the Apps Script editor after
 * vendoring the file (it uses an injected fetch stub — no network, no
 * properties needed). Logs "GuardianClient self-check passed" on success.
 */
function guardianClientSelfTest_() {
  var calls = [];
  function stub(code, text) {
    return function (method, url, headers, payload) {
      calls.push({ method: method, url: url, headers: headers, body: payload ? JSON.parse(payload) : null });
      return { code: code, text: text };
    };
  }
  function assert(cond, msg) {
    if (!cond) throw new Error('self-check failed: ' + msg);
  }

  // ai.run routes the AI token and injects project + mapped importance.
  var c = new GuardianClient({
    project: 'my-worker',
    priority: 'important',
    baseUrl: 'https://g.example.com',
    aiToken: 'AI',
    apiKey: 'API',
    fetchImpl: stub(200, '{"request_uuid":"u1"}'),
  });
  var r = c.ai.run({ provider: 'openai', model: 'gpt', input: { messages: [] } });
  assert(r.request_uuid === 'u1', 'run result');
  assert(calls[0].url === 'https://g.example.com/api/ai-router/run', 'run url');
  assert(calls[0].headers.Authorization === 'Bearer AI', 'run auth');
  assert(calls[0].body.project === 'my-worker', 'run project');
  assert(calls[0].body.importance === 'medium', 'important -> medium');

  // unknown/empty priority falls back to low, never undefined.
  calls.length = 0;
  var bad = new GuardianClient({
    project: 'w',
    priority: 'Nope',
    aiToken: 'AI',
    fetchImpl: stub(200, '{}'),
  });
  bad.ai.run({ provider: 'p', model: 'm', input: {} });
  assert(calls[0].body.importance === 'low', 'unknown priority -> low');

  // register routes the API key and maps project -> worker.
  calls.length = 0;
  var c2 = new GuardianClient({ project: 'my-worker', apiKey: 'API', fetchImpl: stub(200, '{"priced":"scraped"}') });
  c2.usage.register({ provider: 'p', model: 'm', tokensIn: 10 });
  assert(calls[0].url.indexOf('/api/guardian/usage/register') !== -1, 'register url');
  assert(calls[0].headers.Authorization === 'Bearer API', 'register auth');
  assert(calls[0].body.worker === 'my-worker', 'register worker');
  assert(calls[0].body.tokensIn === 10, 'register tokensIn');

  // 429 breaker surfaces isCircuitBreaker.
  var broke = new GuardianClient({
    project: 'w',
    aiToken: 'AI',
    fetchImpl: stub(429, '{"isCircuitBreaker":true,"circuitBrokenMessage":"cooling"}'),
  });
  var threw = false;
  try {
    broke.ai.run({ provider: 'p', model: 'm', input: {} });
  } catch (e) {
    threw = true;
    assert(e.status === 429 && e.isCircuitBreaker === true, 'breaker flag');
  }
  assert(threw, 'expected GuardianError');

  // stream is unsupported.
  var streamThrew = false;
  try {
    c.ai.stream({ provider: 'p', model: 'm', input: {} });
  } catch (e) {
    streamThrew = true;
  }
  assert(streamThrew, 'stream should throw');

  // budget() and projectStatus() both route the API key over GET — these are
  // where an accidental swap to the AI token would 401 every deploy.
  calls.length = 0;
  var reader = new GuardianClient({ project: 'my-worker', apiKey: 'API', fetchImpl: stub(200, '{"cap":100}') });
  reader.budget();
  assert(calls[0].url === 'https://core-guardian.hacolby.workers.dev/api/ai/budget', 'budget url');
  assert(calls[0].method === 'GET' && calls[0].headers.Authorization === 'Bearer API', 'budget GET+auth');
  calls.length = 0;
  reader.projectStatus();
  assert(calls[0].url.indexOf('/api/guardian/projects/my-worker') !== -1, 'projectStatus url');
  assert(calls[0].method === 'GET' && calls[0].headers.Authorization === 'Bearer API', 'projectStatus GET+auth');

  // toJSON excludes both tokens.
  var dumped = JSON.stringify(reader);
  assert(dumped.indexOf('API') === -1 && dumped.indexOf('_apiKey') === -1, 'toJSON hides apiKey');
  var withAi = new GuardianClient({ project: 'w', aiToken: 'SECRETAI', apiKey: 'SECRETAPI' });
  var dumped2 = JSON.stringify(withAi);
  assert(dumped2.indexOf('SECRETAI') === -1 && dumped2.indexOf('SECRETAPI') === -1, 'toJSON hides both tokens');

  // fromScriptProperties: happy path + the three failure branches.
  function fakeProps(map) {
    return { getProperty: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; } };
  }
  var fromProps = GuardianClient.fromScriptProperties(
    fakeProps({ GUARDIAN: JSON.stringify({ project: 'p2', baseUrl: 'https://x' }), GUARDIAN_AI_TOKEN: 'AI', GUARDIAN_API_KEY: 'API' })
  );
  assert(fromProps.project === 'p2' && fromProps.baseUrl === 'https://x', 'fromScriptProperties parses config');
  [{}, { GUARDIAN: '{bad json' }, { GUARDIAN: JSON.stringify({ repo: 'x' }) }].forEach(function (bad, i) {
    var threwCfg = false;
    try {
      GuardianClient.fromScriptProperties(fakeProps(bad));
    } catch (e) {
      threwCfg = true;
    }
    assert(threwCfg, 'fromScriptProperties should throw on bad config #' + i);
  });

  assert(GuardianClient.VERSION === '1.0.0', 'version');
  Logger.log('GuardianClient self-check passed');
}
