# ADR 002 — User-Sync Lambda Placed in FoundationStack

**Date:** 2026-04-05
**Status:** Accepted

## Context

The user-sync Lambda (`api/src/lambda/user-sync-handler.ts`) is triggered by Cognito's
PostConfirmation event. It must be wired to the Cognito User Pool as a trigger.

The initial task spec (Task 11) placed this Lambda in ComputeStack alongside the other
Lambdas (cleaning, reconciliation). However, this creates a cross-stack circular dependency:

- ComputeStack depends on FoundationStack (for the VPC, security groups, Cognito pool ID)
- If the Cognito trigger is added in ComputeStack, Cognito (in FoundationStack) depends on
  a Lambda ARN from ComputeStack
- CDK cannot resolve this cycle at synth time

## Decision

Place the user-sync Lambda in FoundationStack, where the Cognito User Pool is defined.
Both the Lambda and the User Pool live in the same stack, so `userPool.addTrigger()` is
a same-stack reference — no cycle.

```typescript
// In FoundationStack constructor:
this.userSyncLambda = new lambda.Function(this, 'UserSyncLambda', { ... });
this.userPool.addTrigger(
  cognito.UserPoolOperation.POST_CONFIRMATION,
  this.userSyncLambda,
);
```

The Lambda is exposed as `foundationStack.userSyncLambda` in case ComputeStack needs to
reference it later (e.g. for IAM grants or alarms).

## Consequences

- FoundationStack imports `aws-lambda` and `aws-logs` (minor — these are already CDK v2 deps)
- The Lambda's `lambdaCodePath` is resolved relative to the stack file
  (`path.join(__dirname, '../../api/src/lambda')`) — this path must be kept valid
- Cleaning and reconciliation Lambdas remain in ComputeStack (they have no Cognito dependency)

## Alternatives considered

- **Custom resource in ComputeStack** to attach the trigger post-deploy — adds operational
  complexity and a custom resource Lambda with no benefit.
- **Separate LambdaStack** between Foundation and Compute — unnecessary indirection for
  a single Lambda.
