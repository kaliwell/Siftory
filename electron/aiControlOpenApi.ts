import type { AiCapabilityDescriptor } from './aiControlPolicy'

export function buildAiControlOpenApi(
  capabilities: readonly AiCapabilityDescriptor[],
  port = 32145,
) {
  const paths: Record<string, unknown> = {
    '/v1/health': { get: protectedOperation('Read application health.') },
    '/v1/version': { get: protectedOperation('Read the application version.') },
    '/v1/capabilities': { get: protectedOperation('List capabilities allowed by this token.') },
    '/v1/openapi.json': { get: protectedOperation('Read this OpenAPI document.') },
    '/v1/events': { get: protectedOperation('Subscribe to redacted job events over SSE.') },
    '/v1/jobs/{jobId}': {
      get: protectedOperation('Read a redacted job.', [jobIdParameter()]),
      post: protectedOperation('Request cooperative job cancellation.', [
        jobIdParameter(),
        {
          name: 'action',
          in: 'query',
          required: true,
          schema: { type: 'string', enum: ['cancel'] },
        },
      ]),
    },
  }
  for (const capability of capabilities) {
    paths[`/v1/actions/${capability.id}`] = {
      post: {
        ...protectedOperation(capability.description),
        operationId: capability.id.replace(/\./g, '_'),
        'x-reasonix-risk': capability.risk,
        'x-reasonix-required-scopes': capability.requiredScopes,
        'x-reasonix-confirmation-required': capability.confirmationRequired,
        'x-reasonix-cancellation': capability.cancellation,
        'x-reasonix-path-policy': capability.pathPolicy,
        'x-reasonix-timeout-ms': capability.timeoutMs,
        'x-reasonix-concurrency': capability.concurrency,
        'x-reasonix-idempotency': capability.idempotency,
        'x-reasonix-result-schema': capability.outputSchema,
        parameters: [
          ...(capability.risk === 'write'
            ? [
                {
                  name: 'Idempotency-Key',
                  in: 'header',
                  required: true,
                  schema: { type: 'string', maxLength: 128 },
                },
              ]
            : []),
          ...(capability.confirmationRequired
            ? [
                {
                  name: 'X-Reasonix-Confirm',
                  in: 'header',
                  required: false,
                  description:
                    'One-time confirmation ID after the user approves the exact request in Settings.',
                  schema: { type: 'string', format: 'uuid' },
                },
              ]
            : []),
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: capability.inputSchema } },
        },
        responses: {
          '202': {
            description: 'Job accepted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['jobId'],
                  properties: {
                    jobId: { type: 'string', format: 'uuid' },
                    state: { type: 'string' },
                    requestId: { type: 'string', format: 'uuid' },
                    replayed: { type: 'boolean' },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
          '400': { description: 'Invalid input or missing idempotency key' },
          '403': { description: 'Scope denied' },
          '409': { description: 'Concurrency or idempotency conflict' },
          '428': { description: 'Explicit user confirmation required or pending' },
          '429': { description: 'Rate or confirmation queue limit exceeded' },
        },
      },
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Reasonix AI Control API',
      version: '1.0.0',
      description: 'Loopback-only, token-authenticated capability API.',
    },
    servers: [
      {
        url: 'http://127.0.0.1:{port}',
        variables: { port: { default: String(port) } },
      },
    ],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' },
      },
    },
  }
}

function protectedOperation(description: string, parameters: unknown[] = []) {
  return {
    description,
    security: [{ bearerAuth: [] }],
    ...(parameters.length > 0 ? { parameters } : {}),
    responses: {
      '200': { description: 'Success' },
      '401': { description: 'Invalid bearer token' },
      '403': { description: 'Scope denied' },
    },
  }
}

function jobIdParameter() {
  return {
    name: 'jobId',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  }
}
