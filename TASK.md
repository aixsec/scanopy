> **First:** Read `CLAUDE.md` (project instructions) — you are a **worker**.

# Task: SNMP Support Implementation

## Issues
- https://github.com/scanopy/scanopy/issues/226
- https://github.com/scanopy/scanopy/issues/64

## User Feedback
Users want SNMP-based monitoring with visibility into:
- Switch and firewall port status
- IP/MAC address to port mappings
- Device vendor information
- VLAN details
- Click-through to device console/management pages
- Network switch-to-switch/host link discovery

## Current State (Pre-Investigation)
- SNMP dependency exists: `snmp2 = "0.4.8"` in Cargo.toml
- Basic SNMP service detection exists in `daemon/utils/scanner.rs`
- Tests for `sysDescr` OID query with "public" community string
- No actual SNMP data collection beyond port detection

## API Testing
```
API Key: scp_u_YANq5G2OLn7zir5ixPydwe3WrXOsaWyw
Network ID: b19b9406-8e6e-44ed-a68e-c65e7738ff09
```

---

## Work Summary

### Phase 1: Scoping Completed

#### 1. Existing SNMP Code Audit

**Current Capability (`daemon/utils/scanner.rs:546-569`):**
- `test_snmp_service()` function exists for UDP port 161 detection
- Uses `snmp2` crate with hardcoded "public" community string
- Only queries `sysDescr` OID (1.3.6.1.2.1.1.1.0) to detect SNMP presence
- Returns `Some(161)` if response received, used for port detection only
- **No actual SNMP data collection** - purely a "is SNMP running?" check

**SNMP Dependency:** `snmp2 = "0.4.8"` supports both SNMPv2c and SNMPv3 (v3 requires enabling the `v3` feature flag). This crate is actively maintained and provides both sync and async sessions. We'll use v2c functionality for MVP but the same crate supports v3 when we add it later - no crate swap needed.

#### 2. Current Data Model Analysis

**Host Entity (`server/hosts/impl/base.rs`):**
- Fields: `name`, `network_id`, `hostname`, `description`, `source`, `virtualization`, `hidden`, `tags`
- No vendor/device type fields exist

**Interface Entity (`server/interfaces/impl/base.rs`):**
- Fields: `network_id`, `host_id`, `subnet_id`, `ip_address`, `mac_address`, `name`, `position`
- Represents an IP address assignment on a subnet (not an SNMP ifTable entry)
- Note: Named "Interface" but semantically closer to "IpAddress" or "AddressAssignment"

**Port Entity (`server/ports/impl/base.rs`):**
- Represents TCP/UDP application layer ports (SSH, HTTP, SNMP, etc.)
- NOT physical switch ports
- Has predefined `PortType::Snmp` (161/UDP)

**Topology (`server/topology/types/edges.rs`):**
- Edge types: `Interface`, `HostVirtualization`, `ServiceVirtualization`, `RequestPath`, `HubAndSpoke`
- No physical link edge type yet

---

### 3. Data Model Design

#### 3.1 MAC Address Table (Storable, not Entity)

MAC addresses are stored in a dedicated table to serve as a single source of truth for both Interface and IfEntry. This is a `Storable` (not an `Entity`) - no CRUD API, hydrated onto related entities in the service layer.

**Rust Types:**
```rust
/// Stored in mac_addresses table - Storable but not Entity
/// Hydrated onto Interface and IfEntry in service layer
pub struct MacAddressRecord {
    pub id: Uuid,
    pub mac_address: MacAddress,
    pub arp_discovered_at: Option<DateTime<Utc>>,
    pub snmp_discovered_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl MacAddressRecord {
    pub fn discovered_via_arp(&self) -> bool {
        self.arp_discovered_at.is_some()
    }

    pub fn discovered_via_snmp(&self) -> bool {
        self.snmp_discovered_at.is_some()
    }

    pub fn discovered_via_both(&self) -> bool {
        self.discovered_via_arp() && self.discovered_via_snmp()
    }
}
```

**Database Schema:**
```sql
CREATE TABLE mac_addresses (
    id UUID PRIMARY KEY,
    mac_address MACADDR NOT NULL UNIQUE,
    arp_discovered_at TIMESTAMPTZ,
    snmp_discovered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_mac_addresses_mac ON mac_addresses(mac_address);
```

**Usage:**
- Interface and IfEntry store `mac_address_id: Option<Uuid>` (FK)
- Service layer hydrates to `mac_address: Option<MacAddress>` before API response
- When discovering via ARP, set/update `arp_discovered_at`
- When discovering via SNMP, set/update `snmp_discovered_at`
- Deduplication uses the `mac_addresses` table as source of truth

#### 3.2 SNMP Credentials (Entity)

Organization-level credential pool with network defaults and per-host overrides.
Schema designed for v2c now, v3 fields added via future migration.

```rust
pub struct SnmpCredentialBase {
    pub organization_id: Uuid,
    pub name: String,                    // "Production RO", "Lab Switches"
    pub version: SnmpVersion,            // V2c (MVP), V3 (future)
    pub community: String,               // v2c community string, encrypted
}

pub struct SnmpCredential {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub base: SnmpCredentialBase,
}

pub enum SnmpVersion {
    V2c,
    // V3 added in future migration
}
```

**Credential Resolution:**
```
Host credential = host.snmp_credential_id
                  ?? network.snmp_credential_id
                  ?? NULL (no SNMP)
```

- Credentials are org-level resources (reusable across networks)
- Networks pick a default credential
- Hosts can override with a different credential
- If no credential at any level, skip SNMP collection for that host

**Database Schema:**
```sql
CREATE TABLE snmp_credentials (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT 'V2c',
    community TEXT NOT NULL,  -- encrypted
    UNIQUE(organization_id, name)
);

CREATE INDEX idx_snmp_credentials_org ON snmp_credentials(organization_id);

-- Network default credential
ALTER TABLE networks
    ADD COLUMN snmp_credential_id UUID REFERENCES snmp_credentials(id) ON DELETE SET NULL,
    ADD COLUMN snmp_enabled BOOLEAN NOT NULL DEFAULT false;

-- Host override (nullable = inherit from network)
ALTER TABLE hosts
    ADD COLUMN snmp_credential_id UUID REFERENCES snmp_credentials(id) ON DELETE SET NULL;
```

#### 3.3 Host SNMP Fields

**Note:** SNMP `sysName.0` populates the existing `hostname` field on HostBase - no new field needed.

```rust
pub struct HostBase {
    // ... existing fields (name, network_id, hostname, description, source, virtualization, hidden, tags) ...

    // SNMP system info (NEW fields)
    pub sys_descr: Option<String>,       // sysDescr.0 - full system description
    pub sys_object_id: Option<String>,   // sysObjectID.0 - vendor OID
    // Note: sysName.0 → populates existing `hostname` field
    pub sys_location: Option<String>,    // sysLocation.0 - physical location
    pub sys_contact: Option<String>,     // sysContact.0 - admin contact

    // Management access
    pub management_url: Option<String>,  // Click-through URL

    // Deduplication (LLDP)
    pub chassis_id: Option<String>,      // lldpLocChassisId - globally unique

    // Credential override
    pub snmp_credential_id: Option<Uuid>,
}
```

**Database Migration:**
```sql
ALTER TABLE hosts
    ADD COLUMN sys_descr TEXT,
    ADD COLUMN sys_object_id TEXT,
    -- Note: sysName.0 populates existing hostname column, no new field
    ADD COLUMN sys_location TEXT,
    ADD COLUMN sys_contact TEXT,
    ADD COLUMN management_url TEXT,
    ADD COLUMN chassis_id TEXT,
    ADD COLUMN snmp_credential_id UUID REFERENCES snmp_credentials(id) ON DELETE SET NULL;

CREATE INDEX idx_hosts_snmp_credential ON hosts(snmp_credential_id);
CREATE INDEX idx_hosts_chassis_id ON hosts(chassis_id);
```

Vendor resolution via fixture-generated lookup (see section 3.7).

#### 3.4 Interface Changes (MAC Address FK)

**Breaking Change:** Replace `mac_address: Option<MacAddress>` with FK to `mac_addresses` table.

**Input Types (unchanged for backwards compatibility):**
```rust
/// API input - keeps raw MAC address.
/// Server resolves to mac_address_id during processing.
pub struct InterfaceInput {
    pub id: Uuid,
    pub subnet_id: Uuid,
    pub ip_address: IpAddr,
    pub mac_address: Option<MacAddress>,  // Raw MAC (unchanged)
    pub name: Option<String>,
    pub position: Option<i32>,
}

/// Discovery interface input - separate type for daemon requests.
/// Keeps raw MAC address for backwards compatibility with legacy daemons.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryInterfaceInput {
    pub id: Uuid,
    pub network_id: Uuid,
    pub host_id: Uuid,
    pub subnet_id: Uuid,
    pub ip_address: IpAddr,
    pub mac_address: Option<MacAddress>,  // Raw MAC from daemon
    pub name: Option<String>,
    pub position: i32,
}

impl DiscoveryInterfaceInput {
    /// Convert to Interface entity with resolved mac_address_id.
    /// Uses exhaustive destructuring to ensure compile error if fields change.
    pub fn into_interface(self, mac_address_id: Option<Uuid>) -> Interface {
        let DiscoveryInterfaceInput {
            id,
            network_id,
            host_id,
            subnet_id,
            ip_address,
            mac_address: _, // Raw MAC consumed during resolution, not stored
            name,
            position,
        } = self;

        Interface {
            id,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            base: InterfaceBase {
                network_id,
                host_id,
                subnet_id,
                ip_address,
                mac_address_id,
                name,
                position,
            },
        }
    }
}

/// Discovery request from daemon - uses input types with raw MAC.
pub struct DiscoveryHostRequest {
    pub host: Host,
    pub interfaces: Vec<DiscoveryInterfaceInput>,  // Input type with raw mac_address
    pub ports: Vec<Port>,
    pub services: Vec<Service>,
}
```

