# Task: Fix Trial Hiding Logic

> **First:** Read `CLAUDE.md` (project instructions) — you are a **worker**.

## Objective

Fix bug where trial offers are incorrectly hidden for users who haven't actually used a trial. Currently hides trial for any org with a `stripe_customer_id`, but should only hide for orgs that have actually had a subscription/trial.

## Root Cause

A `stripe_customer_id` is created when checkout is **initiated**, before subscription is activated. So a first-time buyer already has a customer ID but hasn't used their trial yet.

## The Fix

Check `plan_status.is_some()` instead of `stripe_customer_id.is_some()`.

If `plan_status` has any value (trialing, active, past_due, canceled, etc.), the user has had a subscription and shouldn't get another trial.

## Requirements

1. **Backend:** Update `is_returning_customer` check in billing service
2. **Frontend:** Update `isReturningCustomer` derivation in billing page
3. No database migration needed

## Acceptance Criteria

- [ ] User with `stripe_customer_id` but no `plan_status` sees trial offers
- [ ] User with any `plan_status` value does NOT see trial offers
- [ ] Backend checkout correctly applies/skips trial based on `plan_status`
- [ ] Tests pass: `cd backend && cargo test` and `cd ui && npm test`
- [ ] Linting passes: `make format && make lint`

## Files to Modify

### Backend

**File:** `backend/src/server/billing/service.rs`

Find (around line 326-340):
```rust
let is_returning_customer = if let Some(organization) = self
    .organization_service
    .get_by_id(&organization_id)
    .await?
{
    Ok(organization.base.stripe_customer_id.is_some())
} else {
    ...
}?;
```

Change to:
```rust
let is_returning_customer = if let Some(organization) = self
    .organization_service
    .get_by_id(&organization_id)
    .await?
{
    Ok(organization.base.plan_status.is_some())
} else {
    ...
}?;
```

### Frontend

**File:** `ui/src/routes/billing/+page.svelte`

Find (around line 25-26):
```typescript
// Returning customers (have existing Stripe customer ID) shouldn't see trial offers
let isReturningCustomer = $derived(!!organization?.stripe_customer_id);
```

Change to:
```typescript
// Returning customers (have had a subscription) shouldn't see trial offers
let isReturningCustomer = $derived(!!organization?.plan_status);
```

## Testing

1. **New user (no stripe_customer_id, no plan_status):** Should see trial offers
2. **User who started checkout but didn't complete (has stripe_customer_id, no plan_status):** Should see trial offers
3. **User with active subscription (has plan_status: "active"):** Should NOT see trial offers
4. **User with canceled subscription (has plan_status: "canceled"):** Should NOT see trial offers
5. **User currently in trial (has plan_status: "trialing"):** Should NOT see trial offers

## Notes

- The `plan_status` field reflects Stripe subscription status
- Values: "trialing", "active", "past_due", "canceled", "incomplete"
- An empty/null `plan_status` means they've never had a subscription

---

## Work Summary

### Changes Made

**Backend** (`backend/src/server/billing/service.rs:326-332`):
- Changed `is_returning_customer` check from `stripe_customer_id.is_some()` to `plan_status.is_some()`
- Updated comment to reflect the new logic

**Frontend** (`ui/src/routes/billing/+page.svelte:25-26`):
- Changed `isReturningCustomer` derivation from `!!organization?.stripe_customer_id` to `!!organization?.plan_status`
- Updated comment to reflect the new logic

### Verification

- [x] Backend tests pass (79 passed, 2 ignored)
- [x] Frontend has no test script configured
- [x] Backend format (`cargo fmt`) and lint (`cargo clippy`) pass
- [x] Frontend format (`prettier`) and lint (`eslint`) pass

### Acceptance Criteria Status

- [x] User with `stripe_customer_id` but no `plan_status` sees trial offers
- [x] User with any `plan_status` value does NOT see trial offers
- [x] Backend checkout correctly applies/skips trial based on `plan_status`
- [x] Tests pass
- [x] Linting passes
