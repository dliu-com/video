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
    .toEqual(['embed/*', 'v/*', 't/*', 'h/*', 'data/*', 'api/*', 'auth/*']);
  expect(behavior('api/*').AllowedMethods).toContain('POST');
  expect(behavior('auth/*').AllowedMethods).not.toContain('POST');
  expect(behavior('v/*').Compress).toBe(false);
  expect(behavior('data/*').Compress).toBe(true);
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
    ['vendor/', { 'cache-control': 'public, max-age=31536000, immutable' }],
  ]);
  expect((deployments[0] as any).Properties.Exclude).toEqual(['vendor/*']);
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
