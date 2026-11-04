#!/usr/bin/env node
// Rebuilds /sitemap.xml from the video index (the Lambda also does this whenever a video changes).
// Usage: make sitemap   (needs AWS credentials for the Video stack)
'use strict';
const { execFileSync } = require('child_process');
const { S3Client } = require('@aws-sdk/client-s3');
const store = require('../lambda/api/store');

const region = process.env.AWS_REGION || 'eu-west-1';
const output = (key) => execFileSync('aws', ['cloudformation', 'describe-stacks', '--region', region, '--stack-name', process.env.STACK_NAME || 'Video',
  '--query', `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue`, '--output', 'text'], { encoding: 'utf8' }).trim();

(async () => {
  const bucket = output('VideoBucketName');
  process.env.SITE_URL = output('SiteUrl');
  const s3 = new S3Client({ region });
  const index = await store.readIndex(s3, bucket);
  await store.writeSitemap(s3, bucket, index);
  console.log(`sitemap.xml: ${index.videos.length + 2} URLs (home, /docs and ${index.videos.length} videos)`);
})().catch((error) => { console.error(error.message); process.exit(1); });
