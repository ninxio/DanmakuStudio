# Security

Studio processes untrusted XML, project files, media and optional remote-service responses. Supported release testing targets Windows x64. Local account access is trusted; projects and caches are not isolated from other processes running as that account.

## Supported versions

Security fixes are made on `main` and shipped in the next release. Only the latest published release is supported; please reproduce on it before reporting.

| Version | Supported |
| --- | --- |
| Latest release (currently 0.4.x) | Yes |
| Older releases | No |

## Reporting a vulnerability

Please avoid posting credentials, private media, project paths or working exploit details in public issues. Use the repository's private vulnerability reporting channel when enabled. If it is unavailable, open a minimal issue requesting a private contact channel without including the sensitive details.

Useful reports identify the affected version, input boundary, minimal synthetic reproduction and observed impact. A successful build or clean dependency scan is not a guarantee that every media decoder or input is safe.

## Threat model

[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) describes the data flows, trust boundaries, assets and a STRIDE analysis of the desktop app, with each claim tied to the source and a prioritized list of hardening steps. It separates what was verified in code from assumptions about the platform.

See [privacy and local data](docs/PRIVACY.md) for storage and network boundaries.

## Automated checks

Every push and pull request to `main` runs two GitHub Actions workflows:

- **CI** (`.github/workflows/ci.yml`, Windows): ESLint, TypeScript type checking, the Vitest unit suite (including hostile-XML and export-escaping tests in `src/infrastructure/xml/xmlHostileInput.test.ts`) and `cargo test` for `src-tauri`.
- **Security** (`.github/workflows/security.yml`, also weekly):
  - CodeQL static analysis for JavaScript/TypeScript, Rust and the workflow files themselves (`security-extended` queries).
  - `pnpm audit --prod --audit-level high` for runtime npm dependencies.
  - `cargo audit` against the RustSec advisory database.
  - OSV-Scanner across all lockfiles, with results uploaded to code scanning.
  - A CycloneDX SBOM, kept as a workflow artifact.

Workflows run with read-only default permissions; only the jobs that upload results to code scanning get `security-events: write`. Dependabot proposes weekly grouped updates for npm, Cargo and GitHub Actions.

Accepted advisories are listed, with a reason, in [`osv-scanner.toml`](osv-scanner.toml) and [`src-tauri/.cargo/audit.toml`](src-tauri/.cargo/audit.toml). Time-limited exceptions expire automatically, which makes the weekly scan fail until they are reviewed again.