**Entity Struct (stored in DB):**
```rust
pub struct InterfaceBase {
    pub network_id: Uuid,
    pub host_id: Uuid,
    pub subnet_id: Uuid,
    pub ip_address: IpAddr,
    pub mac_address_id: Option<Uuid>,    // FK to mac_addresses table
    pub name: Option<String>,
    pub position: i32,
}

pub struct Interface {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub base: InterfaceBase,
}

impl PartialEq for Interface {
    fn eq(&self, other: &Self) -> bool {
        (self.base.ip_address == other.base.ip_address
            && self.base.subnet_id == other.base.subnet_id)
            || (self.base.mac_address_id == other.base.mac_address_id
                && self.base.mac_address_id.is_some())
            || (self.id == other.id)
    }
}

impl Hash for Interface {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.base.ip_address.hash(state);
        self.base.subnet_id.hash(state);
        self.base.mac_address_id.hash(state);
    }
}
```

**API Response Struct (with hydrated MAC):**
```rust
/// Response type for interface endpoints - includes hydrated mac_address.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct InterfaceResponse {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub network_id: Uuid,
    pub host_id: Uuid,
    pub subnet_id: Uuid,
    pub ip_address: IpAddr,
    pub mac_address: Option<MacAddress>,  // Hydrated from mac_addresses table
    pub name: Option<String>,
    pub position: i32,
}

impl InterfaceResponse {
    /// Build from Interface + hydrated MAC address.
    /// Uses exhaustive destructuring to ensure compile error if Interface changes.
    pub fn from_interface(interface: Interface, mac_address: Option<MacAddress>) -> Self {
        let Interface { id, created_at, updated_at, base } = interface;
        let InterfaceBase {
            network_id,
            host_id,
            subnet_id,
            ip_address,
            mac_address_id: _, // FK not exposed in API
            name,
            position,
        } = base;

        Self {
            id, created_at, updated_at,
            network_id, host_id, subnet_id, ip_address,
            mac_address,
            name, position,
        }
    }
}
```

**MAC Resolution in Host Service:**

Raw MAC addresses are resolved to `mac_address_id` early in `create_with_children()`, before any Interface comparisons occur. The discovery handler converts `DiscoveryInterfaceInput` → `Interface` during this step:

```rust
impl HostService {
    /// Called from discovery handler with input types
    async fn create_from_discovery(
        &self,
        request: DiscoveryHostRequest,
        // ...
    ) -> Result<HostResponse> {
        // Resolve raw MAC addresses and convert to entity types BEFORE deduplication
        let interfaces = self.resolve_discovery_interfaces(request.interfaces).await?;

        self.create_with_children(request.host, interfaces, request.ports, request.services, ...)
            .await
    }

    /// Resolve raw MAC addresses from discovery input and convert to Interface entities.
    async fn resolve_discovery_interfaces(
        &self,
        inputs: Vec<DiscoveryInterfaceInput>,
    ) -> Result<Vec<Interface>> {
        let mut interfaces = Vec::with_capacity(inputs.len());
        for input in inputs {
            let mac_address_id = if let Some(mac) = &input.mac_address {
                let record = self.mac_address_service.find_or_create(*mac).await?;
                Some(record.id)
            } else {
                None
            };
            interfaces.push(input.into_interface(mac_address_id));
        }
        Ok(interfaces)
    }

    async fn create_with_children(
        &self,
        mut host: Host,
        interfaces: Vec<Interface>,  // Already resolved with mac_address_id
        // ...
    ) -> Result<HostResponse> {
        // find_matching_host_by_interfaces can now compare mac_address_id
        let matching_result = self
            .find_matching_host_by_interfaces(&host.base.network_id, &interfaces)
            .await?;
        // ...
    }
}
```

**MAC fallback query updated:**
```rust
// Before: query by raw MAC
if let Some(mac) = &interface.base.mac_address {
    let mac_filter = StorableFilter::<Interface>::new()
        .host_id(&interface.base.host_id)
        .mac_address(mac);

// After: query by mac_address_id
if let Some(mac_id) = &interface.base.mac_address_id {
    let mac_filter = StorableFilter::<Interface>::new()
        .host_id(&interface.base.host_id)
        .mac_address_id(mac_id);
```

**Migration:**
```sql
-- 1. Create mac_addresses table (see 3.1)

-- 2. Migrate existing MAC addresses
INSERT INTO mac_addresses (id, mac_address, arp_discovered_at, created_at, updated_at)
SELECT gen_random_uuid(), mac_address, NOW(), NOW(), NOW()
FROM interfaces
WHERE mac_address IS NOT NULL
ON CONFLICT (mac_address) DO NOTHING;

-- 3. Add FK column
ALTER TABLE interfaces ADD COLUMN mac_address_id UUID REFERENCES mac_addresses(id) ON DELETE SET NULL;

-- 4. Populate FK from existing data
UPDATE interfaces i
SET mac_address_id = m.id
FROM mac_addresses m
WHERE i.mac_address = m.mac_address;

-- 5. Drop old column
ALTER TABLE interfaces DROP COLUMN mac_address;

CREATE INDEX idx_interfaces_mac_address ON interfaces(mac_address_id);
```

#### 3.5 IfEntry Entity (NEW)

Represents entries from SNMP ifTable - physical ports, logical interfaces, tunnels, LAGs, etc.
Named `IfEntry` to match SNMP terminology and avoid confusion with existing `Interface` entity.

**Entity Struct (stored in DB):**
```rust
pub struct IfEntryBase {
    pub host_id: Uuid,
    pub network_id: Uuid,

    // SNMP identifiers
    pub if_index: i32,                   // ifIndex - stable identifier within device
    pub if_descr: String,                // ifDescr - "GigabitEthernet0/1", "eth0"
    pub if_alias: Option<String>,        // ifAlias - user-configured description

    // Type (raw SNMP integer - interpreted via lookup)
    pub if_type: i32,                    // IANAifType (6=ethernet, 24=loopback, etc.)

    // Speed
    pub speed_bps: Option<i64>,          // ifSpeed/ifHighSpeed in bits/sec

    // Status (raw SNMP integers)
    pub admin_status: i32,               // ifAdminStatus: 1=up, 2=down, 3=testing
    pub oper_status: i32,                // ifOperStatus: 1-7 per IF-MIB

    // Foreign keys (stored)
    pub mac_address_id: Option<Uuid>,    // FK to mac_addresses table
    pub interface_id: Option<Uuid>,      // FK to interfaces table (when this ifEntry has an IP)
    pub connected_to_id: Option<Uuid>,   // FK to another if_entries row (LLDP/CDP neighbor)
}

pub struct IfEntry {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub base: IfEntryBase,
}
```

**API Response Struct (with hydrated MAC):**
```rust
/// Response type for IfEntry endpoints - includes hydrated mac_address.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct IfEntryResponse {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub host_id: Uuid,
    pub network_id: Uuid,

    // SNMP identifiers
    pub if_index: i32,
    pub if_descr: String,
    pub if_alias: Option<String>,
    pub if_type: i32,
    pub speed_bps: Option<i64>,
    pub admin_status: i32,
    pub oper_status: i32,

    // Hydrated field
    pub mac_address: Option<MacAddress>,  // Hydrated from mac_addresses table

    // Links
    pub interface_id: Option<Uuid>,
    pub connected_to_id: Option<Uuid>,
}

impl IfEntryResponse {
    /// Build from IfEntry + hydrated MAC.
    /// Uses exhaustive destructuring to ensure compile error if IfEntry changes.
    pub fn from_if_entry(if_entry: IfEntry, mac_address: Option<MacAddress>) -> Self {
        let IfEntry { id, created_at, updated_at, base } = if_entry;
        let IfEntryBase {
            host_id,
            network_id,
            if_index,
            if_descr,
            if_alias,
            if_type,
            speed_bps,
            admin_status,
            oper_status,
            mac_address_id: _, // FK not exposed in API
            interface_id,
            connected_to_id,
        } = base;

        Self {
            id, created_at, updated_at,
            host_id, network_id,
            if_index, if_descr, if_alias, if_type,
            speed_bps, admin_status, oper_status,
            mac_address,
            interface_id, connected_to_id,
        }
    }
}
```

**Database Schema (MVP):**
```sql
CREATE TABLE if_entries (
    id UUID PRIMARY KEY,
    host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    network_id UUID NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- SNMP identifiers
    if_index INTEGER NOT NULL,
    if_descr TEXT NOT NULL,
    if_alias TEXT,

    -- Type (raw SNMP integer)
    if_type INTEGER NOT NULL,

    -- Speed
    speed_bps BIGINT,

    -- Status (raw SNMP integers)
    admin_status INTEGER NOT NULL,
    oper_status INTEGER NOT NULL,

    -- MAC address (FK)
    mac_address_id UUID REFERENCES mac_addresses(id) ON DELETE SET NULL,

    -- Links
    interface_id UUID REFERENCES interfaces(id) ON DELETE SET NULL,
    connected_to_id UUID REFERENCES if_entries(id) ON DELETE SET NULL,

    UNIQUE(host_id, if_index)
);

CREATE INDEX idx_if_entries_host ON if_entries(host_id);
CREATE INDEX idx_if_entries_network ON if_entries(network_id);
CREATE INDEX idx_if_entries_interface ON if_entries(interface_id);
CREATE INDEX idx_if_entries_mac ON if_entries(mac_address_id);
CREATE INDEX idx_if_entries_connected ON if_entries(connected_to_id);
```

