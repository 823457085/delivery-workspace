---
name: go-service-code-review
description: Review Go backend services for team middleware engineering standards, including DDD layering, Bootstrap Adapter startup, Nacos configuration, Makefile/Docker conventions, logging, testing, and deployment readiness. Use for Go service code review, G3 提测准入 review, backend refactoring review, or implementation-plan validation.
---

# Go Service Code Review

Use this skill for Go service implementation or review work.

## Reference Files

Load only what is needed:

- `../../core/go-coding-standard.md` for general Go language, testing, security, and G3 提测准入 rules.
- `../../core/go-service-engineering-standard.md` for company service architecture, Bootstrap, Nacos, Docker, Makefile, and review checklist.
- `../../core/code-review-standard.md` for MR/PR review dimensions, finding severity, and required evidence.
- `../../core/unit-test-standard.md` for unit test scope, coverage, exceptions, and GitLab MR review rules.
- `../../core/api-contract-standard.md` when HTTP/gRPC/Webhook contracts change.
- `../../core/db-change-standard.md` when migrations, SQL, schema, or data repair logic changes.
- `../../core/self-test-evidence-standard.md` when reviewing G3/self-test or PR evidence.

## Review Order

1. Build and tests: run the repository's standard commands where practical.
2. Architecture: verify domain, service, application, and infrastructure dependencies flow in one direction.
3. Startup: verify `cmd/*/main.go` is thin and initialization lives in a Bootstrap Adapter or equivalent.
4. Configuration: verify `-f` config path support, Nacos separation, no local secrets, and enabled flags for optional components.
5. Runtime: verify health checks, graceful shutdown, logging, context propagation, and resource cleanup.
6. Contracts and data: verify API error codes, auth, idempotency, DB compatibility, migration safety, and rollback evidence when applicable.
7. Delivery: verify Makefile/Docker/Jenkins expectations and local development commands.
8. Findings: report bugs and risks first, with file/line references.

## Output

For reviews, lead with findings ordered by severity:

- `[P0]` blocks release or corrupts data
- `[P1]` likely production bug, security issue, or serious maintainability risk
- `[P2]` important but not immediately blocking
- `[P3]` polish or optional improvement

If no issues are found, say so and mention remaining test or deployment risk.
