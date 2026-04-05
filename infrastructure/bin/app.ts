#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';
import { DataStack } from '../lib/data-stack';
import { ComputeStack } from '../lib/compute-stack';

// Deployment model: app compute (API + Frontend) runs on EC2 via nginx + PM2.
// These CDK stacks manage only the AWS-managed services: Cognito, RDS,
// ElastiCache, S3, and background Lambdas. See ADR 004.

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const foundationStack = new FoundationStack(app, 'ArenaFoundationStack', { env });

const dataStack = new DataStack(app, 'ArenaDataStack', {
  env,
  foundationStack,
});

new ComputeStack(app, 'ArenaComputeStack', { env });
