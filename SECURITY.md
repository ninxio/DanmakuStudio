# Security

Studio processes untrusted XML, project files, media and optional remote-service responses. Supported release testing targets Windows x64. Local account access is trusted; projects and caches are not isolated from other processes running as that account.

Please avoid posting credentials, private media, project paths or working exploit details in public issues. Use the repository's private vulnerability reporting channel when enabled. If it is unavailable, open a minimal issue requesting a private contact channel without including the sensitive details.

Useful reports identify the affected version, input boundary, minimal synthetic reproduction and observed impact. A successful build or clean dependency scan is not a guarantee that every media decoder or input is safe.

See [privacy and local data](docs/PRIVACY.md) for storage and network boundaries.
