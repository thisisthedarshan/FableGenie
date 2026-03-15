# =============================================================================
# FableGenie — Full GCP Deploy Script (PowerShell)
# =============================================================================
# USAGE:
#   1. Open PowerShell (run as Administrator on Windows)
#   2. From repo root, run: .\deploy.ps1
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
# =============================================================================

# ─── USER CONFIGURATION — ONLY CHANGE THESE IF NEEDED ───────────────────────
$PROJECT_ID   = "fable-genie"
$REGION       = "asia-south1"
$DOMAIN       = "exportgenie.ai"
$SERVICE_NAME = "fable-genie-api"
$BUCKET_NAME  = "fable-genie-assets"
$SA_NAME      = "fable-genie-sa"
$REPO_NAME    = "fable-genie-repo"
$IMAGE_NAME   = "fable-genie-api"
# ─────────────────────────────────────────────────────────────────────────────

# Derived — do not edit
$SA_EMAIL  = "$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
$IMAGE_URI = "$REGION-docker.pkg.dev/$PROJECT_ID/$REPO_NAME/$IMAGE_NAME"

# ─── HELPERS ─────────────────────────────────────────────────────────────────

function Write-Step    { param([string]$M); Write-Host "`n━━━ $M ━━━" -ForegroundColor Cyan }
function Write-Success { param([string]$M); Write-Host "  ✓ $M" -ForegroundColor Green }
function Write-Warn    { param([string]$M); Write-Host "  ⚠ $M" -ForegroundColor Yellow }
function Write-Fail    { param([string]$M); Write-Host "  ✗ $M" -ForegroundColor Red }

function Invoke-GCloud {
    param([string[]]$Arguments)
    $out = & gcloud @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { return $null }
    return $out
}

# ─── PREFLIGHT ───────────────────────────────────────────────────────────────

Write-Step "Preflight checks"

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    Write-Fail "gcloud CLI not found."
    Write-Host "  Install from: https://cloud.google.com/sdk/docs/install" -ForegroundColor DarkGray
    exit 1
}
Write-Success "gcloud CLI found"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Fail "Docker not found."
    Write-Host "  Install from: https://docs.docker.com/get-docker/" -ForegroundColor DarkGray
    exit 1
}
Write-Success "Docker found"

$activeAccount = & gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>&1
if (-not $activeAccount) {
    Write-Warn "No active gcloud account. Launching login..."
    & gcloud auth login
    $activeAccount = & gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>&1
}
Write-Success "Authenticated as: $activeAccount"

# ─── STEP 1: PROJECT ─────────────────────────────────────────────────────────

Write-Step "Step 1 — GCP Project"

$existing = Invoke-GCloud @("projects", "describe", $PROJECT_ID, "--format=value(projectId)")
if ($existing) {
    Write-Success "Project exists: $PROJECT_ID — using it"
} else {
    Write-Host "  Creating project: $PROJECT_ID ..."
    & gcloud projects create $PROJECT_ID --name="FableGenie"
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Could not create project. '$PROJECT_ID' may already be taken globally."
        Write-Host "  Change `$PROJECT_ID at the top of this script and retry." -ForegroundColor DarkGray
        exit 1
    }
    Write-Success "Project created: $PROJECT_ID"
}

& gcloud config set project $PROJECT_ID | Out-Null
Write-Success "Active project: $PROJECT_ID"

# ─── STEP 2: BILLING ─────────────────────────────────────────────────────────

Write-Step "Step 2 — Billing check"

$billingEnabled = & gcloud billing projects describe $PROJECT_ID --format="value(billingEnabled)" 2>&1
if ($billingEnabled -ne "True") {
    Write-Warn "Billing is NOT enabled on $PROJECT_ID"
    Write-Host ""
    Write-Host "  Enable billing before continuing:" -ForegroundColor Yellow
    Write-Host "  → https://console.cloud.google.com/billing/projects" -ForegroundColor White
    Write-Host "  Link a billing account to: $PROJECT_ID" -ForegroundColor White
    Write-Host ""
    Read-Host "  Press Enter once billing is enabled, or Ctrl+C to abort"
} else {
    Write-Success "Billing is enabled"
}

# ─── STEP 3: ENABLE APIS ─────────────────────────────────────────────────────

Write-Step "Step 3 — Enabling APIs (~60 seconds)"

$apis = @(
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "storage.googleapis.com",
    "aiplatform.googleapis.com",
    "cloudbuild.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com"
)

& gcloud services enable @apis --project $PROJECT_ID
if ($LASTEXITCODE -ne 0) {
    Write-Fail "API enablement failed. Is billing active?"
    exit 1
}

foreach ($api in $apis) {
    Write-Success $api
}

