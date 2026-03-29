import { ApolloClient, InMemoryCache, createHttpLink } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { getIdToken, getBypassUserId } from '@/lib/auth';

const isBypass = process.env.NEXT_PUBLIC_COGNITO_BYPASS === 'true';

const httpLink = createHttpLink({
  uri: process.env.NEXT_PUBLIC_GRAPHQL_URL ?? 'http://localhost:3001/graphql',
});

const authLink = setContext(async (_, { headers }) => {
  if (isBypass) {
    const bypassUserId = getBypassUserId();
    return {
      headers: {
        ...headers,
        ...(bypassUserId ? { 'x-mock-user-id': bypassUserId } : {}),
      },
    };
  }
  const token = await getIdToken();
  return {
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
});

const apolloClient = new ApolloClient({
  link: authLink.concat(httpLink),
  cache: new InMemoryCache(),
  defaultOptions: {
    watchQuery: { fetchPolicy: 'cache-and-network' },
  },
});

export default apolloClient;
