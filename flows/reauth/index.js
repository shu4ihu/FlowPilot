(function attachMultiPageReauthFlowDefinition(root, factory) {
  root.MultiPageReauthFlowDefinition = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createMultiPageReauthFlowDefinition() {
  return Object.freeze({
    id: 'reauth',
    label: 'Reauth',
    services: ['account', 'email', 'proxy'],
    capabilities: {
      supportsEmailSignup: true,
      supportsPhoneSignup: false,
      supportsPhoneVerificationSettings: false,
      supportsPlusMode: false,
      supportsContributionMode: false,
      supportsAccountContribution: false,
      supportedTargetIds: ['sub2api'],
      supportsLuckmail: false,
      canSwitchFlow: true,
      stepDefinitionMode: 'default',
      targetSelectorLabel: '来源',
    },
    baseGroups: ['reauth-oauth', 'shared-auto-run'],
    defaultTargetId: 'sub2api',
    targets: {
      sub2api: {
        id: 'sub2api',
        label: 'SUB2API',
        defaultState: {
          sub2apiUrl: '',
          sub2apiEmail: '',
          sub2apiPassword: '',
          sub2apiGroupName: 'codex',
          sub2apiGroupNames: ['codex', 'openai-plus'],
          sub2apiAccountPriority: 1,
          sub2apiDefaultProxyName: '',
        },
        groups: ['reauth-target-sub2api'],
      },
    },
    settingsDefaults: {
      reauthAccountCount: 1,
      autoRun: {
        stepExecutionRange: {
          enabled: false,
          fromStep: 1,
          toStep: 5,
        },
      },
    },
    settingsGroups: {
      'reauth-oauth': {
        id: 'reauth-oauth',
        label: 'OAuth',
        rowIds: ['row-reauth-account-count', 'row-oauth-display', 'row-oauth-callback'],
      },
      'reauth-target-sub2api': {
        id: 'reauth-target-sub2api',
        label: 'SUB2API 来源',
        rowIds: [
          'row-sub2api-url',
          'row-sub2api-email',
          'row-sub2api-password',
          'row-sub2api-group',
          'row-sub2api-account-priority',
          'row-sub2api-default-proxy',
        ],
      },
    },
    targetCapabilities: {
      sub2api: {
        supportedAccountDeliveryModes: ['oauth'],
        defaultAccountDeliveryMode: 'oauth',
        accountDeliveryRouteByMode: { oauth: 'oauth' },
      },
    },
  });
});
