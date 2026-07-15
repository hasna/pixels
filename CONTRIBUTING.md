# Contributing

Use Bun for installs, tests, type checking, and builds. Keep the release-age quarantine enabled.

Before opening a pull request:

```bash
bun run check
secrets scan workspace . --pretty
git diff --cached --check
```

New providers must have a fixed origin allowlist, strict public-identifier schemas, an explicit consent purpose, tests proving default-off behavior, and no credential values in browser configuration. Do not add generic arbitrary-script or arbitrary-beacon adapters.
