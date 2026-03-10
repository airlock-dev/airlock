# Build TypeScript
build:
    npx tsc

# Run all tests
test:
    npx vitest run

# Run tests in watch mode
test-watch:
    npx vitest

# Run only the integration test (real child process over stdio)
test-integration:
    npx vitest run test/integration.test.ts

# Open MCP Inspector against Airlock with the echo server
inspect:
    npx @modelcontextprotocol/inspector npx tsx src/index.ts -- --profile test --config test/test-gateway.yaml

# Run tests with coverage
coverage:
    npx vitest run --coverage
