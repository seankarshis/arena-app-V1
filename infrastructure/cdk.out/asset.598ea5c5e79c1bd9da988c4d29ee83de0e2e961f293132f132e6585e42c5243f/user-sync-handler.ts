import type { CognitoUserPoolTriggerEvent, CognitoUserPoolTriggerHandler } from 'aws-lambda';

/**
 * User-sync Lambda — syncs Cognito user pool events to the application database.
 * Stub handler; replaced in Task 10b.
 */
export const handler: CognitoUserPoolTriggerHandler = async (event: CognitoUserPoolTriggerEvent) => {
  console.log('user-sync-handler invoked', { triggerSource: event.triggerSource });

  return event;
};
