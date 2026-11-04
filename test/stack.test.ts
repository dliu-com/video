import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VideoStack } from '../lib/video-stack';

const template = Template.fromStack(new VideoStack(new App(), 'Video', {
  subdomain: 'video',
  embedAncestors: ['https://dliu.com', 'https://*.dliu.com'],
  maxUploadBytes: 50 * 1024 ** 3,
  env: { account: '123456789012', region: 'eu-west-1' },
}));

const distributionConfig = () => Object.values(template.findResources('AWS::CloudFront::Distribution'))[0].Properties.DistributionConfig;
const behavior = (pattern: string) => distributionConfig().CacheBehaviors.find((b: { PathPattern: string }) => b.PathPattern === pattern);
const headers = (name: string) => Object.entries(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'))
  .find(([id]) => id.startsWith(name))![1].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
const csp = (name: string) => JSON.stringify(headers(name).ContentSecurityPolicy);

test('has nothing that bills while idle', () => {
  for (const type of ['AWS::EC2::Instance', 'AWS::EC2::NatGateway', 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    'AWS::DynamoDB::Table', 'AWS::WAFv2::WebACL', 'AWS::RDS::DBInstance', 'AWS::ApiGateway::RestApi']) {
    template.resourceCountIs(type, 0);
  }
});

test('video bucket accepts browser uploads from the site and cleans up abandoned ones', () => {
  template.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedMethods: ['PUT'], ExposedHeaders: ['ETag'] })] },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 } }),
          Match.objectLike({ Prefix: 'pending/', ExpirationInDays: 7 }),
        ]),
      },
    }),
  });
});

test('routes files, data and the API to the right origins', () => {
  expect(distributionConfig().CacheBehaviors.map((b: { PathPattern: string }) => b.PathPattern))
    .toEqual(['embed/*', 'v/*', 't/*', 'h/*', 'data/*', 'sitemap.xml', 'api/*', 'auth/*', 'health']);
  expect(behavior('api/*').AllowedMethods).toContain('POST');
  expect(behavior('auth/*').AllowedMethods).not.toContain('POST');
  expect(behavior('v/*').Compress).toBe(false);
  expect(behavior('data/*').Compress).toBe(true);
  expect(behavior('sitemap.xml').TargetOriginId).toBe(behavior('data/*').TargetOriginId);
  expect(behavior('sitemap.xml').CachePolicyId).toEqual(behavior('data/*').CachePolicyId);
  expect(distributionConfig().Logging).toEqual({ IncludeCookies: true });
});

test('only the embed player can be framed, and only by the configured sites', () => {
  expect(csp('PageHeaders')).toContain("frame-ancestors 'self';");
  expect(csp('EmbedHeaders')).toContain("frame-ancestors 'self' https://dliu.com https://*.dliu.com;");
  expect(headers('PageHeaders').FrameOptions).toEqual({ FrameOption: 'SAMEORIGIN', Override: true });
  expect(headers('EmbedHeaders').FrameOptions).toBeUndefined();
});

test('pages may load only the shared dliu.com stylesheet folder and DL icon from files.dliu.com, and no shared scripts', () => {
  for (const policy of ['PageHeaders', 'EmbedHeaders']) {
    expect(csp(policy)).toContain("style-src 'self' https://files.dliu.com/dliu.com/ui/;");
    expect(csp(policy)).toContain("img-src 'self' data: blob: https://files.dliu.com/dliu.com/;");
    expect(csp(policy)).toContain("script-src 'self';");
  }
});

test('the browser API Lambda is invoked through CloudFront and can invalidate it', () => {
  template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
    Runtime: 'nodejs22.x',
    Architectures: ['arm64'],
    Environment: { Variables: Match.objectLike({ PARAMETER_PREFIX: '/video', MAX_UPLOAD_BYTES: String(50 * 1024 ** 3) }) },
  }));
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/video/distribution-id' });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: { Statement: [Match.objectLike({ Action: 'cloudfront:CreateInvalidation' })] },
  });
});

