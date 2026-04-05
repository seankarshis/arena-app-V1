// MUST be first import — starts OTel SDK before Fastify/Prisma/HTTP modules load
import './instrumentation';
import { validateObservabilityConfig } from './observability/validateConfig';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ApolloServer } from '@apollo/server';
import fastifyApollo, { fastifyApolloDrainPlugin } from '@as-integrations/fastify';
import { PrismaClient } from '@prisma/client';
import { createCognitoAuthHook, buildContext } from './middleware/auth';
import { typeDefs } from './schema/typedefs';
import { resolvers } from './schema/resolvers';
import { buildArenaContext, type ArenaContext } from './schema/context';
import { ssePlugin } from './sse/stream';

const prisma = new PrismaClient();

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  // --- Plugins ---
  if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
    throw new Error('CORS_ORIGIN environment variable is required in production');
  }
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  });
  await app.register(helmet, {
    contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
  });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // --- Auth hook (runs before every request) ---
  app.addHook('onRequest', createCognitoAuthHook(prisma));

  // --- Health check (skipped by auth hook) ---
  app.get('/health', async (_request, reply) => {
    reply.send({ status: 'ok' });
  });

  // --- SSE + TTS routes ---
  await app.register(ssePlugin, { prisma, apiKey: process.env.CLAUDE_API_KEY });

  // --- Apollo Server ---
  const apollo = new ApolloServer<ArenaContext>({
    typeDefs,
    resolvers,
    plugins: [fastifyApolloDrainPlugin(app)],
    formatError: (formattedError) => {
      if (process.env.NODE_ENV === 'production') {
        return {
          message: formattedError.message,
          extensions: formattedError.extensions,
        };
      }
      return formattedError;
    },
  });

  await apollo.start();

  await app.register(fastifyApollo(apollo), {
    path: '/graphql',
    context: async (request) => {
      const user = buildContext(request);
      return buildArenaContext(user, prisma);
    },
  });

  return app;
}

async function main() {
  await validateObservabilityConfig();
  const app = await buildServer();
  const host = process.env.HOST || '0.0.0.0';
  const port = parseInt(process.env.PORT || '3001', 10);

  try {
    await app.listen({ host, port });
    app.log.info('Arena API server listening on %s:%d', host, port);
  } catch (err) {
    app.log.error('Failed to start server: %s', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
