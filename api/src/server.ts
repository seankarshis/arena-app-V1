import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ApolloServer } from '@apollo/server';
import fastifyApollo, { fastifyApolloDrainPlugin } from '@as-integrations/fastify';
import { cognitoAuthHook, buildContext } from './middleware/auth';
import type { AuthUser } from './middleware/auth';

export interface ArenaContext {
  user: AuthUser | null;
}

// Minimal bootstrap schema — resolvers and types are added by later tasks
const typeDefs = `#graphql
  type Query {
    _health: String
  }
`;

const resolvers = {
  Query: {
    _health: () => 'ok',
  },
};

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
  app.addHook('onRequest', cognitoAuthHook);

  // --- Health check (skipped by auth hook) ---
  app.get('/health', async (_request, reply) => {
    reply.send({ status: 'ok' });
  });

  // --- Apollo Server ---
  const apollo = new ApolloServer<ArenaContext>({
    typeDefs,
    resolvers,
    plugins: [fastifyApolloDrainPlugin(app)],
    formatError: (formattedError) => {
      // Strip stack traces in production
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
      return { user: buildContext(request) } satisfies ArenaContext;
    },
  });

  return app;
}

async function main() {
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