test('Microsoft API is opt-in and every exposed route has its exact delegated scope', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
    const enabled = Template.fromStack(new VideoStack(new App(), 'VideoMicrosoft', {
      subdomain: 'video', embedAncestors: ['https://dliu.com'], maxUploadBytes: 50 * 1024 ** 3,
      microsoftApi: true, env: { account: '123456789012', region: 'eu-west-1' },
    }));
    enabled.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    enabled.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT', IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: { Audience: [Match.anyValue()], Issuer: Match.anyValue() },
    });
    const routes = require('../lambda/api/routes.json');
    const deployed = Object.values(enabled.findResources('AWS::ApiGatewayV2::Route'));
    expect(deployed).toHaveLength(Object.keys(routes).length);
    for (const route of deployed) {
      expect(route.Properties.AuthorizationType).toBe('JWT');
      expect(route.Properties.AuthorizationScopes).toEqual([routes[route.Properties.RouteKey].scope]);
      expect(route.Properties.AuthorizerId).toBeDefined();
    }
    expect(deployed.some((route) => route.Properties.RouteKey.includes('/auth/'))).toBe(false);
    enabled.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
    enabled.hasResourceProperties('AWS::Lambda::Permission', {
      Principal: 'apigateway.amazonaws.com', Action: 'lambda:InvokeFunction', SourceArn: Match.anyValue(),
    });
    enabled.hasResourceProperties('AWS::ApiGatewayV2::Integration', { PayloadFormatVersion: '2.0' });
    enabled.hasOutput('MicrosoftApiUrl', { Value: Match.anyValue() });
    enabled.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default', DefaultRouteSettings: { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
    });
});

test('a request flood is throttled instead of billed: the API Lambda has a concurrency cap', () => {
  template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({ Handler: 'index.handler', ReservedConcurrentExecutions: 10 }));
});

test('files opened directly run no script (posters, videos, streams and data)', () => {
  for (const policy of ['FileHeaders', 'StreamHeaders']) {
    expect(headers(policy).ContentSecurityPolicy).toEqual({ ContentSecurityPolicy: "default-src 'none'; sandbox", Override: true });
    expect(headers(policy).ContentTypeOptions).toEqual({ Override: true });
  }
});

test('serves from every edge location over HTTP/2 and HTTP/3; HTML and catalog stay revalidated', () => {
  expect(distributionConfig().PriceClass).toBe('PriceClass_All');
  expect(distributionConfig().HttpVersion).toBe('http2and3');
  const deployments = Object.values(template.findResources('Custom::CDKBucketDeployment'));
  // Pages revalidate; the versioned player libraries are cached for a year.
  expect(deployments.map((d: any) => [d.Properties.DestinationBucketKeyPrefix, d.Properties.SystemMetadata])).toEqual([
    [undefined, { 'cache-control': 'no-cache' }],
    [undefined, { 'cache-control': 'no-cache', 'content-type': 'text/markdown; charset=utf-8' }],
    ['vendor/', { 'cache-control': 'public, max-age=31536000, immutable' }],
  ]);
  // The Markdown docs are deployed only by the Markdown deployment, with their charset.
  expect((deployments[0] as any).Properties.Exclude).toEqual(['vendor/*', '*.md']);
  expect((deployments[1] as any).Properties).toMatchObject({ Exclude: ['*'], Include: ['*.md'] });
});

test('/health for status.dliu.com: the Lambda, no forwarded request data, cached 60 s on an empty key', () => {
  const health = behavior('health');
  expect(health.AllowedMethods).toEqual(['GET', 'HEAD']);
  expect(health.TargetOriginId).toBe(behavior('auth/*').TargetOriginId);
  expect(health.OriginRequestPolicyId).toBeUndefined();
  expect(health.FunctionAssociations).toBeUndefined();
  const policies = template.findResources('AWS::CloudFront::CachePolicy');
  const [id] = Object.entries(policies).find(([key]) => key.startsWith('HealthCache'))!;
  expect(health.CachePolicyId).toEqual({ Ref: id });
  expect(policies[id].Properties.CachePolicyConfig).toMatchObject({
    MinTTL: 0, DefaultTTL: 60, MaxTTL: 60,
    ParametersInCacheKeyAndForwardedToOrigin: {
      CookiesConfig: { CookieBehavior: 'none' },
      HeadersConfig: { HeaderBehavior: 'none' },
      QueryStringsConfig: { QueryStringBehavior: 'none' },
    },
  });
});

