#!/usr/bin/env bash
# =============================================================================
# FableGenie — Full GCP Deploy Script (Bash)
# =============================================================================
# USAGE:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# WHAT THIS DOES (fully automated):
#   - Creates GCP project (or uses existing)
#   - Enables all required APIs
#   - Creates service account + grants all IAM roles
#   - Creates Artifact Registry repository
#   - Creates GCS bucket with CORS for exportgenie.ai
#   - Builds and pushes Docker image
#   - Deploys to Cloud Run (min-instances=1, no cold starts)
#   - Maps exportgenie.ai + www.exportgenie.ai
#   - Prints exact DNS records to add at your registrar
#   - Writes .env.example (no API keys — ADC auth only)
#
# RUNS ON: macOS, Linux, WSL on Windows
# =============================================================================

set -euo pipefail

# ─── USER CONFIGURATION — ONLY CHANGE THESE IF NEEDED ───────────────────────
PROJECT_ID="fable-genie"
REGION="asia-south1"
DOMAIN="exportgenie.ai"
SERVICE_NAME="fable-genie-api"
BUCKET_NAME="fable-genie-assets"
SA_NAME="fable-genie-sa"
REPO_NAME="fable-genie-repo"
IMAGE_NAME="fable-genie-api"
# ─────────────────────────────────────────────────────────────────────────────

