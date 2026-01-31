use crate::server::auth::middleware::permissions::{Authorized, Owner, Viewer};
use crate::server::billing::types::api::CreateCheckoutRequest;
use crate::server::billing::types::base::BillingPlan;
use crate::server::config::AppState;
use crate::server::hubspot::types::HubSpotFormField;
use crate::server::shared::types::ErrorCode;
use crate::server::shared::types::api::{ApiError, ApiResult};
use crate::server::shared::types::api::{ApiErrorResponse, ApiResponse, EmptyApiResponse};
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::header::CACHE_CONTROL;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use utoipa::ToSchema;
use utoipa_axum::{router::OpenApiRouter, routes};

/// Enterprise plan inquiry request
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EnterpriseInquiryRequest {
    /// Contact email
    pub email: String,
    /// Contact name
    pub name: String,
    /// Company name
    pub company: String,
    /// Team/company size: 1-10, 11-25, 26-50, 51-100, 101-250, 251-500, 501-1000, 1001+
    pub team_size: String,
    /// Use case description
    pub use_case: String,
    /// Urgency: immediately, 1-3 months, 3-6 months, exploring
    #[serde(default)]
    pub urgency: Option<String>,
    /// Number of networks/sites
    #[serde(default)]
    pub network_count: Option<i64>,
    /// Plan type being inquired about
    #[serde(default)]
    pub plan_type: Option<String>,
}

pub fn create_router() -> OpenApiRouter<Arc<AppState>> {
    OpenApiRouter::new()
        .routes(routes!(get_billing_plans))
        .routes(routes!(create_checkout_session))
        .routes(routes!(handle_webhook))
        .routes(routes!(create_portal_session))
        .routes(routes!(submit_enterprise_inquiry))
}

/// Get available billing plans
#[utoipa::path(
    get,
    path = "/plans",
    tags = ["billing", "internal"],
    responses(
        (status = 200, description = "List of available billing plans", body = ApiResponse<Vec<BillingPlan>>),
        (status = 400, description = "Billing not enabled", body = ApiErrorResponse),
    ),
     security(("user_api_key" = []), ("session" = []))
)]
async fn get_billing_plans(
    State(state): State<Arc<AppState>>,
    _auth: Authorized<Owner>,
) -> Result<impl IntoResponse, ApiError> {
    if let Some(billing_service) = state.services.billing_service.clone() {
        let plans = billing_service.get_plans();
        Ok((
            [(CACHE_CONTROL, "no-store, no-cache, must-revalidate")],
            Json(ApiResponse::success(plans)),
        ))
    } else {
        Err(ApiError::billing_setup_incomplete())
    }
}

/// Create a checkout session
#[utoipa::path(
    post,
    path = "/checkout",
    tags = ["billing", "internal"],
    request_body = CreateCheckoutRequest,
    responses(
        (status = 200, description = "Checkout session URL", body = ApiResponse<String>),
        (status = 400, description = "Invalid plan or billing not enabled", body = ApiErrorResponse),
    ),
     security(("user_api_key" = []), ("session" = []))
)]
async fn create_checkout_session(
    State(state): State<Arc<AppState>>,
    auth: Authorized<Owner>,
    Json(request): Json<CreateCheckoutRequest>,
) -> ApiResult<Json<ApiResponse<String>>> {
    let organization_id = auth
        .organization_id()
        .ok_or_else(ApiError::organization_required)?;

    // Build success/cancel URLs
    let success_url = format!("{}?session_id={{CHECKOUT_SESSION_ID}}", request.url);
    let cancel_url = format!("{}/billing", request.url);

    if let Some(billing_service) = state.services.billing_service.clone() {
        let current_plans = billing_service.get_plans();

        if !current_plans.contains(&request.plan) {
            return Err(ApiError::validation(ErrorCode::ValidationInvalidFormat {
                field: "plan".to_string(),
            }));
        }

        let session = billing_service
            .create_checkout_session(
                organization_id,
                request.plan,
                success_url,
                cancel_url,
                auth.into_entity(),
            )
            .await?;

        Ok(Json(ApiResponse::success(session.url.unwrap())))
    } else {
        Err(ApiError::billing_setup_incomplete())
    }
}

