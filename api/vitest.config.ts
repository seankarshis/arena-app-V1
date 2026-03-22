import { defineConfig } from 'vitest/config'

// TEST_TYPE selects which test suite to run:
//   (unset) → unit tests only  (npm run test)
//   int      → integration tests (npm run test:int)
//   e2e      → end-to-end tests  (npm run test:e2e)
const testType = process.env.TEST_TYPE

const includePatterns: Record<string, string[]> = {
  unit: ['src/**/*.test.ts'],
  int:  ['src/**/*.int.test.ts'],
  e2e:  ['src/**/*.e2e.test.ts'],
}

const include = testType
  ? (includePatterns[testType] ?? includePatterns.unit)
  : includePatterns.unit

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.int.test.ts',
        'src/**/*.e2e.test.ts',
      ],
    },
  },
})
