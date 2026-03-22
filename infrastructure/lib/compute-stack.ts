import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { FoundationStack } from './foundation-stack';
import { DataStack } from './data-stack';

export interface ComputeStackProps extends cdk.StackProps {
  foundationStack: FoundationStack;
  dataStack: DataStack;
}

/**
 * ComputeStack — ECS Fargate cluster, ALB, API server service,
 * frontend service, STT proxy service, and Lambda functions.
 *
 * No resources are provisioned yet. This is a scaffold stub.
 */
export class ComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    // TODO: ECS Fargate cluster shared by API, frontend, and STT proxy services
    // TODO: Application Load Balancer with path-based routing
    // TODO: Fastify API server service (with Apollo Server + WebSocket STT proxy)
    // TODO: Next.js frontend service
    // TODO: Lambda: LLM cleaning pipeline (Node.js 20, Claude API)
    // TODO: Lambda: Cognito post-confirmation user sync trigger
    // TODO: Lambda: Reconciliation job (stuck turns, audio uploads, auto-abandonment, data retention)
  }
}
