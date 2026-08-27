import { op, jsonBody, idParam } from '../helpers.js';

export function notificationsPaths() {
  return {
    '/api/v1/notifications/providers': {
      get: op({
        summary: 'List supported notification channel providers',
        tag: 'Notifications',
        description: 'Available providers are returned for any authenticated user. Personal channels currently support Webhook and message-pusher; household channels support every listed provider.',
      }),
    },
    '/api/v1/notifications/channels': {
      get: op({
        summary: 'List notification channels visible to the current user',
        tag: 'Notifications',
        description: 'Members receive only their own personal channels. Administrators receive household channels plus their own personal channels; personal channels belonging to other members are never exposed.',
        responses: {
          200: {
            description: 'Notification channels with secrets omitted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationChannelListResponse' } } },
          },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Create a personal or household notification channel',
        tag: 'Notifications',
        description: 'Authenticated users can create personal Webhook or message-pusher channels for themselves. Administrators can also create household channels for all members. If scope is omitted, it defaults to `user` for members and `household` for administrators.',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/NotificationChannelInput'),
        responses: {
          201: {
            description: 'Notification channel created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationChannelResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/notifications/channels/{id}': {
      put: op({
        summary: 'Update an owned notification channel',
        tag: 'Notifications',
        description: 'A member can update their own personal channel. An administrator can update household channels and their own personal channels. The channel scope and owner cannot be changed through this operation.',
        stateChanging: true,
        params: [idParam()],
        requestBody: jsonBody('#/components/schemas/NotificationChannelInput'),
        responses: {
          200: {
            description: 'Notification channel updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationChannelResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Notification channel not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({
        summary: 'Delete an owned notification channel',
        tag: 'Notifications',
        description: 'A member can delete their own personal channel. An administrator can delete household channels and their own personal channels.',
        stateChanging: true,
        params: [idParam()],
        responses: {
          200: {
            description: 'Notification channel deleted',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { deleted: { type: 'boolean' } } } } } } },
          },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Notification channel not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/notifications/channels/{id}/test': {
      post: op({
        summary: 'Send a test notification through a channel',
        tag: 'Notifications',
        description: 'The same ownership rules as update and delete apply. The test payload contains the full template field set, with empty date fields.',
        stateChanging: true,
        params: [idParam()],
        responses: {
          200: {
            description: 'Test notification sent',
            content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
          },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Notification channel not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },

    // --- Health module ---
  };
}