test('streaming versions: MediaConvert after a delay, finished jobs reported back, cached for a year', () => {
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: [Match.objectLike({ Principal: { Service: 'mediaconvert.amazonaws.com' } })],
    }),
  });
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: [Match.objectLike({
        Principal: { Service: 'scheduler.amazonaws.com' },
        Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' } },
      })],
    }),
  });
  template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', { Name: 'video-streaming' });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({
      MEDIACONVERT_ROLE_ARN: Match.anyValue(), SCHEDULER_ROLE_ARN: Match.anyValue(),
      SCHEDULE_GROUP: 'video-streaming', CONVERT_DELAY_MINUTES: '120',
    }) },
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: {
      'source': ['aws.mediaconvert'],
      'detail-type': ['MediaConvert Job State Change'],
      'detail': { status: ['COMPLETE', 'ERROR', 'CANCELED'], userMetadata: { app: ['video.dliu.com'] } },
    },
  });
  const stream = behavior('h/*');
  expect(stream.Compress).toBe(true);
  const policy = Object.entries(template.findResources('AWS::CloudFront::CachePolicy'))
    .find(([id]) => id.startsWith('StreamCache'))![1].Properties.CachePolicyConfig;
  expect(policy.DefaultTTL).toBe(365 * 24 * 3600);
  const streamHeaders = Object.entries(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'))
    .find(([id]) => id.startsWith('StreamHeaders'))![1].Properties.ResponseHeadersPolicyConfig;
  expect(streamHeaders.CustomHeadersConfig.Items).toEqual([
    { Header: 'Cache-Control', Value: 'public, max-age=31536000, immutable', Override: false },
  ]);
});

test('every log group the stack manages is kept for 3 months', () => {
  const groups = Object.values(template.findResources('AWS::Logs::LogGroup'));
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) expect(group.Properties.RetentionInDays).toBe(90);
  template.resourceCountIs('Custom::LogRetention', 0);
});

test('tenant and dliu API IDs come only from the shared /dliu/ parameters, and the Lambda can read exactly those two', () => {
  const enabled = Template.fromStack(new VideoStack(new App(), 'VideoShared', {
    subdomain: 'video', embedAncestors: ['https://dliu.com'], maxUploadBytes: 50 * 1024 ** 3,
    microsoftApi: true, env: { account: '123456789012', region: 'eu-west-1' },
  }));
  const parameters = Object.values(enabled.toJSON().Parameters || {}).map((p: any) => p.Default);
  expect(parameters.filter((name: string) => name.startsWith('/dliu/')).sort()).toEqual(['/dliu/api-app-id', '/dliu/entra-tenant-id']);
  expect(parameters.filter((name: string) => /^\/video\/(api-|entra-tenant)/.test(name))).toEqual([]);
  enabled.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
    Handler: 'index.handler',
    Environment: { Variables: Match.objectLike({ TENANT_PARAMETER: '/dliu/entra-tenant-id' }) },
  }));
  const statements = Object.values(enabled.findResources('AWS::IAM::Policy'))
    .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
  const shared = statements.filter((s: any) => JSON.stringify(s.Resource).includes(':parameter/dliu/'));
  expect(shared).toHaveLength(1);
  expect(shared[0].Action).toBe('ssm:GetParameters');
  const arns = shared[0].Resource.map((r: any) => JSON.stringify(r));
  expect(arns).toHaveLength(2);
  expect(arns.some((a: string) => a.includes(':parameter/dliu/entra-tenant-id'))).toBe(true);
  expect(arns.some((a: string) => a.includes(':parameter/dliu/api-app-id'))).toBe(true);
  expect(arns.some((a: string) => a.includes('*'))).toBe(false);
});
