(function attachMultiPageReauthWorkflow(root, factory) {
  root.MultiPageReauthWorkflow = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createMultiPageReauthWorkflow() {
  const STEPS = Object.freeze([
    {
      id: 1,
      order: 10,
      key: 'reauth-prepare-account',
      title: '获取待重新授权账号',
      sourceId: 'sub2api-panel',
      driverId: 'flows/openai/background/steps/reauth-prepare-account',
      command: 'reauth-prepare-account',
      flowId: 'reauth',
    },
    {
      id: 2,
      order: 20,
      key: 'oauth-login',
      title: '重新登录 OAuth',
      sourceId: 'openai-auth',
      driverId: 'flows/openai/content/openai-auth',
      command: 'oauth-login',
      flowId: 'reauth',
    },
    {
      id: 3,
      order: 30,
      key: 'fetch-login-code',
      title: '获取登录验证码',
      sourceId: 'openai-auth',
      driverId: 'flows/openai/content/openai-auth',
      command: 'submit-verification-code',
      mailRuleId: 'openai-login-code',
      flowId: 'reauth',
    },
    {
      id: 4,
      order: 40,
      key: 'confirm-oauth',
      title: '自动确认 OAuth',
      sourceId: 'openai-auth',
      driverId: 'flows/openai/content/openai-auth',
      command: 'confirm-oauth',
      flowId: 'reauth',
    },
    {
      id: 5,
      order: 50,
      key: 'platform-verify',
      title: 'SUB2API 回调验证',
      sourceId: 'platform-panel',
      driverId: 'content/platform-panel',
      command: 'platform-verify',
      flowId: 'reauth',
    },
  ].map((step) => Object.freeze(step)));

  function getSteps() {
    return STEPS;
  }

  return {
    flowId: 'reauth',
    getAllSteps: getSteps,
    getModeStepDefinitions: getSteps,
    getPlusPaymentStepTitle: () => '',
    resolveStepTitle: (step = {}) => step.title || '',
  };
});