**Future Related Tables (added when we query those MIBs):**
```sql
-- LAG/Bond membership (IEEE8023-LAG-MIB)
CREATE TABLE if_entry_lag_members (
    lag_if_entry_id UUID NOT NULL REFERENCES if_entries(id) ON DELETE CASCADE,
    member_if_entry_id UUID NOT NULL REFERENCES if_entries(id) ON DELETE CASCADE,
    member_order INTEGER,
    PRIMARY KEY (lag_if_entry_id, member_if_entry_id)
);

-- VLAN assignments (Q-BRIDGE-MIB)
CREATE TABLE if_entry_vlans (
    id UUID PRIMARY KEY,
    if_entry_id UUID NOT NULL REFERENCES if_entries(id) ON DELETE CASCADE,
    vlan_id INTEGER NOT NULL,
    is_tagged BOOLEAN NOT NULL DEFAULT true,
    is_native BOOLEAN NOT NULL DEFAULT false,
    UNIQUE(if_entry_id, vlan_id)
);

-- Tunnel info (various tunnel MIBs)
CREATE TABLE if_entry_tunnels (
    if_entry_id UUID PRIMARY KEY REFERENCES if_entries(id) ON DELETE CASCADE,
    tunnel_type TEXT NOT NULL,  -- gre, ipsec, vxlan, etc.
    local_endpoint INET,
    remote_endpoint INET
);
```

**Status/Type Lookup:**
- `if_type` → human-readable name via fixture-generated IANAifType lookup (see section 3.7)
- `admin_status` / `oper_status` → simple match (only 3/7 values, defined in IF-MIB RFC 2863)

**IfEntry as Host Child Entity:**

IfEntries follow the same pattern as Interfaces, Ports, and Services - they are host children:
- Hydrated in `get_host_response()` via `load_children_for_host()`
- Included in `HostResponse` struct alongside interfaces/ports/services
- Synced via `create_with_children()` during discovery
- Managed via ChildCrudService trait
- MAC address hydrated from `mac_addresses` table before API response

**IfEntry does NOT implement Positioned:**
- Unlike Interfaces/Ports/Services, IfEntries have no `position` field
- Order is determined by `ifIndex` (device-assigned, stable identifier)
- Sorted by `if_index` on the client for display
- Not user-reorderable in the UI

```rust
// Updated HostResponse - uses Response types for hydrated children
pub struct HostResponse {
    // ... existing host fields ...
    pub interfaces: Vec<InterfaceResponse>,  // mac_address hydrated
    pub ports: Vec<Port>,
    pub services: Vec<Service>,
    pub if_entries: Vec<IfEntryResponse>,    // mac_address, lag_members, vlans hydrated
}

// Service layer builds response types with hydration
impl HostService {
    async fn get_host_response(&self, host_id: &Uuid) -> Result<HostResponse> {
        let host = self.get_by_id(host_id).await?;
        let (interfaces, ports, services, if_entries) =
            self.load_children_for_host(host_id).await?;

        // Hydrate MAC addresses for interfaces
        let interface_responses: Vec<InterfaceResponse> = interfaces
            .into_iter()
            .map(|iface| {
                let mac = self.mac_service.get_by_id(iface.base.mac_address_id).await?;
                InterfaceResponse::from_interface(iface, mac.map(|m| m.mac_address))
            })
            .collect();

        // Hydrate MAC addresses for if_entries
        let if_entry_responses: Vec<IfEntryResponse> = if_entries
            .into_iter()
            .map(|entry| {
                let mac = self.mac_service.get_by_id(entry.base.mac_address_id).await?;
                IfEntryResponse::from_if_entry(entry, mac.map(|m| m.mac_address))
            })
            .collect();

        Ok(HostResponse::from_host_with_children(
            host,
            interface_responses,
            ports,
            services,
            if_entry_responses,
        ))
    }
}
```

#### 3.6 Entity Relationships

```
Organization (1) --> (*) SnmpCredential     // Org owns credentials
Network (*) --> (0..1) SnmpCredential       // Network has default credential
Host (*) --> (0..1) SnmpCredential          // Host can override credential
Host (1) --> (*) IfEntry                    // A device has many ifTable entries
Host (1) --> (*) Interface                  // A host has many IP assignments
MacAddressRecord (1) <-- (*) Interface      // Interface references MAC
MacAddressRecord (1) <-- (*) IfEntry        // IfEntry references MAC
IfEntry (0..1) --> (0..1) Interface         // An ifEntry may have an IP
IfEntry (0..1) --> (0..1) IfEntry           // Physical link to neighbor (LLDP/CDP)
IfEntry (1) <-- (*) IfEntryLagMember        // Future: LAG membership
IfEntry (1) <-- (*) IfEntryVlan             // Future: VLAN assignments
```

#### 3.7 Deduplication Integration

SNMP data can improve host and interface deduplication, but only using **globally unique** identifiers.

**What IS globally unique (safe for dedup):**
| Field | Source | Why Unique |
|-------|--------|------------|
| `lldpLocChassisId` | LLDP-MIB | Base MAC of device - globally unique |
| `ifPhysAddress` | IF-MIB | MAC address per interface - globally unique |

**What is NOT globally unique (NOT safe for dedup):**
| Field | Source | Why NOT Unique |
|-------|--------|----------------|
| `sysName` | System MIB | User-configurable, conventions vary by org |
| `sysObjectID` | System MIB | Identifies device *type*, not instance |
| `sysDescr` | System MIB | Same model = same description |

**Current Host Deduplication (`find_matching_host_by_interfaces`):**
- Compares incoming interfaces against existing hosts' interfaces
- `Interface::eq()` matches on: same (ip + subnet), OR same MAC (via mac_address_id), OR same ID
- Works well when interfaces share MAC or IP

**Problem Case - Multi-Interface Device with Different MACs:**
```
Device "core-switch" has:
- 192.168.1.10 (MAC aa:bb:cc:00:00:01) on VLAN 10
- 10.0.0.1 (MAC aa:bb:cc:00:00:02) on VLAN 20

Scanned separately, these create TWO hosts because MACs differ.
But SNMP shows both IPs have chassisId = "aa:bb:cc:00:00:00"
```

**Proposed Enhancement - Chassis ID Matching:**

Modify `find_matching_host_by_interfaces` to also check chassis ID:
```rust
pub async fn find_matching_host(
    &self,
    network_id: &Uuid,
    incoming_interfaces: &[Interface],
    chassis_id: Option<&str>,  // NEW: from LLDP
) -> Result<Option<(Host, Vec<Interface>)>> {
    // 1. Try existing interface matching (MAC or IP+subnet)
    // ... existing logic ...

    // 2. If no interface match but chassis_id provided, try that
    if let Some(cid) = chassis_id {
        for host in &all_hosts {
            if host.base.chassis_id.as_deref() == Some(cid) {
                return Ok(Some((host.clone(), host_interfaces)));
            }
        }
    }

    Ok(None)
}
```

**IfEntry → Interface Linking via MAC:**

After IfEntry records are created, link to existing Interface entities via shared mac_address_id:
```rust
for if_entry in &mut if_entries {
    if let Some(mac_id) = if_entry.base.mac_address_id {
        // Find Interface on this host with same mac_address_id
        if let Some(iface) = host_interfaces.iter()
            .find(|i| i.base.mac_address_id == Some(mac_id))
        {
            if_entry.base.interface_id = Some(iface.id);
        }
    }
}
```

**Discovery Flow with Deduplication:**
```
1. Daemon queries SNMP for IP, gets:
   - chassisId from LLDP local info
   - ifTable with MAC addresses

2. Daemon sends to server:
   - Host with chassis_id populated
   - Interfaces (from existing ARP logic)
   - IfEntries (from SNMP ifTable)

3. Server deduplication (enhanced):
   a. Try Interface matching (existing - MAC or IP+subnet)
   b. If no match AND chassis_id provided, try Chassis ID match
   c. If match found → upsert existing host
   d. If no match → create new host

4. MAC address handling:
   a. For each MAC in incoming data, find-or-create in mac_addresses table
   b. Set arp_discovered_at if from ARP, snmp_discovered_at if from SNMP
   c. Link Interface and IfEntry to mac_address_id

5. After host resolved:
   a. Create/update IfEntry records (keyed by host_id + if_index)
   b. Link IfEntry → Interface via shared mac_address_id
   c. Process LLDP neighbors → set connected_to_id
```

#### 3.8 LLDP/CDP Neighbor Discovery

LLDP (Link Layer Discovery Protocol) and CDP (Cisco Discovery Protocol) allow switches to advertise their identity to neighbors. We query these tables to discover physical topology.

**Data Storage:** LLDP/CDP neighbor data is **NOT** stored in a separate database table. It is collected during discovery, used to resolve `IfEntry.connected_to_id` links, and then discarded. The permanent record is the `connected_to_id` foreign key on IfEntry which points to the remote IfEntry.

**Transient data structure (discovery only):**
```rust
pub struct LldpNeighbor {
    pub local_if_index: i32,             // Local port where neighbor was seen
    pub remote_chassis_id: String,       // Neighbor's chassis identifier
    pub remote_port_id: String,          // Neighbor's port identifier
    pub remote_port_desc: Option<String>,// Neighbor's port description
    pub remote_sys_name: Option<String>, // Neighbor's system name
    pub remote_sys_desc: Option<String>, // Neighbor's system description
    pub remote_mgmt_addr: Option<IpAddr>,// Neighbor's management IP
}
```

**Resolution to IfEntry (during discovery):**
1. Query LLDP/CDP tables on each SNMP-enabled host
2. For each neighbor entry:
   a. Find local IfEntry by `local_if_index`
   b. Find remote Host by `remote_chassis_id` (preferred) or `remote_mgmt_addr`
   c. Find remote IfEntry by matching `remote_port_id` or `remote_port_desc` to `if_descr`
   d. Set `local_if_entry.connected_to_id = remote_if_entry.id`
3. Discard transient LldpNeighbor data after links are resolved

