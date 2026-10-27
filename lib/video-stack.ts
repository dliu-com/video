import * as path from 'path';
import { Construct } from 'constructs';
import {
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_ssm as ssm,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';

const ROOT = path.join(__dirname, '..');
export const PARAMETER_PREFIX = '/video';

export interface VideoStackProps extends StackProps {
  /** Subdomain under the MainDomain export. */
  subdomain: string;
  /** Origins allowed to show the embed player in an iframe (CSP frame-ancestors). */
  embedAncestors: string[];
  /** Largest video the upload page accepts. */
  maxUploadBytes: number;
}

// Everything here is pay-per-use: S3, CloudFront, one Lambda behind a function URL, CloudFront Functions and
// standard SSM parameters. Nothing runs while nobody uses the site; idle cost is the S3 storage of the videos.
export class VideoStack extends Stack {
  constructor(scope: Construct, id: string, props: VideoStackProps) {
    super(scope, id, props);

    const rootDomain = Fn.importValue('MainDomain');
    const domainName = Fn.join('', [`${props.subdomain}.`, rootDomain]);
    const siteUrl = Fn.join('', ['https://', domainName]);
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
      zoneName: rootDomain,
      hostedZoneId: Fn.importValue('MainHostedZoneId'),
    });

    // ---------- Storage ----------
    const videoBucket = new s3.Bucket(this, 'VideoBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // The upload page sends the file straight to S3 with presigned URLs.
      cors: [{
        allowedOrigins: [siteUrl],
        allowedMethods: [s3.HttpMethods.PUT],
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
        maxAge: 3600,
      }],
      lifecycleRules: [
        { id: 'abort-unfinished-uploads', abortIncompleteMultipartUploadAfter: Duration.days(2) },
        { id: 'expire-pending', prefix: 'pending/', expiration: Duration.days(7) },
      ],
    });

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---------- API (sign-in and owner actions only; viewers never call it) ----------
    const api = new lambda.Function(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(ROOT, 'lambda/api')),
      timeout: Duration.seconds(30),
      memorySize: 256,
      description: 'video.dliu.com sign-in (Microsoft Entra) and upload/edit/delete API',
      environment: {
        SITE_URL: siteUrl,
        ROOT_DOMAIN: rootDomain,
        PARAMETER_PREFIX,
        VIDEO_BUCKET: videoBucket.bucketName,
        MAX_UPLOAD_BYTES: String(props.maxUploadBytes),
      },
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    videoBucket.grantReadWrite(api);
    videoBucket.grantDelete(api);
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: PARAMETER_PREFIX.slice(1) + '/*' })],
    }));
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }));
    const functionUrl = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // ---------- CDN ----------
    // CloudFront requires its certificate in us-east-1 (same pattern as the other sites).
    const certificate = new acm.DnsValidatedCertificate(this, 'SiteCertificate', {
      domainName,
      hostedZone,
      region: 'us-east-1',
    });

    const securityHeaders = (frameAncestors: string): cloudfront.ResponseSecurityHeadersBehavior => ({
      contentSecurityPolicy: {
        contentSecurityPolicy: [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self'",
          "img-src 'self' data: blob:",
          "media-src 'self' blob:",
          `connect-src 'self' https://${videoBucket.bucketRegionalDomainName}`,
          `frame-ancestors ${frameAncestors}`,
          "base-uri 'none'",
          "form-action 'self'",
        ].join('; '),
        override: true,
      },
      contentTypeOptions: { override: true },
      referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: true },
    });
    const permissions = { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', override: true };

    const pageHeaders = new cloudfront.ResponseHeadersPolicy(this, 'PageHeaders', {
      securityHeadersBehavior: {
        ...securityHeaders("'self'"),
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN, override: true },
      },
      customHeadersBehavior: { customHeaders: [permissions] },
    });
    // The embed player may be framed by the listed sites, so it has no X-Frame-Options.
    const embedHeaders = new cloudfront.ResponseHeadersPolicy(this, 'EmbedHeaders', {
      securityHeadersBehavior: securityHeaders(["'self'", ...props.embedAncestors].join(' ')),
      customHeadersBehavior: { customHeaders: [permissions, { header: 'X-Robots-Tag', value: 'noindex', override: true }] },
    });
    const fileHeaders = new cloudfront.ResponseHeadersPolicy(this, 'FileHeaders', {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: true },
      },
    });

    // Central traffic monitoring (dliu-com/traffic-monitor): shared visitor cookie and city logging on pages.
    const visitorId = cloudfront.Function.fromFunctionAttributes(this, 'VisitorId', {
      functionArn: Fn.importValue('TrafficVisitorFunctionArn'),
      functionName: 'dliu-visitor-id',
    });
    const trafficGeo = cloudfront.OriginRequestPolicy.fromOriginRequestPolicyId(
      this, 'TrafficGeo', Fn.importValue('TrafficGeoOriginRequestPolicyId'));

    const pagesFunction = new cloudfront.Function(this, 'PagesFunction', {
      comment: 'Serves /watch, /upload and /embed/<id> from their .html files',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromFile({ filePath: path.join(ROOT, 'functions/pages.js') }),
    });

    const siteOrigin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket);
    const videoOrigin = origins.S3BucketOrigin.withOriginAccessControl(videoBucket, {
      originAccessLevels: [cloudfront.AccessLevel.READ],
    });
    const pageBehavior = (responseHeadersPolicy: cloudfront.IResponseHeadersPolicy): cloudfront.BehaviorOptions => ({
      origin: siteOrigin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      originRequestPolicy: trafficGeo,
      responseHeadersPolicy,
      compress: true,
      functionAssociations: [
        { function: pagesFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        { function: visitorId, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE },
      ],
    });
    // Video files and posters: cached at the edge; S3 answers range requests for seeking.
    const fileBehavior: cloudfront.BehaviorOptions = {
      origin: videoOrigin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: fileHeaders,
      compress: false,
    };
    // Catalog and video details are written with Cache-Control: no-cache, so edits show at once.
    const dataCache = new cloudfront.CachePolicy(this, 'DataCache', {
      comment: 'video.dliu.com catalog JSON: honour origin no-cache',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(60),
      maxTtl: Duration.days(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl, { readTimeout: Duration.seconds(30) }),
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: pageHeaders,
    };

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'video.dliu.com',
      defaultBehavior: pageBehavior(pageHeaders),
      additionalBehaviors: {
        'embed/*': pageBehavior(embedHeaders),
        'v/*': fileBehavior,
        't/*': fileBehavior,
        'data/*': { ...fileBehavior, cachePolicy: dataCache, compress: true },
        'api/*': { ...apiBehavior, allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL },
        'auth/*': apiBehavior,
      },
      domainNames: [domainName],
      certificate,
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });
    // IncludeCookies is the only legacy logging setting v2 honours: it puts the dl_vid cookie in the logs.
    (distribution.node.defaultChild as cloudfront.CfnDistribution)
      .addPropertyOverride('DistributionConfig.Logging', { IncludeCookies: true });

    // New function URLs require both invoke permissions. CDK adds InvokeFunctionUrl.
    api.addPermission('CloudFrontInvokeFunction', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: distribution.distributionArn,
      invokedViaFunctionUrl: true,
    });

    // Deletes invalidate the CDN. A separate policy (not the role's default one) and an SSM parameter keep
    // the function from depending on the distribution, which already depends on the function.
    new ssm.StringParameter(this, 'DistributionIdParameter', {
      parameterName: `${PARAMETER_PREFIX}/distribution-id`,
      stringValue: distribution.distributionId,
      description: 'video.dliu.com CloudFront distribution, for invalidating deleted videos',
    });
    new iam.Policy(this, 'InvalidatePolicy', {
      roles: [api.role!],
      statements: [new iam.PolicyStatement({ actions: ['cloudfront:CreateInvalidation'], resources: [distribution.distributionArn] })],
    });

    new s3deploy.BucketDeployment(this, 'SiteContent', {
      sources: [s3deploy.Source.asset(path.join(ROOT, 'web'))],
      destinationBucket: siteBucket,
      // Browsers and CloudFront revalidate on every load (a 304 when unchanged), so a deploy shows up at once.
      cacheControl: [s3deploy.CacheControl.noCache()],
    });

    new route53.ARecord(this, 'AliasRecord', {
      recordName: props.subdomain,
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'AliasIpv6Record', {
      recordName: props.subdomain,
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    new CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new CfnOutput(this, 'AuthRedirectUri', { value: Fn.join('', [siteUrl, '/auth/callback']) });
    new CfnOutput(this, 'VideoBucketName', { value: videoBucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'ApiFunctionName', { value: api.functionName });
  }
}
