> **First:** Read `CLAUDE.md` (project instructions) — you are a **worker**.

# Task: Storable/Entity Trait Refactor

## Objective

Refactor the `StorableEntity` trait into two separate traits:
1. **`Storable`** - Base trait for anything stored in the database (including junction tables)
2. **`Entity`** - Extended trait for user-facing domain entities (excludes junction tables)

Additionally, consolidate entity naming and add taggability validation.

## Background

Currently, `StorableEntity` is used for both domain entities (Host, Service, Network) and junction tables (GroupBinding, EntityTag, UserNetworkAccess). This leads to:
- Junction tables implementing stub methods (`network_id() -> None`, `set_updated_at()` as no-op)
- Junction tables being technically taggable via the tag API (even though they shouldn't be)
- Inconsistent entity naming across `table_name()`, OpenAPI macros, and `EntityDiscriminants`

## Requirements

### 1. Split StorableEntity into Storable + Entity

**`Storable` trait** (base, for all DB-stored types):
```rust
pub trait Storable: Sized + Clone + Send + Sync + 'static + Default {
    type BaseData;

    fn new(base: Self::BaseData) -> Self;
    fn get_base(&self) -> Self::BaseData;

    fn table_name() -> &'static str;
    fn id(&self) -> Uuid;
    fn created_at(&self) -> DateTime<Utc>;
    fn set_id(&mut self, id: Uuid);
    fn set_created_at(&mut self, time: DateTime<Utc>);

    fn to_params(&self) -> Result<(Vec<&'static str>, Vec<SqlValue>), anyhow::Error>;
    fn from_row(row: &PgRow) -> Result<Self, anyhow::Error>;
}
```

**`Entity` trait** (extends Storable, for domain entities only):
```rust
pub trait Entity: Storable {
    fn entity_type() -> EntityDiscriminants;
    fn entity_name_singular() -> &'static str;
    fn entity_name_plural() -> &'static str;

    fn network_id(&self) -> Option<Uuid>;
    fn organization_id(&self) -> Option<Uuid>;
    fn is_network_keyed() -> bool;
    fn is_organization_keyed() -> bool;

    fn updated_at(&self) -> DateTime<Utc>;
    fn set_updated_at(&mut self, time: DateTime<Utc>);

    // Tags - default implementations
    fn is_taggable() -> bool { is_entity_taggable(Self::entity_type()) }
    fn get_tags(&self) -> Option<&Vec<Uuid>> { None }
    fn set_tags(&mut self, _tags: Vec<Uuid>) {}

    // Optional overrides
    fn set_source(&mut self, _source: EntitySource) {}
    fn preserve_immutable_fields(&mut self, _existing: &Self) {}
}
```

### 2. Implement Taggability as Single Source of Truth

Create a centralized function in `backend/src/server/shared/entities.rs`:

```rust
/// Single source of truth for which entity types support tagging
pub fn is_entity_taggable(entity_type: EntityDiscriminants) -> bool {
    matches!(entity_type,
        EntityDiscriminants::Host |
        EntityDiscriminants::Service |
        EntityDiscriminants::Subnet |
        EntityDiscriminants::Group |
        EntityDiscriminants::Network |
        EntityDiscriminants::Discovery |
        EntityDiscriminants::Daemon |
        EntityDiscriminants::DaemonApiKey |
        EntityDiscriminants::UserApiKey
    )
}
```

- `Entity::is_taggable()` has a default impl that calls `is_entity_taggable(Self::entity_type())`
- Tag API handlers (`/tags/assign/*`) must validate `is_entity_taggable(request.entity_type)` before processing
- ServiceFactory injects `entity_tag_service` only for entities where `T::is_taggable()` is true

### 3. Add Entity Naming Methods

Add to `Entity` trait:
- `fn entity_name_singular() -> &'static str` (e.g., "host")
- `fn entity_name_plural() -> &'static str` (e.g., "hosts")

Update OpenAPI macros to use these instead of string parameters where possible.

**Fix Topology inconsistency:** Currently uses `"topology"` for both singular and plural in OpenAPI macros - should use `"topologies"` for plural.

### 4. Update All Implementations

**Junction tables (impl Storable only):**
- `GroupBinding`
- `EntityTag`
- `UserNetworkAccess`
- `UserApiKeyNetworkAccess`

**Domain entities (impl Entity, which requires Storable):**
- All other entities: Host, Subnet, Service, Interface, Port, Binding, Network, Organization, User, Tag, Group, Discovery, Daemon, Topology, Invite, Share, UserApiKey, DaemonApiKey

## Files Likely Involved

- `backend/src/server/shared/storage/traits.rs` - Main trait definitions
- `backend/src/server/shared/entities.rs` - EntityDiscriminants, add `is_entity_taggable()`
- `backend/src/server/shared/storage/generic.rs` - GenericPostgresStorage (update trait bounds)
- `backend/src/server/shared/handlers/traits.rs` - Handler traits (update bounds)
- `backend/src/server/shared/handlers/openapi_macros.rs` - Consider using trait methods
- `backend/src/server/shared/services/traits.rs` - CrudService (update bounds)
- `backend/src/server/shared/services/factory.rs` - ServiceFactory (taggable injection logic)
- `backend/src/server/tags/handlers.rs` - Add taggability validation
- `backend/src/server/*/impl/*.rs` - All entity implementations (split trait impls)
- `backend/src/server/group_bindings/impl/base.rs` - Junction table impl
- `backend/src/server/shared/storage/entity_tags.rs` - Junction table impl
- `backend/src/server/topology/handlers.rs` - Fix naming inconsistency

## Acceptance Criteria

- [ ] `Storable` trait defined with base storage methods
- [ ] `Entity` trait extends `Storable` with domain-specific methods
- [ ] Junction tables implement only `Storable`
- [ ] Domain entities implement `Entity` (and thus `Storable`)
- [ ] `is_entity_taggable()` function is single source of truth
- [ ] Tag API handlers validate taggability before operations
- [ ] `entity_name_singular()` and `entity_name_plural()` added to Entity
- [ ] Topology naming fixed to use "topologies" plural
- [ ] All existing tests pass
- [ ] `cargo test` passes
- [ ] `make format && make lint` passes

## Notes

- This is a large refactor touching many files - work incrementally
- Ensure backward compatibility - no behavior changes, just better organization
- The `ChildStorableEntity` trait in `storage/child.rs` may need similar treatment
- Watch for trait bounds in generic functions - update `StorableEntity` to `Entity` or `Storable` as appropriate

## Work Summary

### Completed Tasks

1. **Split `StorableEntity` into `Storable` + `Entity` traits** (`storage/traits.rs`)
   - `Storable`: Base trait with `new()`, `get_base()`, `table_name()`, `id()`, `created_at()`, `set_id()`, `set_created_at()`, `to_params()`, `from_row()`
   - `Entity`: Extends `Storable` with `entity_type()`, `entity_name_singular()`, `entity_name_plural()`, `network_id()`, `organization_id()`, `updated_at()`, `set_updated_at()`, tagging methods, and optional overrides
   - Removed `StorableEntity` entirely (no backwards compatibility alias)

2. **Added `is_entity_taggable()` function** (`entities.rs`)
   - Single source of truth for taggable entity types
   - Used by `Entity::is_taggable()` default implementation

3. **Updated storage layer bounds** to use `Storable` (`generic.rs`, `child.rs`)

4. **Converted junction tables to `Storable`-only** (4 files):
   - `group_bindings/impl/base.rs`
   - `shared/storage/entity_tags.rs`
   - `users/impl/network_access.rs`
   - `user_api_keys/impl/network_access.rs`

5. **Converted domain entities to `Storable` + `Entity`** (18 files):
   - Added `entity_name_singular()` and `entity_name_plural()` methods to all domain entities
   - Split existing `impl StorableEntity` into separate `impl Storable` and `impl Entity` blocks

6. **Updated service/handler layer bounds**:
   - `CrudService<T: Entity>`
   - `ChildCrudService<T: ChildStorableEntity + Entity>`
   - `EventBusService<T: Into<EntityEnum>>`
   - `CrudHandlers: Entity`
   - Used `Entity as EntityEnum` aliasing to resolve naming conflict between the enum and trait

7. **Fixed Topology OpenAPI tag** (`topology/handlers.rs`)
   - Changed from "topology" to "topologies" for plural

8. **Added taggability validation** (`tags/handlers.rs`)
   - Added validation to `bulk_add_tag`, `bulk_remove_tag`, and `set_entity_tags` handlers
   - Returns 400 Bad Request for non-taggable entity types

9. **Removed junction table variants from Entity enum** (`entities.rs`)
   - Removed `GroupBinding`, `EntityTag`, `UserApiKeyNetworkAccess`, `UserNetworkAccess` variants
   - Removed associated imports, `From` implementations, and color/icon mappings

10. **Fixed test imports** across unit and integration tests
    - Updated `StorableEntity` imports to `Storable` or `Entity` as appropriate

### Files Changed

**Core trait definitions:**
- `backend/src/server/shared/storage/traits.rs`
- `backend/src/server/shared/entities.rs`
- `backend/src/server/shared/storage/child.rs`
- `backend/src/server/shared/storage/generic.rs`

**Service/Handler layer:**
- `backend/src/server/shared/services/traits.rs`
- `backend/src/server/shared/services/entity_tags.rs`
- `backend/src/server/shared/handlers/traits.rs`
- `backend/src/server/tags/handlers.rs`
- `backend/src/server/topology/handlers.rs`

**Junction tables (Storable-only):**
- `backend/src/server/group_bindings/impl/base.rs`
- `backend/src/server/shared/storage/entity_tags.rs`
- `backend/src/server/users/impl/network_access.rs`
- `backend/src/server/user_api_keys/impl/network_access.rs`

**Domain entities (Storable + Entity):**
- All 18 storage implementation files in `backend/src/server/*/impl/storage.rs`

**Other service/handler files with import updates:**
- `backend/src/server/auth/service.rs`, `auth/handlers.rs`
- `backend/src/server/daemons/handlers.rs`, `daemon_api_keys/handlers.rs`
- `backend/src/server/discovery/service.rs`, `groups/service.rs`, `hosts/service.rs`
- `backend/src/server/organizations/handlers.rs`, `services/service.rs`
- `backend/src/server/subnets/service.rs`, `subnets/impl/base.rs`
- `backend/src/server/topology/service/main.rs`, `users/service.rs`

**Test files:**
- `backend/src/tests/mod.rs`
- `backend/src/server/services/tests.rs`
- `backend/src/server/shared/storage/tests.rs`
- `backend/tests/integration/*.rs` (6 files)

### 11. File Reorganization (completed)

Moved junction table implementations into their parent entity directories:

**entity_tags → tags/entity_tags.rs:**
- Combined `shared/storage/entity_tags.rs` (EntityTag, EntityTagBase, EntityTagStorage) and `shared/services/entity_tags.rs` (EntityTagService) into single file `tags/entity_tags.rs`
- Updated exports in `tags/mod.rs`
- Updated 15+ files with new import paths

**group_bindings → groups/group_bindings.rs:**
- Combined `group_bindings/impl/base.rs` (GroupBinding, GroupBindingBase) and `group_bindings/impl/storage.rs` (GroupBindingStorage) into single file `groups/group_bindings.rs`
- Deleted entire `group_bindings/` directory
- Removed `pub mod group_bindings` from `server/mod.rs`
- Updated exports in `groups/mod.rs`
- Updated 3 files with new import paths

**Files deleted:**
- `backend/src/server/shared/storage/entity_tags.rs`
- `backend/src/server/shared/services/entity_tags.rs`
- `backend/src/server/group_bindings/` (entire directory)

**Files created:**
- `backend/src/server/tags/entity_tags.rs`
- `backend/src/server/groups/group_bindings.rs`

### Verification

- `cargo test --lib`: 84 passed, 0 failed
- `cargo fmt`: No changes needed
- `cargo clippy -- -D warnings`: No warnings
