const { loadConfig, resetConfigCache } = require('../lambda/api/config');

const fakeSsm = (values) => {
  const requested = [];
  return {
    requested,
    send: async (command) => {
      requested.push(...command.input.Names);
      return { Parameters: command.input.Names.filter((name) => values[name]).map((Name) => ({ Name, Value: values[Name] })) };
    },
  };
};

beforeEach(() => resetConfigCache());

test('the tenant comes from the shared /dliu/ parameter; the client ID and secret stay under /video', async () => {
  const ssm = fakeSsm({
    '/dliu/entra-tenant-id': ' tenant-guid \n',
    '/video/entra-client-id': 'client-guid',
    '/video/entra-client-secret': 'secret',
    '/video/entra-tenant-id': 'stale-copy',
  });
  const config = await loadConfig(ssm, 1);
  expect(config).toMatchObject({ tenantId: 'tenant-guid', clientId: 'client-guid', clientSecret: 'secret' });
  expect(ssm.requested.sort()).toEqual(['/dliu/entra-tenant-id', '/video/entra-client-id', '/video/entra-client-secret']);
});

test('a missing shared tenant parameter is reported by its full name', async () => {
  const ssm = fakeSsm({ '/video/entra-client-id': 'client-guid', '/video/entra-client-secret': 'secret' });
  await expect(loadConfig(ssm, 1)).rejects.toThrow('/dliu/entra-tenant-id');
});
