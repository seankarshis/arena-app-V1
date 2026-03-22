import crypto from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

export interface AuthUser {
  userId: string;
  groups: string[];
  email?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

interface JWK {
  kid: string;
  kty: string;
  alg: string;
  use: string;
  n: string;
  e: string;
}

interface JWKS {
  keys: JWK[];
}

interface JWTHeader {
  kid: string;
  alg: string;
}

interface CognitoClaims {
  sub: string;
  email?: string;
  'cognito:groups'?: string[];
  token_use: string;
  iss: string;
  exp: number;
  iat: number;
}

let cachedJwks: JWKS | null = null;
let jwksCachedAt = 0;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function base64urlDecode(input: string): Buffer {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeJwtParts(token: string): { header: JWTHeader; payload: CognitoClaims; signatureInput: string; signature: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const header = JSON.parse(base64urlDecode(parts[0]).toString('utf8')) as JWTHeader;
  const payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8')) as CognitoClaims;
  const signatureInput = `${parts[0]}.${parts[1]}`;
  const signature = base64urlDecode(parts[2]);
  return { header, payload, signatureInput, signature };
}

function getJwksUrl(): string {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const region = process.env.COGNITO_REGION || process.env.AWS_REGION || 'us-east-2';
  if (!userPoolId) {
    throw new Error('COGNITO_USER_POOL_ID environment variable is required');
  }
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;
}

function getIssuer(): string {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const region = process.env.COGNITO_REGION || process.env.AWS_REGION || 'us-east-2';
  if (!userPoolId) {
    throw new Error('COGNITO_USER_POOL_ID environment variable is required');
  }
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

async function fetchJwks(): Promise<JWKS> {
  const now = Date.now();
  if (cachedJwks && now - jwksCachedAt < JWKS_CACHE_TTL_MS) {
    return cachedJwks;
  }

  const url = getJwksUrl();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status} ${response.statusText}`);
  }

  cachedJwks = (await response.json()) as JWKS;
  jwksCachedAt = now;
  return cachedJwks;
}

function findKey(jwks: JWKS, kid: string): JWK {
  const key = jwks.keys.find((k) => k.kid === kid);
  if (!key) {
    throw new Error(`No matching key found for kid: ${kid}`);
  }
  return key;
}

function verifySignature(jwk: JWK, signatureInput: string, signature: Buffer): boolean {
  const publicKey = crypto.createPublicKey({
    key: {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
    },
    format: 'jwk',
  });

  return crypto.verify(
    'RSA-SHA256',
    Buffer.from(signatureInput, 'utf8'),
    publicKey,
    signature,
  );
}

function validateClaims(payload: CognitoClaims): void {
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    throw new Error('Token has expired');
  }

  if (payload.token_use !== 'access' && payload.token_use !== 'id') {
    throw new Error(`Invalid token_use: ${payload.token_use}`);
  }

  const expectedIssuer = getIssuer();
  if (payload.iss !== expectedIssuer) {
    throw new Error('Invalid token issuer');
  }
}

async function verifyToken(token: string): Promise<AuthUser> {
  const { header, payload, signatureInput, signature } = decodeJwtParts(token);

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported algorithm: ${header.alg}`);
  }

  const jwks = await fetchJwks();
  const key = findKey(jwks, header.kid);
  const isValid = verifySignature(key, signatureInput, signature);
  if (!isValid) {
    throw new Error('Invalid token signature');
  }

  validateClaims(payload);

  return {
    userId: payload.sub,
    groups: payload['cognito:groups'] || [],
    email: payload.email,
  };
}

function getBypassUser(): AuthUser {
  return {
    userId: process.env.COGNITO_MOCK_USER_ID || '00000000-0000-0000-0000-000000000001',
    groups: (process.env.COGNITO_MOCK_GROUPS || 'admin').split(',').map((g) => g.trim()),
    email: 'dev@localhost',
  };
}

function extractToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export async function cognitoAuthHook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Skip auth for health check
  if (request.url === '/health') return;

  const isBypass = process.env.COGNITO_BYPASS === 'true';

  if (isBypass) {
    request.user = getBypassUser();
    return;
  }

  const token = extractToken(request);
  if (!token) {
    reply.code(401).send({
      errors: [{
        message: 'Missing or invalid Authorization header',
        extensions: { code: 'UNAUTHORIZED' },
      }],
    });
    return;
  }

  try {
    request.user = await verifyToken(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token validation failed';
    request.log.warn({ err }, 'JWT validation failed');
    reply.code(401).send({
      errors: [{
        message,
        extensions: { code: 'UNAUTHORIZED' },
      }],
    });
  }
}

export function buildContext(request: FastifyRequest): AuthUser | null {
  return request.user || null;
}

// Export for testing
export { verifyToken, getBypassUser, extractToken, fetchJwks as _fetchJwks };
