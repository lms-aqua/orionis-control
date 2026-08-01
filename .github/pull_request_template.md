# Summary

<!-- What changes, and why. One paragraph is usually enough. -->

## Screenshots

<!-- Required for any user-visible change. Include light AND dark appearance,
     and an iPad layout if the change affects a regular-width view. Delete this
     section only if nothing visual changed. -->

## Test evidence

<!-- Paste the actual commands and their results. Do not claim a test passed
     unless you ran it. -->

```
# e.g.
# services/mobile-api $ npm test
# ...
```

- [ ] Backend unit tests run and pass
- [ ] Backend integration tests run and pass
- [ ] iOS unit tests run and pass (or: CI is the first build — say so)
- [ ] iOS UI tests run (note any that were skipped and why)
- [ ] Manually exercised against a real gateway (describe below)

## Security impact

- [ ] No new secret is committed, logged, or returned in an API response
- [ ] Every new endpoint enforces authentication **and** authorisation server-side
- [ ] Any new state-changing action is audited
- [ ] Any new disruptive action requires explicit confirmation
- [ ] No TLS validation is weakened, and no credential moves into a URL
- [ ] Retry behaviour cannot execute a write twice (idempotency key present)

<!-- If this touches authentication, RBAC, streaming authorisation or the audit
     log, describe the threat you considered and how it is handled. -->

## API changes

- [ ] No API change
- [ ] Additive only (new field or endpoint; old clients unaffected)
- [ ] Breaking — describe the migration and bump the contract version

If the OpenAPI document changed, confirm it was regenerated and committed:

- [ ] `npm run openapi` run, `packages/api-contract/openapi.json` committed

## Migration impact

- [ ] No schema change
- [ ] New migration appended (never edited an existing one)
- [ ] Migration is idempotent and was verified against an empty database
- [ ] Rollback path described below

## Accessibility impact

- [ ] Works at accessibility Dynamic Type sizes
- [ ] VoiceOver labels are meaningful on any new control
- [ ] Status is not communicated by colour alone
- [ ] Reduce Motion and Reduce Transparency respected
- [ ] Hit targets are at least 44×44 pt

## Honest state

<!-- Anything incomplete, unverified, or blocked. This section exists so that
     partial work can be merged openly rather than described as finished. -->

- Complete:
- Partial:
- Not started:
- Blocked on:

## Checklist

- [ ] The proprietary LICENSE is unchanged
- [ ] The public README remains an overview with no deployment detail
- [ ] Commits are authored as `lms-aqua`
- [ ] No placeholder or fixture data reaches a production code path