# Derived — do not edit
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${IMAGE_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── COLOURS ─────────────────────────────────────────────────────────────────

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
GRAY='\033[0;90m'
BOLD='\033[1m'
RESET='\033[0m'

step()    { echo -e "\n${CYAN}━━━ $1 ━━━${RESET}"; }
success() { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
fail()    { echo -e "  ${RED}✗${RESET} $1"; }
note()    { echo -e "  ${GRAY}$1${RESET}"; }

# ─── PREFLIGHT ───────────────────────────────────────────────────────────────

step "Preflight checks"

if ! command -v gcloud &>/dev/null; then
    fail "gcloud CLI not found."
    note "Install from: https://cloud.google.com/sdk/docs/install"
    exit 1
fi
success "gcloud CLI found"

if ! command -v docker &>/dev/null; then
    fail "Docker not found."
    note "Install from: https://docs.docker.com/get-docker/"
    exit 1
fi
success "Docker found"

ACTIVE_ACCOUNT=$(gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>/dev/null || true)
if [[ -z "$ACTIVE_ACCOUNT" ]]; then
    warn "No active gcloud account. Launching login..."
    gcloud auth login
    ACTIVE_ACCOUNT=$(gcloud auth list --filter="status:ACTIVE" --format="value(account)")
fi
success "Authenticated as: $ACTIVE_ACCOUNT"

# ─── STEP 1: PROJECT ─────────────────────────────────────────────────────────

step "Step 1 — GCP Project"

if gcloud projects describe "$PROJECT_ID" --format="value(projectId)" &>/dev/null; then
    success "Project exists: $PROJECT_ID — using it"
else
    echo "  Creating project: $PROJECT_ID ..."
    if ! gcloud projects create "$PROJECT_ID" --name="FableGenie"; then
        fail "Could not create project. '$PROJECT_ID' may already be taken globally."
        note "Change PROJECT_ID at the top of this script and retry."
        exit 1
    fi
    success "Project created: $PROJECT_ID"
fi

gcloud config set project "$PROJECT_ID" --quiet
success "Active project: $PROJECT_ID"

# ─── STEP 2: BILLING ─────────────────────────────────────────────────────────

step "Step 2 — Billing check"

BILLING_ENABLED=$(gcloud billing projects describe "$PROJECT_ID" \
    --format="value(billingEnabled)" 2>/dev/null || echo "False")

if [[ "$BILLING_ENABLED" != "True" ]]; then
    warn "Billing is NOT enabled on $PROJECT_ID"
    echo ""
    echo -e "  ${YELLOW}Enable billing before continuing:${RESET}"
    echo -e "  → ${BOLD}https://console.cloud.google.com/billing/projects${RESET}"
    echo    "  Link a billing account to: $PROJECT_ID"
    echo ""
    read -r -p "  Press Enter once billing is enabled, or Ctrl+C to abort: "
else
    success "Billing is enabled"
fi

# ─── STEP 3: ENABLE APIS ─────────────────────────────────────────────────────

step "Step 3 — Enabling APIs (~60 seconds)"

APIS=(
    "run.googleapis.com"
    "artifactregistry.googleapis.com"
    "storage.googleapis.com"
    "aiplatform.googleapis.com"
    "cloudbuild.googleapis.com"
    "secretmanager.googleapis.com"
    "iam.googleapis.com"
    "cloudresourcemanager.googleapis.com"
)

gcloud services enable "${APIS[@]}" --project "$PROJECT_ID"

for api in "${APIS[@]}"; do
    success "$api"
done

# ─── STEP 4: SERVICE ACCOUNT ─────────────────────────────────────────────────

step "Step 4 — Service Account"

if gcloud iam service-accounts describe "$SA_EMAIL" \
    --project="$PROJECT_ID" &>/dev/null; then
    success "Already exists: $SA_EMAIL"
else
    gcloud iam service-accounts create "$SA_NAME" \
        --display-name="FableGenie Backend" \
        --project="$PROJECT_ID"
    success "Created: $SA_EMAIL"
fi

ROLES=(
    "roles/aiplatform.user"              # Vertex AI — all model calls
    "roles/storage.objectViewer"         # GCS — read Veo clips
    "roles/storage.objectCreator"        # GCS — upload Veo clips
    "roles/secretmanager.secretAccessor" # Secret Manager
    "roles/logging.logWriter"            # Cloud Run logs
    "roles/run.invoker"                  # Cloud Run invocation
)

for role in "${ROLES[@]}"; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$SA_EMAIL" \
        --role="$role" \
        --quiet &>/dev/null
    success "Granted $role"
done

# ─── STEP 5: ARTIFACT REGISTRY ───────────────────────────────────────────────

step "Step 5 — Artifact Registry"

if gcloud artifacts repositories describe "$REPO_NAME" \
    --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
    success "Repository exists: $REPO_NAME"
else
    gcloud artifacts repositories create "$REPO_NAME" \
        --repository-format=docker \
        --location="$REGION" \
        --description="FableGenie Docker images" \
        --project="$PROJECT_ID"
    success "Repository created: $REPO_NAME"
fi

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
success "Docker auth configured for ${REGION}-docker.pkg.dev"

# ─── STEP 6: CLOUD STORAGE BUCKET ────────────────────────────────────────────

step "Step 6 — Cloud Storage Bucket"

if gcloud storage buckets describe "gs://$BUCKET_NAME" &>/dev/null; then
    success "Bucket exists: gs://$BUCKET_NAME"
else
    gcloud storage buckets create "gs://$BUCKET_NAME" \
        --location="$REGION" \
        --project="$PROJECT_ID"
    success "Bucket created: gs://$BUCKET_NAME"
fi

# Write CORS config to temp file
CORS_FILE=$(mktemp /tmp/fg-cors-XXXXXX.json)
cat > "$CORS_FILE" <<EOF
[{
  "origin": ["https://${DOMAIN}", "https://www.${DOMAIN}", "http://localhost:8080"],
  "method": ["GET", "HEAD"],
  "responseHeader": ["Content-Type", "Content-Length", "Accept-Ranges", "Content-Range"],
  "maxAgeSeconds": 3600
}]
EOF

gcloud storage buckets update "gs://$BUCKET_NAME" --cors-file="$CORS_FILE"
success "CORS applied (exportgenie.ai + localhost:8080)"
rm -f "$CORS_FILE"

gcloud storage buckets add-iam-policy-binding "gs://$BUCKET_NAME" \
    --member="allUsers" \
    --role="roles/storage.objectViewer" &>/dev/null
success "Bucket is publicly readable (required for video streaming)"

# ─── STEP 7: BUILD AND PUSH DOCKER IMAGE ─────────────────────────────────────

step "Step 7 — Docker Build and Push"

DOCKERFILE_PATH="$SCRIPT_DIR/backend/Dockerfile"
if [[ ! -f "$DOCKERFILE_PATH" ]]; then
    fail "backend/Dockerfile not found. Run this script from the repo root."
    exit 1
fi

echo "  Building: $IMAGE_URI"
docker build -t "$IMAGE_URI" "$SCRIPT_DIR/backend"
success "Image built"

echo "  Pushing to Artifact Registry..."
docker push "$IMAGE_URI"
success "Image pushed: $IMAGE_URI"

# ─── STEP 8: DEPLOY TO CLOUD RUN ─────────────────────────────────────────────

step "Step 8 — Cloud Run Deployment"

gcloud run deploy "$SERVICE_NAME" \
    --image="$IMAGE_URI" \
    --platform=managed \
    --region="$REGION" \
    --allow-unauthenticated \
    --service-account="$SA_EMAIL" \
    --memory=1Gi \
    --cpu=1 \
    --min-instances=1 \
    --max-instances=5 \
    --timeout=300 \
    --port=8080 \
    --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},VERTEX_AI_LOCATION=${REGION},GCS_BUCKET=${BUCKET_NAME}" \
    --project="$PROJECT_ID"

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --format="value(status.url)")

