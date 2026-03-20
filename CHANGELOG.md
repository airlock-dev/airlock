# Changelog

## [0.2.22](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.21...airlock-bot-v0.2.22) (2026-03-19)


### Bug Fixes

* **http-client:** cancel stale reconnect timer to prevent session ID race ([#71](https://github.com/airlock-dev/airlock/issues/71)) ([20f1db5](https://github.com/airlock-dev/airlock/commit/20f1db58a2d1d61556fe866c0014187a7ee59ba6))
* **transport:** sanitize tool names to comply with MCP name pattern ([#69](https://github.com/airlock-dev/airlock/issues/69)) ([83f843c](https://github.com/airlock-dev/airlock/commit/83f843c8f0f0bde92f6b51d4801d042025ff0c5b))

## [0.2.21](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.20...airlock-bot-v0.2.21) (2026-03-19)


### Features

* **transport:** add Streamable HTTP server transport ([#67](https://github.com/airlock-dev/airlock/issues/67)) ([89ece7e](https://github.com/airlock-dev/airlock/commit/89ece7e9a91a641ad17c014577ed75b0024844bd))

## [0.2.20](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.19...airlock-bot-v0.2.20) (2026-03-18)


### Features

* **sandbox:** add presets, tool variants, and runtime smoke tests ([#50](https://github.com/airlock-dev/airlock/issues/50)) ([750a73e](https://github.com/airlock-dev/airlock/commit/750a73ee5bb6ef1ac1dea50cebc7d1f691e57460))

## [0.2.19](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.18...airlock-bot-v0.2.19) (2026-03-18)


### Features

* add /hook endpoint for external tool approval (Claude Code, Cursor, etc.) ([#63](https://github.com/airlock-dev/airlock/issues/63)) ([b677371](https://github.com/airlock-dev/airlock/commit/b677371b96ad1d9d05d5273307cbf7393e596ece))

## [0.2.18](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.17...airlock-bot-v0.2.18) (2026-03-18)


### Bug Fixes

* **sse:** add keep-alive ping and cancel HITL on session disconnect ([#61](https://github.com/airlock-dev/airlock/issues/61)) ([fd4bedf](https://github.com/airlock-dev/airlock/commit/fd4bedf489b1aaef8177121c2933c9c57523d260))

## [0.2.17](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.16...airlock-bot-v0.2.17) (2026-03-18)


### Features

* **cli:** add completion-driven configure wizard ([#59](https://github.com/airlock-dev/airlock/issues/59)) ([a668eff](https://github.com/airlock-dev/airlock/commit/a668effd42802169a7d7805715c0e137ae887090))

## [0.2.16](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.15...airlock-bot-v0.2.16) (2026-03-17)


### Features

* **companion:** polish settings and request review ([#57](https://github.com/airlock-dev/airlock/issues/57)) ([6cd9a15](https://github.com/airlock-dev/airlock/commit/6cd9a159a6527635e1830daef555b12da8cb04b4))

## [0.2.15](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.14...airlock-bot-v0.2.15) (2026-03-17)


### Features

* **companion,dashboard:** add update visibility and keyboard approval flow ([#55](https://github.com/airlock-dev/airlock/issues/55)) ([99f0ea4](https://github.com/airlock-dev/airlock/commit/99f0ea484fcc24dcfec33e28c5c1b555c31ee347))
* **dashboard,companion:** clickable approvals, version check, keyboard shortcuts ([#53](https://github.com/airlock-dev/airlock/issues/53)) ([cb32093](https://github.com/airlock-dev/airlock/commit/cb32093a28be786763f755e8b2bcdb37812854cd))

## [0.2.14](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.13...airlock-bot-v0.2.14) (2026-03-17)


### Bug Fixes

* prevent reconnection storms and orphaned children on shutdown ([#51](https://github.com/airlock-dev/airlock/issues/51)) ([5452f90](https://github.com/airlock-dev/airlock/commit/5452f9035ecaa19eb69c0722c2d070d3d6b0163b))

## [0.2.13](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.12...airlock-bot-v0.2.13) (2026-03-17)


### Bug Fixes

* **companion:** use stored dashboard URL for API client ([#48](https://github.com/airlock-dev/airlock/issues/48)) ([8486ac5](https://github.com/airlock-dev/airlock/commit/8486ac552ec5fcadcafe1cc0f5004170c29de5ef))

## [0.2.12](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.11...airlock-bot-v0.2.12) (2026-03-17)


### Bug Fixes

* SIGKILL orphaned child processes on forced shutdown ([#46](https://github.com/airlock-dev/airlock/issues/46)) ([a852611](https://github.com/airlock-dev/airlock/commit/a85261187c18edd1bb33a7fa455ce6968da44b05))

## [0.2.11](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.10...airlock-bot-v0.2.11) (2026-03-16)


### Bug Fixes

* **dashboard:** default browser notifications to off ([#43](https://github.com/airlock-dev/airlock/issues/43)) ([9441aeb](https://github.com/airlock-dev/airlock/commit/9441aeb2e8136bfe5d01511d0ff8fb9eede9985d))

## [0.2.10](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.9...airlock-bot-v0.2.10) (2026-03-16)


### Bug Fixes

* force exit after 3s if graceful shutdown hangs ([#41](https://github.com/airlock-dev/airlock/issues/41)) ([fe96703](https://github.com/airlock-dev/airlock/commit/fe967034da8580768cab7e7c48b377a3fb2c240f))

## [0.2.9](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.8...airlock-bot-v0.2.9) (2026-03-16)


### Features

* **dashboard:** add settings for browser notifications and sound ([#39](https://github.com/airlock-dev/airlock/issues/39)) ([11575b1](https://github.com/airlock-dev/airlock/commit/11575b12a080f5d396c63bc295e8cc4f8c4bd86e))

## [0.2.8](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.7...airlock-bot-v0.2.8) (2026-03-16)


### Features

* macOS companion menu bar app for HITL approvals ([#33](https://github.com/airlock-dev/airlock/issues/33)) ([46a58cb](https://github.com/airlock-dev/airlock/commit/46a58cb3273962a38b2ab0f7a3138601464ad1c4))


### Bug Fixes

* **sse:** prevent session drops and stream encoding errors ([#35](https://github.com/airlock-dev/airlock/issues/35)) ([222fa83](https://github.com/airlock-dev/airlock/commit/222fa8368ecac717332d00c1701d4748adf27787))

## [0.2.7](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.6...airlock-bot-v0.2.7) (2026-03-16)


### Features

* **configure-agent:** injection warnings, pre-population, and TUI improvements ([#30](https://github.com/airlock-dev/airlock/issues/30)) ([9110de6](https://github.com/airlock-dev/airlock/commit/9110de6b663f63d86037bf8ed0cd2e45cf9ea82b))

## [0.2.6](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.5...airlock-bot-v0.2.6) (2026-03-16)


### Features

* trusted tool overrides and schema pre-commit check ([#29](https://github.com/airlock-dev/airlock/issues/29)) ([1088946](https://github.com/airlock-dev/airlock/commit/108894688030ebe98c67fbcd182d89fa4a5869e2))


### Bug Fixes

* **sse:** hijack reply to prevent Fastify from finalising SSE connections ([#28](https://github.com/airlock-dev/airlock/issues/28)) ([45b84ac](https://github.com/airlock-dev/airlock/commit/45b84ac37622edee65cef482fb8c89eff125cb53))

## [0.2.5](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.4...airlock-bot-v0.2.5) (2026-03-16)


### Features

* add tilde expansion for config paths and --pretty log output ([#26](https://github.com/airlock-dev/airlock/issues/26)) ([0809d41](https://github.com/airlock-dev/airlock/commit/0809d416e5f610cb967355bfa3738dc71c7202c4))

## [0.2.4](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.3...airlock-bot-v0.2.4) (2026-03-16)


### Bug Fixes

* escape AppleScript strings and improve macOS approval dialog ([#24](https://github.com/airlock-dev/airlock/issues/24)) ([cbfd071](https://github.com/airlock-dev/airlock/commit/cbfd071c3afa2b3aea7071608d618bc0c5b8044b))

## [0.2.3](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.2...airlock-bot-v0.2.3) (2026-03-15)


### Bug Fixes

* pass through downstream MCP response shape instead of re-wrapping ([#19](https://github.com/airlock-dev/airlock/issues/19)) ([a695ace](https://github.com/airlock-dev/airlock/commit/a695acead17625fa91b1a1df61d1a352177a4ed3))
* register onClientReady after registry is initialized ([#17](https://github.com/airlock-dev/airlock/issues/17)) ([c4e1380](https://github.com/airlock-dev/airlock/commit/c4e1380d2c7ec0d7bde65eea60dd45921f8b75f2))
* substitute env vars in SSE and HTTP provider headers ([#21](https://github.com/airlock-dev/airlock/issues/21)) ([1ed6907](https://github.com/airlock-dev/airlock/commit/1ed690753065ac7873078f6fd0dc088963fde566))

## [0.2.2](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.1...airlock-bot-v0.2.2) (2026-03-15)


### Features

* wire configure-agent as a CLI subcommand ([#14](https://github.com/airlock-dev/airlock/issues/14)) ([ecb3d7a](https://github.com/airlock-dev/airlock/commit/ecb3d7ab523a2440d63e6f95b579fc037b3b9362))


### Bug Fixes

* read MCP server version from package.json instead of hardcoding ([#16](https://github.com/airlock-dev/airlock/issues/16)) ([e06c707](https://github.com/airlock-dev/airlock/commit/e06c707fa58e373af61b139378b1f1e7e83b57da))

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
