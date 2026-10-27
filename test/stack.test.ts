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
    .toEqual(['embed/*', 'v/*', 't/*', 'data/*', 'api/*', 'auth/*']);
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

test('the API Lambda is invoked only through CloudFront and can invalidate it', () => {
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