success "Live at: $SERVICE_URL"

# ─── STEP 9: DOMAIN MAPPING ──────────────────────────────────────────────────

step "Step 9 — Domain Mapping"

for d in "$DOMAIN" "www.$DOMAIN"; do
    if gcloud run domain-mappings describe \
        --domain="$d" \
        --region="$REGION" \
        --project="$PROJECT_ID" &>/dev/null; then
        success "Mapping exists: $d"
    else
        gcloud run domain-mappings create \
            --service="$SERVICE_NAME" \
            --domain="$d" \
            --region="$REGION" \
            --project="$PROJECT_ID" 2>/dev/null || true
        success "Mapping created: $d"
    fi
done

# ─── STEP 10: DNS RECORDS ────────────────────────────────────────────────────

step "Step 10 — Add These DNS Records at Your Registrar"

echo ""
echo -e "  ${GRAY}TYPE    NAME                     VALUE${RESET}"
echo -e "  ${GRAY}──────────────────────────────────────────────────────────────${RESET}"
echo    "  A       $DOMAIN            216.239.32.21"
echo    "  A       $DOMAIN            216.239.34.21"
echo    "  A       $DOMAIN            216.239.36.21"
echo    "  A       $DOMAIN            216.239.38.21"
echo    "  AAAA    $DOMAIN            2001:4860:4802:32::15"
echo    "  AAAA    $DOMAIN            2001:4860:4802:36::15"
echo    "  CNAME   www.$DOMAIN        ghs.googlehosted.com."
echo ""
note "DNS propagation: up to 48 hours."
note "SSL certificate: provisioned automatically by Google."
echo ""

# ─── WRITE .env.example ──────────────────────────────────────────────────────

cat > "$SCRIPT_DIR/.env.example" <<EOF
# FableGenie environment variables
# NO API KEYS — authentication uses GCP Application Default Credentials.
#
# Cloud Run: auth is automatic via the attached service account.
# Local dev:  run once → gcloud auth application-default login

GOOGLE_CLOUD_PROJECT=${PROJECT_ID}
VERTEX_AI_LOCATION=${REGION}
GCS_BUCKET=${BUCKET_NAME}
PORT=8080
EOF

note ".env.example written to repo root"

# ─── SUMMARY ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}  FableGenie — deployment complete${RESET}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo    "  Cloud Run  : $SERVICE_URL"
echo    "  Domain     : https://$DOMAIN  (live after DNS propagates)"
echo    "  Bucket     : gs://$BUCKET_NAME"
echo    "  Image      : $IMAGE_URI"
echo    "  Project    : $PROJECT_ID"
echo    "  Region     : $REGION"
echo ""
echo -e "  ${YELLOW}Next steps:${RESET}"
echo    "  1. Add DNS records above to your domain registrar"
echo    "  2. Upload Veo clips:"
note   "     gcloud storage cp assets/trust_resolution.mp4 gs://$BUCKET_NAME/"
note   "     gcloud storage cp assets/run_away_resolution.mp4 gs://$BUCKET_NAME/"
echo    "  3. Local dev: gcloud auth application-default login"
echo    "  4. Re-deploys: just run ./deploy.sh again"
echo ""