# Changelog

## [0.3.0](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.38...airlock-bot-v0.3.0) (2026-08-22)


### ⚠ BREAKING CHANGES

* **config:** the default flips from on-for-all to per-agent (off unless an agent opts in). Set server.expose_tools_api: all (or opt agents in) to keep prior behavior; explicit legacy true/false still work.

### Features

* **audit:** log request lifecycle (received → dispatched → result) by request_id ([#153](https://github.com/airlock-dev/airlock/issues/153)) ([8278b6f](https://github.com/airlock-dev/airlock/commit/8278b6f16f1887810b47f093f14c213362e07809))
* **command-policy:** general allow/ask/deny router for dispatcher-tool command args ([#158](https://github.com/airlock-dev/airlock/issues/158)) ([38ab1b0](https://github.com/airlock-dev/airlock/commit/38ab1b0b07c986ee2a04bbb26003234e3acdbe29))
* **config:** optional default_profile inherited by every agent ([#156](https://github.com/airlock-dev/airlock/issues/156)) ([70da4ff](https://github.com/airlock-dev/airlock/commit/70da4ffef16dd0f406a05e77951d0721b668e2a0))
* **config:** per-agent expose_tools_api with all/none/per-agent modes ([#146](https://github.com/airlock-dev/airlock/issues/146)) ([4ba0ac4](https://github.com/airlock-dev/airlock/commit/4ba0ac4616a95a1778515159363599efa052f527))
* **dashboard:** show provider status issue count ([#151](https://github.com/airlock-dev/airlock/issues/151)) ([7017451](https://github.com/airlock-dev/airlock/commit/70174519748b306ebd3188d09165b1348d19d442))
* expose agent-visible provider status ([#149](https://github.com/airlock-dev/airlock/issues/149)) ([5f037ea](https://github.com/airlock-dev/airlock/commit/5f037eac50e93a21b632aec9b10af34539555955))
* **health:** report per-provider credential health, not just reachability ([#168](https://github.com/airlock-dev/airlock/issues/168)) ([fee65ca](https://github.com/airlock-dev/airlock/commit/fee65cae4a3bea6110209888fa68a21abaaaea75))
* **oauth:** proactively refresh access tokens before expiry ([#164](https://github.com/airlock-dev/airlock/issues/164)) ([4ef11ff](https://github.com/airlock-dev/airlock/commit/4ef11ff14660b0ec2c37a77cb536c40dd1682415))
* per-agent session bulkheads so one agent can't starve the others ([#150](https://github.com/airlock-dev/airlock/issues/150)) ([575784e](https://github.com/airlock-dev/airlock/commit/575784e7a6f38f351b3713faa763a775cce1dd09))
* **pool:** authenticate providers as an app via client_credentials ([#169](https://github.com/airlock-dev/airlock/issues/169)) ([d293d5d](https://github.com/airlock-dev/airlock/commit/d293d5d9d3e7498372ef7ef0981f79938fa75be6))
* **registry:** detect tool-catalog drift — fingerprints and two lint rules ([#170](https://github.com/airlock-dev/airlock/issues/170)) ([ce8d1c8](https://github.com/airlock-dev/airlock/commit/ce8d1c8340654ba6ded08cbbe0a45b0764f87c10))
* **registry:** proxy MCP server instructions, and let config extend them ([#165](https://github.com/airlock-dev/airlock/issues/165)) ([5639398](https://github.com/airlock-dev/airlock/commit/5639398de6f4c2340ecc0974cfb4289d158c1e2b))
* **transport:** log MCP requests at the transport layer to surface session wedges ([#154](https://github.com/airlock-dev/airlock/issues/154)) ([416b6e5](https://github.com/airlock-dev/airlock/commit/416b6e5b9bd92b467b9257b258beb6357fc20991))


### Bug Fixes

* align docs and reject complex parameters ([#159](https://github.com/airlock-dev/airlock/issues/159)) ([2397579](https://github.com/airlock-dev/airlock/commit/23975794ca5abe7743bcc2ab57d0815a64c3f680))
* close reaped sessions before HITL requests ([#171](https://github.com/airlock-dev/airlock/issues/171)) ([6f01ba7](https://github.com/airlock-dev/airlock/commit/6f01ba74b26fe8d89f9a0a9911e2d42133cd2078))
* **command-policy:** carry `default` through the profile merge ([#160](https://github.com/airlock-dev/airlock/issues/160)) ([fd4c41c](https://github.com/airlock-dev/airlock/commit/fd4c41c87a10348a9176a5c35e28371cd7badeb1))
* **companion:** avoid status item redraw loop ([#161](https://github.com/airlock-dev/airlock/issues/161)) ([e907420](https://github.com/airlock-dev/airlock/commit/e9074207b445cde2547494c99d607e7ba937f057))
* **companion:** constrain status icon and notarize dmg ([#162](https://github.com/airlock-dev/airlock/issues/162)) ([ab3b6e8](https://github.com/airlock-dev/airlock/commit/ab3b6e897dc7e6edafccc4e154fa5e226f42e95f))
* **middleware:** trust built-in Airlock output ([#173](https://github.com/airlock-dev/airlock/issues/173)) ([68a71c7](https://github.com/airlock-dev/airlock/commit/68a71c7f0139c823971b95a79cf800e837630d3a))
* **oauth:** accept stateless loopback callbacks when no state was issued ([#163](https://github.com/airlock-dev/airlock/issues/163)) ([b768fec](https://github.com/airlock-dev/airlock/commit/b768fec43c1134c36b4106e4d0ecb2fa28c6b8c4))
* **oauth:** harden refresh and credential persistence ([#172](https://github.com/airlock-dev/airlock/issues/172)) ([2db1ee7](https://github.com/airlock-dev/airlock/commit/2db1ee732a969439e47db94eca4fe47de0fa3d55))
* **oauth:** preserve refresh_token when a refresh response omits one ([#155](https://github.com/airlock-dev/airlock/issues/155)) ([cfac992](https://github.com/airlock-dev/airlock/commit/cfac992b9ef6bfc0979f041257ded016f8257a67))
* **pool:** stop leaking MCP sessions and stop giving up on downed providers ([#167](https://github.com/airlock-dev/airlock/issues/167)) ([8a780f7](https://github.com/airlock-dev/airlock/commit/8a780f7ec873a40a0952166dd98912c1a80b425d))
* **registry:** demote upstream headings in proxied instructions ([#166](https://github.com/airlock-dev/airlock/issues/166)) ([6a306ce](https://github.com/airlock-dev/airlock/commit/6a306ce1f8680b68843b8107c8bec8711aa35798))
* **transport:** TCP keep-alive so silently-dead peers release their MCP session ([#152](https://github.com/airlock-dev/airlock/issues/152)) ([597f3a6](https://github.com/airlock-dev/airlock/commit/597f3a6695d38c1d7b00fdd0da04e3426b79762b))

## [0.2.38](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.37...airlock-bot-v0.2.38) (2026-06-25)


### Features

* add Airlock notification tools ([#125](https://github.com/airlock-dev/airlock/issues/125)) ([6f9f61f](https://github.com/airlock-dev/airlock/commit/6f9f61f7628154d1e82b16b911380c9e636f06e6))
* add config introspection CLI ([#124](https://github.com/airlock-dev/airlock/issues/124)) ([d6103fc](https://github.com/airlock-dev/airlock/commit/d6103fce9a1496fbc62e7cb02e73fbefcf647739))
* add local TestFlight release lane ([#135](https://github.com/airlock-dev/airlock/issues/135)) ([1e02d16](https://github.com/airlock-dev/airlock/commit/1e02d1628dc873238b692afb4e98243ac4230777))
* add reusable argument scoping ([#115](https://github.com/airlock-dev/airlock/issues/115)) ([ca48a96](https://github.com/airlock-dev/airlock/commit/ca48a96be314e314975c165a6c6d26d980cb3ae0))
* add staged secret scanner ([#123](https://github.com/airlock-dev/airlock/issues/123)) ([0abb684](https://github.com/airlock-dev/airlock/commit/0abb684568ce4133348be34b26596f184befe73e))
* **config:** split management API secret ([#129](https://github.com/airlock-dev/airlock/issues/129)) ([27c9c64](https://github.com/airlock-dev/airlock/commit/27c9c64f77348a0687c9930b089cc8a1d774ddb4))
* **ios:** add companion approval app ([#122](https://github.com/airlock-dev/airlock/issues/122)) ([57a2265](https://github.com/airlock-dev/airlock/commit/57a2265eb4c8329dce0cd2a4cce32c5baeb996be))
* **lint:** add rule severities and summary output ([#136](https://github.com/airlock-dev/airlock/issues/136)) ([f41e021](https://github.com/airlock-dev/airlock/commit/f41e021fed6f8e5680c29baed93dc89fa4882b26))
* propagate MCP session identity ([#118](https://github.com/airlock-dev/airlock/issues/118)) ([75d2892](https://github.com/airlock-dev/airlock/commit/75d2892f24ccd94ecdd9a6f2c97cbcdcd9ab7b05))
* split management API listener ([#120](https://github.com/airlock-dev/airlock/issues/120)) ([dfb23c7](https://github.com/airlock-dev/airlock/commit/dfb23c70a6cc41b043f9bc40703c4e4ff0db4f29))


### Bug Fixes

* **config:** fail closed on misconfigured argument policies ([#134](https://github.com/airlock-dev/airlock/issues/134)) ([608efd8](https://github.com/airlock-dev/airlock/commit/608efd82b583ed50f16a08c397cbe7144f1a3324))
* enforce agent tokens on tools api ([#119](https://github.com/airlock-dev/airlock/issues/119)) ([fcd5e92](https://github.com/airlock-dev/airlock/commit/fcd5e926ca8e8f8c540e07b21e9f865179339af4))
* harden gateway security boundaries ([#133](https://github.com/airlock-dev/airlock/issues/133)) ([a2af2a5](https://github.com/airlock-dev/airlock/commit/a2af2a546bd794ac553c64d4ab75ee1b655eea0e))
* **hitl:** decouple approval stream hub ([#145](https://github.com/airlock-dev/airlock/issues/145)) ([c5e398b](https://github.com/airlock-dev/airlock/commit/c5e398b55743f44df373d9a32466a83cadcf9336))
* **macos:** correct companion settings version state ([#137](https://github.com/airlock-dev/airlock/issues/137)) ([c3e10ef](https://github.com/airlock-dev/airlock/commit/c3e10efb80525aaf040bce1b3a8e91467b3c0d11))
* **macos:** show reason in expanded approvals ([#139](https://github.com/airlock-dev/airlock/issues/139)) ([8414693](https://github.com/airlock-dev/airlock/commit/8414693b59651dd44cfa299f8ab4b7b9a5a646cd))
* **macos:** stabilize companion connection state ([#144](https://github.com/airlock-dev/airlock/issues/144)) ([6099856](https://github.com/airlock-dev/airlock/commit/6099856840d02e7cbbf576eb2a1b01201e450e2e))
* **macos:** support authenticated dashboard sync ([#121](https://github.com/airlock-dev/airlock/issues/121)) ([1c743b0](https://github.com/airlock-dev/airlock/commit/1c743b0f9d160450912c02a61dc060ce0615aae0))
* require canonical approval ids ([#143](https://github.com/airlock-dev/airlock/issues/143)) ([2fe9678](https://github.com/airlock-dev/airlock/commit/2fe9678b2dde6e3c12ed96013cf60a97e462e104))
* stream mobile approval updates ([#142](https://github.com/airlock-dev/airlock/issues/142)) ([8580a3d](https://github.com/airlock-dev/airlock/commit/8580a3d5b584aabc8573c5439cc8fc1acfc9c8f9))

## [0.2.37](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.36...airlock-bot-v0.2.37) (2026-06-19)


### Features

* add profile inheritance ([#113](https://github.com/airlock-dev/airlock/issues/113)) ([2e92eda](https://github.com/airlock-dev/airlock/commit/2e92edab64962652c7ee26f9060e4dc00975dfaa))
* add tool argument policy ([#114](https://github.com/airlock-dev/airlock/issues/114)) ([5077222](https://github.com/airlock-dev/airlock/commit/5077222a4e0c83ee4d0b54ebe92a8c41e02a9777))
* **config:** add agent creation flow ([#110](https://github.com/airlock-dev/airlock/issues/110)) ([f215cb6](https://github.com/airlock-dev/airlock/commit/f215cb635b54710131c9f68439e76a31599279d3))


### Bug Fixes

* **configure-web:** distinguish glob-matched rules ([#112](https://github.com/airlock-dev/airlock/issues/112)) ([f8fb396](https://github.com/airlock-dev/airlock/commit/f8fb396644977a57b81a44e2e63636e8c4d49a23))

## [0.2.36](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.35...airlock-bot-v0.2.36) (2026-06-18)


### Features

* add docker split dashboard deployment ([#108](https://github.com/airlock-dev/airlock/issues/108)) ([3f817f4](https://github.com/airlock-dev/airlock/commit/3f817f401beec6d187e23e55659806caf697c9ab))
* **configure-web:** add command center activity dashboard ([#106](https://github.com/airlock-dev/airlock/issues/106)) ([55fb8f3](https://github.com/airlock-dev/airlock/commit/55fb8f367ad157f0f39bdfeecfe50bd9fa00fc35))

## [0.2.35](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.34...airlock-bot-v0.2.35) (2026-06-18)


### Features

* **config:** add command center status UI ([#105](https://github.com/airlock-dev/airlock/issues/105)) ([3b1d0a0](https://github.com/airlock-dev/airlock/commit/3b1d0a0af5ab9c7d71b730ce91881cb4dae86fcc))
* let companion remember approval decisions ([#100](https://github.com/airlock-dev/airlock/issues/100)) ([8b44dfa](https://github.com/airlock-dev/airlock/commit/8b44dfa534ebd570328f3241766a85b526815492))


### Bug Fixes

* **companion:** speed up approval popover ([#104](https://github.com/airlock-dev/airlock/issues/104)) ([ab91bfb](https://github.com/airlock-dev/airlock/commit/ab91bfb84c29df49890200ada119fde4c0b0848f))

## [0.2.34](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.33...airlock-bot-v0.2.34) (2026-06-11)


### Bug Fixes

* recover stale http mcp sessions ([#101](https://github.com/airlock-dev/airlock/issues/101)) ([b93bf28](https://github.com/airlock-dev/airlock/commit/b93bf281974b5e7ad8e09c183d6218ede65fd6e8))

## [0.2.33](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.32...airlock-bot-v0.2.33) (2026-05-23)


### Features

* **config:** add configure web UI ([#97](https://github.com/airlock-dev/airlock/issues/97)) ([55bbddc](https://github.com/airlock-dev/airlock/commit/55bbddccd145e953d582b334eff5bfc60ce41ac8))


### Bug Fixes

* **macos:** reduce companion idle work ([#99](https://github.com/airlock-dev/airlock/issues/99)) ([1e48db9](https://github.com/airlock-dev/airlock/commit/1e48db9e9fe578bcb21b39a48db93a67366f1a59))

## [0.2.32](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.31...airlock-bot-v0.2.32) (2026-05-07)


### Bug Fixes

* **oauth:** refresh registry after auth reconnect ([#95](https://github.com/airlock-dev/airlock/issues/95)) ([7f5a175](https://github.com/airlock-dev/airlock/commit/7f5a1756b6c81ed14898575288b8ecf637067537))

## [0.2.31](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.30...airlock-bot-v0.2.31) (2026-04-28)


### Bug Fixes

* **registry:** skip listTools for adapters not yet connected ([#93](https://github.com/airlock-dev/airlock/issues/93)) ([c760ad9](https://github.com/airlock-dev/airlock/commit/c760ad9c1759f94b2b94d5150d8003f0af57c446))

## [0.2.30](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.29...airlock-bot-v0.2.30) (2026-04-17)


### Bug Fixes

* **oauth:** don't block gateway startup on browser auth flow ([#91](https://github.com/airlock-dev/airlock/issues/91)) ([ad75564](https://github.com/airlock-dev/airlock/commit/ad7556482e3d896eb1dc81c25c87bf1de56d500c))

## [0.2.29](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.28...airlock-bot-v0.2.29) (2026-04-17)


### Bug Fixes

* **oauth:** re-prompt browser auth when grant is invalidated ([#89](https://github.com/airlock-dev/airlock/issues/89)) ([cc5a9ff](https://github.com/airlock-dev/airlock/commit/cc5a9ffb533047970d7602e33609fafe2ec44861))

## [0.2.28](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.27...airlock-bot-v0.2.28) (2026-04-01)


### Bug Fixes

* **oauth:** wrap state even when empty for relay compatibility ([#85](https://github.com/airlock-dev/airlock/issues/85)) ([6d0b3c7](https://github.com/airlock-dev/airlock/commit/6d0b3c72d8e0122cda89450b02e2afe16ebdb816))

## [0.2.27](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.26...airlock-bot-v0.2.27) (2026-03-31)


### Features

* **oauth:** support HTTPS relay for OAuth callbacks ([#83](https://github.com/airlock-dev/airlock/issues/83)) ([a4d7483](https://github.com/airlock-dev/airlock/commit/a4d7483d6f4ffba750b28a326d4b83411ec5982c))

## [0.2.26](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.25...airlock-bot-v0.2.26) (2026-03-31)


### Features

* **oauth:** support pre-registered OAuth client credentials ([#81](https://github.com/airlock-dev/airlock/issues/81)) ([26637b3](https://github.com/airlock-dev/airlock/commit/26637b343b90772738d0153be4df16807dda5c47))

## [0.2.25](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.24...airlock-bot-v0.2.25) (2026-03-31)


### Features

* **companion:** add launch at login toggle in settings ([3d41694](https://github.com/airlock-dev/airlock/commit/3d4169492e7a57ae3a7a1f647a0aa2c9b259dc26))
* **companion:** add launch at login toggle in settings ([#78](https://github.com/airlock-dev/airlock/issues/78)) ([6ae7f1b](https://github.com/airlock-dev/airlock/commit/6ae7f1b4eef31e7868b83c768ae3a112218329ca))
* **companion:** embed highlight.js directly for syntax coloring ([c89dd68](https://github.com/airlock-dev/airlock/commit/c89dd68d0a2363db79916ae19cda28845c88722c))
* **openclaw:** HTTP tool execution API and airlock-bridge plugin ([#72](https://github.com/airlock-dev/airlock/issues/72)) ([66ec09b](https://github.com/airlock-dev/airlock/commit/66ec09b5e51b1ba0bf04ac4ef30e67ef903d58a2))


### Bug Fixes

* **companion:** async highlight.js init to prevent UI lag on launch ([64d53c9](https://github.com/airlock-dev/airlock/commit/64d53c98a6c982ae192b6f4f81739a430a38d7ce))
* **companion:** copy SPM resource bundles into .app for release builds ([dc62403](https://github.com/airlock-dev/airlock/commit/dc62403c149fe93134024c5fabb261166c26c5bb))
* **companion:** dark mode syntax highlighting with xcode-dusk theme ([808fbe8](https://github.com/airlock-dev/airlock/commit/808fbe8ca468499b56eed4f1186bc857d29b7ba3))
* **companion:** place SPM resource bundles at .app root for Bundle.main ([3e4105e](https://github.com/airlock-dev/airlock/commit/3e4105e5bbccb539de930b2f3a431fd4be363075))
* **companion:** sign SPM resource bundles before app for codesigning ([bfd0c8a](https://github.com/airlock-dev/airlock/commit/bfd0c8a5972b4ebfe716a92c1831240438e9afbe))
* **tools-api:** map MCP isError responses to success:false in HTTP API ([#80](https://github.com/airlock-dev/airlock/issues/80)) ([882a489](https://github.com/airlock-dev/airlock/commit/882a4894ac9a680cf07bd387e5af12a16bad2e28))

## [0.2.24](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.23...airlock-bot-v0.2.24) (2026-03-20)


### Features

* **companion:** inline detail view with vim-style keyboard nav ([#73](https://github.com/airlock-dev/airlock/issues/73)) ([e8b90cd](https://github.com/airlock-dev/airlock/commit/e8b90cd51bd14cfc049f3ad89a2625d524e05bdd))

## [0.2.23](https://github.com/airlock-dev/airlock/compare/airlock-bot-v0.2.22...airlock-bot-v0.2.23) (2026-03-20)


### Bug Fixes

* **hitl:** return tool-level isError for deny/timeout + reconnect race fix ([#74](https://github.com/airlock-dev/airlock/issues/74)) ([d6e530b](https://github.com/airlock-dev/airlock/commit/d6e530bc134314a85efc063e431a6f9d39621170))

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
