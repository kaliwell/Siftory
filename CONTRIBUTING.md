# Contributing to Siftory

Siftory is an Alpha Windows desktop application. Original project code and documentation are licensed under Apache-2.0; third-party code and resources keep their own licenses. Contributions intentionally submitted for inclusion are made under the project license. Keep third-party notices and identify material copied from upstream projects.

Use the Node/npm versions pinned in `.nvmrc` and `package.json`. Follow [development setup](README.md) for native tools and optional runtime resources. Work on a task branch, preserve unrelated changes, and keep each commit focused. Project development and Git conventions are documented in [the documentation center](docs/README.md).

The supported everyday verification commands are:

| Command                               | Purpose                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run dev`                         | Start the Windows development application                                                |
| `npm run ci:verify:source`            | Types, lint, format, documentation, privacy, contracts and checked renderer build        |
| `npm run test:core-behavior`          | Search, catalog, source synchronization, automatic maintenance and vector GC behavior    |
| `npm run coverage:critical`           | Critical-module coverage with versioned minimums                                         |
| `npm run test:modern-desktop:browser` | Real React UI with a synthetic Electron bridge                                           |
| `npm run benchmark:core-search`       | Repeatable temporary-catalog measurement, with no models or user data                    |
| `npm test`                            | Full local regression chain, including tests requiring prepared native/runtime resources |

Older automation and experiment commands remain available for their specific workflows. They are not required to understand the normal development loop.

Use temporary or copied profiles for integration tests. Never run destructive tests against a contributor's real library. Keep model weights, runtime databases, private material, credentials, screenshots of personal files, and generated build/benchmark output out of Git. Review the staged snapshot with `npm run git:preflight` before committing.

For bugs, describe the version, Windows version, reproduction steps and expected/actual behavior. Provide synthetic examples and redacted diagnostics. A browser fixture passing is not evidence that every Native/model/GPU or installer combination has passed. Only claim the validation actually performed.
