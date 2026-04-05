# ADR 003 — Audio Upload Mutations Removed Pending S3 Infrastructure

**Date:** 2026-04-05
**Status:** Accepted

## Context

The GraphQL schema included two mutations for generating S3 presigned upload URLs:
- `requestResponseAudioUploadUrl(interviewId, responseId)` 
- `requestDraftAudioUploadUrl(interviewId, draftId)`

Both were implemented as stubs that threw `internalError('Audio operations not yet implemented')`.
The S3 bucket (defined in FoundationStack) has not been deployed yet, and the API service
doesn't have the IAM permissions or bucket name wired to generate presigned URLs.

Leaving these in the schema meant any client calling them would receive a confusing internal
error with no indication that the feature simply isn't ready.

## Decision

Remove both mutations from the schema (`api/src/schema/typedefs.ts`) and their resolver
stubs (`api/src/schema/resolvers.ts`).

`confirmAudioUpload` is **not** removed — it writes metadata to the database and is
functional independent of S3.

The `frontend/src/lib/audioUploadQueue.ts` file was also deleted as it depended on these
mutations.

## When to re-implement

Implement the full audio upload flow after:
1. CDK stacks are deployed and the S3 bucket (`arena-audio-<account>-<region>`) exists
2. The API ECS task role has `s3:PutObject` on the bucket (already granted in ComputeStack)
3. `S3_AUDIO_BUCKET` and `S3_REGION` env vars are confirmed set in the task definition

The implementation should use `@aws-sdk/s3-request-presigner` and `PutObjectCommand` to
generate a presigned URL scoped to the specific interview and response IDs.

## Alternatives considered

- **Return a clear NOT_IMPLEMENTED error** — better than an internal error, but still
  misleading since the schema implies the feature exists. Removing is cleaner.
- **Keep stubs, add a feature flag** — adds unnecessary complexity for a feature with
  known missing infrastructure.
