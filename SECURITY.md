# Security policy

Only the latest release is supported. Soocial updates itself from GitHub
Releases, so staying current is one click.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
private vulnerability reporting instead:

**https://github.com/MrJOYEN/soocial/security/advisories/new**

Describe the issue, how to reproduce it, and what an attacker could do with
it. You will get an answer as fast as possible, usually within a few days.

## Scope worth knowing

- Soocial is not code signed, and updates are not signature-verified. Anyone
  controlling the repository could ship a malicious version. This is a known
  trade-off of unsigned distribution, documented in the development notes.
- The app lock and per-service codes are privacy screens: they hide the
  window, they do not encrypt session data on disk.
