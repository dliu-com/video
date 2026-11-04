import * as path from 'path';
import { Construct } from 'constructs';
import {
  aws_apigatewayv2 as apigateway,
  aws_apigatewayv2_authorizers as authorizers,
  aws_apigatewayv2_integrations as integrations,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_events as events,
  aws_events_targets as eventTargets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_scheduler as scheduler,
  aws_ssm as ssm,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import apiRoutes from '../lambda/api/routes.json';

const ROOT = path.join(__dirname, '..');
export const PARAMETER_PREFIX = '/video';
// Shared by every dliu.com app; owned by the dliu-com/audit stack.
export const SHARED_TENANT_PARAMETER = '/dliu/entra-tenant-id';
export const SHARED_API_APP_PARAMETER = '/dliu/api-app-id';
/** Marks this site's MediaConvert jobs (UserMetadata.app), so the event rule only sends those. Matches streaming.js. */
export const STREAMING_APP = 'video.dliu.com';
export const SCHEDULE_GROUP = 'video-streaming';
/** Conversion waits until a file has stayed unchanged this long (it is often replaced while being edited). */
export const CONVERT_DELAY_MINUTES = 120;
/** Most API Lambda runs at once; the owner needs a few, so a flood is throttled rather than billed. */
export const API_CONCURRENCY = 10;
/** Microsoft API (API Gateway) limits per second for the whole API. */
export const API_RATE_PER_SECOND = 10;
export const API_BURST = 20;

export interface VideoStackProps extends StackProps {
  /** Subdomain under the MainDomain export. */
  subdomain: string;
  /** Origins allowed to show the embed player in an iframe (CSP frame-ancestors). */
  embedAncestors: string[];
  /** Largest video the upload page accepts. */
  maxUploadBytes: number;
  microsoftApi?: boolean;
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
      // Caps what a flood of requests can run up (viewers never call this function). Reserving costs nothing.
      reservedConcurrentExecutions: API_CONCURRENCY,
      description: 'video.dliu.com sign-in (Microsoft Entra) and upload/edit/delete API',
      environment: {
        SITE_URL: siteUrl,
        ROOT_DOMAIN: rootDomain,
        PARAMETER_PREFIX,
        TENANT_PARAMETER: SHARED_TENANT_PARAMETER,
        VIDEO_BUCKET: videoBucket.bucketName,
        MAX_UPLOAD_BYTES: String(props.maxUploadBytes),
      },
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    videoBucket.grantReadWrite(api);
    videoBucket.grantDelete(api);
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: PARAMETER_PREFIX.slice(1) + '/*' })],
    }));
    // The shared IDs: exactly these two parameters, nothing else under /dliu/.
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters'],
      resources: [SHARED_TENANT_PARAMETER, SHARED_API_APP_PARAMETER].map((name) =>
        this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: name.slice(1) })),
    }));
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }));
    const functionUrl = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // ---------- Streaming versions (MediaConvert HLS), pay per converted minute ----------
    const mediaConvertRole = new iam.Role(this, 'MediaConvertRole', {
      assumedBy: new iam.ServicePrincipal('mediaconvert.amazonaws.com'),
      description: 'video.dliu.com: MediaConvert reads uploaded videos (v/) and writes streaming versions (h/)',
    });
    videoBucket.grantRead(mediaConvertRole, 'v/*');
    videoBucket.grantPut(mediaConvertRole, 'h/*');
    const scheduleGroup = new scheduler.CfnScheduleGroup(this, 'ConversionSchedules', { name: SCHEDULE_GROUP });
    const schedulerRole = new iam.Role(this, 'ConversionSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
      description: 'video.dliu.com: starts the delayed conversion of an uploaded video',
    });
    api.grantInvoke(schedulerRole);
    api.addEnvironment('MEDIACONVERT_ROLE_ARN', mediaConvertRole.roleArn);
    api.addEnvironment('SCHEDULER_ROLE_ARN', schedulerRole.roleArn);
    api.addEnvironment('SCHEDULE_GROUP', SCHEDULE_GROUP);
    api.addEnvironment('CONVERT_DELAY_MINUTES', String(CONVERT_DELAY_MINUTES));
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['mediaconvert:CreateJob', 'mediaconvert:CancelJob', 'mediaconvert:GetJob'],
      resources: [
        this.formatArn({ service: 'mediaconvert', resource: 'jobs', resourceName: '*' }),
        this.formatArn({ service: 'mediaconvert', resource: 'queues', resourceName: 'Default' }),
      ],
    }));
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['scheduler:CreateSchedule', 'scheduler:UpdateSchedule', 'scheduler:DeleteSchedule'],
      resources: [this.formatArn({ service: 'scheduler', resource: 'schedule', resourceName: `${SCHEDULE_GROUP}/*` })],
    }));
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [mediaConvertRole.roleArn, schedulerRole.roleArn],
    }));
    api.node.addDependency(scheduleGroup);
    new events.Rule(this, 'ConversionFinished', {
      description: 'video.dliu.com: a streaming conversion finished or failed',
      eventPattern: {
        source: ['aws.mediaconvert'],
        detailType: ['MediaConvert Job State Change'],
        detail: { status: ['COMPLETE', 'ERROR', 'CANCELED'], userMetadata: { app: [STREAMING_APP] } },
      },
      targets: [new eventTargets.LambdaFunction(api, { retryAttempts: 8 })],
    });

    if (props.microsoftApi) {
      const tenantId = ssm.StringParameter.valueForStringParameter(this, SHARED_TENANT_PARAMETER);
      // The shared "dliu API" application is both the token audience and the only approved client (azp).
      const audience = ssm.StringParameter.valueForStringParameter(this, SHARED_API_APP_PARAMETER);
      const clientId = audience;
      const httpApi = new apigateway.HttpApi(this, 'MicrosoftApi', {
        description: 'Video API: Microsoft Entra access tokens, delegated permissions and assigned users',
      });
      const authorizer = new authorizers.HttpJwtAuthorizer('MicrosoftJwt',
        Fn.join('', ['https://login.microsoftonline.com/', tenantId, '/v2.0']), { jwtAudience: [audience] });
      const integration = new integrations.HttpLambdaIntegration('VideoApi', api);
      for (const [route, permission] of Object.entries(apiRoutes)) {
        const [method, routePath] = route.split(' ');
        httpApi.addRoutes({
          path: routePath,
          methods: [apigateway.HttpMethod[method as 'GET' | 'POST']],
          integration,
          authorizer,
          authorizationScopes: [permission.scope],
        });
      }
      // Requests over the limit get 429 before reaching the authorizer or the function.
      (httpApi.defaultStage!.node.defaultChild as apigateway.CfnStage).defaultRouteSettings = {
        throttlingRateLimit: API_RATE_PER_SECOND,
        throttlingBurstLimit: API_BURST,
      };
      api.addEnvironment('API_GATEWAY_ID', httpApi.apiId);
      api.addEnvironment('API_TENANT_ID', tenantId);
      api.addEnvironment('API_AUDIENCE', audience);
      api.addEnvironment('API_CLIENT_ID', clientId);
      new CfnOutput(this, 'MicrosoftApiUrl', { value: httpApi.apiEndpoint });
    }

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
          // Shared dliu.com look (dliu-com/shared-resources): only its stylesheet folder and the DL icon.
          "style-src 'self' https://files.dliu.com/dliu.com/ui/",
          "img-src 'self' data: blob: https://files.dliu.com/dliu.com/",
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
    // Files are never pages: if one is opened directly, it runs no script and gets a unique origin.
    const fileSecurity: cloudfront.ResponseSecurityHeadersBehavior = {
      contentSecurityPolicy: { contentSecurityPolicy: "default-src 'none'; sandbox", override: true },
      contentTypeOptions: { override: true },
      strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: true },
    };
    const fileHeaders = new cloudfront.ResponseHeadersPolicy(this, 'FileHeaders', { securityHeadersBehavior: fileSecurity });
    // MediaConvert cannot set Cache-Control on what it writes. Every conversion gets a new folder, so it never changes.
    const immutable = { header: 'Cache-Control', value: 'public, max-age=31536000, immutable', override: false };
    const streamHeaders = new cloudfront.ResponseHeadersPolicy(this, 'StreamHeaders', {
      securityHeadersBehavior: fileSecurity,
      customHeadersBehavior: { customHeaders: [immutable] },
    });

    // Central traffic monitoring (dliu-com/traffic-monitor): shared visitor cookie and city logging on pages.
    const visitorId = cloudfront.Function.fromFunctionAttributes(this, 'VisitorId', {
      functionArn: Fn.importValue('TrafficVisitorFunctionArn'),
      functionName: 'dliu-visitor-id',
    });
    const trafficGeo = cloudfront.OriginRequestPolicy.fromOriginRequestPolicyId(
      this, 'TrafficGeo', Fn.importValue('TrafficGeoOriginRequestPolicyId'));

    const pagesFunction = new cloudfront.Function(this, 'PagesFunction', {
      comment: 'Serves /watch, /upload, /docs and /embed/<id> from their .html files; /docs/api, /docs/health -> 301 /docs tabs',
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
    const streamCache = new cloudfront.CachePolicy(this, 'StreamCache', {
      comment: 'video.dliu.com streaming versions: versioned folders, cached for a year',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.days(365),
      maxTtl: Duration.days(365),
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

    // status.dliu.com's /health: no origin request policy, so CloudFront forwards no cookies, Authorization
    // header or query string; the empty cache key and 60 s TTL run the checks at most once a minute per edge.
    const healthCache = new cloudfront.CachePolicy(this, 'HealthCache', {
      comment: 'video.dliu.com /health: 60 s, keyed on nothing',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(60),
      maxTtl: Duration.seconds(60),
    });
    const healthBehavior: cloudfront.BehaviorOptions = {
      origin: apiBehavior.origin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: healthCache,
      responseHeadersPolicy: pageHeaders,
    };

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'video.dliu.com',
      defaultBehavior: pageBehavior(pageHeaders),
      additionalBehaviors: {
        'embed/*': pageBehavior(embedHeaders),
        'v/*': fileBehavior,
        't/*': fileBehavior,
        'h/*': { ...fileBehavior, cachePolicy: streamCache, responseHeadersPolicy: streamHeaders, compress: true },
        'data/*': { ...fileBehavior, cachePolicy: dataCache, compress: true },
        // Written by the Lambda with the catalog whenever a video is published, edited or deleted (make sitemap rebuilds it).
        'sitemap.xml': { ...fileBehavior, cachePolicy: dataCache, compress: true },
        'api/*': { ...apiBehavior, allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL },
        'auth/*': apiBehavior,
        'health': healthBehavior,
      },
      domainNames: [domainName],
      certificate,
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // All edge locations: most viewers are in Europe and Asia. Within the always-free 1 TB this costs nothing.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
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
      sources: [s3deploy.Source.asset(path.join(ROOT, 'web'), { exclude: ['vendor'] })],
      destinationBucket: siteBucket,
      // Browsers and CloudFront revalidate on every load (a 304 when unchanged), so a deploy shows up at once.
      cacheControl: [s3deploy.CacheControl.noCache()],
      // vendor/ and the Markdown docs belong to the deployments below; leave them alone when pruning.
      exclude: ['vendor/*', '*.md'],
    });
    // Markdown docs for agents and status.dliu.com (/docs/api.md, /docs/health.md), with their charset.
    new s3deploy.BucketDeployment(this, 'Markdown', {
      sources: [s3deploy.Source.asset(path.join(ROOT, 'web'), { exclude: ['vendor'] })],
      destinationBucket: siteBucket,
      exclude: ['*'],
      include: ['*.md'],
      contentType: 'text/markdown; charset=utf-8',
      cacheControl: [s3deploy.CacheControl.noCache()],
    });
    // Player libraries (Plyr, hls.js). Their file names carry the version, so they can be cached for a year.
    new s3deploy.BucketDeployment(this, 'PlayerLibraries', {
      sources: [s3deploy.Source.asset(path.join(ROOT, 'web/vendor'))],
      destinationBucket: siteBucket,
      destinationKeyPrefix: 'vendor/',
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
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
