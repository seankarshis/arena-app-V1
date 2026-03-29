import pino from 'pino';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type {
  CognitoUserPoolTriggerEvent,
  CognitoUserPoolTriggerHandler,
} from 'aws-lambda';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const prisma = new PrismaClient();
const cognito = new CognitoIdentityProviderClient({});

export const handler: CognitoUserPoolTriggerHandler = async (
  event: CognitoUserPoolTriggerEvent,
) => {
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    return event;
  }

  try {
    const attrs = event.request.userAttributes;
    const sub = attrs.sub;
    const email = attrs.email;

    if (!sub || !email) {
      log.error({ hasSub: !!sub, hasEmail: !!email }, 'user-sync-handler: missing required attributes');
      return event;
    }

    const name = attrs.name || attrs['custom:name'] || email.split('@')[0];

    // Determine role from Cognito group membership
    let role = 'user';
    try {
      const response = await cognito.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: event.userPoolId,
          Username: event.userName,
        }),
      );
      const groupNames = response.Groups?.map((g) => g.GroupName) ?? [];
      if (groupNames.includes('admin')) {
        role = 'admin';
      }
    } catch (groupErr) {
      log.error({ err: groupErr instanceof Error ? groupErr.message : String(groupErr) }, 'user-sync-handler: failed to fetch groups, defaulting to user role');
    }

    // Insert user row; skip silently if already exists (idempotency)
    await prisma.user.create({
      data: { id: sub, email, name, role },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      // User already exists — idempotent, skip silently
      return event;
    }
    // Log but do not block Cognito confirmation
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'user-sync-handler: unexpected error');
  }

  return event;
};
