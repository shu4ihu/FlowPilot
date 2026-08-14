(function attachBackgroundSub2ApiApi(root, factory) {
  root.MultiPageBackgroundSub2ApiApi = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundSub2ApiApiModule() {
  function createSub2ApiApi(deps = {}) {
    const {
      addLog = async () => {},
      normalizeSub2ApiUrl = (value) => value,
      DEFAULT_SUB2API_GROUP_NAME = 'codex',
      fetchImpl = (...args) => fetch(...args),
      setTimeoutImpl = (...args) => setTimeout(...args),
      clearTimeoutImpl = (...args) => clearTimeout(...args),
    } = deps;

    const DEFAULT_REDIRECT_URI = 'http://localhost:1455/auth/callback';
    const DEFAULT_PROXY_NAME = '';
    const DEFAULT_OPENAI_SUB2API_CONCURRENCY = 1;
    const DEFAULT_GROK_SUB2API_CONCURRENCY = 1;
    const DEFAULT_PRIORITY = 1;
    const DEFAULT_RATE_MULTIPLIER = 1;
    const GROK_OAUTH_AUTH_URL_PATH = '/api/v1/admin/grok/oauth/auth-url';
    const GROK_OAUTH_CREATE_PATH = '/api/v1/admin/grok/oauth/create-from-oauth';
    const GROK_OAUTH_CREATE_TIMEOUT_MS = 180000;

    function normalizeString(value = '') {
      return String(value || '').trim();
    }

    function extractStateFromAuthUrl(authUrl = '') {
      try {
        return new URL(authUrl).searchParams.get('state') || '';
      } catch {
        return '';
      }
    }

    function normalizeRedirectUri(input = DEFAULT_REDIRECT_URI) {
      const withProtocol = /^https?:\/\//i.test(input) ? input : `http://${input}`;
      const parsed = new URL(withProtocol);
      if (!parsed.pathname || parsed.pathname === '/') {
        parsed.pathname = '/auth/callback';
      }
      if (parsed.pathname !== '/auth/callback') {
        throw new Error('SUB2API 回调地址必须是 /auth/callback，例如 http://localhost:1455/auth/callback');
      }
      return parsed.toString();
    }

    function getSub2ApiOrigin(rawUrl = '') {
      const sub2apiUrl = normalizeSub2ApiUrl(rawUrl);
      if (!sub2apiUrl) {
        throw new Error('SUB2API URL is not configured. Please fill it in the side panel first.');
      }
      try {
        return new URL(sub2apiUrl).origin;
      } catch {
        throw new Error('SUB2API URL 格式无效，请先在侧边栏检查。');
      }
    }

    function getSub2ApiErrorMessage(payload, responseStatus = 500, path = '') {
      const candidates = [
        payload?.message,
        payload?.detail,
        payload?.error,
        payload?.reason,
      ];
      const message = candidates.map(normalizeString).find(Boolean);
      return message || `SUB2API 请求失败（HTTP ${responseStatus}）：${path}`;
    }

    function redactSensitiveText(value = '', secrets = []) {
      let message = normalizeString(value);
      for (const secret of secrets) {
        const normalizedSecret = normalizeString(secret);
        if (normalizedSecret) {
          message = message.split(normalizedSecret).join('[redacted]');
        }
      }
      return message
        .replace(/Bearer\s+[^\s;,]+/gi, 'Bearer [redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
        .slice(0, 1000);
    }

    function createSub2ApiRequestError(message, metadata = {}) {
      const error = new Error(normalizeString(message) || 'SUB2API 请求失败。');
      if (Number.isFinite(Number(metadata.status))) {
        error.status = Number(metadata.status);
      }
      if (metadata.code) {
        error.code = metadata.code;
      }
      if (metadata.isTimeout) {
        error.isTimeout = true;
      }
      if (metadata.isNetworkError) {
        error.isNetworkError = true;
      }
      if (metadata.name) {
        error.name = metadata.name;
      }
      return error;
    }

    function sanitizeSub2ApiRequestError(error, secrets = []) {
      return createSub2ApiRequestError(
        redactSensitiveText(error?.message || error, secrets),
        {
          status: error?.status,
          code: error?.code,
          isTimeout: error?.isTimeout,
          isNetworkError: error?.isNetworkError,
          name: error?.name,
        }
      );
    }

    async function requestJson(origin, path, options = {}) {
      const controller = new AbortController();
      const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 30000));
      const timer = setTimeoutImpl(() => controller.abort(), timeoutMs);
      const sensitiveValues = Array.isArray(options.sensitiveValues)
        ? options.sensitiveValues
        : [];

      try {
        const token = normalizeString(options.token);
        let response;
        try {
          response = await fetchImpl(`${origin}${path}`, {
            method: options.method || 'GET',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal,
          });
        } catch (error) {
          if (error?.name === 'AbortError') {
            throw createSub2ApiRequestError(`SUB2API 请求超时：${path}`, {
              code: 'SUB2API_TIMEOUT',
              isTimeout: true,
            });
          }
          throw createSub2ApiRequestError(error?.message || `SUB2API 网络请求失败：${path}`, {
            code: error?.code,
            isNetworkError: true,
            name: error?.name,
          });
        }

        const text = await response.text();
        let payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = null;
        }

        if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'code')) {
          if (Number(payload.code) === 0) {
            return payload.data;
          }
          throw createSub2ApiRequestError(
            getSub2ApiErrorMessage(payload, response.status, path),
            { status: response.status }
          );
        }

        if (!response.ok) {
          throw createSub2ApiRequestError(
            getSub2ApiErrorMessage(payload, response.status, path),
            { status: response.status }
          );
        }

        return payload;
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw createSub2ApiRequestError(`SUB2API 请求超时：${path}`, {
            code: 'SUB2API_TIMEOUT',
            isTimeout: true,
          });
        }
        throw sanitizeSub2ApiRequestError(error, sensitiveValues);
      } finally {
        clearTimeoutImpl(timer);
      }
    }

    async function loginSub2Api(state = {}, options = {}) {
      const email = normalizeString(state.sub2apiEmail);
      const password = String(state.sub2apiPassword || '');
      const origin = getSub2ApiOrigin(state.sub2apiUrl);

      if (!email) {
        throw new Error('尚未配置 SUB2API 登录邮箱，请先在侧边栏填写。');
      }
      if (!password) {
        throw new Error('尚未配置 SUB2API 登录密码，请先在侧边栏填写。');
      }

      const loginData = await requestJson(origin, '/api/v1/auth/login', {
        method: 'POST',
        timeoutMs: options.timeoutMs,
        body: { email, password },
      });

      const token = normalizeString(loginData?.access_token || loginData?.accessToken);
      if (!token) {
        throw new Error('SUB2API 登录返回缺少 access_token。');
      }

      return {
        origin,
        token,
        user: loginData?.user || null,
      };
    }

    function normalizeSub2ApiGroupNames(value, options = {}) {
      const source = Array.isArray(value)
        ? value
        : String(value || '').split(/[\r\n,，;；]+/);
      const seen = new Set();
      const names = [];
      for (const item of source) {
        const name = normalizeString(item);
        const key = name.toLowerCase();
        if (!name || seen.has(key)) continue;
        seen.add(key);
        names.push(name);
      }
      return names.length || options.fallbackToDefault === false
        ? names
        : [DEFAULT_SUB2API_GROUP_NAME];
    }

    async function getGroupsByNames(origin, token, groupNames, options = {}) {
      const targetNames = normalizeSub2ApiGroupNames(groupNames);
      const requestedPlatform = normalizeString(options.platform).toLowerCase();
      const targetPlatform = requestedPlatform || 'openai';
      const query = requestedPlatform ? `?platform=${encodeURIComponent(requestedPlatform)}` : '';
      const groups = await requestJson(origin, `/api/v1/admin/groups/all${query}`, {
        method: 'GET',
        token,
        timeoutMs: options.timeoutMs,
      });
      const matched = [];
      const missing = [];

      for (const targetName of targetNames) {
        const normalized = targetName.toLowerCase();
        const group = (Array.isArray(groups) ? groups : []).find((item) => {
          const itemName = normalizeString(item?.name).toLowerCase();
          if (!itemName || itemName !== normalized) return false;
          return !item.platform || normalizeString(item.platform).toLowerCase() === targetPlatform;
        });
        if (group) {
          matched.push(group);
        } else {
          missing.push(targetName);
        }
      }

      if (missing.length) {
        throw new Error(`SUB2API 中未找到以下 ${targetPlatform} 分组：${missing.join('、')}。`);
      }

      return matched;
    }

    function resolveGrokRuntimeState(state = {}) {
      const canonical = state?.runtimeState?.flowState?.grok;
      if (canonical && typeof canonical === 'object' && !Array.isArray(canonical)) {
        return canonical;
      }
      const legacyCanonical = state?.flowState?.grok;
      return legacyCanonical && typeof legacyCanonical === 'object' && !Array.isArray(legacyCanonical)
        ? legacyCanonical
        : {};
    }

    function resolveGrokRegistrationEmail(state = {}) {
      const runtimeState = resolveGrokRuntimeState(state);
      return normalizeString(runtimeState?.register?.email)
        || normalizeString(state.grokEmail)
        || normalizeString(state.email);
    }

    function normalizePositiveIds(values = []) {
      if (!Array.isArray(values)) {
        return [];
      }
      return Array.from(new Set(
        values
          .map((value) => Number(value))
          .filter((value) => Number.isSafeInteger(value) && value > 0)
      ));
    }

    function resolveConfiguredGrokGroupNames(state = {}) {
      return normalizeSub2ApiGroupNames(
        Array.isArray(state.sub2apiGroupNames) && state.sub2apiGroupNames.length
          ? state.sub2apiGroupNames
          : state.sub2apiGroupName,
        { fallbackToDefault: false }
      );
    }

    async function prepareGrokOAuth(state = {}, options = {}) {
      const logLabel = normalizeString(options.logLabel) || 'Grok SUB2API OAuth';
      const accountName = resolveGrokRegistrationEmail(state);
      if (!accountName) {
        throw new Error('缺少本轮 Grok 注册邮箱，无法创建 SUB2API 账号。');
      }
      const configuredGroupNames = resolveConfiguredGrokGroupNames(state);
      if (!configuredGroupNames.length) {
        throw new Error('请先添加 Grok SUB2API 分组。');
      }

      await logWithOptions(`${logLabel}：正在登录 SUB2API 并准备 OAuth 授权...`, 'info', options);
      const { origin, token } = await loginSub2Api(state, options);
      const groups = await getGroupsByNames(origin, token, configuredGroupNames, {
        ...options,
        platform: 'grok',
      });
      const groupIds = normalizePositiveIds(groups.map((group) => group?.id));
      if (!groupIds.length) {
        throw new Error('SUB2API 返回的 Grok 目标分组 ID 无效。');
      }

      const proxyPreference = resolveSub2ApiProxyPreference(state);
      const proxy = proxyPreference
        ? await resolveSub2ApiProxy(origin, token, proxyPreference, options)
        : null;
      const proxyId = normalizeProxyId(proxy?.id);
      const authData = await requestJson(origin, GROK_OAUTH_AUTH_URL_PATH, {
        method: 'POST',
        token,
        timeoutMs: options.timeoutMs,
        body: proxyId ? { proxy_id: proxyId } : {},
      });
      const authUrl = normalizeString(authData?.auth_url || authData?.authUrl);
      const sessionId = normalizeString(authData?.session_id || authData?.sessionId);
      const oauthState = normalizeString(authData?.state);
      if (!authUrl || !sessionId || !oauthState) {
        throw new Error('SUB2API OAuth 授权地址响应缺少 auth_url、session_id 或 state。');
      }
      try {
        const parsed = new URL(authUrl);
        if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.x.ai')) {
          throw new Error('invalid host');
        }
      } catch {
        throw new Error('SUB2API 返回的 Grok OAuth 授权地址无效。');
      }

      return {
        accountName,
        authUrl,
        groupIds,
        origin,
        proxyId,
        sessionId,
        state: oauthState,
        targetUrl: `${origin}${GROK_OAUTH_AUTH_URL_PATH}`,
      };
    }

    async function createGrokAccountFromOAuth(state = {}, oauthContext = {}, code = '', options = {}) {
      const logLabel = normalizeString(options.logLabel) || 'Grok SUB2API OAuth';
      const accountName = resolveGrokRegistrationEmail(state);
      const authorizationCode = normalizeString(code);
      const sessionId = normalizeString(oauthContext?.sessionId || oauthContext?.session_id);
      const oauthState = normalizeString(oauthContext?.state);
      const groupIds = normalizePositiveIds(oauthContext?.groupIds || oauthContext?.group_ids);
      const proxyId = normalizeProxyId(oauthContext?.proxyId ?? oauthContext?.proxy_id);
      const accountPriority = resolveSub2ApiAccountPriority(state);

      if (!accountName) {
        throw new Error('缺少本轮 Grok 注册邮箱，无法创建 SUB2API 账号。');
      }
      if (!authorizationCode) {
        throw new Error('缺少 Grok OAuth 授权码，无法创建 SUB2API 账号。');
      }
      if (!sessionId || !oauthState) {
        throw new Error('缺少 SUB2API OAuth session_id 或 state，请重新获取授权地址。');
      }
      if (!groupIds.length) {
        throw new Error('缺少 SUB2API Grok 目标分组，请重新获取授权地址。');
      }

      const { origin, token } = await loginSub2Api(state, options);
      const payload = {
        session_id: sessionId,
        state: oauthState,
        code: authorizationCode,
        name: accountName,
        ...(proxyId ? { proxy_id: proxyId } : {}),
        group_ids: groupIds,
        concurrency: DEFAULT_GROK_SUB2API_CONCURRENCY,
        priority: accountPriority,
      };
      await logWithOptions(`${logLabel}：正在创建 Grok OAuth 账号...`, 'info', options);
      const account = await requestJson(origin, GROK_OAUTH_CREATE_PATH, {
        method: 'POST',
        token,
        timeoutMs: options.createTimeoutMs || GROK_OAUTH_CREATE_TIMEOUT_MS,
        body: payload,
      });
      if (!account || typeof account !== 'object' || !Number.isSafeInteger(Number(account.id)) || Number(account.id) <= 0) {
        throw new Error('SUB2API OAuth 创建接口未返回有效账号。');
      }

      const verifiedStatus = `SUB2API 已创建 Grok OAuth 账号：${accountName}。`;
      await logWithOptions(verifiedStatus, 'ok', options);
      return {
        account,
        targetUrl: `${origin}${GROK_OAUTH_CREATE_PATH}`,
        verifiedStatus,
      };
    }

    function normalizeSub2ApiProxyPreference(value) {
      return normalizeString(value);
    }

    function resolveSub2ApiProxyPreference(state = {}) {
      if (state.sub2apiDefaultProxyName !== undefined) {
        return normalizeSub2ApiProxyPreference(state.sub2apiDefaultProxyName);
      }
      return DEFAULT_PROXY_NAME;
    }

    function resolveSub2ApiAccountPriority(state = {}) {
      const rawValue = normalizeString(state.sub2apiAccountPriority);
      if (!rawValue) {
        return DEFAULT_PRIORITY;
      }
      const numeric = Number(rawValue);
      if (!Number.isSafeInteger(numeric) || numeric < 1) {
        throw new Error('SUB2API 账号优先级必须是大于等于 1 的整数。');
      }
      return numeric;
    }

    function normalizeProxyId(value) {
      if (value === undefined || value === null || value === '') {
        return null;
      }
      const normalized = Number(value);
      if (!Number.isSafeInteger(normalized) || normalized <= 0) {
        return null;
      }
      return normalized;
    }

    function buildProxyDisplayName(proxy = {}) {
      const id = normalizeProxyId(proxy.id);
      const name = normalizeString(proxy.name);
      const protocol = normalizeString(proxy.protocol);
      const host = normalizeString(proxy.host);
      const port = proxy.port === undefined || proxy.port === null ? '' : normalizeString(proxy.port);
      const address = protocol && host && port ? `${protocol}://${host}:${port}` : '';
      return [
        name || '(未命名代理)',
        id ? `#${id}` : '',
        address,
      ].filter(Boolean).join(' ');
    }

    function buildProxySearchText(proxy = {}) {
      return [
        proxy.id,
        proxy.name,
        proxy.protocol,
        proxy.host,
        proxy.port,
        buildProxyDisplayName(proxy),
      ]
        .filter((value) => value !== undefined && value !== null && value !== '')
        .map((value) => normalizeString(value).toLowerCase())
        .filter(Boolean)
        .join(' ');
    }

    function isActiveProxy(proxy = {}) {
      const status = normalizeString(proxy.status).toLowerCase();
      return !status || status === 'active';
    }

    function findSub2ApiProxy(proxies = [], preference = '') {
      const activeProxies = (Array.isArray(proxies) ? proxies : [])
        .filter(isActiveProxy)
        .filter((proxy) => normalizeProxyId(proxy.id));
      const normalizedPreference = normalizeSub2ApiProxyPreference(preference).toLowerCase();
      const preferredId = normalizeProxyId(normalizedPreference);

      if (preferredId) {
        const matchedById = activeProxies.find((proxy) => normalizeProxyId(proxy.id) === preferredId);
        return {
          proxy: matchedById || null,
          reason: matchedById ? 'id' : 'missing-id',
          candidates: activeProxies,
        };
      }

      if (normalizedPreference) {
        const exactMatches = activeProxies.filter((proxy) => normalizeString(proxy.name).toLowerCase() === normalizedPreference);
        if (exactMatches.length === 1) {
          return { proxy: exactMatches[0], reason: 'name', candidates: activeProxies };
        }
        if (exactMatches.length > 1) {
          return { proxy: null, reason: 'ambiguous-name', candidates: exactMatches };
        }

        const fuzzyMatches = activeProxies.filter((proxy) => buildProxySearchText(proxy).includes(normalizedPreference));
        if (fuzzyMatches.length === 1) {
          return { proxy: fuzzyMatches[0], reason: 'fuzzy', candidates: activeProxies };
        }
        if (fuzzyMatches.length > 1) {
          return { proxy: null, reason: 'ambiguous-fuzzy', candidates: fuzzyMatches };
        }

        return { proxy: null, reason: 'missing-name', candidates: activeProxies };
      }

      if (activeProxies.length === 1) {
        return { proxy: activeProxies[0], reason: 'single-active', candidates: activeProxies };
      }
      return {
        proxy: null,
        reason: activeProxies.length ? 'no-preference' : 'none-active',
        candidates: activeProxies,
      };
    }

    async function resolveSub2ApiProxy(origin, token, preference = '', options = {}) {
      const proxies = await requestJson(origin, '/api/v1/admin/proxies/all?with_count=true', {
        method: 'GET',
        token,
        timeoutMs: options.timeoutMs,
      });
      if (!Array.isArray(proxies)) {
        throw new Error('SUB2API 代理列表返回格式异常，无法自动选择代理。');
      }

      const { proxy, reason, candidates } = findSub2ApiProxy(proxies, preference);
      if (proxy) {
        return proxy;
      }

      const configured = normalizeSub2ApiProxyPreference(preference) || '(未配置)';
      const available = (candidates || [])
        .slice(0, 8)
        .map(buildProxyDisplayName)
        .join('；') || '无可用代理';
      if (reason === 'ambiguous-name' || reason === 'ambiguous-fuzzy') {
        throw new Error(`SUB2API 默认代理“${configured}”匹配到多个代理，请改填代理 ID。候选：${available}`);
      }
      if (reason === 'missing-id') {
        throw new Error(`SUB2API 默认代理 ID “${configured}”不存在或未启用。可用代理：${available}`);
      }
      if (reason === 'missing-name') {
        throw new Error(`SUB2API 默认代理“${configured}”不存在或未启用。可用代理：${available}`);
      }
      if (reason === 'no-preference') {
        throw new Error(`SUB2API 存在多个可用代理，请在侧边栏填写默认代理名称或 ID；留空则不使用代理。可用代理：${available}`);
      }
      throw new Error('SUB2API 没有可用代理；请检查默认代理配置，或将其留空以禁用代理。');
    }

    function buildDraftAccountName(groupName) {
      const prefix = normalizeString(groupName || DEFAULT_SUB2API_GROUP_NAME)
        .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
        .replace(/^-+|-+$/g, '') || DEFAULT_SUB2API_GROUP_NAME;
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
      const random = Math.floor(Math.random() * 9000 + 1000);
      return `${prefix}-${stamp}-${random}`;
    }

    function normalizeCodexSessionObject(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }

    function normalizeEmailValue(value = '') {
      const email = normalizeString(value);
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
    }

    function decodeCodexBase64UrlSegment(segment = '') {
      const normalized = normalizeString(segment)
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      if (!normalized) {
        return '';
      }
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      try {
        if (typeof Buffer !== 'undefined') {
          return Buffer.from(padded, 'base64').toString('utf8');
        }
        if (typeof atob === 'function') {
          const binary = atob(padded);
          const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder().decode(bytes);
          }
          return binary;
        }
      } catch {
        return '';
      }
      return '';
    }

    function parseCodexAccessTokenClaims(accessToken = '') {
      const token = normalizeString(accessToken);
      if (!token) {
        return null;
      }
      const parts = token.split('.');
      if (parts.length !== 3) {
        return null;
      }
      try {
        return JSON.parse(decodeCodexBase64UrlSegment(parts[1]));
      } catch {
        return null;
      }
    }

    function resolveCodexSessionImportAccountName(state = {}, session = null, accessToken = '') {
      const sessionObject = normalizeCodexSessionObject(session);
      const claims = parseCodexAccessTokenClaims(accessToken || sessionObject?.accessToken);
      const accountIdentifierType = normalizeString(state?.accountIdentifierType).toLowerCase();
      const accountIdentifierEmail = accountIdentifierType === 'email'
        ? normalizeEmailValue(state?.accountIdentifier)
        : '';

      return normalizeEmailValue(sessionObject?.user?.email)
        || normalizeEmailValue(sessionObject?.email)
        || normalizeEmailValue(claims?.email)
        || normalizeEmailValue(state?.email)
        || accountIdentifierEmail;
    }

    function buildCodexSessionImportContent(session, accessToken = '') {
      const normalizedAccessToken = normalizeString(accessToken);
      const sessionObject = normalizeCodexSessionObject(session);

      if (sessionObject) {
        const contentObject = normalizedAccessToken
          ? {
            ...sessionObject,
            accessToken: normalizedAccessToken,
          }
          : sessionObject;
        return JSON.stringify(contentObject);
      }

      if (normalizedAccessToken) {
        return normalizedAccessToken;
      }

      throw new Error('未读取到可导入的 ChatGPT 会话或 accessToken。');
    }

    function serializeCodexAuth(authJson) {
      if (typeof authJson === 'string') {
        const content = normalizeString(authJson);
        if (content) {
          return content;
        }
      } else if (authJson && typeof authJson === 'object' && !Array.isArray(authJson)) {
        return JSON.stringify(authJson);
      }
      throw new Error('SUB2API 导入内容格式无效。');
    }

    function collectCodexAuthSecrets(authJson, serializedContent = '') {
      const secrets = new Set();
      const addSecret = (value) => {
        const normalized = normalizeString(value);
        if (normalized) {
          secrets.add(normalized);
        }
      };
      const visited = new Set();
      const visit = (value) => {
        if (!value || typeof value !== 'object' || visited.has(value)) {
          return;
        }
        visited.add(value);
        for (const [key, child] of Object.entries(value)) {
          if (typeof child === 'string' && /(token|private[_-]?key|authorization)/i.test(key)) {
            addSecret(child);
          } else if (child && typeof child === 'object') {
            visit(child);
          }
        }
      };

      if (typeof authJson === 'string') {
        addSecret(authJson);
        try {
          visit(JSON.parse(authJson));
        } catch (_error) {
          // Raw access tokens are valid codex-session import content.
        }
      } else if (authJson && typeof authJson === 'object') {
        visit(authJson);
      }

      if (normalizeString(serializedContent).length >= 20) {
        addSecret(serializedContent);
      }
      return Array.from(secrets);
    }

    function resolveCodexSessionImportExpiresAt(session) {
      const sessionObject = normalizeCodexSessionObject(session);
      const expiresValue = normalizeString(sessionObject?.expires);
      if (!expiresValue) {
        return null;
      }
      const expiresAtMs = Date.parse(expiresValue);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
        return null;
      }
      return Math.floor(expiresAtMs / 1000);
    }

    function normalizeCodexSessionImportMessages(messages, sensitiveValues = []) {
      return (Array.isArray(messages) ? messages : [])
        .map((item, index) => ({
          index: Number(item?.index) || index + 1,
          name: redactSensitiveText(item?.name, sensitiveValues),
          message: redactSensitiveText(item?.message, sensitiveValues),
        }))
        .filter((item) => item.message);
    }

    function normalizeCodexSessionImportResult(result, sensitiveValues = []) {
      return {
        total: Math.max(0, Number(result?.total) || 0),
        created: Math.max(0, Number(result?.created) || 0),
        updated: Math.max(0, Number(result?.updated) || 0),
        skipped: Math.max(0, Number(result?.skipped) || 0),
        failed: Math.max(0, Number(result?.failed) || 0),
        items: (Array.isArray(result?.items) ? result.items : []).map((item) => ({
          ...item,
          ...(item?.name !== undefined
            ? { name: redactSensitiveText(item.name, sensitiveValues) }
            : {}),
          ...(item?.message !== undefined
            ? { message: redactSensitiveText(item.message, sensitiveValues) }
            : {}),
        })),
        warnings: normalizeCodexSessionImportMessages(result?.warnings, sensitiveValues),
        errors: normalizeCodexSessionImportMessages(result?.errors, sensitiveValues),
      };
    }

    function buildCodexSessionImportSummary(result, resultLabel = 'SUB2API 会话导入完成') {
      const normalized = normalizeCodexSessionImportResult(result);
      const label = normalizeString(resultLabel) || 'SUB2API 会话导入完成';
      return `${label}：新建 ${normalized.created}，更新 ${normalized.updated}，跳过 ${normalized.skipped}，失败 ${normalized.failed}`;
    }

    function getCodexSessionImportFailureMessage(result) {
      const normalized = normalizeCodexSessionImportResult(result);
      const detail = normalized.errors.map((item) => item.message).find(Boolean)
        || normalized.warnings.map((item) => item.message).find(Boolean)
        || normalized.items
          .map((item) => normalizeString(item?.message))
          .find(Boolean)
        || buildCodexSessionImportSummary(normalized);
      return detail || 'SUB2API 会话导入失败。';
    }

    function parseLocalhostCallback(rawUrl, visibleStep = 10) {
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch {
        throw new Error(`步骤 ${visibleStep} 捕获到的 localhost OAuth 回调地址格式无效。`);
      }

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('回调 URL 协议不正确。');
      }
      if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
        throw new Error(`步骤 ${visibleStep} 只接受 localhost / 127.0.0.1 回调地址。`);
      }
      if (parsed.pathname !== '/auth/callback') {
        throw new Error('回调 URL 路径必须是 /auth/callback。');
      }

      const code = normalizeString(parsed.searchParams.get('code'));
      const oauthState = normalizeString(parsed.searchParams.get('state'));
      if (!code || !oauthState) {
        throw new Error('回调 URL 中缺少 code 或 state。');
      }

      return {
        url: parsed.toString(),
        code,
        state: oauthState,
      };
    }

    function buildOpenAiCredentials(exchangeData) {
      const credentials = {};
      const allowedKeys = [
        'access_token',
        'refresh_token',
        'id_token',
        'expires_at',
        'email',
        'chatgpt_account_id',
        'chatgpt_user_id',
        'organization_id',
        'plan_type',
        'client_id',
      ];

      for (const key of allowedKeys) {
        if (exchangeData?.[key] !== undefined && exchangeData?.[key] !== null && exchangeData?.[key] !== '') {
          credentials[key] = exchangeData[key];
        }
      }

      if (!credentials.access_token) {
        throw new Error('SUB2API 交换授权码后未返回 access_token。');
      }

      return credentials;
    }

    function buildOpenAiExtra(exchangeData) {
      const extra = {};
      const allowedKeys = ['email', 'name', 'privacy_mode'];

      for (const key of allowedKeys) {
        if (exchangeData?.[key] !== undefined && exchangeData?.[key] !== null && exchangeData?.[key] !== '') {
          extra[key] = exchangeData[key];
        }
      }

      return Object.keys(extra).length ? extra : undefined;
    }

    async function logWithOptions(message, level = 'info', options = {}) {
      await addLog(message, level, options.logOptions || {});
    }

    async function generateOpenAiAuthUrl(state = {}, options = {}) {
      const logLabel = normalizeString(options.logLabel) || 'OAuth 刷新';
      const redirectUri = normalizeRedirectUri(options.redirectUri || DEFAULT_REDIRECT_URI);
      const groupNames = normalizeSub2ApiGroupNames(state.sub2apiGroupName || DEFAULT_SUB2API_GROUP_NAME);
      const groupName = groupNames[0] || DEFAULT_SUB2API_GROUP_NAME;

      await logWithOptions(`${logLabel}：正在通过 SUB2API 管理接口登录并生成 OpenAI Auth 链接...`, 'info', options);
      const { origin, token } = await loginSub2Api(state, options);
      const groups = await getGroupsByNames(origin, token, groupNames, options);
      const group = groups[0];
      const proxyPreference = resolveSub2ApiProxyPreference(state);
      const proxy = proxyPreference ? await resolveSub2ApiProxy(origin, token, proxyPreference, options) : null;
      const proxyId = normalizeProxyId(proxy?.id);
      const draftName = buildDraftAccountName(group.name || groupName);
      const groupLabel = groups.map((item) => `${item.name}（#${item.id}）`).join('、');

      await logWithOptions(`${logLabel}：已登录 SUB2API，使用分组 ${groupLabel}。`, 'info', options);
      if (proxy) {
        await logWithOptions(`${logLabel}：已选择 SUB2API 默认代理 ${buildProxyDisplayName(proxy)}。`, 'info', options);
      } else {
        await logWithOptions(`${logLabel}：未配置 SUB2API 默认代理，本次将不使用代理。`, 'info', options);
      }

      const authRequestBody = { redirect_uri: redirectUri };
      if (proxyId) {
        authRequestBody.proxy_id = proxyId;
      }

      const authData = await requestJson(origin, '/api/v1/admin/openai/generate-auth-url', {
        method: 'POST',
        token,
        timeoutMs: options.timeoutMs,
        body: authRequestBody,
      });

      const oauthUrl = normalizeString(authData?.auth_url || authData?.authUrl);
      const sessionId = normalizeString(authData?.session_id || authData?.sessionId);
      const oauthState = normalizeString(authData?.state || extractStateFromAuthUrl(oauthUrl));

      if (!oauthUrl || !sessionId) {
        throw new Error('SUB2API 未返回完整的 auth_url / session_id。');
      }

      await logWithOptions(`${logLabel}：已获取 SUB2API OAuth 链接：${oauthUrl.slice(0, 96)}...`, 'ok', options);
      return {
        oauthUrl,
        sub2apiSessionId: sessionId,
        sub2apiOAuthState: oauthState,
        sub2apiGroupId: group.id,
        sub2apiGroupIds: groups.map((item) => item.id),
        sub2apiDraftName: draftName,
        sub2apiProxyId: proxyId,
      };
    }

    async function prepareReauthAccount(state = {}, options = {}) {
      const groupNames = normalizeSub2ApiGroupNames(state.sub2apiGroupName || DEFAULT_SUB2API_GROUP_NAME);
      const { origin, token } = await loginSub2Api(state, options);
      const groups = await getGroupsByNames(origin, token, groupNames, options);
      const groupId = Number(groups[0]?.id);
      if (!Number.isSafeInteger(groupId) || groupId <= 0) {
        throw new Error('SUB2API 目标分组 ID 无效。');
      }

      const reauthAccountLimit = Math.min(1000, Math.max(1, Math.floor(Number(state.autoRunTotalRuns) || 1)));
      const query = new URLSearchParams({
        page: '1',
        page_size: String(reauthAccountLimit),
        platform: 'openai',
        type: 'oauth',
        status: 'error',
        group: String(groupId),
        sort_by: 'last_used_at',
        sort_order: 'desc',
        timezone: 'Asia/Shanghai',
      });
      const result = await requestJson(origin, `/api/v1/admin/accounts?${query.toString()}`, {
        method: 'GET',
        token,
        timeoutMs: options.timeoutMs,
      });
      const accounts = Array.isArray(result?.items) ? result.items : (Array.isArray(result) ? result : []);
      const excludedAccountIds = new Set(
        (Array.isArray(state.reauthExcludedAccountIds) ? state.reauthExcludedAccountIds : [])
          .map((id) => Number(id))
          .filter((id) => Number.isSafeInteger(id) && id > 0)
      );
      const account = accounts.find((item) => {
        const id = Number(item?.id);
        return Number.isSafeInteger(id) && id > 0 && !excludedAccountIds.has(id);
      });
      const accountId = Number(account?.id);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) {
        throw new Error(`分组“${groupNames[0]}”下没有可重新授权的 error 状态 OpenAI 账号。`);
      }

      const proxyId = normalizeProxyId(account?.proxy_id);
      const authBody = { redirect_uri: normalizeRedirectUri(options.redirectUri || DEFAULT_REDIRECT_URI) };
      if (proxyId) authBody.proxy_id = proxyId;
      let authData;
      try {
        authData = await requestJson(origin, '/api/v1/admin/openai/generate-auth-url', {
          method: 'POST',
          token,
          timeoutMs: options.timeoutMs,
          body: authBody,
        });
      } catch (error) {
        error.reauthAccountId = accountId;
        error.reauthAccountName = normalizeString(account?.name);
        throw error;
      }
      const oauthUrl = normalizeString(authData?.auth_url || authData?.authUrl);
      const sessionId = normalizeString(authData?.session_id || authData?.sessionId);
      const oauthState = normalizeString(authData?.state || extractStateFromAuthUrl(oauthUrl));
      if (!oauthUrl || !sessionId) {
        const error = new Error('SUB2API 未返回完整的 reauth auth_url / session_id。');
        error.reauthAccountId = accountId;
        error.reauthAccountName = normalizeString(account?.name);
        throw error;
      }
      const reauthAccountName = normalizeString(account?.name);
      const reauthAccountEmail = normalizeString(
        account?.extra?.email
        || account?.credentials?.email
        || account?.email
      );
      if (!reauthAccountEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reauthAccountEmail)) {
        const error = new Error(`账号 #${accountId}${reauthAccountName ? `（${reauthAccountName}）` : ''} 缺少有效 email，无法进行 OAuth 登录。`);
        error.reauthAccountId = accountId;
        error.reauthAccountName = reauthAccountName;
        throw error;
      }
      await logWithOptions(`${options.logLabel || 'Reauth'}：已定位账号 #${accountId}（${reauthAccountEmail}），正在打开重新授权链接...`, 'ok', options);
      return {
        oauthUrl,
        sub2apiSessionId: sessionId,
        sub2apiOAuthState: oauthState,
        reauthAccountId: accountId,
        reauthAccountName,
        reauthAccountEmail,
        sub2apiProxyId: proxyId,
      };
    }

    async function submitReauthCallback(state = {}, options = {}) {
      const callback = parseLocalhostCallback(state.localhostUrl || '', options.visibleStep || 6);
      const accountId = Number(state.reauthAccountId);
      const sessionId = normalizeString(state.sub2apiSessionId);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('缺少待重新授权账号 ID，请重新执行第 1 步。');
      if (!sessionId) throw new Error('缺少 SUB2API session_id，请重新执行第 1 步。');
      if (state.sub2apiOAuthState && state.sub2apiOAuthState !== callback.state) throw new Error('OAuth 回调 state 与当前 reauth 会话不一致，请重新执行第 1 步。');
      const { origin, token } = await loginSub2Api(state, options);
      const exchangeData = await requestJson(origin, '/api/v1/admin/openai/exchange-code', {
        method: 'POST', token, timeoutMs: options.timeoutMs,
        body: { session_id: sessionId, code: callback.code, state: callback.state },
      });
      const credentials = buildOpenAiCredentials(exchangeData);
      const extra = buildOpenAiExtra(exchangeData);
      const updatedAccount = await requestJson(origin, `/api/v1/admin/accounts/${accountId}/apply-oauth-credentials`, {
        method: 'POST', token, timeoutMs: options.timeoutMs,
        body: { type: 'oauth', credentials, ...(extra ? { extra } : {}) },
      });
      const verifiedStatus = `SUB2API 已完成账号 #${accountId} 重新授权`;
      await logWithOptions(verifiedStatus, 'ok', options);
      return { localhostUrl: callback.url, reauthAccount: updatedAccount, verifiedStatus };
    }

    async function submitOpenAiCallback(state = {}, options = {}) {
      const visibleStep = Number(options.visibleStep || state.visibleStep) || 10;
      const callback = parseLocalhostCallback(state.localhostUrl || '', visibleStep);
      const flowEmail = normalizeString(state.email);
      const sessionId = normalizeString(state.sub2apiSessionId);
      const expectedState = normalizeString(state.sub2apiOAuthState);
      const logLabel = normalizeString(options.logLabel) || `步骤 ${visibleStep}`;

      if (!sessionId) {
        throw new Error('缺少 SUB2API session_id，请重新执行步骤 1。');
      }
      if (expectedState && expectedState !== callback.state) {
        throw new Error('本次 localhost 回调中的 state 与步骤 1 生成的 state 不一致，请重新执行步骤 1。');
      }

      const { origin, token } = await loginSub2Api(state, options);
      const proxyPreference = resolveSub2ApiProxyPreference(state);
      const preferredProxyId = normalizeProxyId(state.sub2apiProxyId);
      const proxySelector = preferredProxyId || proxyPreference;
      const proxy = proxySelector ? await resolveSub2ApiProxy(origin, token, proxySelector, options) : null;
      const proxyId = normalizeProxyId(proxy?.id);
      const accountPriority = resolveSub2ApiAccountPriority(state);
      const storedGroupIds = Array.isArray(state.sub2apiGroupIds) ? state.sub2apiGroupIds : [];
      const groupIdsFromState = storedGroupIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0);
      const groups = groupIdsFromState.length
        ? groupIdsFromState.map((id) => ({ id }))
        : (state.sub2apiGroupId
          ? [{ id: state.sub2apiGroupId, name: state.sub2apiGroupName || DEFAULT_SUB2API_GROUP_NAME }]
          : await getGroupsByNames(origin, token, state.sub2apiGroupName || DEFAULT_SUB2API_GROUP_NAME, options));

      await logWithOptions(`${logLabel}：正在通过 SUB2API 管理接口交换 OpenAI 授权码...`, 'info', options);
      if (proxy) {
        await logWithOptions(`${logLabel}：使用 SUB2API 默认代理 ${buildProxyDisplayName(proxy)}。`, 'info', options);
      } else {
        await logWithOptions(`${logLabel}：未配置 SUB2API 默认代理，本次将不使用代理。`, 'info', options);
      }

      const exchangeRequestBody = {
        session_id: sessionId,
        code: callback.code,
        state: callback.state,
      };
      if (proxyId) {
        exchangeRequestBody.proxy_id = proxyId;
      }

      const exchangeData = await requestJson(origin, '/api/v1/admin/openai/exchange-code', {
        method: 'POST',
        token,
        timeoutMs: options.timeoutMs,
        body: exchangeRequestBody,
      });

      const credentials = buildOpenAiCredentials(exchangeData);
      const extra = buildOpenAiExtra(exchangeData);
      const resolvedEmail = normalizeString(exchangeData?.email || credentials?.email);
      const groupIds = groups
        .map((group) => Number(group.id))
        .filter((id) => Number.isFinite(id) && id > 0);
      if (!groupIds.length) {
        throw new Error('SUB2API 返回的目标分组 ID 无效。');
      }

      const accountName = resolvedEmail
        || flowEmail
        || normalizeString(state.sub2apiDraftName)
        || buildDraftAccountName(state.sub2apiGroupName || DEFAULT_SUB2API_GROUP_NAME);
      const createPayload = {
        name: accountName,
        notes: '',
        platform: 'openai',
        type: 'oauth',
        credentials,
        concurrency: DEFAULT_OPENAI_SUB2API_CONCURRENCY,
        priority: accountPriority,
        rate_multiplier: DEFAULT_RATE_MULTIPLIER,
        group_ids: groupIds,
        auto_pause_on_expired: true,
      };
      if (proxyId) {
        createPayload.proxy_id = proxyId;
      }
      if (extra) {
        createPayload.extra = extra;
      }

      await logWithOptions(`${logLabel}：授权码交换成功，正在创建 SUB2API 账号（名称：${accountName}）...`, 'info', options);
      const createdAccount = await requestJson(origin, '/api/v1/admin/accounts', {
        method: 'POST',
        token,
        timeoutMs: options.createTimeoutMs,
        body: createPayload,
      });

      const verifiedStatus = `SUB2API 已创建账号 #${createdAccount?.id || 'unknown'}`;
      await logWithOptions(verifiedStatus, 'ok', options);
      return {
        localhostUrl: callback.url,
        verifiedStatus,
      };
    }

    async function prepareCodexSessionImport(state = {}, options = {}) {
      const logLabel = normalizeString(options.logLabel) || 'SUB2API 会话导入';
      await logWithOptions(`${logLabel}：正在通过 SUB2API 管理接口登录并准备 Codex 凭据导入...`, 'info', options);
      const { origin, token } = await loginSub2Api(state, options);
      const groupNames = state.sub2apiGroupName || DEFAULT_SUB2API_GROUP_NAME;
      const groups = await getGroupsByNames(origin, token, groupNames, options);
      const groupLabel = groups.map((item) => `${item.name}（${item.id}）`).join('、');
      const proxyPreference = resolveSub2ApiProxyPreference(state);
      const proxy = proxyPreference ? await resolveSub2ApiProxy(origin, token, proxyPreference, options) : null;
      const proxyId = normalizeProxyId(proxy?.id);
      const accountPriority = resolveSub2ApiAccountPriority(state);
      const groupIds = groups
        .map((group) => Number(group?.id))
        .filter((id) => Number.isFinite(id) && id > 0);
      if (!groupIds.length) {
        throw new Error('SUB2API 返回的目标分组 ID 无效。');
      }

      await logWithOptions(`${logLabel}：已登录 SUB2API，使用分组 ${groupLabel}。`, 'info', options);
      if (proxy) {
        await logWithOptions(`${logLabel}：已选择 SUB2API 默认代理 ${buildProxyDisplayName(proxy)}。`, 'info', options);
      } else {
        await logWithOptions(`${logLabel}：未配置 SUB2API 默认代理，本次将不使用代理。`, 'info', options);
      }

      return {
        origin,
        token,
        groupIds,
        proxyId,
        accountPriority,
      };
    }

    function buildCodexSessionImportPayload(prepared = {}, input = {}) {
      const authContent = serializeCodexAuth(input.authJson);
      const groupIds = (Array.isArray(prepared.groupIds) ? prepared.groupIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0);
      if (!groupIds.length) {
        throw new Error('SUB2API 返回的目标分组 ID 无效。');
      }

      const accountPriority = Number(prepared.accountPriority);
      if (!Number.isSafeInteger(accountPriority) || accountPriority < 1) {
        throw new Error('SUB2API 账号优先级必须是大于等于 1 的整数。');
      }

      const accountName = normalizeString(input.accountName);
      const proxyId = normalizeProxyId(prepared.proxyId);
      const expiresAt = Number(input.expiresAt);
      return {
        payload: {
          content: authContent,
          group_ids: groupIds,
          ...(accountName ? { name: accountName } : {}),
          concurrency: DEFAULT_OPENAI_SUB2API_CONCURRENCY,
          priority: accountPriority,
          auto_pause_on_expired: true,
          update_existing: true,
          ...(proxyId ? { proxy_id: proxyId } : {}),
          ...(Number.isFinite(expiresAt) && expiresAt > 0
            ? { expires_at: Math.floor(expiresAt) }
            : {}),
        },
        sensitiveValues: collectCodexAuthSecrets(input.authJson, authContent),
      };
    }

    async function importPreparedCodexAuth(prepared = {}, input = {}, options = {}) {
      const origin = normalizeString(prepared.origin);
      const token = normalizeString(prepared.token);
      if (!origin || !token) {
        throw new Error('SUB2API Codex 导入预检结果无效，请重新执行当前步骤。');
      }

      const logLabel = normalizeString(options.logLabel) || 'SUB2API 会话导入';
      const resultLabel = normalizeString(options.resultLabel) || 'SUB2API 会话导入完成';
      const { payload, sensitiveValues } = buildCodexSessionImportPayload(prepared, input);
      const requestSensitiveValues = [token, ...sensitiveValues];

      await logWithOptions(`${logLabel}：正在向 SUB2API 导入 Codex 凭据...`, 'info', options);
      const importResult = normalizeCodexSessionImportResult(await requestJson(
        origin,
        '/api/v1/admin/accounts/import/codex-session',
        {
          method: 'POST',
          token,
          timeoutMs: options.importTimeoutMs || options.timeoutMs,
          body: payload,
          sensitiveValues: requestSensitiveValues,
        }
      ), requestSensitiveValues);

      for (const warning of importResult.warnings) {
        await logWithOptions(`${logLabel}：${warning.message}`, 'warn', options);
      }

      if (importResult.failed > 0) {
        throw new Error(getCodexSessionImportFailureMessage(importResult));
      }
      if (importResult.created <= 0 && importResult.updated <= 0) {
        throw new Error(getCodexSessionImportFailureMessage(importResult));
      }

      const verifiedStatus = buildCodexSessionImportSummary(importResult, resultLabel);
      await logWithOptions(verifiedStatus, 'ok', options);
      return {
        verifiedStatus,
        sub2apiImportTotal: importResult.total,
        sub2apiImportCreated: importResult.created,
        sub2apiImportUpdated: importResult.updated,
        sub2apiImportSkipped: importResult.skipped,
        sub2apiImportFailed: importResult.failed,
      };
    }

    async function importCurrentChatGptSession(state = {}, options = {}) {
      const session = normalizeCodexSessionObject(state?.session);
      const accessToken = normalizeString(
        state?.accessToken
        || session?.accessToken
      );
      const authJson = buildCodexSessionImportContent(session, accessToken);
      const accountName = resolveCodexSessionImportAccountName(state, session, accessToken);
      const expiresAt = resolveCodexSessionImportExpiresAt(session);
      const prepared = await prepareCodexSessionImport(state, options);
      return importPreparedCodexAuth(prepared, {
        authJson,
        accountName,
        expiresAt,
      }, options);
    }

    return {
      buildDraftAccountName,
      buildCodexSessionImportContent,
      buildOpenAiCredentials,
      buildOpenAiExtra,
      buildProxyDisplayName,
      extractStateFromAuthUrl,
      generateOpenAiAuthUrl,
      getGroupsByNames,
      prepareReauthAccount,
      submitReauthCallback,
      prepareGrokOAuth,
      prepareCodexSessionImport,
      createGrokAccountFromOAuth,
      importPreparedCodexAuth,
      importCurrentChatGptSession,
      loginSub2Api,
      normalizeProxyId,
      normalizeRedirectUri,
      normalizeSub2ApiGroupNames,
      parseLocalhostCallback,
      requestJson,
      resolveSub2ApiAccountPriority,
      resolveSub2ApiProxy,
      resolveGrokRegistrationEmail,
      submitOpenAiCallback,
    };
  }

  return {
    createSub2ApiApi,
  };
});