# ─── STEP 4: SERVICE ACCOUNT ─────────────────────────────────────────────────

Write-Step "Step 4 — Service Account"

$existingSA = Invoke-GCloud @("iam", "service-accounts", "describe", $SA_EMAIL, "--project=$PROJECT_ID")
if ($existingSA) {
    Write-Success "Already exists: $SA_EMAIL"
} else {
    & gcloud iam service-accounts create $SA_NAME `
        --display-name="FableGenie Backend" `
        --project=$PROJECT_ID
    if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to create service account"; exit 1 }
    Write-Success "Created: $SA_EMAIL"
}

$roles = @(
    "roles/aiplatform.user",             # Vertex AI — all model calls
    "roles/storage.objectViewer",        # GCS — read Veo clips
    "roles/storage.objectCreator",       # GCS — upload Veo clips
    "roles/secretmanager.secretAccessor",# Secret Manager
    "roles/logging.logWriter",           # Cloud Run logs
    "roles/run.invoker"                  # Cloud Run invocation
)

foreach ($role in $roles) {
    & gcloud projects add-iam-policy-binding $PROJECT_ID `
        --member="serviceAccount:$SA_EMAIL" `
        --role=$role --quiet 2>&1 | Out-Null
    Write-Success "Granted $role"
}

# ─── STEP 5: ARTIFACT REGISTRY ───────────────────────────────────────────────

Write-Step "Step 5 — Artifact Registry"

$existingRepo = Invoke-GCloud @("artifacts", "repositories", "describe", $REPO_NAME, "--location=$REGION", "--project=$PROJECT_ID")
if ($existingRepo) {
    Write-Success "Repository exists: $REPO_NAME"
} else {
    & gcloud artifacts repositories create $REPO_NAME `
        --repository-format=docker `
        --location=$REGION `
        --description="FableGenie Docker images" `
        --project=$PROJECT_ID
    Write-Success "Repository created: $REPO_NAME"
}

& gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
Write-Success "Docker auth configured for $REGION-docker.pkg.dev"

# ─── STEP 6: CLOUD STORAGE BUCKET ────────────────────────────────────────────

Write-Step "Step 6 — Cloud Storage Bucket"

$existingBucket = Invoke-GCloud @("storage", "buckets", "describe", "gs://$BUCKET_NAME")
if ($existingBucket) {
    Write-Success "Bucket exists: gs://$BUCKET_NAME"
} else {
    & gcloud storage buckets create "gs://$BUCKET_NAME" `
        --location=$REGION `
        --project=$PROJECT_ID
    Write-Success "Bucket created: gs://$BUCKET_NAME"
}

# Write CORS config
$corsJson = @"
[{
  "origin": ["https://$DOMAIN", "https://www.$DOMAIN", "http://localhost:8080"],
  "method": ["GET", "HEAD"],
  "responseHeader": ["Content-Type", "Content-Length", "Accept-Ranges", "Content-Range"],
  "maxAgeSeconds": 3600
}]
"@
$corsFile = Join-Path $env:TEMP "fg-cors.json"
$corsJson | Out-File -FilePath $corsFile -Encoding UTF8
& gcloud storage buckets update "gs://$BUCKET_NAME" --cors-file=$corsFile
Write-Success "CORS applied (exportgenie.ai + localhost:8080)"

& gcloud storage buckets add-iam-policy-binding "gs://$BUCKET_NAME" `
    --member="allUsers" --role="roles/storage.objectViewer" 2>&1 | Out-Null
Write-Success "Bucket is publicly readable (required for video streaming)"

Remove-Item $corsFile -ErrorAction SilentlyContinue

# ─── STEP 7: BUILD AND PUSH DOCKER IMAGE ─────────────────────────────────────

Write-Step "Step 7 — Docker Build and Push"

$dockerfilePath = Join-Path $PSScriptRoot "backend\Dockerfile"
if (-not (Test-Path $dockerfilePath)) {
    Write-Fail "backend\Dockerfile not found. Run this script from the repo root."
    exit 1
}

Write-Host "  Building: $IMAGE_URI"
& docker build -t $IMAGE_URI "$PSScriptRoot\backend"
if ($LASTEXITCODE -ne 0) { Write-Fail "Docker build failed"; exit 1 }
Write-Success "Image built"

Write-Host "  Pushing to Artifact Registry..."
& docker push $IMAGE_URI
if ($LASTEXITCODE -ne 0) { Write-Fail "Docker push failed"; exit 1 }
Write-Success "Image pushed: $IMAGE_URI"

# ─── STEP 8: DEPLOY TO CLOUD RUN ─────────────────────────────────────────────

Write-Step "Step 8 — Cloud Run Deployment"

& gcloud run deploy $SERVICE_NAME `
    --image=$IMAGE_URI `
    --platform=managed `
    --region=$REGION `
    --allow-unauthenticated `
    --service-account=$SA_EMAIL `
    --memory=1Gi `
    --cpu=1 `
    --min-instances=1 `
    --max-instances=5 `
    --timeout=300 `
    --port=8080 `
    --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,VERTEX_AI_LOCATION=$REGION,GCS_BUCKET=$BUCKET_NAME" `
    --project=$PROJECT_ID