**OIDs:**
```
LLDP-MIB (IEEE 802.1AB):
- lldpLocChassisId     1.0.8802.1.1.2.1.3.2.0     (local chassis ID)
- lldpRemChassisId     1.0.8802.1.1.2.1.4.1.1.5.* (remote chassis IDs)
- lldpRemPortId        1.0.8802.1.1.2.1.4.1.1.7.*
- lldpRemPortDesc      1.0.8802.1.1.2.1.4.1.1.8.*
- lldpRemSysName       1.0.8802.1.1.2.1.4.1.1.9.*
- lldpRemSysDesc       1.0.8802.1.1.2.1.4.1.1.10.*
- lldpRemManAddrIfId   1.0.8802.1.1.2.1.4.2.1.4.*

CDP-MIB (Cisco proprietary):
- cdpCacheDeviceId     1.3.6.1.4.1.9.9.23.1.2.1.1.6.*
- cdpCacheDevicePort   1.3.6.1.4.1.9.9.23.1.2.1.1.7.*
- cdpCacheAddress      1.3.6.1.4.1.9.9.23.1.2.1.1.4.*
- cdpCachePlatform     1.3.6.1.4.1.9.9.23.1.2.1.1.8.*
```

#### 3.9 Topology PhysicalLink Edge Type

New edge type for physical connections discovered via LLDP/CDP.

**Important:** Topology nodes are **Interfaces**, not Hosts. Edge `source` and `target` are Interface UUIDs (see `get_subnet_from_interface_id(edge.source)` usage in topology code).

```rust
pub enum EdgeType {
    // ... existing variants ...

    /// Physical link discovered via LLDP/CDP
    /// Note: Edge.source and Edge.target are Interface IDs (obtained via IfEntry.interface_id)
    PhysicalLink {
        source_if_entry_id: Uuid,
        target_if_entry_id: Uuid,
        discovery_protocol: DiscoveryProtocol,
    },
}

pub enum DiscoveryProtocol {
    Lldp,
    Cdp,
}
```

**Edge Creation:**
- When `IfEntry.connected_to_id` is populated AND both IfEntries have `interface_id` set:
  - `Edge.source` = source IfEntry's `interface_id` (Interface UUID)
  - `Edge.target` = target IfEntry's `interface_id` (Interface UUID)
  - `source_if_entry_id` / `target_if_entry_id` provide the IfEntry detail for hover/click
