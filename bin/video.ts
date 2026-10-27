#!/usr/bin/env node
import 'source-map-support/register';
import { App, Tags } from 'aws-cdk-lib';
import { VideoStack } from '../lib/video-stack';
import site from '../config/site.json';

const region = process.env.CDK_DEFAULT_REGION || 'eu-west-1';
// Imports the traffic-monitor exports, which live in eu-west-1 with the other site stacks.
if (region !== 'eu-west-1') throw new Error('Video must be deployed to eu-west-1, alongside the other site stacks.');

const app = new App();
for (const [key, value] of Object.entries({ service: 'video', Project: 'video.dliu.com' })) Tags.of(app).add(key, value);
new VideoStack(app, 'Video', {
  subdomain: site.subdomain,
  embedAncestors: site.embedAncestors,
  maxUploadBytes: site.maxUploadGiB * 1024 ** 3,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
});