/// Handle Stripe webhook
///
/// Internal endpoint for Stripe webhook callbacks.
#[utoipa::path(
    post,
    path = "/webhooks",
    tags = ["billing", "internal"],
    responses(
        (status = 200, description = "Webhook processed", body = EmptyApiResponse),
        (status = 400, description = "Invalid signature or billing not enabled", body = ApiErrorResponse),
    )
)]
async fn handle_webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: String,
) -> ApiResult<Json<ApiResponse<()>>> {
    let signature = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            ApiError::validation(ErrorCode::ValidationRequired {
                field: "stripe-signature".to_string(),
            })
        })?;

    if let Some(billing_service) = &state.services.billing_service {
        billing_service.handle_webhook(&body, signature).await?;
        Ok(Json(ApiResponse::success(())))
    } else {
        Err(ApiError::billing_setup_incomplete())
    }
}

/// Create a billing portal session
#[utoipa::path(
    post,
    path = "/portal",
    tags = ["billing", "internal"],
    request_body = String,
    responses(
        (status = 200, description = "Portal session URL", body = ApiResponse<String>),
        (status = 400, description = "Billing not enabled", body = ApiErrorResponse),
    ),
     security(("user_api_key" = []), ("session" = []))
)]
async fn create_portal_session(
    State(state): State<Arc<AppState>>,
    auth: Authorized<Owner>,
    Json(return_url): Json<String>,
) -> ApiResult<Json<ApiResponse<String>>> {
    let organization_id = auth
        .organization_id()
        .ok_or_else(ApiError::organization_required)?;

    if let Some(billing_service) = &state.services.billing_service {
        let session_url = billing_service
            .create_portal_session(organization_id, return_url)
            .await?;

        Ok(Json(ApiResponse::success(session_url)))
    } else {
        Err(ApiError::billing_setup_incomplete())
    }
}

/// Submit enterprise plan inquiry
///
/// Creates a contact and company in HubSpot for sales follow-up.
/// Requires authentication to link the inquiry to an organization.
#[utoipa::path(
    post,
    path = "/inquiry",
    tags = ["billing", "internal"],
    request_body = EnterpriseInquiryRequest,
    responses(
        (status = 200, description = "Inquiry submitted successfully", body = EmptyApiResponse),
        (status = 400, description = "Invalid request or HubSpot not configured", body = ApiErrorResponse),
        (status = 401, description = "Authentication required", body = ApiErrorResponse),
    ),
    security(("user_api_key" = []), ("session" = []))
)]
async fn submit_enterprise_inquiry(
    State(state): State<Arc<AppState>>,
    auth: Authorized<Viewer>,
    Json(request): Json<EnterpriseInquiryRequest>,
) -> ApiResult<Json<ApiResponse<()>>> {
    // Get organization_id from auth context
    let organization_id = auth
        .organization_id()
        .ok_or_else(ApiError::organization_required)?;

    // Validate required fields
    if request.email.is_empty() || request.name.is_empty() || request.company.is_empty() {
        return Err(ApiError::validation(ErrorCode::ValidationRequired {
            field: "email, name, company".to_string(),
        }));
    }

    // Check if HubSpot is configured
    let hubspot_service = state
        .services
        .hubspot_service
        .as_ref()
        .ok_or_else(|| ApiError::bad_request("Enterprise inquiries are not enabled"))?;

    // Build form fields to match HubSpot form
    // Field names must match exactly what's configured in the HubSpot form
    let mut fields = vec![
        HubSpotFormField::new("email", &request.email),
        HubSpotFormField::new("firstname", &request.name),
        HubSpotFormField::new("company", &request.company),
        HubSpotFormField::new("company_size", &request.team_size),
        HubSpotFormField::new("use_case", &request.use_case),
        HubSpotFormField::new("scanopy_org_id", organization_id.to_string()),
    ];

    if let Some(urgency) = &request.urgency {
        fields.push(HubSpotFormField::new("urgency", urgency));
    }
    if let Some(network_count) = request.network_count {
        fields.push(HubSpotFormField::new(
            "network_count",
            network_count.to_string(),
        ));
    }
    if let Some(plan_type) = &request.plan_type {
        fields.push(HubSpotFormField::new("plan_type", plan_type));
    }

    // Submit to HubSpot form - this triggers workflows and email notifications
    hubspot_service
        .client
        .submit_enterprise_inquiry_form(fields)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to submit inquiry to HubSpot form");
            ApiError::internal_error("Failed to submit inquiry")
        })?;

    tracing::info!(
        email = %request.email,
        company = %request.company,
        organization_id = %organization_id,
        plan_type = ?request.plan_type,
        "Enterprise inquiry submitted to HubSpot form"
    );

    Ok(Json(ApiResponse::success(())))
}