- If either IfEntry lacks an `interface_id` (physical port without IP), the edge cannot be created (physical-only ports don't have topology representation currently)
- Links are bidirectional but stored once (deduplicated by sorted UUID pair)

**IfEntry ↔ Interface Linking:**
The `interface_id` field on IfEntry provides the 1:1 link between an SNMP ifTable entry and an Interface entity:
- Set when the IfEntry has an IP address that matches an existing Interface
- Linked via shared `mac_address_id` (see section 3.7)
- Enables PhysicalLink edges to connect to topology nodes

#### 3.10 IANA Lookup Tables (Fixture Generation)

Use the existing fixture generation pattern (`backend/tests/integration/fixtures.rs`) to generate lookup tables from IANA sources. This follows the established pattern used for `services-next.json`, `billing-plans-next.json`, etc.

**Enterprise Numbers (Vendor OIDs):**
- Source: https://www.iana.org/assignments/enterprise-numbers/enterprise-numbers
- ~60,000 entries mapping enterprise number → organization name
- OID format: `1.3.6.1.4.1.{enterprise_number}.*`

**IANAifType (Interface Types):**
- Source: https://www.iana.org/assignments/ianaiftype-mib/ianaiftype-mib
- ~300 entries mapping ifType integer → name

**Generated Files:**
```
backend/src/server/snmp/generated/enterprise_numbers.rs  (generated, checked in)
backend/src/server/snmp/generated/iana_if_type.rs        (generated, checked in)
```

**Fixture Generator Addition:**
```rust
// backend/tests/integration/fixtures.rs
pub async fn generate_fixtures() {
    // ... existing generators ...

    generate_iana_enterprise_numbers()
        .await
        .expect("Failed to generate IANA enterprise numbers");

    generate_iana_if_types()
        .await
        .expect("Failed to generate IANA interface types");
}
```

**Lookup Functions:**
```rust
// backend/src/server/snmp/generated/enterprise_numbers.rs
pub fn vendor_from_enterprise_number(num: u32) -> Option<&'static str> {
    match num {
        9 => Some("Cisco"),
        11 => Some("HP"),
        2636 => Some("Juniper Networks"),
        30065 => Some("Arista Networks"),
        41112 => Some("Ubiquiti Networks"),
        // ... ~60,000 entries
        _ => None,
    }
}

pub fn vendor_from_sys_object_id(oid: &str) -> Option<&'static str> {
    let parts: Vec<&str> = oid.split('.').collect();
    if parts.len() >= 7 && parts[..6] == ["1","3","6","1","4","1"] {
        if let Ok(num) = parts[6].parse::<u32>() {
            return vendor_from_enterprise_number(num);
        }
    }
    None
}

// backend/src/server/snmp/generated/iana_if_type.rs
pub fn if_type_name(if_type: i32) -> &'static str {
    match if_type {
        1 => "other",
        6 => "ethernetCsmacd",
        24 => "softwareLoopback",
        131 => "tunnel",
        135 => "l2vlan",
        161 => "ieee8023adLag",
        // ... ~300 entries
        _ => "unknown",
    }
}
```

**Regeneration:** Run `cargo test --test integration generate_fixtures` to regenerate from IANA sources. Generated files are checked into git so builds don't require network access.

#### 3.11 OID Constants Module

Define OID constants in a dedicated module to avoid brittle string literals throughout the codebase. The `snmp2` crate accepts OIDs as `&[u32]` slices.

**File:** `backend/src/server/snmp/oids.rs`

```rust
//! SNMP OID constants for standard MIBs.
//!
//! OIDs are defined as const arrays of u32 for use with snmp2 crate.
//! References:
//! - System MIB: RFC 1213
//! - IF-MIB: RFC 2863
//! - IF-MIB (ifXTable): RFC 2863
//! - LLDP-MIB: IEEE 802.1AB
//! - CDP-MIB: Cisco proprietary

/// System MIB (RFC 1213) - 1.3.6.1.2.1.1
pub mod system {
    pub const SYS_DESCR: &[u32] = &[1, 3, 6, 1, 2, 1, 1, 1, 0];
    pub const SYS_OBJECT_ID: &[u32] = &[1, 3, 6, 1, 2, 1, 1, 2, 0];
    pub const SYS_UP_TIME: &[u32] = &[1, 3, 6, 1, 2, 1, 1, 3, 0];
    pub const SYS_CONTACT: &[u32] = &[1, 3, 6, 1, 2, 1, 1, 4, 0];
    pub const SYS_NAME: &[u32] = &[1, 3, 6, 1, 2, 1, 1, 5, 0];
    pub const SYS_LOCATION: &[u32] = &[1, 3, 6, 1, 2, 1, 1, 6, 0];
}

/// IF-MIB ifTable (RFC 2863) - 1.3.6.1.2.1.2.2.1
pub mod if_table {
    /// Base OID for ifTable walks
    pub const BASE: &[u32] = &[1, 3, 6, 1, 2, 1, 2, 2, 1];

    pub const IF_INDEX: &[u32] = &[1, 3, 6, 1, 2, 1, 2, 2, 1, 1];
    pub const IF_DESCR: &[u32] = &[1, 3, 6, 1, 2, 1, 2, 2, 1, 2];
    pub const IF_TYPE: &[u32] = &[1, 3, 6, 1, 2, 1, 2, 2, 1, 3];
    pub const IF_SPEED: &[u32] = &[1, 3, 6, 1, 2, 1, 2, 2, 1, 5];
    pub const IF_PHYS_ADDRESS: &[u32] = &[1, 3, 6, 1, 2, 1, 2, 2, 1, 6];
    pub const IF_ADMIN_STATUS: &[u32] = &[1, 3, 6, 1, 2, 1, 2, 2, 1, 7];
    pub const IF_OPER_STATUS: &[u32] = &[1, 3, 6, 1, 2, 1, 2, 2, 1, 8];
}

/// IF-MIB ifXTable (RFC 2863) - 1.3.6.1.2.1.31.1.1.1
pub mod if_x_table {
    /// Base OID for ifXTable walks
    pub const BASE: &[u32] = &[1, 3, 6, 1, 2, 1, 31, 1, 1, 1];

    pub const IF_HIGH_SPEED: &[u32] = &[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 15];
    pub const IF_ALIAS: &[u32] = &[1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 18];
}

/// LLDP-MIB (IEEE 802.1AB) - 1.0.8802.1.1.2
pub mod lldp {
    /// Local chassis ID
    pub const LOC_CHASSIS_ID: &[u32] = &[1, 0, 8802, 1, 1, 2, 1, 3, 2, 0];

    /// Remote table base for walks
    pub const REM_TABLE_BASE: &[u32] = &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1];

    pub const REM_CHASSIS_ID: &[u32] = &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1, 5];
    pub const REM_PORT_ID: &[u32] = &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1, 7];
    pub const REM_PORT_DESC: &[u32] = &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1, 8];
    pub const REM_SYS_NAME: &[u32] = &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1, 9];
    pub const REM_SYS_DESC: &[u32] = &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1, 10];

    /// Remote management address table
    pub const REM_MAN_ADDR_IF_ID: &[u32] = &[1, 0, 8802, 1, 1, 2, 1, 4, 2, 1, 4];
}

/// CDP-MIB (Cisco proprietary) - 1.3.6.1.4.1.9.9.23
pub mod cdp {
    /// CDP cache table base for walks
    pub const CACHE_TABLE_BASE: &[u32] = &[1, 3, 6, 1, 4, 1, 9, 9, 23, 1, 2, 1, 1];

    pub const CACHE_ADDRESS: &[u32] = &[1, 3, 6, 1, 4, 1, 9, 9, 23, 1, 2, 1, 1, 4];
    pub const CACHE_DEVICE_ID: &[u32] = &[1, 3, 6, 1, 4, 1, 9, 9, 23, 1, 2, 1, 1, 6];
    pub const CACHE_DEVICE_PORT: &[u32] = &[1, 3, 6, 1, 4, 1, 9, 9, 23, 1, 2, 1, 1, 7];
    pub const CACHE_PLATFORM: &[u32] = &[1, 3, 6, 1, 4, 1, 9, 9, 23, 1, 2, 1, 1, 8];
}
```

**Usage:**
```rust
use crate::server::snmp::oids::{system, if_table, lldp};

// Query sysDescr
let response = session.get(system::SYS_DESCR)?;

// Walk ifTable
session.walk(if_table::BASE, |oid, value| {
    // Process each ifTable entry
});
```

---

### 4. Discovery Flow

**Integration Point:** `daemon/discovery/service/network.rs:deep_scan_host()`

**Credential Resolution (Server-Side, Pre-Discovery):**

The daemon doesn't have access to host/network data during discovery (by design). The server builds a credential lookup table and sends it in the DiscoveryType payload when initiating discovery.

```rust
// Server-side: Build IP → credential mapping before initiating discovery
pub struct SnmpCredentialMapping {
    /// Network default credential (used when IP not in overrides)
    pub default_credential: Option<SnmpCredential>,
    /// Per-IP overrides (from host.snmp_credential_id where host has known IPs)
    pub ip_overrides: HashMap<IpAddr, SnmpCredential>,
}

// Added to DiscoveryType::Deep payload
pub struct DeepDiscoveryParams {
    // ... existing fields ...
    pub snmp_credentials: Option<SnmpCredentialMapping>,
}

// Daemon-side: Lookup during discovery
impl SnmpCredentialMapping {
    pub fn get_credential_for_ip(&self, ip: &IpAddr) -> Option<&SnmpCredential> {
        self.ip_overrides.get(ip).or(self.default_credential.as_ref())
    }
}
```

**Server builds mapping:**
1. Query all hosts in network with `snmp_credential_id` set
2. For each host, get all interface IPs
3. Build `ip_overrides: HashMap<IpAddr, SnmpCredential>`
4. Set `default_credential` from `network.snmp_credential_id`
5. Include in DiscoveryType::Deep payload

**Per-Host Discovery:**
```
1. ARP/TCP scan identifies live host with IP
2. UDP scan detects port 161 (SNMP)
3. Lookup credential: snmp_credentials.get_credential_for_ip(&ip)
4. If credential available:
   a. Query system MIB (sysDescr, sysObjectID, sysName, sysLocation, sysContact)
   b. Query LLDP local info (lldpLocChassisId) for chassis_id
   c. Walk ifTable (ifIndex, ifDescr, ifType, ifSpeed, ifAdminStatus, ifOperStatus, ifPhysAddress)
   d. Walk ifXTable (ifHighSpeed, ifAlias)
   e. Walk LLDP-MIB and/or CDP-MIB for neighbor data
   f. Store system info + chassis_id on Host entity
   g. Find-or-create MAC addresses in mac_addresses table
   h. Create/update IfEntry records for each ifTable row
   i. Link IfEntry → Interface via shared mac_address_id
5. Continue with normal host/service creation
```

**Post-Discovery Link Resolution:**
```
After all hosts in network are discovered:
1. For each IfEntry with LLDP/CDP neighbor data:
   a. Find remote Host by chassis_id or management IP
   b. Find remote IfEntry by port description match
   c. Set connected_to_id on both ends (bidirectional)
2. Generate PhysicalLink edges for topology
```

**OIDs to Query:**

All OIDs are defined in `backend/src/server/snmp/oids.rs` (see section 3.11) to avoid brittle string literals.

| Category | Constant Module | OIDs |
|----------|-----------------|------|
| System MIB | `oids::system` | `SYS_DESCR`, `SYS_OBJECT_ID`, `SYS_NAME` → hostname, `SYS_LOCATION`, `SYS_CONTACT` |
| IF-MIB ifTable | `oids::if_table` | `IF_INDEX`, `IF_DESCR`, `IF_TYPE`, `IF_SPEED`, `IF_PHYS_ADDRESS`, `IF_ADMIN_STATUS`, `IF_OPER_STATUS` |
| IF-MIB ifXTable | `oids::if_x_table` | `IF_HIGH_SPEED`, `IF_ALIAS` |
| LLDP-MIB | `oids::lldp` | `LOC_CHASSIS_ID`, `REM_CHASSIS_ID`, `REM_PORT_ID`, `REM_PORT_DESC`, `REM_SYS_NAME`, `REM_SYS_DESC`, `REM_MAN_ADDR_IF_ID` |
| CDP-MIB | `oids::cdp` | `CACHE_DEVICE_ID`, `CACHE_DEVICE_PORT`, `CACHE_ADDRESS`, `CACHE_PLATFORM` |

---

### 5. MVP Scope

**In Scope:**
1. SNMPv2c with network-level credentials + per-host overrides
2. System MIB collection (sysDescr, sysObjectID, sysName, sysLocation, sysContact)
3. Vendor identification via fixture-generated lookup from IANA enterprise numbers
4. ifTable/ifXTable collection → IfEntry entities
5. ifType lookup via fixture-generated IANAifType table
6. MAC address normalization (single table, FKs from Interface and IfEntry)
7. IfEntry ↔ Interface linking via shared mac_address_id
8. LLDP/CDP neighbor discovery
9. PhysicalLink topology edges from LLDP/CDP data
10. Display in host detail view (system info, interface table, neighbor links)
11. Management URL field (manual)

**Out of Scope (Future):**
- SNMPv3 authentication
- LAG member discovery (IEEE8023-LAG-MIB)
- VLAN discovery (Q-BRIDGE-MIB)
- MAC-to-port mapping (BRIDGE-MIB)
- Tunnel endpoint discovery
- Scheduled polling
- SNMP traps

---

### 6. Files to Create/Modify

**New Files:**
- `backend/src/server/snmp/` - SNMP module directory
  - `mod.rs` - Module exports
  - `oids.rs` - OID constants for standard MIBs (system, if_table, if_x_table, lldp, cdp)
  - `generated/mod.rs` - Generated lookup code module
  - `generated/enterprise_numbers.rs` - IANA enterprise number lookup (generated via fixtures)
  - `generated/iana_if_type.rs` - IANAifType lookup (generated via fixtures)
- `backend/src/server/mac_addresses/` - MacAddressRecord storage (Storable, not Entity)
  - `mod.rs`
  - `base.rs` - MacAddressRecord struct
  - `storage.rs` - Storage impl, find-or-create logic
- `backend/src/server/snmp_credentials/` - SnmpCredential entity module
  - `mod.rs`
  - `impl/base.rs` - SnmpCredentialBase, SnmpCredential
  - `impl/storage.rs`
  - `handlers.rs`
  - `service.rs`
- `backend/src/server/if_entries/` - IfEntry entity module
  - `mod.rs`
  - `impl/base.rs` - IfEntryBase, IfEntry, IfEntryVlan (future)
  - `impl/storage.rs`
  - `handlers.rs`
  - `service.rs`
- `backend/src/daemon/discovery/service/snmp.rs` - SNMP collection logic
- `backend/migrations/YYYYMMDD_mac_addresses.sql`
- `backend/migrations/YYYYMMDD_snmp_credentials.sql`
- `backend/migrations/YYYYMMDD_host_snmp_fields.sql`
- `backend/migrations/YYYYMMDD_if_entries.sql`
- `backend/migrations/YYYYMMDD_interface_mac_fk.sql` - Migrate Interface.mac_address to FK
- `ui/src/lib/shared/components/forms/selection/display/SnmpCredentialDisplay.svelte` - Display component for RichSelect
- `ui/src/lib/features/hosts/components/HostEditModal/Snmp/` - SNMP tab components
  - `SnmpTab.svelte` - Credential override + metadata display (no ListManager)
- `ui/src/lib/features/hosts/components/HostEditModal/IfEntries/` - IfEntries tab components (separate tab)
  - `IfEntriesForm.svelte` - IfEntry list with ListConfigEditor (sorted by ifIndex, no reorder)
  - `IfEntryConfigPanel.svelte` - Config panel for selected IfEntry
  - `IfEntryDisplay.svelte` - Display component for list items
- `ui/src/lib/features/networks/components/SnmpSettings.svelte` - SNMP settings for network modal
- `ui/src/lib/features/snmp/` - SNMP credentials feature module
  - `queries.ts` - TanStack Query hooks for credentials
  - `types.ts` - TypeScript types for SnmpCredential
  - `components/SnmpCredentialForm.svelte` - Create/edit credential form
  - `components/SnmpCredentialsList.svelte` - List view for org settings page

**Modified Files:**
- `backend/tests/integration/fixtures.rs` - Add IANA data generators
- `backend/src/server/mod.rs` - Export mac_addresses, snmp, snmp_credentials, if_entries modules
- `backend/src/server/shared/entities.rs` - Add SnmpCredential and IfEntry entity discriminants (for icon/color)
- `backend/src/server/hosts/impl/base.rs` - Add SNMP fields + credential FK + chassis_id
- `backend/src/server/hosts/impl/api.rs` - Add if_entries to HostResponse
- `backend/src/server/hosts/impl/storage.rs` - Update queries for new fields
- `backend/src/server/hosts/service.rs` - Add IfEntryService, update load_children_for_host, hydrate MACs
- `backend/src/server/interfaces/impl/base.rs` - Replace mac_address with mac_address_id + hydrated field
- `backend/src/server/interfaces/impl/storage.rs` - Update queries for mac_address_id
- `backend/src/server/interfaces/service.rs` - Hydrate mac_address from mac_addresses table
- `backend/src/server/networks/impl/base.rs` - Add snmp_credential_id, snmp_enabled
- `backend/src/server/networks/impl/storage.rs` - Update queries
- `backend/src/server/topology/types/edges.rs` - Add PhysicalLink variant, DiscoveryProtocol enum
- `backend/src/server/topology/service/edge_builder.rs` - Build PhysicalLink edges
- `backend/src/daemon/discovery/service/network.rs` - Integrate SNMP collection
- `backend/src/daemon/discovery/service/mod.rs` - Export snmp module
- `backend/src/daemon/utils/scanner.rs` - Enhance for credential-based queries
- `ui/src/lib/features/hosts/components/HostEditModal/HostEditor.svelte` - Add SNMP tab
- `ui/src/lib/features/hosts/types/base.ts` - Add IfEntry type, SNMP fields, update HostFormData
- `ui/src/lib/features/networks/components/NetworkEditModal/` - Add SnmpSettings component
- `ui/src/lib/features/networks/types/base.ts` - Add snmp_enabled, snmp_credential_id fields

---

### 7. UI Implementation

#### 7.1 SNMP Credential Display Component

Following the existing pattern in `ui/src/lib/shared/components/forms/selection/display/`, create a display component for SNMP credentials.

**Backend Entity Registration:** Add `SnmpCredential` to `backend/src/server/shared/entities.rs` to get icon/color via the standard pattern.

**File:** `ui/src/lib/shared/components/forms/selection/display/SnmpCredentialDisplay.svelte`

```svelte
<script lang="ts" context="module">
    import { entities } from '$lib/shared/stores/metadata';
    import type { SnmpCredential } from '$lib/features/snmp/types';

    export const SnmpCredentialDisplay: EntityDisplayComponent<SnmpCredential, object> = {
        getId: (credential: SnmpCredential) => credential.id,
        getLabel: (credential: SnmpCredential) => credential.name,
        getDescription: (credential: SnmpCredential) =>
            `SNMPv${credential.version === 'V2c' ? '2c' : '3'}`,
        getIcon: () => entities.getIconComponent('SnmpCredential'),
        getIconColor: () => entities.getColorHelper('SnmpCredential').icon,
        getTags: (credential: SnmpCredential) => [
            {
                label: credential.version,
                color: entities.getColorHelper('SnmpCredential').color
            }
        ],
        getCategory: () => null
    };
</script>

<script lang="ts">
    import type { EntityDisplayComponent } from '../types';
    import ListSelectItem from '../ListSelectItem.svelte';

    export let item: SnmpCredential;
    export let context = {};
</script>

<ListSelectItem {item} {context} displayComponent={SnmpCredentialDisplay} />
```

#### 7.2 SNMP Settings in Network Modal

Add SNMP settings to the network modal using RichSelect with SnmpCredentialDisplay:

**File:** `ui/src/lib/features/networks/components/SnmpSettings.svelte`

```svelte
<script lang="ts">
    import Toggle from '$lib/shared/components/forms/inputs/Toggle.svelte';
    import RichSelect from '$lib/shared/components/forms/selection/RichSelect.svelte';
    import { SnmpCredentialDisplay } from '$lib/shared/components/forms/selection/display/SnmpCredentialDisplay.svelte';
    import { useSnmpCredentialsQuery } from '$lib/features/snmp/queries';

    interface Props {
        formData: NetworkFormData;
    }

    let { formData }: Props = $props();

    const credentialsQuery = useSnmpCredentialsQuery();
    let credentials = $derived(credentialsQuery.data ?? []);
</script>

<div class="space-y-4">
    <Toggle
        label="Enable SNMP Discovery"
        description="Query SNMP-enabled devices for detailed interface and neighbor information"
        bind:checked={formData.snmp_enabled}
    />

    {#if formData.snmp_enabled}
        <RichSelect
            label="Default SNMP Credential"
            placeholder="Select credential..."
            selectedValue={formData.snmp_credential_id}
            options={credentials}
            displayComponent={SnmpCredentialDisplay}
            onSelect={(value) => {
                formData.snmp_credential_id = value;
            }}
            onClear={() => {
                formData.snmp_credential_id = null;
            }}
            allowClear={true}
        />
        <p class="text-xs text-muted">
            Credential used for SNMP queries on this network. Hosts can override.
        </p>
    {/if}
</div>
```

**Credential CRUD UI:**
- Organization-level credential management page at `/settings/snmp-credentials`
- Simple form: name, version (v2c only for MVP), community string (masked input)
- List view with edit/delete actions

#### 7.3 SNMP Tab in Host Modal

Add a dedicated SNMP tab to the HostEditModal for credential configuration and metadata display.

**Tab Visibility Logic:**
- **Always show when editing** - Users need to set credentials before discovery can collect SNMP data
- Hide when creating new host (no credential to set yet, host doesn't exist)

**Tab Configuration:**
```svelte
<!-- HostEditor.svelte - Add SNMP tab after Services -->
...(vmManagerServices && vmManagerServices.length > 0
    ? [{ id: 'virtualization', ... }]
    : []),
...(isEditing
    ? [{
        id: 'snmp',
        label: 'SNMP',
        icon: entities.getIconComponent('SnmpCredential'),
        description: 'SNMP credential and system information'
    }]
    : [])
```

**SnmpTab.svelte Structure:**
```svelte
<script lang="ts">
    import RichSelect from '$lib/shared/components/forms/selection/RichSelect.svelte';
    import { SnmpCredentialDisplay } from '$lib/shared/components/forms/selection/display/SnmpCredentialDisplay.svelte';
    import { useSnmpCredentialsQuery } from '$lib/features/snmp/queries';

    interface Props {
        formData: HostFormData;
        networkSnmpCredentialId: Uuid | null;
        networkSnmpCredentialName: string | null;
    }

    let { formData, networkSnmpCredentialId, networkSnmpCredentialName }: Props = $props();

    const credentialsQuery = useSnmpCredentialsQuery();
    let credentials = $derived(credentialsQuery.data ?? []);

    let hasSnmpMetadata = $derived(
        formData.sys_descr || formData.sys_location || formData.sys_contact || formData.chassis_id
    );
</script>

<div class="space-y-6">
    <!-- Credential Override -->
    <section>
        <h3 class="text-sm font-medium text-secondary mb-2">SNMP Credential</h3>
        <RichSelect
            label="Override network default"
            placeholder="Use network default"
            selectedValue={formData.snmp_credential_id}
            options={credentials}
            displayComponent={SnmpCredentialDisplay}
            onSelect={(value) => {
                formData.snmp_credential_id = value;
            }}
            onClear={() => {
                formData.snmp_credential_id = null;
            }}
            allowClear={true}
        />
        <p class="text-xs text-muted mt-1">
            {#if networkSnmpCredentialId}
                Network default: {networkSnmpCredentialName}
            {:else}
                No network default configured. Set one in network settings or select a credential above.
            {/if}
        </p>
    </section>

    <!-- SNMP Metadata (read-only, populated by discovery) -->
    {#if hasSnmpMetadata}
        <section>
            <h3 class="text-sm font-medium text-secondary mb-2">System Information</h3>
            <p class="text-xs text-muted mb-3">Collected via SNMP during discovery</p>
            <dl class="grid grid-cols-2 gap-2 text-sm">
                {#if formData.sys_descr}
                    <dt class="text-muted">Description</dt>
                    <dd class="font-mono text-xs">{formData.sys_descr}</dd>
                {/if}
                {#if formData.sys_object_id}
                    <dt class="text-muted">Object ID</dt>
                    <dd class="font-mono text-xs">{formData.sys_object_id}</dd>
                {/if}
                {#if formData.sys_location}
                    <dt class="text-muted">Location</dt>
                    <dd>{formData.sys_location}</dd>
                {/if}
                {#if formData.sys_contact}
                    <dt class="text-muted">Contact</dt>
                    <dd>{formData.sys_contact}</dd>
                {/if}
                {#if formData.chassis_id}
                    <dt class="text-muted">Chassis ID</dt>
                    <dd class="font-mono text-xs">{formData.chassis_id}</dd>
                {/if}
            </dl>
        </section>
    {:else}
        <section>
            <p class="text-sm text-muted">
                No SNMP data collected yet. Configure a credential above and run discovery.
            </p>
        </section>
    {/if}
</div>
```

#### 7.4 IfEntries Tab in Host Modal (Separate Tab)

IfEntries get their own dedicated tab using ListConfigEditor, following the same pattern as Interfaces/Ports/Services.

**Tab Visibility:**
- Only show when `formData.if_entries.length > 0` (has collected data)
- Similar to how Virtualization tab only appears when VM manager services exist

**Tab Configuration:**
```svelte
<!-- HostEditor.svelte - Add IfEntries tab after SNMP -->
...(isEditing
    ? [{ id: 'snmp', ... }]
    : []),
...(formData.if_entries && formData.if_entries.length > 0
    ? [{
        id: 'if-entries',
        label: 'SNMP Interfaces',
        icon: entities.getIconComponent('IfEntry'),
        description: 'Physical and logical interfaces from SNMP ifTable'
    }]
    : [])
```

**IfEntriesForm.svelte Structure:**
```svelte
<script lang="ts">
    import ListManager from '$lib/shared/components/forms/selection/ListManager.svelte';
    import ListConfigEditor from '$lib/shared/components/forms/selection/ListConfigEditor.svelte';
    import IfEntryConfigPanel from './IfEntryConfigPanel.svelte';
    import { IfEntryDisplay } from './IfEntryDisplay.svelte';

    interface Props {
        formData: HostFormData;
        form: FormApi;
    }

    let { formData, form }: Props = $props();

    // IfEntries are sorted by ifIndex (device-assigned order), not user-reorderable
    let sortedIfEntries = $derived(
        [...(formData.if_entries ?? [])].sort((a, b) => a.if_index - b.if_index)
    );
</script>

<ListConfigEditor items={sortedIfEntries}>
    <svelte:fragment slot="list" let:items let:onEdit let:highlightedIndex>
        <ListManager
            label="SNMP Interfaces"
            helpText="Interfaces discovered via SNMP ifTable, sorted by ifIndex"
            emptyMessage="No SNMP interface data available"
            allowReorder={false}
            allowAdd={false}
            allowRemove={false}
            itemClickAction="edit"
            {items}
            itemDisplayComponent={IfEntryDisplay}
            {onEdit}
            {highlightedIndex}
        />
    </svelte:fragment>

    <svelte:fragment slot="config" let:selectedItem let:selectedIndex>
        {#if selectedItem}
            <IfEntryConfigPanel
                ifEntry={selectedItem}
                index={selectedIndex}
                {form}
            />
        {:else}
            <EntityConfigEmpty
                title="No interface selected"
                subtitle="Select an interface to view details"
            />
        {/if}
    </svelte:fragment>
</ListConfigEditor>
```

**IfEntry Ordering:**
- IfEntries are **NOT user-reorderable** - they don't implement the `Positioned` trait
- Order is determined by `ifIndex` (device-assigned, stable identifier within the device)
- Sorted client-side by `if_index` for display
- No position field in IfEntryBase

**IfEntryDisplay Component:**
Shows: ifDescr, ifAlias, status indicators (admin/oper), speed, type icon, MAC address

**IfEntryConfigPanel:**
- Read-only display of SNMP data (ifIndex, ifDescr, ifType, speeds, status)
- Editable ifAlias field (user description)
- MAC address display
- Link to associated Interface entity (if interface_id set)
- Link to connected neighbor IfEntry (if connected_to_id set)

---

### 8. Next Steps

1. Database migrations:
   a. mac_addresses table
   b. snmp_credentials table + network/host FKs
   c. Host SNMP fields + chassis_id (note: sysName → existing hostname field)
   d. if_entries table
   e. Interface mac_address → mac_address_id migration

2. MacAddressRecord storage (Storable, not Entity)

3. SnmpCredential entity module (base, storage, handlers, service)

4. IfEntry entity module (base, storage, handlers, service)

5. Update Interface to use mac_address_id FK, hydrate in service layer

6. Update HostResponse and host service to hydrate IfEntries with MAC addresses

7. OID constants module (`backend/src/server/snmp/oids.rs`)

8. IANA lookup generators in fixture generation

9. SNMP collection module in daemon (system MIB, ifTable, LLDP/CDP)

10. Integration into discovery flow with credential resolution and MAC find-or-create

11. Post-discovery link resolution (LLDP/CDP → connected_to_id, IfEntry → Interface via mac_address_id)

12. PhysicalLink edge generation in topology builder (source/target = Interface IDs via IfEntry.interface_id)

13. API for credential management (CRUD)

14. UI: SNMP credential management page at `/settings/snmp-credentials`

15. UI: SNMP settings component for network modal (enable toggle + default credential)

16. UI: SNMP tab in host modal (credential override + metadata display) - always shown when editing

17. UI: IfEntries tab in host modal (ListConfigEditor, sorted by ifIndex) - shown when if_entries exist

---

### Phase 2: Backend Implementation (Completed)

#### Completed Items

**1. IANA Lookup Generators (fixtures.rs)**
- Added `generate_iana_enterprise_numbers()` - parses IANA enterprise numbers registry
- Added `generate_iana_if_types()` - parses IANAifType MIB
- Generated files at `src/server/snmp/generated/`:
  - `enterprise_numbers.rs` - `get_enterprise_name()`, `extract_enterprise_number()`
  - `if_types.rs` - `get_if_type_name()`

**2. SNMP Collection Module (daemon/discovery/service/snmp.rs)**
- `SnmpCollector` with async SNMP session management
- System MIB collection: sysDescr, sysObjectID, sysName, sysLocation, sysContact
- LLDP local info collection: chassis ID
- ifTable walking with ifXTable extension data
- LLDP neighbor discovery (remote chassis, port, system info)
- CDP neighbor discovery (Cisco devices)
- MAC address parsing from ifPhysAddress
- Speed calculation (ifHighSpeed preferred over ifSpeed)
- OID type handling with u64 components (snmp2 API requirement)

**3. Discovery Flow Integration (daemon/discovery/service/network.rs)**
- Added `snmp_credential` to `DeepScanParams`
- Added `get_snmp_credential_for_ip()` helper for credential lookup
- Updated `deep_scan_host()` to:
  - Extract SNMP credential for target IP
  - Call SNMP polling when credentials available
  - Use SNMP sysName for hostname when DNS lookup fails
  - Populate host SNMP system fields
  - Convert SNMP ifTable entries to IfEntry entities
- Added `convert_snmp_if_entry()` for IfTableEntry → IfEntry conversion

**4. Host Entity Updates**
- Added SNMP fields to `HostBase`:
  - `sys_descr`, `sys_object_id`, `sys_location`, `sys_contact`
  - `management_url`, `chassis_id`, `snmp_credential_id`
- Updated `HostBase::Default` implementation
- Updated `to_params()` and `from_row()` in storage.rs
- Updated `HostResponse` with SNMP fields and `if_entries`
- Exhaustive destructuring patterns for compile-time field validation

**5. Discovery Host Request Updates**
- Added `if_entries: Vec<IfEntry>` to `DiscoveryHostRequest`
- Added `create_host_with_snmp()` method to `CreatesDiscoveredEntities` trait
- Updated `discover_host()` in HostService to accept and store if_entries

**6. IfEntry Service**
- Added `create_or_update_by_if_index()` upsert method for idempotent updates

**7. DiscoveryType Updates**
- Added `snmp_credentials: Option<Vec<SnmpQueryCredential>>` to `DiscoveryType::Network`
- Server passes SNMP credentials to daemon in discovery request

#### Files Modified

**Daemon:**
- `daemon/discovery/service/snmp.rs` - New SNMP collection module
- `daemon/discovery/service/network.rs` - SNMP integration in discovery
- `daemon/discovery/service/base.rs` - Added `create_host_with_snmp()`
- `daemon/discovery/service/mod.rs` - Export snmp module

**Server:**
- `server/hosts/impl/base.rs` - SNMP fields on HostBase
- `server/hosts/impl/api.rs` - if_entries in DiscoveryHostRequest/HostResponse
- `server/hosts/impl/storage.rs` - Database columns for SNMP fields
- `server/hosts/impl/legacy.rs` - Updated for new HostBase fields
- `server/hosts/service.rs` - discover_host with if_entries
- `server/hosts/handlers.rs` - Pass if_entries through handlers
- `server/discovery/impl/types.rs` - SNMP credentials in DiscoveryType
- `server/if_entries/service.rs` - Upsert method
- `server/snmp/generated/mod.rs` - Export extract_enterprise_number
- `server/snmp/generated/enterprise_numbers.rs` - Fixed doc test import path

**Tests:**
- `server/services/tests.rs` - Updated discover_host calls
- `server/hosts/tests.rs` - Updated discover_host calls
- `tests/integration/fixtures.rs` - IANA generators

**Other:**
- `server/shared/storage/seed_data.rs` - HostBase defaults
- `server/shared/types/examples.rs` - HostBase defaults
- `server/organizations/demo_data.rs` - HostBase defaults
- `tests/mod.rs` - HostBase defaults

#### Test Results
- All compilation checks pass (`cargo check`)
- All tests pass (`cargo test`)
- All doc tests pass (`cargo test --doc`)
- Linting passes (`cargo clippy --bin server --bin daemon -- -D warnings`)

---

### Phase 3: Topology PhysicalLink Edges (Completed)

Added IfEntry to topology snapshots and PhysicalLink edge type for LLDP-discovered connections.

#### Changes Made

**1. Migrations**
- Added `if_entries` and `removed_if_entries` columns to topologies table
- Added topology snapshot JSONB transformation for Interface `mac_address` → `mac_address_id`

**2. TopologyBase & Storage**
- Added `if_entries: Vec<IfEntry>` and `removed_if_entries: Vec<Uuid>` to TopologyBase struct
- Updated `to_params()` and `from_row()` in topology storage
- Added `SqlValue::IfEntries` variant for database encoding

**3. TopologyService Updates**
- Added `if_entry_service: Arc<IfEntryService>` dependency
- Updated `get_entity_data()` to return IfEntries (7-tuple)
- Updated `BuildGraphParams` to include `if_entries: &'a [IfEntry]`
- Integrated in factory wiring (`shared/services/factory.rs`)

**4. TopologyContext**
- Added `if_entries: &'a [IfEntry]` field
- Added helper methods:
  - `get_if_entry_by_id(id: Uuid)` - Find IfEntry by ID
  - `get_if_entries_for_host(host_id: Uuid)` - Get all IfEntries for a host
  - `get_if_entries_with_neighbor()` - Get IfEntries with resolved Neighbor::IfEntry

**5. TopologySubscriber (Event Handling)**
- Added `EntityDiscriminants::IfEntry` to event filter
- Added `updated_if_entries: bool` and `removed_if_entries: HashSet<Uuid>` to TopologyChanges
- IfEntry changes now trigger topology staleness and updates

**6. PhysicalLink EdgeType**
- Added `DiscoveryProtocol` enum (LLDP, CDP) in `topology/types/edges.rs`
- Added `PhysicalLink` variant to EdgeType with:
  - `source_if_entry_id: Uuid`
  - `target_if_entry_id: Uuid`
  - `protocol: DiscoveryProtocol`
- Implemented metadata (color, icon, name) - uses IfEntry entity color (Cyan)
- Edge style: SmoothStep, solid line, no markers, bidirectional
- Added `is_physical_edge` flag to metadata JSON

**7. EdgeBuilder - PhysicalLink Edge Creation**
- Added `create_physical_link_edges()` in `topology/service/edge_builder.rs`
- Logic:
  - Finds IfEntries with `Neighbor::IfEntry(target_id)` resolution
  - Deduplicates edges (A→B and B→A create one edge)
  - Only creates edges when both IfEntries have `interface_id` (nodes exist)
  - Edge source/target = Interface IDs (for topology node compatibility)
  - Label shows port descriptions: "Gi0/1 ↔ Gi0/2"
- Integrated into `build_graph()` in main.rs

#### Files Modified

**Types:**
- `topology/types/base.rs` - if_entries, removed_if_entries
- `topology/types/storage.rs` - Persistence for if_entries
- `topology/types/edges.rs` - DiscoveryProtocol, PhysicalLink EdgeType

**Services:**
- `topology/service/main.rs` - if_entry_service, BuildGraphParams, build_graph
- `topology/service/subscriber.rs` - Event filter, TopologyChanges
- `topology/service/context.rs` - IfEntry data access methods
- `topology/service/edge_builder.rs` - create_physical_link_edges

**Shared:**
- `shared/storage/traits.rs` - SqlValue::IfEntries
- `shared/storage/generic.rs` - IfEntries encoding
- `shared/services/factory.rs` - Wiring if_entry_service to TopologyService

**Handlers:**
- `topology/handlers.rs` - Updated 3 places with if_entries parameter

#### Test Results
- All compilation checks pass (`cargo check`)
- All tests pass (`cargo test`)

---

### Follow-On Tasks

#### 1. MAC Address Hydration (API Layer) ✓

**Status:** Completed

**Problem:** Interface and IfEntry entities store `mac_address_id: Option<Uuid>` (FK), but API consumers need the actual MAC address string.

**Implementation:**

**1. Response DTOs Created:**
- `interfaces/impl/api.rs` - `InterfaceResponse` with hydrated `mac_address: Option<MacAddress>`
- `if_entries/impl/api.rs` - `IfEntryResponse` with hydrated `mac_address: Option<MacAddress>`
- Both have `from_*()` constructors that take the entity + hydrated MAC

**2. MacAddressService Enhancement:**
- Added `get_by_ids(&[Uuid]) -> HashMap<Uuid, MacAddressRecord>` for batch lookup

**3. HostResponse Updated:**
- `interfaces: Vec<InterfaceResponse>` (was `Vec<Interface>`)
- `if_entries: Vec<IfEntryResponse>` (was `Vec<IfEntry>`)
- `from_host_with_children()` now accepts Response types

**4. HostService Hydration:**
- `load_children_for_host()` - returns hydrated Response types
- `load_children_for_hosts()` - batch version for multiple hosts
- `hydrate_interfaces()` / `hydrate_if_entries()` - helper methods
- All `from_host_with_children()` call sites updated

**5. Supporting Changes:**
- `shared/types/examples.rs` - Added `interface_response()` example
- `hosts/impl/legacy.rs` - Converts `InterfaceResponse` back to `Interface` for old daemon compatibility

**API Impact:**
```json
// Before: interfaces had mac_address_id (FK)
{ "mac_address_id": "uuid-here" }

// After: interfaces have hydrated mac_address
{ "mac_address": "DE:AD:BE:EF:CA:FE" }
```

**Note:** Topology still stores raw entities with `mac_address_id` - hydration only affects API responses.


# Backend Feedback

- Remove any use of Default::default() and replace with enumeration of fields for struct in question
  - **Response:** Found ~22 uses across the codebase. Will replace with explicit field enumeration in SNMP-related code. Note: `..Default::default()` is idiomatic Rust for structs with many optional fields - it prevents errors when new fields are added. However, explicit fields are clearer for code review. Will update.

- SNMP is implemented in docker discovery in backend/src/daemon/discovery/service/snmp.rs, and there's also a lot of SNMP domain-specific code in backend/src/daemon/discovery/service/network.rs. All discovery snmp code should be centralized in an SNMP folder in backend/src/daemon/utils, similar to how all arp domain related code has its own folder
  - **Response:** This is a larger refactor. The SNMP code in `discovery/service/snmp.rs` handles SNMP polling (queries), while the code in `network.rs` handles discovery orchestration that happens to use SNMP. Moving to `daemon/utils/snmp/` would be cleaner. **Question:** Should I proceed with this refactor now, or defer to a separate PR to keep this one focused?

- backend/src/server/daemons/handlers.rs has let network_discovery_type = DiscoveryType::Network { ... snmp_credentials: None }. It should get SNMP credentials from the network being scanned, not have them set to None.
  - **Response:** Done. Now fetches default SNMP credential from the network entity if `snmp_enabled` is true.

- backend/src/server/hosts/service.rs - create_with_children doesn't take an if_entries arg, and then has // IfEntries are populated during SNMP discovery, not during host creation. Is there any reason to not pass if_entries from call sites when available?
  - **Response:** No good reason. Done - added `if_entries: Vec<IfEntry>` parameter to `create_with_children` and updated all call sites.

- In backend/src/server/if_entries/impl/base.rs, can any of IfAdminStatus, IfOperStatus, if_type be obtained from external libraries? Also, is there an opportunity to resolve pub lldp_mgmt_addr or pub cdp_address to an interface_id during resolve_lldp_links? Is this worth doing?
  - **Response:**
    - **External libraries:** Searched crates.io - no established SNMP MIB type libraries in Rust. The `snmp` crate is protocol-level, doesn't define MIB enums. Our simple enums are fine.
    - **Resolving mgmt_addr/cdp_address to interface_id:** After further analysis, this was determined to be **semantically incorrect**. The `lldp_chassis_id` + `lldp_port_id` identify the PHYSICAL neighbor (device/port directly connected via Layer 2), while `lldp_mgmt_addr`/`cdp_address` is the IP where you can MANAGE the remote device - which may NOT be the same interface as the physical connection. Using management addresses for neighbor resolution creates an imprecise network model. **Removed mgmt_addr/cdp_address fallback from neighbor resolution** - now only `chassis_id` and `port_id` are used for physical link discovery. The `lldp_mgmt_addr` and `cdp_address` fields are kept as raw data for display/reference only.

- vec![], // No SNMP if_entries for demo data in backend/src/server/organizations/handlers.rs - I'd like an SNMP entry in demo data. As well as an SNMP credential example.
  - **Response:** Done. Added demo SNMP credential and sample IfEntry for the router host in demo data.


- Please use the SecretString crate for snmp credentials, rather than just storing as a string
  - **Response:** Deferred. This would require adding the `secrecy` crate dependency, changing the `community` field type from String to SecretString, updating serde serialization/deserialization, and modifying database storage. The benefit (zeroize-on-drop, redacted Debug output) is valuable for production credentials but requires careful integration. Recommend addressing in a follow-up PR focused on security hardening.


- Would it be worth using a crate like https://crates.io/crates/const-oid or https://crates.io/crates/oid rather than rolling our own in backend/src/server/snmp/oids.rs?
  - **Response:** Evaluated both:
    - `const-oid`: Great for X.509/cryptographic OIDs, but doesn't include SNMP MIB OIDs
    - `oid`: Similar - general OID parsing, no SNMP MIBs included
    - Our OIDs are just string constants (e.g., `"1.3.6.1.2.1.1.1.0"`) - no complex parsing needed

    **Recommendation:** Keep our simple string constants. External crates don't provide SNMP MIB definitions, and we just need string literals for SNMP GET/WALK operations. No benefit to adding a dependency.

---

### Phase 9: SNMP Feature Fixes and Refactoring (Completed)

Implemented fixes and improvements from the SNMP Feature Fixes plan.

#### Verified Already Complete (Phases 1-7)

1. **Remove Default::default()** - SNMP-related files already have explicit field enumeration
2. **SNMP refactor to utils/snmp/** - Already moved to `daemon/utils/snmp/`
3. **Remove snmp_enabled field** - Already removed; using `snmp_credential_id.is_some()` instead
4. **SecretString implementation** - Already using `secrecy::SecretString` with redaction
5. **CreateHostRequest SNMP support** - Already has SNMP fields and `if_entries: Vec<IfEntryInput>`
6. **Demo data population** - Already generates SNMP credentials and if_entries
7. **Neighbor resolution fix** - Already uses only chassis_id/port_id (not mgmt_addr)

#### Fixes Implemented (Phase 8: IfEntryService Improvements)

**8.1 Fix get_for_host_sorted call**
- Changed `get_for_host_sorted()` → `get_for_host()` in `hosts/service.rs:376`
- The `get_for_host()` method already uses `get_all_ordered(filter, "if_index ASC")`

**8.2 Update convert_snmp_if_entry to use Uuid::nil()**
- Removed `host_id: Uuid` parameter from `convert_snmp_if_entry()` signature
- Now uses `Uuid::nil()` as placeholder (server sets correct host_id in `create_with_children`)
- Added comment: "// Placeholder - server will set correct host_id"

**8.3 Add validation calls in if_entries handlers**
- Added `validate_neighbor_host()` function for `Neighbor::Host` validation
- Updated `create_if_entry` and `update_if_entry` handlers to call:
  - `validate_if_entry_network_consistency()`
  - `validate_relationships()` from IfEntryService
  - `validate_neighbor_host()` for Host neighbor validation

**8.4 Fix IfEntryService factory wiring**
- Removed extra `storage.hosts.clone()` argument from `IfEntryService::new()` in factory.rs
- Added `Storage` trait import to `if_entries/service.rs` for `get_all_ordered()`

#### Files Modified

- `backend/src/server/hosts/service.rs` - Fix get_for_host_sorted → get_for_host
- `backend/src/daemon/discovery/service/network.rs` - Use Uuid::nil() in convert_snmp_if_entry
- `backend/src/server/if_entries/handlers.rs` - Add validate_neighbor_host, call validations
- `backend/src/server/if_entries/service.rs` - Add Storage trait import
- `backend/src/server/shared/services/factory.rs` - Fix IfEntryService constructor args

#### Test Results
- All compilation checks pass (`cargo check`)
- All library tests pass (`cargo test --lib`)
- All integration tests pass (`cargo test`)
- Backend format/lint pass (`cargo fmt && cargo clippy`)