if ($LASTEXITCODE -ne 0) { Write-Fail "Cloud Run deployment failed"; exit 1 }

$SERVICE_URL = & gcloud run services describe $SERVICE_NAME `
    --region=$REGION --project=$PROJECT_ID --format="value(status.url)"
Write-Success "Live at: $SERVICE_URL"

# ─── STEP 9: DOMAIN MAPPING ──────────────────────────────────────────────────

Write-Step "Step 9 — Domain Mapping"

foreach ($d in @($DOMAIN, "www.$DOMAIN")) {
    $check = Invoke-GCloud @("run", "domain-mappings", "describe", "--domain=$d", "--region=$REGION", "--project=$PROJECT_ID")
    if ($check) {
        Write-Success "Mapping exists: $d"
    } else {
        & gcloud run domain-mappings create `
            --service=$SERVICE_NAME --domain=$d `
            --region=$REGION --project=$PROJECT_ID 2>&1 | Out-Null
        Write-Success "Mapping created: $d"
    }
}

# ─── STEP 10: DNS RECORDS ────────────────────────────────────────────────────

Write-Step "Step 10 — Add These DNS Records at Your Registrar"

Write-Host ""
Write-Host "  TYPE    NAME                     VALUE" -ForegroundColor DarkGray
Write-Host "  ──────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  A       $DOMAIN            216.239.32.21" -ForegroundColor White
Write-Host "  A       $DOMAIN            216.239.34.21" -ForegroundColor White
Write-Host "  A       $DOMAIN            216.239.36.21" -ForegroundColor White
Write-Host "  A       $DOMAIN            216.239.38.21" -ForegroundColor White
Write-Host "  AAAA    $DOMAIN            2001:4860:4802:32::15" -ForegroundColor White
Write-Host "  AAAA    $DOMAIN            2001:4860:4802:36::15" -ForegroundColor White
Write-Host "  CNAME   www.$DOMAIN        ghs.googlehosted.com." -ForegroundColor White
Write-Host ""
Write-Host "  DNS propagation: up to 48 hours." -ForegroundColor DarkGray
Write-Host "  SSL certificate: provisioned automatically by Google." -ForegroundColor DarkGray
Write-Host ""

# ─── WRITE .env.example ──────────────────────────────────────────────────────

@"
# FableGenie environment variables
# NO API KEYS — authentication uses GCP Application Default Credentials.
#
# Cloud Run: auth is automatic via the attached service account.
# Local dev:  run once → gcloud auth application-default login

GOOGLE_CLOUD_PROJECT=$PROJECT_ID
VERTEX_AI_LOCATION=$REGION
GCS_BUCKET=$BUCKET_NAME
PORT=8080
"@ | Out-File -FilePath (Join-Path $PSScriptRoot ".env.example") -Encoding UTF8

Write-Host "  .env.example written to repo root" -ForegroundColor DarkGray

# ─── SUMMARY ─────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "  FableGenie — deployment complete" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host ""
Write-Host "  Cloud Run  : $SERVICE_URL" -ForegroundColor White
Write-Host "  Domain     : https://$DOMAIN  (live after DNS propagates)" -ForegroundColor White
Write-Host "  Bucket     : gs://$BUCKET_NAME" -ForegroundColor White
Write-Host "  Image      : $IMAGE_URI" -ForegroundColor White
Write-Host "  Project    : $PROJECT_ID" -ForegroundColor White
Write-Host "  Region     : $REGION" -ForegroundColor White
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Yellow
Write-Host "  1. Add DNS records above to your domain registrar" -ForegroundColor White
Write-Host "  2. Upload Veo clips:" -ForegroundColor White
Write-Host "     gcloud storage cp assets/trust_resolution.mp4 gs://$BUCKET_NAME/" -ForegroundColor DarkGray
Write-Host "     gcloud storage cp assets/run_away_resolution.mp4 gs://$BUCKET_NAME/" -ForegroundColor DarkGray
Write-Host "  3. Local dev: gcloud auth application-default login" -ForegroundColor White
Write-Host "  4. Re-deploys: just run .\deploy.ps1 again" -ForegroundColor White
Write-Host ""