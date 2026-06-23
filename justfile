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

# Run with dashboard HITL (open http://localhost:4112 for approvals)
dev:
    npx tsx src/index.ts --profile dev --config examples/local-dev.yaml

# Run tests with coverage
coverage:
    npx vitest run --coverage

# Install iOS TestFlight release gems into ios-companion/vendor/bundle
ios-testflight-setup:
    cd ios-companion && BUNDLE_PATH=vendor/bundle bundle install

# Write ios-companion/.env.local from the local 1Password item
ios-testflight-env:
    cd ios-companion && ./scripts/write-testflight-env-from-1password

# Upload the iOS companion to TestFlight from this Mac
ios-testflight:
    cd ios-companion && BUNDLE_PATH=vendor/bundle bundle exec fastlane beta --env local
