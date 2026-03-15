#!/bin/bash
set -e

PROJECT_ID="your-project-id"  # Set to real project id 
REGION="us-central1"
SERVICE_NAME="fable-genie"

echo "Submitting build to Cloud Build..."
gcloud builds submit --tag gcr.io/$PROJECT_ID/$SERVICE_NAME

echo "Deploying to Cloud Run..."
gcloud run deploy $SERVICE_NAME \
  --image gcr.io/$PROJECT_ID/$SERVICE_NAME \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --min-instances 1 \
  --port 8080

echo "Deployment complete! Don't forget to run Terraform for GCS CORS."
