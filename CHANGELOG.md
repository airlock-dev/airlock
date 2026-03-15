# Changelog

## [0.2.1](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.0...airlock-bot-v0.2.1) (2026-03-15)


### Features

* add browser push notifications to dashboard HITL provider ([a84ea13](https://github.com/airlock-dev/airlock/commit/a84ea13817c8d6b4c678b74c3808a493ddc1cb45))
* add HTTP/OAuth transport, composite HITL providers, hot-reload MCPs ([b7b001a](https://github.com/airlock-dev/airlock/commit/b7b001a9af3e0f22e55efa498533a9ba80c005c0))
* add macOS dialog and web dashboard HITL providers ([093e40a](https://github.com/airlock-dev/airlock/commit/093e40a87f41a602928d4ecd40da13f1cd9ba4b0))
* add Slack and generic webhook HITL providers (Phase 4) ([92b1ff1](https://github.com/airlock-dev/airlock/commit/92b1ff15ed773947d7270fcaafe7c9636909ba08))
* add TUI HITL provider for terminal-based approve/deny ([a4ecc7d](https://github.com/airlock-dev/airlock/commit/a4ecc7dd61b1cf917925a8d829c7022633a5d256))
* backend adapter interface with MCP, HTTP, and exec adapters ([#6](https://github.com/airlock-dev/airlock/issues/6)) ([7e6911e](https://github.com/airlock-dev/airlock/commit/7e6911e2288bcd83cd7577cc0028d7b02d5cee9e))
* CLI and API discovery system for auto-generating config ([#9](https://github.com/airlock-dev/airlock/issues/9)) ([82420fe](https://github.com/airlock-dev/airlock/commit/82420fe46224b433b9c21566b28f7ee91b823b94))
* CLI backend adapter for exposing shell commands as MCP tools ([#7](https://github.com/airlock-dev/airlock/issues/7)) ([527fa94](https://github.com/airlock-dev/airlock/commit/527fa949a2e715e0606b18fef8bc0d9157fc6ada))
* composable middleware system for tool-call pipeline ([#1](https://github.com/airlock-dev/airlock/issues/1)) ([1c93492](https://github.com/airlock-dev/airlock/commit/1c93492477b219f65f5c7b27f291da8cbe027e93))
* composable permission profiles with agent inheritance ([#5](https://github.com/airlock-dev/airlock/issues/5)) ([171419d](https://github.com/airlock-dev/airlock/commit/171419de36fadc8ef531b6454202b241419edfbd))
* configure-agent TUI for building allow/ask/deny lists ([#10](https://github.com/airlock-dev/airlock/issues/10)) ([9997e94](https://github.com/airlock-dev/airlock/commit/9997e946afc59e33d99b6f64968e75747cc32b67))
* generate JSON schema for YAML config editor support ([a38e1bc](https://github.com/airlock-dev/airlock/commit/a38e1bcb636879cdfb11cd58eaae96da2d997ebf))
* HTTP/OAuth transport, composite HITL, hot-reload MCPs ([69c1aac](https://github.com/airlock-dev/airlock/commit/69c1aac76ec09d599b7da60a29321a320300d236))
* OpenAPI backend adapter for exposing REST APIs as MCP tools ([#8](https://github.com/airlock-dev/airlock/issues/8)) ([ed21f7c](https://github.com/airlock-dev/airlock/commit/ed21f7c201a8d3a33ddba8e684cba4893a4c2a4f))
* wire BackendAdapter into gateway, enabling clis and apis config ([#11](https://github.com/airlock-dev/airlock/issues/11)) ([ae86eb4](https://github.com/airlock-dev/airlock/commit/ae86eb4549e9545582fe4df28dcab2683332fd39))


### Bug Fixes

* resolve all ESLint violations and add tooling config ([#4](https://github.com/airlock-dev/airlock/issues/4)) ([3b68e6a](https://github.com/airlock-dev/airlock/commit/3b68e6adc148a6048b8f2a79d78e98a982e4c0f0))
* send all pino logs to stderr so stdout stays clean for MCP stdio ([d640307](https://github.com/airlock-dev/airlock/commit/d6403078bab5b95b499c951f0cb24a0008f37bdc))
* upgrade better-sqlite3 to v11 for Node 24 compatibility ([4527caf](https://github.com/airlock-dev/airlock/commit/4527caff866e356b15661209743cf9675ad6d2aa))
