use std::{collections::HashSet, sync::Arc};

use anyhow::Result;
use async_trait::async_trait;
use uuid::Uuid;

use crate::server::{
    hosts::service::HostService,
    hubspot::service::HubSpotService,
    networks::service::NetworkService,
    shared::{
        entities::EntityDiscriminants,
        events::{
            bus::{EventFilter, EventSubscriber},
            types::{EntityOperation, Event},
        },
        services::traits::CrudService,
        storage::filter::StorableFilter,
    },
    users::service::UserService,
};

/// Subscriber that syncs entity counts (networks, hosts, users) to HubSpot
/// when those entities are created or deleted.
pub struct HubSpotMetricsSubscriber {
    hubspot_service: Arc<HubSpotService>,
    network_service: Arc<NetworkService>,
    host_service: Arc<HostService>,
    user_service: Arc<UserService>,
}

impl HubSpotMetricsSubscriber {
    pub fn new(
        hubspot_service: Arc<HubSpotService>,
        network_service: Arc<NetworkService>,
        host_service: Arc<HostService>,
        user_service: Arc<UserService>,
    ) -> Self {
        Self {
            hubspot_service,
            network_service,
            host_service,
            user_service,
        }
    }

    async fn sync_org_metrics(&self, org_id: Uuid) -> Result<()> {
        // First check if the company exists in HubSpot - don't create if it doesn't.
        // The company should be created by the OrgCreated telemetry event handler
        // with proper name and contact association. Due to HubSpot's eventual consistency,
        // the company may not be searchable immediately after creation, so we skip
        // the sync rather than creating a duplicate.
        let existing = self
            .hubspot_service
            .client
            .find_company_by_org_id(&org_id.to_string())
            .await?;

        if existing.is_none() {
            tracing::debug!(
                organization_id = %org_id,
                "Skipping HubSpot metrics sync - company not found (may not be indexed yet)"
            );
            return Ok(());
        }

        // Count entities using service layer
        let network_filter = StorableFilter::new_from_org_id(&org_id);
        let networks = self.network_service.get_all(network_filter).await?;
        let network_count = networks.len() as i64;

        let host_filter = StorableFilter::new_from_org_id(&org_id);
        let hosts = self.host_service.get_all(host_filter).await?;
        let host_count = hosts.len() as i64;

        let user_filter = StorableFilter::new_from_org_id(&org_id);
        let users = self.user_service.get_all(user_filter).await?;
        let user_count = users.len() as i64;

        // Sync to HubSpot
        self.hubspot_service
            .sync_organization_metrics(org_id, network_count, host_count, user_count)
            .await?;

        Ok(())
    }
}

#[async_trait]
impl EventSubscriber for HubSpotMetricsSubscriber {
    fn event_filter(&self) -> EventFilter {
        let mut entity_ops = std::collections::HashMap::new();
        entity_ops.insert(
            EntityDiscriminants::Network,
            Some(vec![EntityOperation::Created, EntityOperation::Deleted]),
        );
        entity_ops.insert(
            EntityDiscriminants::Host,
            Some(vec![EntityOperation::Created, EntityOperation::Deleted]),
        );
        entity_ops.insert(
            EntityDiscriminants::User,
            Some(vec![EntityOperation::Created, EntityOperation::Deleted]),
        );

        EventFilter {
            entity_operations: Some(entity_ops),
            auth_operations: Some(vec![]),
            telemetry_operations: Some(vec![]),
            discovery_phases: Some(vec![]),
            network_ids: None,
        }
    }

    async fn handle_events(&self, events: Vec<Event>) -> Result<()> {
        // Collect unique org_ids from entity events
        let mut org_ids = HashSet::new();
        for event in &events {
            if let Event::Entity(entity_event) = event {
                // Try to get org_id directly from event (works for networks, users)
                if let Some(org_id) = entity_event.organization_id {
                    org_ids.insert(org_id);
                } else if let Some(network_id) = entity_event.network_id {
                    // For entities like hosts that only have network_id,
                    // look up the org_id via the network
                    if let Ok(Some(network)) = self.network_service.get_by_id(&network_id).await {
                        org_ids.insert(network.base.organization_id);
                    }
                }
            }
        }

        // Sync metrics for each affected org
        for org_id in org_ids {
            if let Err(e) = self.sync_org_metrics(org_id).await {
                tracing::warn!(
                    error = %e,
                    organization_id = %org_id,
                    "Failed to sync organization metrics to HubSpot"
                );
            }
        }

        Ok(())
    }

    fn name(&self) -> &str {
        "hubspot_metrics"
    }

    fn debounce_window_ms(&self) -> u64 {
        5000 // 5 second debounce to batch rapid changes
    }
}
