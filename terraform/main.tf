terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 4.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

// Variables
variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

// GCS Bucket with CORS for Video Streaming
resource "google_storage_bucket" "assets_bucket" {
  name          = "fable-genie-assets"
  location      = "US"
  force_destroy = true

  cors {
    origin          = ["https://exportgenie.ai", "http://localhost:8080"]
    method          = ["GET", "HEAD", "OPTIONS"]
    response_header = ["*"]
    max_age_seconds = 3600
  }
}

// Cloud Run Service setup assuming prior image deployment
resource "google_cloud_run_service" "default" {
  name     = "fable-genie"
  location = var.region

  template {
    spec {
      containers {
        image = "gcr.io/${var.project_id}/fable-genie"
        ports {
          container_port = 8080
        }
      }
    }
  }

  traffic {
    percent         = 100
    latest_revision = true
  }
}

resource "google_cloud_run_service_iam_member" "allow_unauthenticated" {
  service  = google_cloud_run_service.default.name
  location = google_cloud_run_service.default.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
