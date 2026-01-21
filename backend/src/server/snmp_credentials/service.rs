use crate::server::{
    shared::{
        events::bus::EventBus,
        services::traits::{CrudService, EventBusService},
        storage::generic::GenericPostgresStorage,
    },
    snmp_credentials::r#impl::base::SnmpCredential,
    tags::entity_tags::EntityTagService,
};
use std::sync::Arc;
use uuid::Uuid;

pub struct SnmpCredentialService {
    storage: Arc<GenericPostgresStorage<SnmpCredential>>,
    event_bus: Arc<EventBus>,
    entity_tag_service: Arc<EntityTagService>,
}

impl EventBusService<SnmpCredential> for SnmpCredentialService {
    fn event_bus(&self) -> &Arc<EventBus> {
        &self.event_bus
    }

    fn get_network_id(&self, _entity: &SnmpCredential) -> Option<Uuid> {
        None
    }

    fn get_organization_id(&self, entity: &SnmpCredential) -> Option<Uuid> {
        Some(entity.base.organization_id)
    }
}

impl CrudService<SnmpCredential> for SnmpCredentialService {
    fn storage(&self) -> &Arc<GenericPostgresStorage<SnmpCredential>> {
        &self.storage
    }

    fn entity_tag_service(&self) -> Option<&Arc<EntityTagService>> {
        Some(&self.entity_tag_service)
    }
}

impl SnmpCredentialService {
    pub fn new(
        storage: Arc<GenericPostgresStorage<SnmpCredential>>,
        event_bus: Arc<EventBus>,
        entity_tag_service: Arc<EntityTagService>,
    ) -> Self {
        Self {
            storage,
            event_bus,
            entity_tag_service,
        }
    }
}
