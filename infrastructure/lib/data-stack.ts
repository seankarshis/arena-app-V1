import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { FoundationStack } from './foundation-stack';

export interface DataStackProps extends cdk.StackProps {
  foundationStack: FoundationStack;
}

/**
 * DataStack — RDS PostgreSQL, ElastiCache Redis, SQS queues,
 * and EventBridge rules.
 *
 * No resources are provisioned yet. This is a scaffold stub.
 */
export class DataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // TODO: RDS PostgreSQL (single instance for dev, Multi-AZ for prod)
    // TODO: ElastiCache Redis (ephemeral interview session state)
    // TODO: SQS queue for post-interview cleaning pipeline + dead-letter queue
    // TODO: EventBridge rules for interview completion and scheduled reconciliation (rate 15 min)
  }
}
